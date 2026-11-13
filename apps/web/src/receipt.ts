/**
 * Reading a receipt photo with Gemini, straight from the phone. The key is the
 * owner's own free Gemini key, saved only on their device (Settings); Marmoot's
 * server never sees it or the photo. Same prompt and rules as the Sheets POC.
 */
import { usd } from './money.ts';

export interface ScannedReceipt {
  merchant: string;
  items: { name: string; price: number }[];
  tax: number;
  tip: number;
  /** What the receipt says the total is, to compare against; 0 when unknown. */
  total: number;
  warnings: string[];
}

export const RECEIPT_PROMPT = [
  'This is a photo of a shopping or restaurant receipt.',
  'List every purchased line item with the price printed for that line, after any discount on that line.',
  'If a discount or coupon line follows an item, subtract it from that item instead of listing it.',
  'Use short readable names; expand obvious store abbreviations (ORG BNLS CHKN BRST -> Organic boneless chicken breast).',
  'Never list subtotal, tax, tip, service charge, total, payment, card, change, savings or loyalty lines as items.',
  'Report tax, tip (or service charge) and the receipt total separately; use 0 when there is none.',
  'All amounts are plain numbers in the receipt currency, like 3.49.',
].join(' ');

/**
 * Models to try, best first. Google retires models for new keys without notice
 * ("no longer available to new users"), so the app also follows the replacement the
 * error names, and remembers whichever model last worked on this phone. Flash-Lite
 * comes second because its free tier allows many more requests a day.
 */
export const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];
const MODEL_KEY = 'marmoot:gemini-model';

function rememberedModel(): string | null {
  try {
    return globalThis.localStorage?.getItem(MODEL_KEY) ?? null;
  } catch {
    return null;
  }
}

function rememberModel(model: string) {
  try {
    globalThis.localStorage?.setItem(MODEL_KEY, model);
  } catch {
    // Not saved; the next scan finds it again.
  }
}

/** The generateContent body. Newer models reject sampling settings, so there are none. */
export function receiptRequest(base64: string, mimeType: string, withSchema = true) {
  return {
    contents: [{ parts: [{ text: RECEIPT_PROMPT }, { inlineData: { mimeType, data: base64 } }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      ...(withSchema && {
        responseJsonSchema: {
          type: 'object',
          properties: {
            merchant: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, quantity: { type: 'number' }, price: { type: 'number' } },
                required: ['name', 'price'],
              },
            },
            tax: { type: 'number' },
            tip: { type: 'number' },
            total: { type: 'number' },
          },
          required: ['items'],
        },
      }),
    },
  };
}

/** Model ids an error message points to, like "please use models/gemini-3.8-flash". */
export function suggestedModels(message: string, current: string): string[] {
  const found = [...message.matchAll(/models\/([A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9])/g)].map((m) => m[1]!);
  return [...new Set(found)].filter((m) => m !== current);
}

/** A number or "3.49" -> cents, or null. */
function cents(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null;
  const s = String(v ?? '').replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** Gemini's answer -> items in cents. A leftover negative line is folded into the item above it. */
export function parseReceipt(response: unknown): ScannedReceipt {
  const r = response as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    promptFeedback?: { blockReason?: string };
  };
  const text = r?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
  if (!text) {
    const why = r?.promptFeedback?.blockReason;
    throw new Error(why ? `Gemini wouldn't read this image (${why}).` : 'Gemini returned nothing. Try a sharper photo.');
  }
  let raw: { merchant?: unknown; items?: { name?: unknown; quantity?: unknown; price?: unknown }[]; tax?: unknown; tip?: unknown; total?: unknown };
  try {
    raw = JSON.parse(text.replace(/^```(json)?\s*|\s*```$/g, ''));
  } catch {
    throw new Error("Gemini didn't return a list of items. Try again, or type them in.");
  }
  const items: { name: string; price: number }[] = [];
  for (const it of raw.items ?? []) {
    const price = cents(it.price);
    let name = String(it.name ?? '').trim();
    if (price === null || !name) continue;
    const qty = Number(it.quantity);
    if (qty > 1 && Number.isInteger(qty) && !/ x\d+$/.test(name)) name = `${name} x${qty}`;
    if (price < 0) {
      const last = items.at(-1);
      if (last) last.price = Math.max(0, last.price + price);
      continue;
    }
    items.push({ name: name.slice(0, 80), price });
  }
  const pos = (v: unknown) => Math.max(0, cents(v ?? 0) ?? 0);
  const out: ScannedReceipt = {
    merchant: String(raw.merchant ?? '').trim().slice(0, 60),
    items,
    tax: pos(raw.tax),
    tip: pos(raw.tip),
    total: pos(raw.total),
    warnings: [],
  };
  const sum = items.reduce((s, it) => s + it.price, 0) + out.tax + out.tip;
  if (out.total && sum !== out.total) {
    out.warnings.push(`Items, tax and tip add up to ${usd(sum)}, but the receipt says ${usd(out.total)}. Check the items.`);
  }
  if (!items.length) out.warnings.push('No items found. Type them in, or try a flatter, brighter photo.');
  return out;
}

/** Shrink a photo to at most 1600 px on its long side, as JPEG base64 (no data: prefix). */
export function shrinkPhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s);
      c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85).split(',')[1]!);
    };
    img.onerror = () => reject(new Error("Couldn't open that photo. Try a JPEG or PNG."));
    img.src = url;
  });
}

/** Send the photo to Gemini with the owner's key and read the answer. */
export async function scanReceipt(file: File, apiKey: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<ScannedReceipt> {
  return readReceipt(await shrinkPhoto(file), apiKey, fetchImpl);
}

/**
 * Ask Gemini to read a receipt (JPEG, base64). Tries the model that worked last time,
 * then the list above, following any replacement Google names, and falls back to
 * Flash-Lite when the free daily limit of a model is used up.
 */
export async function readReceipt(
  base64: string,
  apiKey: string,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
  first: string | null = rememberedModel(),
): Promise<ScannedReceipt> {
  const queue = [...new Set([first, ...GEMINI_MODELS].filter((m): m is string => !!m))];
  const tried = new Set<string>();
  let withSchema = true;
  let quota: Error | null = null;
  let lastProblem = '';
  while (queue.length && tried.size < 6) {
    const model = queue.shift()!;
    const attempt = `${model}|${withSchema}`;
    if (tried.has(attempt)) continue;
    tried.add(attempt);
    let res: Response;
    try {
      res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(receiptRequest(base64, 'image/jpeg', withSchema)),
      });
    } catch {
      throw new Error("Couldn't reach Gemini. Check your connection.");
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string } };
    if (res.ok) {
      rememberModel(model);
      return parseReceipt(body);
    }
    const message = body.error?.message ?? `answered ${res.status}`;
    if (res.status === 429) {
      quota = new Error("Gemini's free limit is used up for now. Try again in a minute, or tomorrow if it's the daily limit.");
      continue;
    }
    if (res.status === 404 || /no longer available|not found|is not supported/i.test(message)) {
      queue.unshift(...suggestedModels(message, model));
      lastProblem = message;
      continue;
    }
    if (res.status === 400 && withSchema && /schema|unknown name|invalid json payload/i.test(message)) {
      withSchema = false;
      queue.unshift(model);
      continue;
    }
    if (/api key not valid|api_key_invalid|permission_denied/i.test(`${message} ${body.error?.status ?? ''}`)) {
      throw new Error("Gemini didn't accept this key. Check it in Settings, or make a new one at aistudio.google.com/apikey.");
    }
    throw new Error(`Gemini: ${message}`);
  }
  throw quota ?? new Error(`No Gemini model worked with this key. ${lastProblem}`.trim());
}
