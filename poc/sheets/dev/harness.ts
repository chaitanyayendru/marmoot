/**
 * Runs the Apps Script POC on your computer, with stand-ins for Google's services, a
 * pretend Gemini and a pretend Splitwise. For testing the pages and the sheet logic
 * without deploying anything:
 *
 *   node --experimental-strip-types poc/sheets/dev/harness.ts     -> http://localhost:8790
 *
 * The owner page is at /exec?owner=dev. Bills live in memory; /sheets/<id>.json dumps one.
 * The stand-ins follow the real Apps Script signatures closely enough to catch wrong
 * row/column arithmetic (setValues refuses a mismatched size, as Google's does), but
 * they don't evaluate formulas: test-formulas.py checks those in LibreOffice.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { loadGs, pocDir } from '../test/load.ts';

type Cell = { v: unknown; f?: string; checkbox?: boolean };

class Range {
  readonly sheet: Sheet;
  readonly row: number;
  readonly col: number;
  readonly nr: number;
  readonly nc: number;
  constructor(sheet: Sheet, row: number, col: number, nr = 1, nc = 1) {
    if (!(row >= 1 && col >= 1 && nr >= 1 && nc >= 1)) throw new Error(`Range out of bounds: ${row},${col},${nr},${nc}`);
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.nr = nr;
    this.nc = nc;
  }
  private each(fn: (c: Cell, i: number, j: number) => void) {
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.sheet.cell(this.row + i, this.col + j), i, j);
  }
  private dims(v: unknown[][], what: string) {
    if (!Array.isArray(v) || v.length !== this.nr || v.some((r) => !Array.isArray(r) || r.length !== this.nc)) {
      throw new Error(`The number of rows or columns in the ${what} does not match the range (${this.nr}x${this.nc}).`);
    }
  }
  getValue() { return this.sheet.read(this.row, this.col); }
  getValues() { return Array.from({ length: this.nr }, (_, i) => Array.from({ length: this.nc }, (_, j) => this.sheet.read(this.row + i, this.col + j))); }
  setValue(v: unknown) { this.each((c) => { c.v = v; delete c.f; }); return this; }
  setValues(v: unknown[][]) { this.dims(v, 'data'); this.each((c, i, j) => { c.v = v[i]![j]; delete c.f; }); return this; }
  setFormula(f: string) { this.each((c) => { c.f = f; c.v = undefined; }); return this; }
  setFormulas(f: string[][]) { this.dims(f, 'formulas'); this.each((c, i, j) => { c.f = f[i]![j]; c.v = undefined; }); return this; }
  insertCheckboxes() { this.each((c) => { c.checkbox = true; c.v = false; delete c.f; }); return this; }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
  setFontSize() { return this; }
  setFontColor() { return this; }
  setBackground() { return this; }
}

class Sheet {
  cells = new Map<string, Cell>();
  hidden = false;
  frozen = { rows: 0, cols: 0 };
  protection: { description?: string; warningOnly?: boolean; unprotected?: Range[] } | null = null;
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  cell(r: number, c: number): Cell {
    const k = `${r},${c}`;
    if (!this.cells.has(k)) this.cells.set(k, { v: '' });
    return this.cells.get(k)!;
  }
  read(r: number, c: number) {
    const cell = this.cells.get(`${r},${c}`);
    if (!cell) return '';
    if (cell.f) return ''; // formulas aren't evaluated here
    return cell.v ?? '';
  }
  getRange(r: number, c: number, nr?: number, nc?: number) { return new Range(this, r, c, nr ?? 1, nc ?? 1); }
  setName(n: string) { this.name = n; return this; }
  getName() { return this.name; }
  setFrozenRows(n: number) { this.frozen.rows = n; return this; }
  setFrozenColumns(n: number) { this.frozen.cols = n; return this; }
  setColumnWidth() { return this; }
  setColumnWidths() { return this; }
  hideSheet() { this.hidden = true; return this; }
  protect() {
    const p = (this.protection = {} as NonNullable<Sheet['protection']>);
    const api = {
      setDescription: (d: string) => { p.description = d; return api; },
      setWarningOnly: (w: boolean) => { p.warningOnly = w; return api; },
      setUnprotectedRanges: (r: Range[]) => { p.unprotected = r; return api; },
    };
    return api;
  }
}

class Spreadsheet {
  id = randomUUID().replace(/-/g, '').slice(0, 24);
  sheets: Sheet[] = [new Sheet('Sheet1')];
  sharing: string | null = null;
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  getId() { return this.id; }
  getUrl() { return `https://docs.google.com/spreadsheets/d/${this.id}/edit`; }
  getSheets() { return this.sheets; }
  getSheetByName(n: string) { return this.sheets.find((s) => s.name === n) ?? null; }
  insertSheet(n: string) { const s = new Sheet(n); this.sheets.push(s); return s; }
  setActiveSheet(s: Sheet) { return s; }
}

export interface Harness {
  ctx: Record<string, any>;
  spreadsheets: Map<string, Spreadsheet>;
  splitwiseExpenses: Record<string, string>[];
  geminiCalls: unknown[];
  props: Map<string, string>;
  dump(id: string): unknown;
}

export const FAKE_RECEIPT = {
  merchant: 'COSTCO WHOLESALE',
  currency: 'USD',
  items: [
    { name: 'Tomatoes', price: 6.0 },
    { name: 'Onions', price: 3.0 },
    { name: 'Basmati rice 10 lb', price: 10.0 },
    { name: 'Olive oil', price: 14.99 },
    { name: 'Instant savings', price: -2.5 },
  ],
  tax: 1.9,
  tip: 0,
  total: 33.39,
};

export function makeHarness(baseUrl: string): Harness {
  const spreadsheets = new Map<string, Spreadsheet>();
  const props = new Map<string, string>([['OWNER_KEY', 'dev']]);
  const splitwiseExpenses: Record<string, string>[] = [];
  const geminiCalls: unknown[] = [];
  const response = (code: number, body: unknown) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });

  const splitwiseUsers = [
    { id: 11, first_name: 'Chai', last_name: 'Y' },
    { id: 22, first_name: 'Chandu', last_name: '' },
    { id: 33, first_name: 'Hima', last_name: 'K' },
  ];

  const globals = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => props.get(k) ?? null,
        setProperty: (k: string, v: string) => { props.set(k, String(v)); },
        deleteProperty: (k: string) => { props.delete(k); },
      }),
    },
    Utilities: { getUuid: () => randomUUID() },
    ScriptApp: { getService: () => ({ getUrl: () => `${baseUrl}/exec` }) },
    Logger: { log: (...a: unknown[]) => console.log('[Logger]', ...a) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    HtmlService: {
      createHtmlOutputFromFile: (name: string) => output(readFileSync(`${pocDir}${name}.html`, 'utf8')),
      createHtmlOutput: (html: string) => output(html),
    },
    SpreadsheetApp: {
      create: (name: string) => { const s = new Spreadsheet(name); spreadsheets.set(s.id, s); return s; },
      openById: (id: string) => { const s = spreadsheets.get(id); if (!s) throw new Error(`Unexpected error while getting the method or property openById on object SpreadsheetApp.`); return s; },
      flush: () => {},
    },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
      Permission: { EDIT: 'EDIT' },
      getFileById: (id: string) => ({ setSharing: (a: string, p: string) => { spreadsheets.get(id)!.sharing = `${a}/${p}`; } }),
    },
    UrlFetchApp: {
      fetch: (url: string, params: { method?: string; headers?: Record<string, string>; payload?: unknown }) => {
        if (url.startsWith('https://generativelanguage.googleapis.com/')) {
          if (params.headers?.['x-goog-api-key'] !== 'gemini-test-key') return response(400, { error: { message: 'API key not valid. Please pass a valid API key.' } });
          const body = JSON.parse(String(params.payload));
          geminiCalls.push(body);
          if (!body.contents?.[0]?.parts?.[1]?.inlineData?.data) return response(400, { error: { message: 'no image' } });
          return response(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(FAKE_RECEIPT) }] } }] });
        }
        if (url.startsWith('https://secure.splitwise.com/api/v3.0/')) {
          if (params.headers?.Authorization !== 'Bearer splitwise-test-key') return response(401, { error: 'Invalid API Request: you are not logged in' });
          const path = url.slice('https://secure.splitwise.com/api/v3.0/'.length);
          if (path === 'get_current_user') return response(200, { user: splitwiseUsers[0] });
          if (path === 'get_groups') {
            return response(200, { groups: [{ id: 0, name: 'Non-group expenses', members: [] }, { id: 999, name: 'Flat 4B', members: splitwiseUsers }] });
          }
          if (path === 'create_expense') {
            const form = params.payload as Record<string, string>;
            if (typeof form !== 'object') return response(400, { errors: { base: ['send a form'] } });
            const cost = Math.round(Number(form.cost) * 100);
            let paid = 0, owed = 0;
            for (let i = 0; form[`users__${i}__user_id`]; i++) {
              paid += Math.round(Number(form[`users__${i}__paid_share`]) * 100);
              owed += Math.round(Number(form[`users__${i}__owed_share`]) * 100);
            }
            if (paid !== cost || owed !== cost) return response(200, { expenses: [], errors: { base: ['The total of everyone\'s owed shares is different from the total cost.'] } });
            splitwiseExpenses.push(form);
            return response(200, { expenses: [{ id: 5000 + splitwiseExpenses.length, cost: form.cost }], errors: {} });
          }
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    },
  };

  function output(html: string) {
    const o = {
      html,
      title: '',
      setTitle(t: string) { o.title = t; return o; },
      addMetaTag() { return o; },
      setXFrameOptionsMode() { return o; },
      getContent() { return o.html; },
    };
    return o;
  }

  const ctx = loadGs(['Logic.gs', 'Code.gs'], globals);
  return {
    ctx, spreadsheets, splitwiseExpenses, geminiCalls, props,
    dump(id: string) {
      const s = spreadsheets.get(id)!;
      return {
        name: s.name,
        sharing: s.sharing,
        sheets: s.sheets.map((sh) => ({
          name: sh.name, hidden: sh.hidden, frozen: sh.frozen,
          protection: sh.protection ? { description: sh.protection.description, warningOnly: sh.protection.warningOnly, unprotected: sh.protection.unprotected?.map((r) => [r.row, r.col, r.nr, r.nc]) } : null,
          cells: [...sh.cells.entries()].map(([k, c]) => { const [r, col] = k.split(',').map(Number); return { r, c: col, v: c.v, f: c.f, checkbox: !!c.checkbox }; }),
        })),
      };
    },
  };
}

// ---------------------------------------------------------------- browser bridge

const SHIM = `<script>
window.google = { script: {
  url: { getLocation: function (cb) { var p = {}; new URLSearchParams(location.search).forEach(function (v, k) { p[k] = v; }); setTimeout(function () { cb({ parameter: p, parameters: {}, hash: '' }); }, 0); } },
  run: (function () {
    function runner(ok, fail) {
      return new Proxy({}, { get: function (_, name) {
        if (name === 'withSuccessHandler') return function (f) { return runner(f, fail); };
        if (name === 'withFailureHandler') return function (f) { return runner(ok, f); };
        return function () {
          var args = Array.prototype.slice.call(arguments);
          fetch('/run/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
            .then(function (r) { return r.json(); })
            .then(function (res) { if (res.ok) { if (ok) ok(res.value); } else if (fail) fail(new Error(res.error)); }, function (e) { if (fail) fail(e); });
        };
      } });
    }
    return runner(null, null);
  })()
} };
</script>`;

export function serve(port: number) {
  const base = `http://localhost:${port}`;
  const h = makeHarness(base);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', base);
    if (req.method === 'GET' && url.pathname === '/exec') {
      const parameter: Record<string, string> = {};
      url.searchParams.forEach((v, k) => { parameter[k] = v; });
      const out = h.ctx.doGet({ parameter });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SHIM + out.getContent().replace('<base target="_top">', ''));
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/run/')) {
      const fn = url.pathname.slice(5);
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let out: unknown;
        try {
          if (typeof h.ctx[fn] !== 'function' || fn.endsWith('_')) throw new Error(`Script function not found: ${fn}`);
          out = { ok: true, value: JSON.parse(JSON.stringify(h.ctx[fn](...JSON.parse(body || '[]')) ?? null)) };
        } catch (e) {
          out = { ok: false, error: (e as Error).message };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      });
      return;
    }
    const dump = /^\/sheets\/([^/]+)\.json$/.exec(url.pathname);
    if (dump && h.spreadsheets.has(dump[1]!)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(h.dump(dump[1]!)));
      return;
    }
    if (url.pathname === '/state.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sheets: [...h.spreadsheets.keys()], splitwise: h.splitwiseExpenses, gemini: h.geminiCalls.length }));
      return;
    }
    res.writeHead(404).end('not found');
  });
  server.listen(port, () => console.log(`Marmoot POC harness: ${base}/exec?owner=dev`));
  return { server, harness: h };
}

if (process.argv[1]?.endsWith('harness.ts')) serve(Number(process.env.PORT || 8790));
