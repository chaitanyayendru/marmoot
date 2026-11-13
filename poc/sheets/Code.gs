/**
 * Marmoot POC on Google Sheets.
 *
 * A web app with two pages, served from this script:
 *   ?owner=<OWNER_KEY>                 your page: scan a receipt, pick who's in, create the
 *                                      sheet, share it to WhatsApp, add it to Splitwise
 *   ?b=<spreadsheet id>&t=<token>      a roommate's page: pick your name, untick what you
 *                                      didn't have, tap Done
 *
 * Each bill is its own Google Sheet in your Drive: items down the side, members across,
 * every box ticked to start, live totals underneath. Anyone with the sheet's link can
 * tick boxes in it too. The amounts sent to Splitwise are worked out in Logic.gs, to the
 * cent, from whatever is ticked when you tap "Add to Splitwise".
 *
 * Setup: poc/sheets/README.md. Run setup() once from the editor after deploying.
 */

// ---------------------------------------------------------------- layout of a bill sheet

var BILL_SHEET = 'Bill';
var META_SHEET = '_marmoot';
var ROW_TITLE = 1;
var ROW_NOTE = 2;
var ROW_HEADER = 3;
var ROW_DONE = 4;
var ROW_FIRST_ITEM = 5;
var COL_FIRST_MEMBER = 3; // A = item, B = price, C onward = members

function layout_(nItems, nMembers) {
  var lastItem = ROW_FIRST_ITEM + nItems - 1;
  var sub = lastItem + 2;
  return {
    lastItem: lastItem,
    subRow: sub,
    taxRow: sub + 1,
    tipRow: sub + 2,
    totalRow: sub + 3,
    lastMemberCol: COL_FIRST_MEMBER + nMembers - 1,
    inCol: COL_FIRST_MEMBER + nMembers,
    eachCol: COL_FIRST_MEMBER + nMembers + 1
  };
}

function colLetter_(n) {
  var s = '';
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ---------------------------------------------------------------- settings

function props_() {
  return PropertiesService.getScriptProperties();
}

function prop_(k) {
  return props_().getProperty(k) || '';
}

function assertOwner_(key) {
  var expected = prop_('OWNER_KEY');
  if (!expected || key !== expected) throw new Error('This page needs your owner link. Run setup() in the script editor to see it.');
}

function appUrl_() {
  if (prop_('APP_URL')) return prop_('APP_URL');
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (e) {
    return '';
  }
}

/** Run once from the Apps Script editor, after Deploy > New deployment > Web app. */
function setup() {
  var key = prop_('OWNER_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '');
    props_().setProperty('OWNER_KEY', key);
  }
  var url = appUrl_();
  if (!url) {
    Logger.log('Deploy the web app first (Deploy > New deployment > Web app), then run setup() again.');
    return;
  }
  Logger.log('Your Marmoot page (keep it private, bookmark it on your phone):\n' + url + '?owner=' + key);
}

// ---------------------------------------------------------------- web app

function doGet(e) {
  var p = (e && e.parameter) || {};
  var page;
  if (p.b && p.t) page = 'Guest';
  else if (p.owner && p.owner === prop_('OWNER_KEY')) page = 'Owner';
  else {
    return HtmlService.createHtmlOutput(
      '<p style="font:16px system-ui;padding:24px">Nothing to see here. If this is your Marmoot, open the link that <code>setup()</code> printed.</p>'
    ).setTitle('Marmoot');
  }
  return HtmlService.createHtmlOutputFromFile(page)
    .setTitle('Marmoot')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

// ---------------------------------------------------------------- owner: settings and Splitwise

function ownerBootstrap(key) {
  assertOwner_(key);
  var out = {
    ownerName: prop_('OWNER_NAME'),
    geminiReady: !!prop_('GEMINI_API_KEY'),
    splitwiseReady: !!prop_('SPLITWISE_API_KEY'),
    groupId: prop_('SPLITWISE_GROUP_ID'),
    appUrl: appUrl_(),
    defaultMembers: JSON.parse(prop_('DEFAULT_MEMBERS') || '[]'),
    groups: [],
    me: null,
    splitwiseError: null,
    bills: listBills_()
  };
  if (out.splitwiseReady) {
    try {
      var me = splitwise_('get', 'get_current_user').user;
      out.me = { splitwiseId: me.id, name: splitwiseName(me) };
      out.groups = (splitwise_('get', 'get_groups').groups || [])
        .filter(function (g) { return g.id !== 0; })
        .map(function (g) {
          return {
            id: g.id,
            name: g.name,
            members: (g.members || []).map(function (m) { return { splitwiseId: m.id, name: splitwiseName(m) }; })
          };
        });
      if (!out.ownerName) out.ownerName = (me.first_name || '').trim();
    } catch (err) {
      out.splitwiseError = err.message;
    }
  }
  return out;
}

/** Keys are only written when given, so a blank field keeps the saved one. */
function saveSettings(key, s) {
  assertOwner_(key);
  var p = props_();
  if (s.ownerName) p.setProperty('OWNER_NAME', String(s.ownerName).trim());
  if (s.geminiKey) p.setProperty('GEMINI_API_KEY', String(s.geminiKey).trim());
  if (s.splitwiseKey) p.setProperty('SPLITWISE_API_KEY', String(s.splitwiseKey).trim());
  if (s.appUrl) p.setProperty('APP_URL', String(s.appUrl).trim().replace(/\?.*$/, ''));
  if (s.defaultMembers) {
    var names = String(s.defaultMembers).split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
    p.setProperty('DEFAULT_MEMBERS', JSON.stringify(names));
  }
  return ownerBootstrap(key);
}

function splitwise_(method, path, form) {
  var apiKey = prop_('SPLITWISE_API_KEY');
  if (!apiKey) throw new Error('Add your Splitwise API key in Settings first.');
  var params = { method: method, headers: { Authorization: 'Bearer ' + apiKey }, muteHttpExceptions: true };
  if (form) params.payload = form; // an object is sent as a form, which is what Splitwise expects
  var res = UrlFetchApp.fetch('https://secure.splitwise.com/api/v3.0/' + path, params);
  var code = res.getResponseCode();
  var body = {};
  try { body = JSON.parse(res.getContentText() || '{}'); } catch (e) { /* not JSON */ }
  if (code === 401) throw new Error('Splitwise refused the API key. Check it in Settings.');
  if (code < 200 || code >= 300) throw new Error('Splitwise answered ' + code + (splitwiseErrors(body).length ? ': ' + splitwiseErrors(body).join('; ') : '.'));
  var errs = splitwiseErrors(body);
  if (errs.length) throw new Error('Splitwise: ' + errs.join('; '));
  return body;
}

// ---------------------------------------------------------------- owner: scan

/** base64 of a (downscaled) photo -> { merchant, items, tax, tip, total, warnings }. */
function scanReceipt(key, base64, mimeType) {
  assertOwner_(key);
  var apiKey = prop_('GEMINI_API_KEY');
  if (!apiKey) throw new Error('Add your Gemini API key in Settings to scan receipts, or type the items in.');
  var saved = prop_('GEMINI_MODEL');
  var queue = (saved ? [saved] : []).concat(GEMINI_MODELS.filter(function (m) { return m !== saved; }));
  var tried = {};
  var quota = false;
  var lastProblem = '';
  while (queue.length) {
    var model = queue.shift();
    if (tried[model]) continue;
    tried[model] = true;
    var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': apiKey },
      payload: JSON.stringify(geminiReceiptRequest(base64, mimeType)),
      muteHttpExceptions: true
    });
    var body = {};
    try { body = JSON.parse(res.getContentText() || '{}'); } catch (e) { /* not JSON */ }
    var code = res.getResponseCode();
    var message = (body.error && body.error.message) || 'answered ' + code;
    if (code === 200) {
      if (model !== saved) props_().setProperty('GEMINI_MODEL', model);
      return parseReceiptResponse(body);
    }
    if (code === 429) { quota = true; continue; }
    if (code === 404 || /no longer available|not found|is not supported/i.test(message)) {
      queue = suggestedModels(message, model).concat(queue);
      lastProblem = message;
      continue;
    }
    throw new Error('Gemini: ' + message);
  }
  if (quota) throw new Error('Gemini\'s free limit is used up for now. Try again in a minute, or tomorrow if it\'s the daily limit.');
  throw new Error('No Gemini model worked with this key. ' + lastProblem);
}

// ---------------------------------------------------------------- owner: create a bill sheet

/**
 * input: { title, currency, items: [{name, price}], tax, tip,
 *          members: [{name, splitwiseId?}], payerIndex, groupId?, groupName? }
 */
function createBill(key, input) {
  assertOwner_(key);
  var items = (input.items || []).filter(function (it) { return String(it.name || '').trim(); });
  if (!items.length) throw new Error('Add at least one item.');
  items.forEach(function (it) {
    if (!(it.price >= 0) || Math.round(it.price) !== it.price) throw new Error('Check the price of ' + it.name + '.');
  });
  var members = (input.members || []).filter(function (m) { return String(m.name || '').trim(); });
  if (!members.length) throw new Error('Pick who was on this bill.');
  var payerIndex = Number(input.payerIndex) || 0;
  if (payerIndex < 0 || payerIndex >= members.length) throw new Error('Pick who paid.');
  var tax = Math.max(0, Math.round(input.tax || 0));
  var tip = Math.max(0, Math.round(input.tip || 0));
  var title = String(input.title || 'Bill').trim().slice(0, 60) || 'Bill';
  var currency = input.currency || 'USD';
  var L = layout_(items.length, members.length);

  var ss = SpreadsheetApp.create('Marmoot: ' + title + ' (' + new Date().toISOString().slice(0, 10) + ')');
  var sh = ss.getSheets()[0];
  sh.setName(BILL_SHEET);
  var payer = members[payerIndex];

  sh.getRange(ROW_TITLE, 1).setValue(title + ', paid by ' + payer.name).setFontSize(14).setFontWeight('bold');
  sh.getRange(ROW_NOTE, 1).setValue('Untick anything you didn\'t have, then tick Done. Totals update by themselves. Tax and tip follow what you keep.')
    .setFontColor('#696e69');

  // Header and Done row.
  var header = ['Item', 'Price'].concat(members.map(function (m) { return m.name; })).concat(['People in', 'Each pays']);
  sh.getRange(ROW_HEADER, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  sh.getRange(ROW_DONE, 1).setValue('Done').setFontWeight('bold');
  var doneRange = sh.getRange(ROW_DONE, COL_FIRST_MEMBER, 1, members.length);
  doneRange.insertCheckboxes();
  doneRange.setValues([members.map(function () { return false; })]);

  // Items: name, price, a ticked box per member, how many are in, what each pays.
  var inL = colLetter_(L.inCol);
  var firstL = colLetter_(COL_FIRST_MEMBER);
  var lastL = colLetter_(L.lastMemberCol);
  sh.getRange(ROW_FIRST_ITEM, 1, items.length, 2).setValues(items.map(function (it) { return [it.name, it.price / 100]; }));
  var checks = sh.getRange(ROW_FIRST_ITEM, COL_FIRST_MEMBER, items.length, members.length);
  checks.insertCheckboxes();
  checks.setValues(items.map(function () { return members.map(function () { return true; }); }));
  sh.getRange(ROW_FIRST_ITEM, L.inCol, items.length, 2).setFormulas(items.map(function (it, i) {
    var r = ROW_FIRST_ITEM + i;
    return ['=COUNTIF(' + firstL + r + ':' + lastL + r + ',TRUE)', '=IF(' + inL + r + '=0,0,B' + r + '/' + inL + r + ')'];
  }));

  // Totals per member: items they're in for, then tax and tip in proportion.
  var eachL = colLetter_(L.eachCol);
  var r0 = ROW_FIRST_ITEM;
  var rN = L.lastItem;
  sh.getRange(L.subRow, 1, 4, 2).setValues([['Items', ''], ['Tax', tax / 100], ['Tip', tip / 100], ['Total', '']]);
  sh.getRange(L.subRow, 2).setFormula('=SUM(B' + r0 + ':B' + rN + ')');
  sh.getRange(L.totalRow, 2).setFormula('=B' + L.subRow + '+B' + L.taxRow + '+B' + L.tipRow);
  var formulas = [[], [], [], []];
  members.forEach(function (m, j) {
    var c = colLetter_(COL_FIRST_MEMBER + j);
    var isPayer = j === payerIndex;
    var sub = '=SUMIF(' + c + r0 + ':' + c + rN + ',TRUE,$' + eachL + '$' + r0 + ':$' + eachL + '$' + rN + ')' +
      (isPayer ? '+SUMIF($' + inL + '$' + r0 + ':$' + inL + '$' + rN + ',0,$B$' + r0 + ':$B$' + rN + ')' : '');
    var share = function (row) {
      return '=IF($B$' + L.subRow + '=0,' + (isPayer ? '$B$' + row : '0') + ',$B$' + row + '*' + c + '$' + L.subRow + '/$B$' + L.subRow + ')';
    };
    formulas[0].push(sub);
    formulas[1].push(share(L.taxRow));
    formulas[2].push(share(L.tipRow));
    formulas[3].push('=' + c + L.subRow + '+' + c + L.taxRow + '+' + c + L.tipRow);
  });
  sh.getRange(L.subRow, COL_FIRST_MEMBER, 4, members.length).setFormulas(formulas);
  sh.getRange(L.totalRow, 1, 1, L.lastMemberCol).setFontWeight('bold');

  // Looks.
  sh.getRange(ROW_FIRST_ITEM, 2, items.length, 1).setNumberFormat('$#,##0.00');
  sh.getRange(ROW_FIRST_ITEM, L.eachCol, items.length, 1).setNumberFormat('$#,##0.00');
  sh.getRange(L.subRow, 2, 4, L.lastMemberCol - 1).setNumberFormat('$#,##0.00');
  sh.getRange(ROW_HEADER, 1, 1, L.eachCol).setBackground('#f3f4f3');
  sh.getRange(ROW_DONE, 1, 1, L.eachCol).setBackground('#e7f8e7');
  sh.getRange(ROW_HEADER, L.inCol, items.length + 2, 2).setFontColor('#696e69');
  sh.setFrozenRows(ROW_HEADER);
  sh.setFrozenColumns(1);
  sh.setColumnWidth(1, 200);
  sh.setColumnWidths(COL_FIRST_MEMBER, members.length, 90);

  // People tick boxes; everything else warns before it changes.
  var protection = sh.protect().setDescription('Marmoot: tick boxes only');
  protection.setWarningOnly(true);
  protection.setUnprotectedRanges([checks, doneRange]);

  // What the app needs to read the sheet back.
  var token = Utilities.getUuid().replace(/-/g, '');
  var meta = {
    v: 1,
    token: token,
    title: title,
    currency: currency,
    payerIndex: payerIndex,
    nItems: items.length,
    members: members.map(function (m, j) { return { id: 'm' + j, name: String(m.name).trim(), splitwiseId: m.splitwiseId || null }; }),
    groupId: input.groupId || null,
    groupName: input.groupName || null,
    createdAt: new Date().toISOString(),
    splitwise: null
  };
  var metaSheet = ss.insertSheet(META_SHEET);
  metaSheet.getRange(1, 1).setValue(JSON.stringify(meta));
  metaSheet.getRange(2, 1).setValue('Marmoot keeps its notes for this bill here. Please leave this tab alone.');
  metaSheet.hideSheet();
  ss.setActiveSheet(sh);

  var shared = true;
  try {
    DriveApp.getFileById(ss.getId()).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.EDIT);
  } catch (e) {
    shared = false; // some Workspace accounts don't allow link sharing
  }

  rememberBill_({ id: ss.getId(), title: title, createdAt: meta.createdAt });
  if (input.groupId) props_().setProperty('SPLITWISE_GROUP_ID', String(input.groupId));
  var links = links_(ss.getId(), ss.getUrl(), token, payer.name, title, items, tax, tip);
  links.linkSharing = shared;
  return links;
}

function links_(id, sheetUrl, token, ownerName, title, items, tax, tip) {
  var total = items.reduce(function (s, it) { return s + it.price; }, 0) + tax + tip;
  var guestUrl = appUrl_() + '?b=' + encodeURIComponent(id) + '&t=' + encodeURIComponent(token);
  var message = groupMessage(ownerName, title, total, guestUrl, sheetUrl);
  return { sheetId: id, sheetUrl: sheetUrl, guestUrl: guestUrl, message: message, whatsappUrl: whatsappShareUrl(message) };
}

// ---------------------------------------------------------------- reading a bill back

function readBill_(sheetId) {
  var ss = SpreadsheetApp.openById(sheetId);
  var metaSheet = ss.getSheetByName(META_SHEET);
  var sh = ss.getSheetByName(BILL_SHEET);
  if (!metaSheet || !sh) throw new Error('That sheet isn\'t a Marmoot bill any more.');
  var meta = JSON.parse(metaSheet.getRange(1, 1).getValue());
  var n = meta.members.length;
  var L = layout_(meta.nItems, n);
  if (String(sh.getRange(L.subRow, 1).getValue()) !== 'Items' || String(sh.getRange(L.totalRow, 1).getValue()) !== 'Total') {
    throw new Error('Rows were added or removed in the sheet, so Marmoot can\'t read it. Undo that, or start a new bill.');
  }
  var grid = sh.getRange(ROW_FIRST_ITEM, 1, meta.nItems, 2 + n).getValues();
  var done = sh.getRange(ROW_DONE, COL_FIRST_MEMBER, 1, n).getValues()[0];
  var extras = sh.getRange(L.taxRow, 2, 2, 1).getValues();
  var items = grid.map(function (row) { return { name: String(row[0]), price: Math.max(0, Math.round(Number(row[1]) * 100) || 0) }; });
  var checks = grid.map(function (row) { return row.slice(2).map(function (v) { return v === true; }); });
  var bill = {
    title: meta.title,
    currency: meta.currency,
    items: items,
    members: meta.members,
    payerId: meta.members[meta.payerIndex].id,
    tax: Math.max(0, Math.round(Number(extras[0][0]) * 100) || 0),
    tip: Math.max(0, Math.round(Number(extras[1][0]) * 100) || 0)
  };
  return { ss: ss, sh: sh, meta: meta, bill: bill, checks: checks, done: done.map(function (v) { return v === true; }), layout: L };
}

/** What both pages show: the bill, who's in for what, who's done, everyone's total. */
function summary_(st, forOwner) {
  var shares = computeShares(st.bill, st.checks);
  var payer = st.meta.members[st.meta.payerIndex];
  var out = {
    sheetId: st.ss.getId(),
    title: st.meta.title,
    ownerName: payer.name,
    currency: st.meta.currency,
    total: shares.total,
    tax: st.bill.tax,
    tip: st.bill.tip,
    items: st.bill.items,
    checks: st.checks,
    cells: shares.cells,
    unclaimed: shares.unclaimed,
    members: st.meta.members.map(function (m, j) {
      var s = shares.members[m.id];
      return { name: m.name, done: st.done[j], isPayer: j === st.meta.payerIndex, items: s.items, extras: s.extras, total: s.total, inSplitwise: !!m.splitwiseId };
    }),
    splitwise: st.meta.splitwise,
    locked: !!st.meta.splitwise
  };
  if (forOwner) {
    var l = links_(out.sheetId, st.ss.getUrl(), st.meta.token, payer.name, st.meta.title, st.bill.items, st.bill.tax, st.bill.tip);
    out.sheetUrl = l.sheetUrl;
    out.guestUrl = l.guestUrl;
    out.whatsappUrl = l.whatsappUrl;
    out.groupId = st.meta.groupId;
    out.groupName = st.meta.groupName;
  }
  return out;
}

function billStatus(key, sheetId) {
  assertOwner_(key);
  return summary_(readBill_(sheetId), true);
}

// ---------------------------------------------------------------- owner: Splitwise

function addToSplitwise(key, sheetId) {
  assertOwner_(key);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var st = readBill_(sheetId);
    if (st.meta.splitwise) return summary_(st, true);
    if (!st.meta.groupId) throw new Error('This bill wasn\'t made from a Splitwise group, so there\'s nowhere to add it.');
    var shares = computeShares(st.bill, st.checks);
    var form = splitwiseExpenseForm(st.bill, shares, {
      groupId: st.meta.groupId,
      details: 'Itemized with Marmoot: ' + st.ss.getUrl(),
      date: new Date().toISOString()
    });
    var body = splitwise_('post', 'create_expense', form);
    var expense = body.expenses && body.expenses[0];
    if (!expense) throw new Error('Splitwise didn\'t confirm the expense. Check the group before trying again.');
    st.meta.splitwise = { expenseId: expense.id, at: new Date().toISOString() };
    st.ss.getSheetByName(META_SHEET).getRange(1, 1).setValue(JSON.stringify(st.meta));
    st.sh.getRange(ROW_NOTE, 1).setValue('Added to Splitwise (' + (st.meta.groupName || 'group') + ') on ' + st.meta.splitwise.at.slice(0, 10) + '. Changes here no longer update Splitwise.');
    return summary_(st, true);
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- your recent bills

function listBills_() {
  return JSON.parse(prop_('BILLS') || '[]');
}

function rememberBill_(b) {
  var bills = listBills_().filter(function (x) { return x.id !== b.id; });
  bills.unshift(b);
  props_().setProperty('BILLS', JSON.stringify(bills.slice(0, 25)));
}

function forgetBill(key, sheetId) {
  assertOwner_(key);
  props_().setProperty('BILLS', JSON.stringify(listBills_().filter(function (x) { return x.id !== sheetId; })));
  return listBills_();
}

// ---------------------------------------------------------------- roommates

function guestState_(sheetId, token) {
  var st;
  try {
    st = readBill_(sheetId);
  } catch (e) {
    throw new Error('This bill can\'t be opened. Ask for a new link.');
  }
  if (!token || token !== st.meta.token) throw new Error('This link isn\'t valid. Ask for a new one.');
  return st;
}

function guestView(sheetId, token) {
  return summary_(guestState_(sheetId, token), false);
}

function guestChange_(sheetId, token, member, apply) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var st = guestState_(sheetId, token);
    if (st.meta.splitwise) throw new Error('This bill is already in Splitwise, so it can\'t change here.');
    var j = Number(member);
    if (!(j >= 0 && j < st.meta.members.length)) throw new Error('Pick your name first.');
    apply(st, COL_FIRST_MEMBER + j);
    SpreadsheetApp.flush();
    return summary_(readBill_(sheetId), false);
  } finally {
    lock.releaseLock();
  }
}

function guestToggle(sheetId, token, member, item, value) {
  return guestChange_(sheetId, token, member, function (st, col) {
    var i = Number(item);
    if (!(i >= 0 && i < st.meta.nItems)) throw new Error('That item isn\'t on the bill.');
    st.sh.getRange(ROW_FIRST_ITEM + i, col).setValue(value === true);
  });
}

function guestSetAll(sheetId, token, member, value) {
  return guestChange_(sheetId, token, member, function (st, col) {
    var v = [];
    for (var i = 0; i < st.meta.nItems; i++) v.push([value === true]);
    st.sh.getRange(ROW_FIRST_ITEM, col, st.meta.nItems, 1).setValues(v);
  });
}

function guestDone(sheetId, token, member, value) {
  return guestChange_(sheetId, token, member, function (st, col) {
    st.sh.getRange(ROW_DONE, col).setValue(value === true);
  });
}
