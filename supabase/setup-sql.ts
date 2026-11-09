/**
 * Writes supabase/setup.sql: every migration in order, in one file you can paste into
 * the Supabase SQL Editor on a new project, no CLI needed. Run after changing a
 * migration: npm run setup-sql (a database test fails if you forget).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('./', import.meta.url));

export function setupSql(): string {
  const files = readdirSync(join(dir, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  const parts = files.map((f) => `-- ================================================================ ${f}\n\n${readFileSync(join(dir, 'migrations', f), 'utf8').trim()}\n`);
  return `-- Marmoot: the whole database schema, for a new Supabase project.
-- Paste all of this into Supabase > SQL Editor > New query, then Run. Run it once.
-- Generated from supabase/migrations by npm run setup-sql; edit the migrations, not this.

${parts.join('\n')}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(join(dir, 'setup.sql'), setupSql());
  console.log('Wrote supabase/setup.sql');
}
