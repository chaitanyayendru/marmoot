/**
 * Marmoot POC: the parts with no Google services in them, so they can be tested
 * outside Apps Script (poc/sheets/test). Amounts are whole cents throughout.
 */

// ---------------------------------------------------------------- money

/** "12.34", "$12.34", "12" -> cents; null when it isn't an amount. */
function parseMoney(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;
  var s = String(input == null ? '' : input).replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  var neg = s.charAt(0) === '-';
  var parts = s.replace('-', '').split('.');
  var cents = Number(parts[0]) * 100 + Number(((parts[1] || '') + '00').slice(0, 2));
  return neg ? -cents : cents;
}

/** 1234 -> "12.34" (what Splitwise expects). */
function centsToDecimal(c) {
  var neg = c < 0;
  var a = Math.abs(c);
  return (neg ? '-' : '') + Math.floor(a / 100) + '.' + ('0' + (a % 100)).slice(-2);
}

/** 1234 -> "$12.34". */
function usd(c) {
  var parts = centsToDecimal(Math.abs(c)).split('.');
  return (c < 0 ? '-$' : '$') + parts[0].replace(/\B(?=(\d{3})+$)/g, ',') + '.' + parts[1];
}

function byKey(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Split `total` cents in proportion to whole-number weights: floor shares first, then
 * one cent at a time to the largest remainders, ties to the key that sorts first.
 * The same rule as allocate() in @marmoot/core, so totals always add up exactly.
 * weights: array of [key, weight]. Returns an object key -> cents.
 */
function allocate(total, weights) {
  var out = {};
  weights.forEach(function (kw) { out[kw[0]] = 0; });
  if (total === 0) return out;
  var live = weights.filter(function (kw) { return kw[1] > 0; }).sort(function (x, y) { return byKey(x[0], y[0]); });
  if (!live.length) throw new Error('cannot split a non-zero amount with nobody in');
  var sign = total < 0 ? -1 : 1;
  var abs = Math.abs(total);
  var W = live.reduce(function (s, kw) { return s + kw[1]; }, 0);
  var given = 0;
  var rema = live.map(function (kw) {
    var num = abs * kw[1];
    var share = Math.floor(num / W);
    given += share;
    out[kw[0]] = share === 0 ? 0 : sign * share;
    return { key: kw[0], rem: num % W };
  });
  var left = abs - given;
  rema.sort(function (x, y) { return x.rem === y.rem ? byKey(x.key, y.key) : y.rem - x.rem; });
  for (var i = 0; i < rema.length && left > 0; i++, left--) out[rema[i].key] += sign;
  return out;
}

// ---------------------------------------------------------------- shares

/**
 * Who pays what for an itemized bill.
 *   bill.items:   [{ name, price }]           price in cents
 *   bill.members: [{ id, name }]
 *   bill.payerId: id of the member who paid
 *   bill.tax, bill.tip: cents
 *   checks:       checks[i][j] true when member j is in for item i
 * Each item splits evenly among the people in for it; an item nobody is in for falls
 * to the payer; tax and tip follow each person's items. Same rules as sheetShares()
 * in @marmoot/core.
 * Returns { members: { id: { items, extras, total } }, cells: [[cents|null]], unclaimed: [i], total }.
 */
function computeShares(bill, checks) {
  var ids = bill.members.map(function (m) { return m.id; });
  if (ids.indexOf(bill.payerId) < 0) throw new Error('the person who paid must be one of the members');
  var items = {};
  ids.forEach(function (id) { items[id] = 0; });
  var cells = [];
  var unclaimed = [];
  var subtotal = 0;
  bill.items.forEach(function (it, i) {
    if (!(it.price >= 0) || Math.round(it.price) !== it.price) throw new Error('price of ' + it.name + ' must be whole cents, 0 or more');
    subtotal += it.price;
    var inFor = ids.filter(function (id, j) { return !!(checks[i] && checks[i][j]); });
    if (!inFor.length) unclaimed.push(i);
    var split = allocate(it.price, (inFor.length ? inFor : [bill.payerId]).map(function (id) { return [id, 1]; }));
    cells.push(ids.map(function (id) { return inFor.indexOf(id) >= 0 ? split[id] : null; }));
    Object.keys(split).forEach(function (id) { items[id] += split[id]; });
  });
  var extrasTotal = (bill.tax || 0) + (bill.tip || 0);
  var extras;
  if (extrasTotal > 0 && subtotal === 0) {
    extras = {};
    ids.forEach(function (id) { extras[id] = id === bill.payerId ? extrasTotal : 0; });
  } else {
    extras = allocate(extrasTotal, ids.map(function (id) { return [id, items[id]]; }));
  }
  var members = {};
  ids.forEach(function (id) {
    members[id] = { items: items[id], extras: extras[id] || 0, total: items[id] + (extras[id] || 0) };
  });
  return { members: members, cells: cells, unclaimed: unclaimed, total: subtotal + extrasTotal };
}

// ---------------------------------------------------------------- receipts (Gemini)

var RECEIPT_PROMPT = [
  'This is a photo of a shopping or restaurant receipt.',
  'List every purchased line item with the price printed for that line, after any discount on that line.',
  'If a discount or coupon line follows an item, subtract it from that item instead of listing it.',
  'Use short readable names; expand obvious store abbreviations (ORG BNLS CHKN BRST -> Organic boneless chicken breast).',
  'Never list subtotal, tax, tip, service charge, total, payment, card, change, savings or loyalty lines as items.',
  'Report tax, tip (or service charge) and the receipt total separately; use 0 when there is none.',
  'All amounts are plain numbers in the receipt currency, like 3.49.'
].join(' ');

/** Models to try, best first; Google retires models for new keys, so scanReceipt also follows the replacement an error names. */
var GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];

/** Model ids an error message points to, like "please use models/gemini-3.8-flash". */
function suggestedModels(message, current) {
  var out = [];
  String(message || '').replace(/models\/([A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9])/g, function (_, m) {
    if (m !== current && out.indexOf(m) < 0) out.push(m);
    return _;
  });
  return out;
}

/** The generateContent request body for one receipt photo. Newer models reject sampling settings, so there are none. */
function geminiReceiptRequest(base64, mimeType) {
  return {
    contents: [{ parts: [{ text: RECEIPT_PROMPT }, { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64 } }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object',
        properties: {
          merchant: { type: 'string' },
          currency: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, quantity: { type: 'number' }, price: { type: 'number' } },
              required: ['name', 'price']
            }
          },
          subtotal: { type: 'number' },
          tax: { type: 'number' },
          tip: { type: 'number' },
          total: { type: 'number' }
        },
        required: ['items']
      }
    }
  };
}

/**
 * Gemini's answer -> { merchant, currency, items: [{name, price}], tax, tip, total, warnings }.
 * Any negative line left over is folded into the item above it, so every price is 0 or more.
 */
function parseReceiptResponse(response) {
  var text = response && response.candidates && response.candidates[0] && response.candidates[0].content &&
    response.candidates[0].content.parts && response.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('');
  if (!text) {
    var why = response && response.promptFeedback && response.promptFeedback.blockReason;
    throw new Error(why ? 'Gemini would not read this image (' + why + ').' : 'Gemini returned no answer. Try a sharper photo.');
  }
  var raw;
  try {
    raw = JSON.parse(text.replace(/^```(json)?\s*|\s*```$/g, ''));
  } catch (e) {
    throw new Error('Gemini did not return a list of items. Try again, or type the items in.');
  }
  var items = [];
  (raw.items || []).forEach(function (it) {
    var price = parseMoney(it.price);
    var name = String(it.name || '').trim();
    if (price === null || !name) return;
    var qty = Number(it.quantity);
    if (qty > 1 && Math.round(qty) === qty && name.indexOf(' x') < 0) name = name + ' x' + qty;
    if (price < 0 && items.length) {
      items[items.length - 1].price = Math.max(0, items[items.length - 1].price + price);
      return;
    }
    if (price >= 0) items.push({ name: name.slice(0, 80), price: price });
  });
  var cents = function (v) { var c = parseMoney(v == null ? 0 : v); return c === null || c < 0 ? 0 : c; };
  var out = {
    merchant: String(raw.merchant || '').trim().slice(0, 60),
    currency: /^[A-Z]{3}$/.test(String(raw.currency || '')) ? raw.currency : 'USD',
    items: items,
    tax: cents(raw.tax),
    tip: cents(raw.tip),
    total: cents(raw.total),
    warnings: []
  };
  var sum = items.reduce(function (s, it) { return s + it.price; }, 0) + out.tax + out.tip;
  if (out.total && sum !== out.total) {
    out.warnings.push('Items, tax and tip add up to ' + usd(sum) + ' but the receipt says ' + usd(out.total) + '. Check the items before sending.');
  }
  if (!items.length) out.warnings.push('No items found. Type them in, or try a flatter, brighter photo.');
  return out;
}

// ---------------------------------------------------------------- Splitwise

/**
 * The create_expense form for a finished bill: the payer paid the whole cost, and
 * everyone owes exactly their total. People who owe nothing are left out.
 * members carry splitwiseId; returns a flat object of form fields.
 */
function splitwiseExpenseForm(bill, shares, opts) {
  var fields = {
    cost: centsToDecimal(shares.total),
    description: String(bill.title || 'Bill').slice(0, 100),
    currency_code: bill.currency || 'USD',
    group_id: String(opts.groupId),
    details: opts.details || ''
  };
  if (opts.date) fields.date = opts.date;
  var i = 0;
  var missing = [];
  bill.members.forEach(function (m) {
    var owed = shares.members[m.id].total;
    var paid = m.id === bill.payerId ? shares.total : 0;
    if (!owed && !paid) return;
    if (!m.splitwiseId) { missing.push(m.name); return; }
    fields['users__' + i + '__user_id'] = String(m.splitwiseId);
    fields['users__' + i + '__paid_share'] = centsToDecimal(paid);
    fields['users__' + i + '__owed_share'] = centsToDecimal(owed);
    i++;
  });
  if (missing.length) throw new Error(missing.join(', ') + (missing.length === 1 ? ' is' : ' are') + ' not in the Splitwise group, so Splitwise can\'t record their share.');
  return fields;
}

/** Splitwise reports problems inside a 200 answer: { errors: { base: [...] } }. */
function splitwiseErrors(body) {
  var errs = body && body.errors;
  if (!errs) return [];
  if (Array.isArray(errs)) return errs.map(String);
  var out = [];
  Object.keys(errs).forEach(function (k) { [].concat(errs[k]).forEach(function (m) { out.push(k === 'base' ? String(m) : k + ' ' + m); }); });
  return out;
}

/** "Chai Yendru" from a Splitwise user. */
function splitwiseName(u) {
  return [u.first_name, u.last_name].filter(function (x) { return x; }).join(' ').trim() || u.email || ('User ' + u.id);
}

// ---------------------------------------------------------------- WhatsApp

/** The message for the group chat. */
function groupMessage(ownerName, title, totalCents, guestUrl, sheetUrl) {
  return ownerName + ' added a bill: ' + title + ', ' + usd(totalCents) + '.\n' +
    'Untick anything you didn\'t have, then tap Done:\n' + guestUrl +
    (sheetUrl ? '\n\nOr open the spreadsheet: ' + sheetUrl : '');
}

function whatsappShareUrl(text) {
  return 'https://wa.me/?text=' + encodeURIComponent(text);
}

/** Node test hook; Apps Script has no `module`. */
if (typeof module !== 'undefined') {
  module.exports = { parseMoney: parseMoney, centsToDecimal: centsToDecimal, usd: usd, allocate: allocate, computeShares: computeShares,
    geminiReceiptRequest: geminiReceiptRequest, suggestedModels: suggestedModels, GEMINI_MODELS: GEMINI_MODELS, parseReceiptResponse: parseReceiptResponse, splitwiseExpenseForm: splitwiseExpenseForm,
    splitwiseErrors: splitwiseErrors, splitwiseName: splitwiseName, groupMessage: groupMessage, whatsappShareUrl: whatsappShareUrl };
}
