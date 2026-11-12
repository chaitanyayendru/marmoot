/** Loads Apps Script .gs files into one shared global scope, as Apps Script does. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const pocDir = fileURLToPath(new URL('../', import.meta.url));

export function loadGs(files: string[], globals: Record<string, unknown> = {}): Record<string, any> {
  const ctx = vm.createContext({ console, ...globals });
  for (const f of files) vm.runInContext(readFileSync(pocDir + f, 'utf8'), ctx, { filename: f });
  return ctx as Record<string, any>;
}
