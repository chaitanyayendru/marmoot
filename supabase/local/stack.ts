/**
 * Marmoot's server on your own computer, for trying shared bill sheets with no
 * accounts anywhere:
 *
 *   npm run local
 *
 * It starts, all on localhost:
 *   - a throwaway Postgres with every migration (needs PostgreSQL 16+ installed);
 *   - PostgREST, the same API layer Supabase runs (downloaded once, or POSTGREST_BIN);
 *   - the two Edge Functions, run in Node;
 *   - a pretend WhatsApp: messages Marmoot "sends" land in an inbox page at
 *     http://localhost:54321/whatsapp, with the same button a real message has;
 *   - a pretend Google sign-in: pick who you are (Chai, Asha, Ben or anyone), so
 *     shared groups, invites and approvals can be tried with two browsers;
 *   - the web app at http://localhost:5173, already pointed at all of the above.
 *
 * Everything is deleted when you stop it with Ctrl+C.
 * Flags: --no-web (don't start the web app), --port N (default 54321).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import pg from 'pg';
import { handleSendBillAlerts } from '../functions/send-bill-alerts/handler.ts';
import type { Env } from '../functions/_shared/whatsapp.ts';
import { handleWhatsAppWebhook } from '../functions/whatsapp-webhook/handler.ts';
import { applySchema, startCluster, stopCluster, supabaseDir } from '../tests/pg.ts';
import { TEMPLATE_BODY } from '../whatsapp-template.ts';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1] || process.env.LOCAL_PORT || 54321) || 54321;
const withWeb = !args.includes('--no-web');
const appUrl = process.env.APP_URL ?? 'http://localhost:5173/';
const base = `http://localhost:${port}`;

// ------------------------------------------------------------------ keys

const jwtSecret = randomBytes(32).toString('hex');
const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');
function jwt(role: string, claims: Record<string, unknown> = {}, ttl = 30 * 86400): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ role, iss: 'marmoot-local', iat: now, exp: now + ttl, ...claims }));
  const sig = createHmac('sha256', jwtSecret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** The claims of a token this server signed, or null. */
function verifyJwt(token: string): Record<string, any> | null {
  const [head, body, sig] = token.split('.');
  if (!head || !body || !sig) return null;
  const want = createHmac('sha256', jwtSecret).update(`${head}.${body}`).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return claims.exp > Date.now() / 1000 ? claims : null;
}
const anonKey = jwt('anon');
const serviceKey = jwt('service_role');
const appSecret = randomBytes(16).toString('hex');

// ------------------------------------------------------------------ PostgREST

const PGRST_VERSION = 'v12.2.12';
async function postgrestBin(): Promise<string> {
  if (process.env.POSTGREST_BIN) return process.env.POSTGREST_BIN;
  const dir = join(supabaseDir, '.local', 'bin');
  const exe = join(dir, process.platform === 'win32' ? 'postgrest.exe' : 'postgrest');
  if (existsSync(exe)) return exe;
  const asset =
    process.platform === 'win32' ? 'windows-x86-64.zip'
    : process.platform === 'darwin' ? 'macos-aarch64.tar.xz'
    : process.arch === 'arm64' ? 'ubuntu-aarch64.tar.xz' : 'linux-static-x86-64.tar.xz';
  const url = `https://github.com/PostgREST/postgrest/releases/download/${PGRST_VERSION}/postgrest-${PGRST_VERSION}-${asset}`;
  console.log(`Downloading PostgREST ${PGRST_VERSION} (one time)…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download PostgREST from ${url} (${res.status}). Download it yourself and set POSTGREST_BIN.`);
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, asset);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  await run('tar', ['-xf', archive, '-C', dir]);
  if (process.platform !== 'win32') chmodSync(exe, 0o755);
  return exe;
}

function run(cmd: string, argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
    p.on('error', reject);
  });
}

// ------------------------------------------------------------------ pretend WhatsApp

interface FakeMessage {
  id: string;
  to: string;
  text: string;
  token: string;
  at: Date;
  status: 'sent' | 'delivered' | 'read' | 'failed';
}
const inbox: FakeMessage[] = [];
/** Numbers the pretend WhatsApp refuses, to see a failure: FAIL_NUMBERS=+15550000000,... */
const failNumbers = new Set((process.env.FAIL_NUMBERS ?? '').split(',').map((s) => s.trim().replace(/^\+/, '')).filter(Boolean));

async function webhook(id: string, status: 'delivered' | 'read'): Promise<void> {
  const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id, status }] } }] }] });
  const sig = 'sha256=' + createHmac('sha256', appSecret).update(body).digest('hex');
  await handleWhatsAppWebhook(new Request(`${base}/functions/v1/whatsapp-webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': sig } }), env);
  const m = inbox.find((x) => x.id === id);
  if (m) m.status = status;
}

function fakeSend(payload: any): { status: number; body: unknown } {
  const to = String(payload.to);
  if (failNumbers.has(to)) {
    return { status: 400, body: { error: { code: 131030, message: 'Recipient phone number not in allowed list' } } };
  }
  const [owner, title, total] = payload.template.components[0].parameters.map((p: { text: string }) => p.text);
  const token = payload.template.components[1].parameters[0].text;
  const id = `wamid.local.${inbox.length + 1}`;
  inbox.unshift({
    id, to: `+${to}`, token, at: new Date(), status: 'sent',
    text: TEMPLATE_BODY.replace('{{1}}', owner).replace('{{2}}', title).replace('{{3}}', total),
  });
  setTimeout(() => void webhook(id, 'delivered'), 1200);
  return { status: 200, body: { messaging_product: 'whatsapp', messages: [{ id }] } };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
function inboxPage(): string {
  const rows = inbox.length
    ? inbox.map((m) => `<li><p class="to">To ${esc(m.to)} · ${m.at.toLocaleTimeString()} · ${m.status}</p><p>${esc(m.text)}</p><a class="btn" href="/whatsapp/open/${encodeURIComponent(m.id)}">Open the bill</a></li>`).join('')
    : '<li class="empty">No messages yet. Create a bill sheet and tap Send.</li>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="4"><title>Pretend WhatsApp · Marmoot local</title>
<style>body{font:16px/1.45 system-ui,sans-serif;margin:0;background:#0b141a;color:#e9edef}main{max-width:32rem;margin:auto;padding:1rem}
h1{font-size:1.1rem}p.lead{color:#8696a0;font-size:.9rem}ul{list-style:none;padding:0;display:grid;gap:.75rem}
li{background:#202c33;border-radius:12px;padding:.75rem 1rem}li p{margin:.2rem 0}.to{color:#8696a0;font-size:.8rem}
.btn{display:block;text-align:center;margin-top:.5rem;padding:.6rem;border-top:1px solid #2a3942;color:#53bdeb;text-decoration:none;font-weight:600}.empty{color:#8696a0}</style></head>
<body><main><h1>Pretend WhatsApp</h1><p class="lead">Messages Marmoot's local server would have sent. Each person's button opens their own link. This page refreshes itself.</p><ul>${rows}</ul></main></body></html>`;
}

// ------------------------------------------------------------------ pretend Google sign-in
//
// The parts of Supabase Auth the app uses, so "Sign in with Google" works with no
// accounts anywhere: /authorize shows a page to pick who you are, then the app trades
// the code for a session exactly as it does with Supabase (PKCE).

interface LocalUser { id: string; email: string; name: string }
const PRESET_USERS = [
  { name: 'Chai', email: 'chai@example.com' },
  { name: 'Asha', email: 'asha@example.com' },
  { name: 'Ben', email: 'ben@example.com' },
];
const pendingSignIns = new Map<string, { redirectTo: string; challenge: string; method: string }>();
const authCodes = new Map<string, { user: LocalUser; challenge: string; method: string }>();
const refreshTokens = new Map<string, LocalUser>();
let authDb: pg.Pool | null = null;

/** The same id for the same email, every run. */
function userFor(email: string, name: string): LocalUser {
  const h = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return { id, email: email.trim().toLowerCase(), name: name.trim() || email.split('@')[0]! };
}

function authUser(u: LocalUser) {
  return {
    id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email,
    user_metadata: { full_name: u.name, name: u.name, email: u.email },
    app_metadata: { provider: 'google', providers: ['google'] },
    created_at: new Date(0).toISOString(), identities: [],
  };
}

function session(u: LocalUser) {
  const refresh = randomBytes(18).toString('base64url');
  refreshTokens.set(refresh, u);
  const expiresIn = 3600;
  return {
    access_token: jwt('authenticated', { aud: 'authenticated', sub: u.id, email: u.email, user_metadata: { full_name: u.name, name: u.name } }, expiresIn),
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    refresh_token: refresh,
    user: authUser(u),
  };
}

const authError = (status: number, code: string, msg: string) => Response.json({ error: code, error_description: msg, msg }, { status });

function pickAccountPage(state: string): string {
  const choose = (u: { name: string; email: string }) =>
    `<li><a class="acct" href="/auth/v1/pretend-google?state=${encodeURIComponent(state)}&name=${encodeURIComponent(u.name)}&email=${encodeURIComponent(u.email)}"><b>${esc(u.name)}</b><span>${esc(u.email)}</span></a></li>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pretend Google · Marmoot local</title>
<style>body{font:16px/1.45 system-ui,sans-serif;margin:0;background:#f1f3f4;color:#202124}main{max-width:26rem;margin:2rem auto;background:#fff;border-radius:16px;padding:1.5rem}
h1{font-size:1.3rem;margin:0 0 .25rem}p{color:#5f6368;margin:0 0 1rem}ul{list-style:none;padding:0;margin:0 0 1rem;border-top:1px solid #e8eaed}
.acct{display:flex;flex-direction:column;padding:.7rem .25rem;border-bottom:1px solid #e8eaed;color:inherit;text-decoration:none}.acct span{color:#5f6368;font-size:.9rem}
form{display:grid;gap:.5rem}input,button{font:inherit;padding:.6rem;border-radius:8px;border:1px solid #dadce0}button{background:#1a73e8;color:#fff;border:0}</style></head>
<body><main><h1>Choose an account</h1><p>Pretend Google, on your computer. Pick who you are for this browser.</p>
<ul>${PRESET_USERS.map(choose).join('')}</ul>
<form action="/auth/v1/pretend-google"><input type="hidden" name="state" value="${esc(state)}"><input name="name" placeholder="Name" required><input name="email" type="email" placeholder="Email" required><button>Use another account</button></form>
</main></body></html>`;
}

async function handleAuth(url: URL, req: http.IncomingMessage, raw: Buffer | undefined): Promise<Response> {
  const path = url.pathname.slice('/auth/v1'.length);
  if (path === '/authorize') {
    if (url.searchParams.get('provider') !== 'google') return authError(400, 'validation_failed', 'Only Google is set up here.');
    const redirectTo = url.searchParams.get('redirect_to') || appUrl;
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(redirectTo)) return authError(400, 'validation_failed', `redirect_to is not allowed: ${redirectTo}`);
    const state = randomBytes(12).toString('base64url');
    pendingSignIns.set(state, { redirectTo, challenge: url.searchParams.get('code_challenge') ?? '', method: (url.searchParams.get('code_challenge_method') ?? 's256').toLowerCase() });
    return new Response(pickAccountPage(state), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (path === '/pretend-google') {
    const p = pendingSignIns.get(url.searchParams.get('state') ?? '');
    const email = url.searchParams.get('email') ?? '';
    if (!p || !email.includes('@')) return authError(400, 'bad_oauth_state', 'Start signing in again from the app.');
    pendingSignIns.delete(url.searchParams.get('state')!);
    const user = userFor(email, url.searchParams.get('name') ?? '');
    await authDb!.query('insert into auth.users (id) values ($1) on conflict do nothing', [user.id]);
    const code = randomBytes(16).toString('base64url');
    authCodes.set(code, { user, challenge: p.challenge, method: p.method });
    const to = new URL(p.redirectTo);
    to.searchParams.set('code', code);
    return new Response(null, { status: 302, headers: { Location: to.toString() } });
  }
  if (path === '/token' && req.method === 'POST') {
    const body = JSON.parse(raw?.toString('utf8') || '{}');
    const grant = url.searchParams.get('grant_type');
    if (grant === 'pkce') {
      const c = authCodes.get(body.auth_code);
      if (!c) return authError(400, 'flow_state_not_found', 'invalid flow state, no valid flow state found');
      authCodes.delete(body.auth_code);
      const expected = c.method === 'plain' ? body.code_verifier : createHash('sha256').update(String(body.code_verifier)).digest('base64url');
      if (expected !== c.challenge) return authError(400, 'bad_code_verifier', 'code challenge does not match previously saved code verifier');
      return Response.json(session(c.user));
    }
    if (grant === 'refresh_token') {
      const u = refreshTokens.get(body.refresh_token);
      if (!u) return authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
      refreshTokens.delete(body.refresh_token);
      return Response.json(session(u));
    }
    return authError(400, 'unsupported_grant_type', `grant_type ${grant} isn't supported here`);
  }
  const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const claims = verifyJwt(bearer);
  if (path === '/user' && req.method === 'GET') {
    if (!claims?.sub || claims.role !== 'authenticated') return authError(401, 'bad_jwt', 'invalid JWT');
    return Response.json(authUser({ id: claims.sub, email: claims.email, name: claims.user_metadata?.full_name ?? '' }));
  }
  if (path === '/logout') return new Response(null, { status: 204 });
  return authError(404, 'not_found', `${path} isn't part of the pretend sign-in`);
}

// ------------------------------------------------------------------ gateway

let restPort = 0;
const env: Env = {
  SUPABASE_URL: base,
  SUPABASE_SERVICE_ROLE_KEY: serviceKey,
  WA_TOKEN: 'local',
  WA_PHONE_NUMBER_ID: 'local',
  WA_APP_SECRET: appSecret,
  WA_VERIFY_TOKEN: 'local',
  WA_GRAPH_URL: `${base}/graph`,
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, prefer',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function send(res: http.ServerResponse, r: Response) {
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    if (!['content-length', 'transfer-encoding', 'connection'].includes(k)) headers[k.toLowerCase()] = v;
  });
  for (const [k, v] of Object.entries(corsHeaders)) headers[k.toLowerCase()] = v;
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', base);
    if (req.method === 'OPTIONS') {
      const asked = req.headers['access-control-request-headers'];
      res.writeHead(204, { ...corsHeaders, ...(asked ? { 'Access-Control-Allow-Headers': String(asked) } : {}) }).end();
      return;
    }
    const raw = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const body = raw ? new Uint8Array(raw) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const request = new Request(url, { method: req.method, headers, body });

    if (url.pathname.startsWith('/rest/v1/')) {
      const upstream = `http://localhost:${restPort}${url.pathname.slice('/rest/v1'.length)}${url.search}`;
      headers.delete('host');
      return await send(res, await fetch(upstream, { method: req.method, headers, body }));
    }
    if (url.pathname.startsWith('/auth/v1/')) return await send(res, await handleAuth(url, req, raw));
    if (url.pathname === '/functions/v1/send-bill-alerts') return await send(res, await handleSendBillAlerts(request, env));
    if (url.pathname === '/functions/v1/whatsapp-webhook') return await send(res, await handleWhatsAppWebhook(request, env));
    if (url.pathname.startsWith('/graph/') && url.pathname.endsWith('/messages')) {
      const r = fakeSend(JSON.parse(raw!.toString('utf8')));
      return await send(res, Response.json(r.body, { status: r.status }));
    }
    if (url.pathname === '/whatsapp') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(inboxPage());
      return;
    }
    if (url.pathname === '/whatsapp/messages') return await send(res, Response.json(inbox));
    const open = /^\/whatsapp\/open\/(.+)$/.exec(url.pathname);
    if (open) {
      const m = inbox.find((x) => x.id === decodeURIComponent(open[1]!));
      if (!m) return void res.writeHead(404).end('no such message');
      await webhook(m.id, 'read');
      res.writeHead(302, { Location: `${appUrl}?s=${encodeURIComponent(m.token)}` }).end();
      return;
    }
    res.writeHead(404, corsHeaders).end('not found');
  } catch (e) {
    console.error(e);
    res.writeHead(500, corsHeaders).end(String((e as Error).message));
  }
});

// ------------------------------------------------------------------ start

const children: ChildProcess[] = [];
async function shutdown() {
  for (const c of children) c.kill();
  server.close();
  await authDb?.end();
  await stopCluster();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

const dbUrl = await startCluster();
if (!dbUrl) {
  console.error('No PostgreSQL found. Install PostgreSQL 16 or newer (see docs/GETTING-STARTED.md), or set PG_BIN.');
  process.exit(1);
}
const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
await applySchema(db);
await db.query(`
  do $$ begin
    if not exists (select from pg_roles where rolname = 'authenticator') then
      create role authenticator login noinherit;
    end if;
  end $$;
  grant anon, authenticated, service_role to authenticator;`);
await db.end();
authDb = new pg.Pool({ connectionString: dbUrl, max: 2 });

restPort = 55000 + Math.floor(Math.random() * 5000);
const pgrst = spawn(await postgrestBin(), [], {
  stdio: ['ignore', 'ignore', 'pipe'],
  env: {
    ...process.env,
    PGRST_DB_URI: dbUrl.replace('postgres@', 'authenticator@'),
    PGRST_DB_SCHEMAS: 'public',
    PGRST_DB_ANON_ROLE: 'anon',
    PGRST_JWT_SECRET: jwtSecret,
    PGRST_SERVER_PORT: String(restPort),
    PGRST_SERVER_HOST: '127.0.0.1',
    PGRST_LOG_LEVEL: 'crit',
  },
});
children.push(pgrst);
// PostgREST logs every start-up step; show only what went wrong.
pgrst.stderr!.on('data', (b: Buffer) => {
  for (const line of b.toString().split('\n')) if (/error|fatal|failed/i.test(line)) console.error(`PostgREST: ${line}`);
});
for (let i = 0; ; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${restPort}/`);
    if (r.ok) break;
  } catch { /* starting */ }
  if (i > 100) throw new Error('PostgREST did not start');
  await new Promise((r) => setTimeout(r, 100));
}

await new Promise<void>((resolve) => server.listen(port, resolve));
console.log(`
Marmoot's local server is running.
  API:               ${base}
  Pretend WhatsApp:  ${base}/whatsapp
  Pretend Google:    "Sign in with Google" in the app lets you pick Chai, Asha, Ben or anyone
  Anon key:          ${anonKey}
`);

if (withWeb) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const web = spawn(npm, ['run', 'dev', '-w', '@marmoot/web'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, VITE_SUPABASE_URL: base, VITE_SUPABASE_ANON_KEY: anonKey },
  });
  children.push(web);
  console.log(`Open the app at ${appUrl}. Stop everything with Ctrl+C.\n`);
} else {
  console.log(`Start the app with VITE_SUPABASE_URL=${base} and VITE_SUPABASE_ANON_KEY set to the anon key above.\n`);
}
