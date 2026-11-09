/**
 * A throwaway Postgres for tests and the local stack: found on this machine, started
 * in a temporary folder, removed afterwards. Works on Linux, macOS and Windows.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const supabaseDir = fileURLToPath(new URL('../', import.meta.url));

const isWindows = process.platform === 'win32';
const exe = (name: string) => (isWindows ? `${name}.exe` : name);
const hasInitdb = (dir: string) => existsSync(join(dir, exe('initdb')));

/** Postgres server binaries: PG_BIN, then pg_config on PATH, then the usual install folders. */
export function findPgBin(): string | null {
  if (process.env.PG_BIN && hasInitdb(process.env.PG_BIN)) return process.env.PG_BIN;
  try {
    const dir = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
    if (hasInitdb(dir)) return dir;
  } catch { /* not on PATH */ }
  const bases = isWindows
    ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PostgreSQL')]
    : ['/usr/lib/postgresql', '/opt/homebrew/opt', '/usr/local/opt'];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    const versions = readdirSync(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) if (hasInitdb(join(base, v, 'bin'))) return join(base, v, 'bin');
  }
  return null;
}

let server: ChildProcess | undefined;
let dataDir: string | undefined;

export async function startCluster(): Promise<string | null> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const bin = findPgBin();
  if (!bin) return null;
  dataDir = mkdtempSync(join(tmpdir(), 'marmoot-pg-'));
  chmodSync(dataDir, 0o777);
  // initdb refuses to run as root; use the postgres system user when we are root.
  const asPg = (cmd: string, args: string[]) => (process.getuid?.() === 0 ? ['runuser', ['-u', 'postgres', '--', cmd, ...args]] as const : [cmd, args] as const);
  const [c1, a1] = asPg(join(bin, exe('initdb')), ['-D', join(dataDir, 'data'), '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-locale']);
  execFileSync(c1, a1, { stdio: 'ignore' });
  const port = String(55000 + Math.floor(Math.random() * 5000));
  // A Unix socket in the temp folder on Linux and macOS; a localhost-only TCP port on Windows.
  const tcp = isWindows || !!process.env.PG_TCP;
  const listen = tcp ? ['-c', 'listen_addresses=localhost'] : ['-k', dataDir, '-c', 'listen_addresses='];
  const [c2, a2] = asPg(join(bin, exe('postgres')), ['-D', join(dataDir, 'data'), '-p', port, ...listen, '-c', 'fsync=off']);
  server = spawn(c2, a2, { stdio: 'ignore' });
  const url = tcp
    ? `postgresql://postgres@localhost:${port}/postgres`
    : `postgresql://postgres@/postgres?host=${encodeURIComponent(dataDir)}&port=${port}`;
  for (let i = 0; i < 150; i++) {
    try {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      await c.end();
      return url;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('temporary Postgres did not start');
}

export async function stopCluster() {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server!.once('exit', r));
    server.kill('SIGINT');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  if (dataDir) {
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      console.warn(`could not remove the temporary database at ${dataDir}`);
    }
  }
}

/** The pieces of Supabase's auth schema the migrations need, then every migration in order. */
export async function applySchema(db: pg.Client): Promise<void> {
  await db.query(readFileSync(join(supabaseDir, 'tests/auth-stub.sql'), 'utf8'));
  for (const f of readdirSync(join(supabaseDir, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    await db.query(readFileSync(join(supabaseDir, 'migrations', f), 'utf8'));
  }
}
