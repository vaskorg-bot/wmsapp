// PDA Raktár: offline WMS for industrial Android PDAs.
// All data lives on the device (IndexedDB inside the app's WebView); no network is used.
(() => {
'use strict';

/* ---------- utils ---------- */
const $ = (s, r = document) => r.querySelector(s);
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Reversible, path-safe document id
const enc = s => { let r = String(s).replace(/[^A-Za-z0-9_\-.:@+]/g, c => '~' + c.charCodeAt(0).toString(16).padStart(4, '0')); if (r === '.' || r === '..' || r === '') r = r.replace(/\./g, '~002e') || '~0000'; return r; };
const round = n => Math.round((Number(n) || 0) * 1000) / 1000;
const num = v => { const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const fmt = n => round(n).toLocaleString('hu-HU', { maximumFractionDigits: 3 });
const nowIso = () => new Date().toISOString();
const pad = (n, w = 2) => String(n).padStart(w, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = () => ymd(new Date());
const tfmt = iso => { if (!iso) return ''; const d = new Date(iso); return ymd(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const hms = iso => { if (!iso) return ''; const d = new Date(iso); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
const clone = o => JSON.parse(JSON.stringify(o));
const cmpLoc = (a, b) => String(a).localeCompare(String(b), 'hu', { numeric: true });
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const rid = p => p + Math.random().toString(36).slice(2, 10);
const DEVICE_ID = (() => { let d = store.get('wms_device'); if (!d) { d = rid('pda'); store.set('wms_device', d); } return d; })();
const Native = window.Native && window.Native.isNative ? window.Native : null;
const FILE_DIR = 'PDA-Raktar';

/* ---------- local database (IndexedDB, in-memory mirror) ---------- */
const META = { fromCache: false, hasPendingWrites: false };
const LocalDB = (() => {
  const NAME = 'pda-raktar', STORE = 'docs';
  let idb = null;
  const cols = new Map();          // collection path -> Map(id -> value)
  const subs = new Set();
  let pending = new Set(), timer = null;
  const split = p => { const i = p.lastIndexOf('/'); return [p.slice(0, i), p.slice(i + 1)]; };
  const memGet = p => { const [c, id] = split(p); const m = cols.get(c); return m ? m.get(id) : undefined; };
  function touch(c) { pending.add(c); if (!timer) timer = setTimeout(flush, 0); }
  function flush() { const cs = pending; pending = new Set(); timer = null; subs.forEach(s => { if (cs.has(s.col)) s.fire(); }); }
  function memSet(p, v) { const [c, id] = split(p); let m = cols.get(c); if (!m) { m = new Map(); cols.set(c, m); } if (v === null) m.delete(id); else m.set(id, v); touch(c); }
  function open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(NAME, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('blocked'));
    });
  }
  // Durable write: resolves only after the IndexedDB transaction commits
  function write(ops, clearFirst) {
    return new Promise((res, rej) => {
      const tx = idb.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      if (clearFirst) st.clear();
      ops.forEach(([p, v]) => { if (v === null) st.delete(p); else st.put(v, p); });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error('abort'));
    });
  }
  async function init() {
    idb = await open();
    await new Promise((res, rej) => {
      const r = idb.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return res();
        const [col, id] = split(String(c.key));
        let m = cols.get(col); if (!m) { m = new Map(); cols.set(col, m); }
        m.set(id, c.value); c.continue();
      };
      r.onerror = () => rej(r.error);
    });
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
  }
  const snapOf = p => { const v = memGet(p); return { id: split(p)[1], exists: v !== undefined, data: () => (v === undefined ? undefined : clone(v)), metadata: META }; };
  function test(v, op, val) {
    switch (op) {
      case '==': return v === val; case '!=': return v !== val;
      case '<': return v < val; case '<=': return v <= val; case '>': return v > val; case '>=': return v >= val;
      case 'in': return val.includes(v); case 'not-in': return !val.includes(v);
      case 'array-contains': return Array.isArray(v) && v.includes(val);
    }
    return false;
  }
  function query(col, filters = [], order = null, lim = Infinity) {
    const run = () => {
      const m = cols.get(col);
      let rows = m ? [...m.keys()].sort().map(id => [id, m.get(id)]) : [];
      rows = rows.filter(([, v]) => filters.every(([f, op, val]) => test(v[f], op, val)));
      if (order) {
        const [f, d] = order;
        rows.sort((a, b) => { const x = a[1][f], y = b[1][f]; if (x === undefined) return 1; if (y === undefined) return -1; return (x < y ? -1 : x > y ? 1 : 0) * (d === 'desc' ? -1 : 1); });
      }
      const docs = rows.slice(0, lim).map(([id]) => snapOf(col + '/' + id));
      return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: META };
    };
    return {
      path: col,
      where: (f, op, v) => query(col, filters.concat([[f, op, v]]), order, lim),
      orderBy: (f, d = 'asc') => query(col, filters, [f, d], lim),
      limit: n => query(col, filters, order, n),
      get: async () => run(),
      onSnapshot(next) { const s = { col, fire: () => { try { next(run()); } catch (e) { console.error(e); } } }; subs.add(s); setTimeout(s.fire, 0); return () => subs.delete(s); },
      doc: id => docRef(col + '/' + (id || rid('d')))
    };
  }
  function docRef(p) {
    const [col, id] = split(p);
    return {
      id, path: p,
      get: async () => snapOf(p),
      set: async d => { const v = clone(d); await write([[p, v]]); memSet(p, v); },
      update: async d => { const cur = memGet(p); if (cur === undefined) throw { code: 'missing', message: 'A dokumentum nem létezik.' }; const v = Object.assign(clone(cur), clone(d)); await write([[p, v]]); memSet(p, v); },
      delete: async () => { await write([[p, null]]); memSet(p, null); },
      onSnapshot(next) { const s = { col, fire: () => { try { next(snapOf(p)); } catch (e) { console.error(e); } } }; subs.add(s); setTimeout(s.fire, 0); return () => subs.delete(s); },
      collection: sub => query(p + '/' + sub)
    };
  }
  async function batch(ops) { const norm = ops.map(([p, v]) => [p, v === null ? null : clone(v)]); await write(norm); norm.forEach(([p, v]) => memSet(p, v)); }
  async function replaceAll(docs) {
    const ops = Object.keys(docs).map(p => [p, docs[p]]);
    await write(ops, true);
    const old = [...cols.keys()];
    cols.clear();
    ops.forEach(([p, v]) => memSet(p, v));
    old.forEach(touch);
  }
  function dump() { const out = {}; cols.forEach((m, c) => m.forEach((v, id) => { out[c + '/' + id] = v; })); return out; }
  function count(col) { let n = 0; cols.forEach((m, c) => { if (!col || c === col) n += m.size; }); return n; }
  return { init, doc: docRef, collection: p => query(p), batch, replaceAll, dump, count };
})();

/* ---------- constants ---------- */
const DEFAULT_CFG = { receivingLoc: 'ATV-01', shipLoc: 'KIADO-01', carriers: ['GLS', 'DPD', 'Foxpost', 'MPL', 'Packeta'], allowNegative: false, blindCount: true, autoBackup: true, adminPin: '' };
const LOC_TYPES = { STORE: 'Tárhely', RCV: 'Átvételi zóna', SHIP: 'Kiadó zóna' };
const ORDER_ST = { NEW: ['Új', 'info'], PICKING: ['Kiszedés alatt', 'warn'], PICKED: ['Kiszedve', 'ok'], LOADED: ['Felrakva', 'ok'], SHIPPED: ['Átadva', ''] };
const LOG_TY = { RCV: 'Átvétel', PUT: 'Betárolás', MOVE: 'Áthelyezés', PICK: 'Kiszedés', SHORT: 'Hiány', COUNT: 'Leltár', SHIP: 'Kiadás' };
const P = {
  item: s => 'items/' + enc(s), loc: c => 'locations/' + enc(c), stock: (l, s) => 'stock/' + enc(l + '|' + s),
  order: n => 'orders/' + enc(n), ho: id => 'handovers/' + enc(id)
};

/* ---------- state ---------- */
const S = {
  db: null, dbState: 'connecting', got: {}, loaded: false,
  operator: store.get('wms_operator') || '', adminUnlocked: false,
  items: new Map(), codeIndex: new Map(), locs: new Map(), stock: new Map(),
  orders: new Map(), orderIndex: new Map(), handovers: new Map(), cfg: { ...DEFAULT_CFG },
  logPart: {}, lastFile: null,
  screen: 'home', st: {}, busy: false, dirty: false, kbd: false,
  sound: store.get('wms_sound') !== false
};
const opName = () => S.operator || 'Operátor';

/* ---------- derived ---------- */
const itemOf = sku => S.items.get(sku);
const itemName = sku => itemOf(sku)?.name || sku;
const unitOf = sku => itemOf(sku)?.unit || 'db';
const locType = code => S.locs.get(code)?.type || (code === S.cfg.receivingLoc ? 'RCV' : code === S.cfg.shipLoc ? 'SHIP' : 'STORE');
const stockList = () => [...S.stock.values()].filter(x => x.qty);
const qtyAt = (loc, sku) => S.stock.get(loc + '|' + sku)?.qty || 0;
const bySku = sku => stockList().filter(x => x.sku === sku).sort((a, b) => cmpLoc(a.loc, b.loc));
const byLoc = loc => stockList().filter(x => x.loc === loc).sort((a, b) => a.sku.localeCompare(b.sku));
const zoneStock = type => stockList().filter(x => locType(x.loc) === type);
const ordersBy = (...st) => [...S.orders.values()].filter(o => st.includes(o.status));
const openHoFor = carrier => [...S.handovers.values()].find(x => x.status === 'OPEN' && x.carrier === carrier);
const who = id => id || '';
const adminOk = () => !S.cfg.adminPin || S.adminUnlocked;
const demand = sku => { let d = 0; for (const o of ordersBy('NEW', 'PICKING')) for (const l of o.lines || []) if (l.sku === sku && !l.short) d += Math.max(0, l.qty - (l.picked || 0)); return round(d); };

function resolve(code) {
  const c = String(code).trim(); const u = c.toUpperCase();
  const tries = [c, u];
  if (/^\d{12}$/.test(c)) tries.push('0' + c);
  if (/^0\d{12}$/.test(c)) tries.push(c.slice(1));
  for (const t of tries) if (S.locs.has(t)) return { type: 'loc', code: t };
  for (const t of tries) { const sku = S.codeIndex.get(t); if (sku) return { type: 'item', sku }; }
  for (const t of tries) { const no = S.orderIndex.get(t); if (no) return { type: 'order', no }; }
  return { type: 'unknown', code: c };
}

/* ---------- feedback ---------- */
let AC = null, flashT = null;
function beep(kind) {
  if (S.sound) {
    try {
      AC = AC || new (window.AudioContext || window.webkitAudioContext)();
      const o = AC.createOscillator(), g = AC.createGain(), t = AC.currentTime;
      o.type = kind === 'err' ? 'square' : 'sine';
      o.frequency.setValueAtTime(kind === 'err' ? 230 : kind === 'warn' ? 640 : 1400, t);
      if (kind === 'err') o.frequency.setValueAtTime(160, t + 0.16);
      g.gain.setValueAtTime(0.07, t);
      o.connect(g); g.connect(AC.destination); o.start(t); o.stop(t + (kind === 'err' ? 0.34 : 0.09));
    } catch (e) {}
  }
  try { navigator.vibrate && navigator.vibrate(kind === 'err' ? [120, 60, 120] : kind === 'warn' ? 80 : 30); } catch (e) {}
}
function flash(kind, msg, extra = '') {
  const f = $('#flash');
  f.className = 'flash ' + kind;
  f.innerHTML = `<div class="wrap flash-in"><span>${h(msg)}</span>${extra}</div>`;
  f.hidden = false;
  if (kind !== 'info') beep(kind);
  clearTimeout(flashT);
  flashT = setTimeout(() => { f.hidden = true; }, kind === 'ok' || kind === 'info' ? (extra ? 7000 : 3500) : 9000);
}
function unknown(code) {
  const extra = adminOk() ? `<button class="btn sm" data-act="quickadd" data-code="${h(code)}">Felvétel cikként</button>` : '';
  flash('err', `Ismeretlen kód: ${code}`, extra);
}
function errMsg(e) {
  const c = e && e.code;
  if (c === 'neg' || c === 'busy' || c === 'missing' || c === 'closed' || c === 'dup' || c === 'user') return e.message;
  if (e && e.name === 'QuotaExceededError') return 'Megtelt az eszköz tárhelye. Készíts mentést, majd futtasd az archív takarítást.';
  return 'Mentési hiba az eszközön: ' + ((e && (e.message || e.name)) || 'ismeretlen hiba') + '. Próbáld újra.';
}

/* ---------- db helpers ---------- */
const dbCall = fn => fn();
// Per-key async mutex: keeps read-modify-write sequences atomic on this device
const lockChains = new Map();
async function withLock(key, fn) {
  const prev = lockChains.get(key) || Promise.resolve();
  let release;
  const mine = new Promise(r => { release = r; });
  const chain = prev.then(() => mine);
  lockChains.set(key, chain);
  await prev;
  try { return await fn(); }
  finally { release(); if (lockChains.get(key) === chain) lockChains.delete(key); }
}
const stockRef = (loc, sku) => S.db.doc(P.stock(loc, sku));
const orderRef = no => S.db.doc(P.order(no));
const hoRef = id => S.db.doc(P.ho(id));

// ops: [{loc, sku, delta} | {loc, sku, set}], optional force (allow negative)
async function changeStock(ops) {
  const groups = new Map();
  ops.forEach(o => { if (!groups.has(o.sku)) groups.set(o.sku, []); groups.get(o.sku).push(o); });
  const applied = [];
  for (const [sku, list] of groups) {
    await withLock('sku|' + sku, async () => {
      const locs = [...new Set(list.map(o => o.loc))];
      const cur = {};
      for (const loc of locs) { const s = await stockRef(loc, sku).get(); cur[loc] = s.exists ? round(s.data().qty) : 0; }
      const next = { ...cur };
      for (const o of list) {
        next[o.loc] = round(o.set !== undefined ? o.set : next[o.loc] + o.delta);
        if (next[o.loc] < 0 && !o.force && !S.cfg.allowNegative) throw { code: 'neg', message: `Nincs elég készlet: ${itemName(sku)} a ${o.loc} helyen (van: ${fmt(cur[o.loc])} ${unitOf(sku)}).` };
      }
      const writes = [];
      for (const loc of locs) {
        if (next[loc] === cur[loc]) continue;
        writes.push([P.stock(loc, sku), next[loc] === 0 ? null : { loc, sku, qty: next[loc], ts: nowIso(), by: opName() }]);
        applied.push({ loc, sku, from: cur[loc], to: next[loc] });
      }
      // one transaction: a move can never half-apply
      if (writes.length) await LocalDB.batch(writes);
      applied.forEach(a => { if (a.to === 0) S.stock.delete(a.loc + '|' + a.sku); else S.stock.set(a.loc + '|' + a.sku, { loc: a.loc, sku: a.sku, qty: a.to }); });
    });
  }
  return applied;
}
async function patchDoc(lockKey, ref, mutate, missingMsg) {
  return withLock(lockKey, async () => {
    const snap = await ref.get();
    if (!snap.exists) throw { code: 'missing', message: missingMsg };
    const o = clone(snap.data());
    mutate(o);
    await ref.set(o);
    return o;
  });
}
async function patchOrder(no, mutate) {
  const o = await patchDoc('ord|' + no, orderRef(no), mutate, 'A rendelés nem található: ' + no);
  if (['NEW', 'PICKING', 'PICKED', 'LOADED'].includes(o.status)) S.orders.set(no, o); else S.orders.delete(no);
  return o;
}
async function patchHandover(id, mutate) {
  const o = await patchDoc('ho|' + id, hoRef(id), mutate, 'Az átadás nem található.');
  S.handovers.set(id, o);
  return o;
}
// Movement journal: one document per day (split when large)
async function appendLog(entries) {
  if (!entries || !entries.length || !S.db) return;
  const date = today();
  const rows = entries.map(e => Object.assign({ t: nowIso(), u: opName(), d: DEVICE_ID }, e));
  try {
    await withLock('log', async () => {
      let n = S.logPart[date] || 1;
      for (let guard = 0; guard < 50; guard++) {
        const ref = S.db.doc('log/' + enc(`${date}_${n}`));
        const snap = await ref.get();
        const cur = snap.exists ? (snap.data().entries || []) : [];
        if (cur.length >= 1500) { n++; continue; }
        await ref.set({ date, part: n, entries: cur.concat(rows) });
        S.logPart[date] = n;
        return;
      }
    });
  } catch (e) {
    flash('warn', 'A könyvelés megtörtént, de a naplóbejegyzés nem mentődött.');
  }
}

/* ---------- files: CSV export, backup ---------- */
async function saveFile(name, data, opt = {}) {
  if (Native) {
    const dir = FILE_DIR + (opt.sub ? '/' + opt.sub : '');
    let res = null, where = '';
    try {
      try { await Native.Filesystem.requestPermissions(); } catch (e) {}
      res = await Native.Filesystem.writeFile({ path: dir + '/' + name, data, directory: Native.Directory.Documents, encoding: Native.Encoding.UTF8, recursive: true });
      where = 'Documents/' + dir + '/' + name;
    } catch (e) {
      try {
        res = await Native.Filesystem.writeFile({ path: dir + '/' + name, data, directory: Native.Directory.External, encoding: Native.Encoding.UTF8, recursive: true });
        where = 'Android/data/hu.pdaraktar.wms/files/' + dir + '/' + name;
      } catch (e2) {
        if (!opt.silent) flash('err', 'A fájl mentése nem sikerült: ' + ((e2 && e2.message) || 'ismeretlen hiba'));
        return null;
      }
    }
    S.lastFile = { uri: res.uri, name };
    if (!opt.silent) flash('ok', 'Mentve: ' + where, `<button class="btn sm" data-act="sharefile">Megosztás</button>`);
    return { where, uri: res.uri };
  }
  // browser (development) fallback
  try {
    const blob = new Blob([data], { type: name.endsWith('.json') ? 'application/json' : 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    if (!opt.silent) flash('ok', 'Letöltve: ' + name);
    return { where: name };
  } catch (e) { if (!opt.silent) flash('err', 'A fájl mentése nem sikerült.'); return null; }
}
async function shareLast() {
  if (!Native || !S.lastFile) return;
  try { await Native.Share.share({ title: S.lastFile.name, files: [S.lastFile.uri] }); }
  catch (e) { if (!/cancel/i.test((e && e.message) || '')) flash('err', 'A megosztás nem sikerült ezen az eszközön.'); }
}
function saveCsv(filename, rows) {
  const cell = v => { const s = String(v ?? ''); return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return saveFile(filename, '﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n'));
}
async function backupNow(silent, name) {
  const d = new Date();
  const fname = name || `pda-raktar-mentes-${ymd(d)}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  const data = JSON.stringify({ app: 'pda-raktar', format: 1, exportedAt: nowIso(), device: DEVICE_ID, docs: LocalDB.dump() });
  const r = await saveFile(fname, data, { silent, sub: 'Mentes' });
  if (r) store.set('wms_lastBackup', nowIso());
  return r;
}
async function pruneBackups() {
  if (!Native) return;
  try {
    const r = await Native.Filesystem.readdir({ path: FILE_DIR + '/Mentes', directory: Native.Directory.Documents });
    const names = (r.files || []).map(f => (typeof f === 'string' ? f : f.name)).filter(n => /^pda-raktar-mentes-[\d-]+\.json$/.test(n)).sort();
    for (const n of names.slice(0, Math.max(0, names.length - 14))) await Native.Filesystem.deleteFile({ path: FILE_DIR + '/Mentes/' + n, directory: Native.Directory.Documents });
  } catch (e) {}
}
let autoRunning = false;
async function maybeAutoBackup() {
  if (!S.loaded || autoRunning || S.cfg.autoBackup === false) return;
  if (store.get('wms_lastAuto') === today() || !LocalDB.count()) return;
  autoRunning = true;
  try { const r = await backupNow(true, `pda-raktar-mentes-${today()}.json`); if (r) { store.set('wms_lastAuto', today()); pruneBackups(); } }
  finally { autoRunning = false; }
}
function readFileText(file) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result || '')); fr.onerror = () => rej(fr.error); fr.readAsText(file, 'utf-8'); });
}
function parseRows(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const first = lines[0];
  const delim = ['\t', ';', ','].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  return lines.map(l => l.split(delim).map(c => c.trim().replace(/^"(.*)"$/, '$1').trim()));
}
const dropHeader = (rows, re) => (rows.length && re.test(rows[0][0] || '') ? rows.slice(1) : rows);

/* ---------- demo data ---------- */
function demoOps() {
  const ops = [];
  [['ATV-01', 'RCV'], ['KIADO-01', 'SHIP'], ['A-01-01', 'STORE'], ['A-01-02', 'STORE'], ['A-01-03', 'STORE'], ['A-01-04', 'STORE'], ['A-02-01', 'STORE'], ['A-02-02', 'STORE'], ['A-02-03', 'STORE'], ['A-02-04', 'STORE']]
    .forEach(([code, type]) => { if (!S.locs.has(code)) ops.push([P.loc(code), { code, type, demo: true }]); });
  const items = [['DEMO-001', 'DEMO Csavar M8x40, 100 db/doboz', '2000000000015', 'karton'], ['DEMO-002', 'DEMO Kábelkötegelő 200 mm', '2000000000022', 'db'], ['DEMO-003', 'DEMO Szigetelőszalag fekete 19 mm', '2000000000039', 'db'], ['DEMO-004', 'DEMO Munkavédelmi kesztyű L', '2000000000046', 'db'], ['DEMO-005', 'DEMO Csomagolószalag 48 mm', '2000000000053', 'db'], ['DEMO-006', 'DEMO Raklapfólia 23 µm', '2000000000060', 'db']];
  items.forEach(([sku, name, ean, unit]) => ops.push([P.item(sku), { sku, name, eans: [ean], unit, demo: true }]));
  [['A-01-01', 'DEMO-001', 40], ['A-01-02', 'DEMO-002', 120], ['A-01-03', 'DEMO-003', 60], ['A-02-01', 'DEMO-004', 24], ['A-02-02', 'DEMO-005', 36], ['A-02-03', 'DEMO-005', 12], ['ATV-01', 'DEMO-006', 10]]
    .forEach(([loc, sku, qty]) => ops.push([P.stock(loc, sku), { loc, sku, qty }]));
  const t = nowIso();
  [['DEMO-1001', 'GLS', 'DEMOTRK1001', 1, [['DEMO-001', 2], ['DEMO-003', 1]]], ['DEMO-1002', 'DPD', '', 2, [['DEMO-002', 5], ['DEMO-005', 40]]], ['DEMO-1003', 'GLS', '', 1, [['DEMO-004', 3]]]]
    .forEach(([orderNo, carrier, tracking, parcels, lines]) => ops.push([P.order(orderNo), { orderNo, carrier, customer: '', tracking, parcels, status: 'NEW', createdAt: t, lines: lines.map(([sku, qty]) => ({ sku, qty, picked: 0, short: false })), demo: true }]));
  return ops;
}

/* ---------- ui helpers ---------- */
const locTag = (code, cls = '') => code ? `<span class="loc ${cls}">${h(code)}</span>` : `<span class="loc ghost ${cls}">nincs hely</span>`;
const chip = (t, cls = '') => `<span class="chip ${cls}">${h(t)}</span>`;
const stChip = st => chip((ORDER_ST[st] || [st])[0], (ORDER_ST[st] || [, ''])[1]);
const itemBlock = sku => { const it = itemOf(sku); return `<div class="name">${h(it?.name || 'Ismeretlen cikk')}</div><div class="sku">${h(sku)}${it?.eans?.length ? ' · ' + h(it.eans[0]) : ''}</div>`; };
const fmtIn = v => String(round(v)).replace('.', ',');
const stepper = (key, val, label) => `<div class="stepper"><button class="btn" data-act="step" data-key="${h(key)}" data-d="-1" aria-label="Csökkentés">−</button><input class="in" id="q-${enc(key)}" data-qty="${h(key)}" inputmode="decimal" autocomplete="off" value="${h(fmtIn(val))}" aria-label="${h(label || 'Mennyiség')}"><button class="btn" data-act="step" data-key="${h(key)}" data-d="1" aria-label="Növelés">+</button></div>`;
const steps = (labels, cur) => `<div class="steps">${labels.map((l, i) => `<span class="${i === cur ? 'on' : i < cur ? 'ok' : ''}">${i + 1} ${h(l)}</span>`).join('')}</div>`;
const armBtn = (key, label, armedLabel, cls = '', disabled = false) => { const on = S.st.armed === key; return `<button class="btn ${cls} ${on ? 'armed' : ''}" data-act="arm" data-key="${h(key)}" ${disabled ? 'disabled' : ''}>${h(on ? armedLabel : label)}</button>`; };
const ro = () => false;
const loading = () => `<div class="empty"><b>Adatok betöltése</b>Az eszközön tárolt adatok olvasása.</div>`;

/* ---------- screens ---------- */
const SCREENS = {};

SCREENS.home = {
  title: 'Raktár',
  init: () => ({ op: S.operator, opEdit: !S.operator }),
  prompt: () => 'Szkennelj cikket, lokációt vagy rendelést',
  onScan(code) {
    const r = resolve(code);
    if (r.type === 'item') return go('stock', { kind: 'item', key: r.sku });
    if (r.type === 'loc') return go('stock', { kind: 'loc', key: r.code });
    if (r.type === 'order') {
      const o = S.orders.get(r.no);
      if (o && (o.status === 'NEW' || o.status === 'PICKING')) { go('pick'); return openOrder(r.no); }
      if (o && o.status === 'PICKED') { go('ship'); return shipScan(code); }
      return go('stock', { kind: 'order', key: r.no });
    }
    unknown(code);
  },
  render(st) {
    if (S.dbState === 'none') return `<div class="empty"><b>Az eszköz tárhelye nem érhető el</b>Indítsd újra az alkalmazást. Ha a hiba marad, ellenőrizd a szabad tárhelyet.</div>`;
    if (!S.loaded) return loading();
    const rcv = zoneStock('RCV'), ship = zoneStock('SHIP');
    const rcvQty = rcv.reduce((a, x) => a + x.qty, 0);
    const open = ordersBy('NEW', 'PICKING').length, picked = ordersBy('PICKED').length;
    const openHo = [...S.handovers.values()].filter(x => x.status === 'OPEN').length;
    const all = stockList(), skus = new Set(all.map(x => x.sku)).size, tot = all.reduce((a, x) => a + x.qty, 0);
    const tiles = [
      ['recv', 'Átvétel', `${fmt(rcvQty)} db a zónában`, ''],
      ['put', 'Betárolás', rcv.length ? `${rcv.length} tétel vár` : 'Nincs teendő', rcv.length ? 'hot' : ''],
      ['pick', 'Kiszedés', open ? `${open} nyitott rendelés` : 'Nincs nyitott', open ? 'hot' : ''],
      ['ship', 'Rakodás', `${picked} kész · ${openHo} nyitott átadás`, picked ? 'hot' : ''],
      ['count', 'Leltár', S.cfg.blindCount ? 'Vak leltár' : 'Rendszerkészlettel', ''],
      ['stock', 'Készlet', `${skus} cikk · ${fmt(tot)} db`, ''],
      ['move', 'Áthelyezés', 'Helyről helyre', ''],
      ['log', 'Napló', 'Mai mozgások', '']
    ];
    let html = '';
    if (st.opEdit) html += `<div class="card"><div class="field"><label for="f-op">Operátor neve</label><input class="in" id="f-op" data-bind="op" data-enter="setop" value="${h(st.op)}" placeholder="pl. Kovács Péter" autocomplete="off"></div><div class="hint">A napló ezzel a névvel rögzíti a mozgásokat.</div><button class="btn primary" data-act="setop">Mentés</button></div>`;
    if (!S.items.size && !S.locs.size) html += `<div class="empty"><b>Üres raktár</b>Vedd fel a lokációkat és cikkeket a Törzsadat menüben, importáld CSV-ből, vagy próbáld ki demo adatokkal.<div style="margin-top:12px"><button class="btn" data-act="demo">Demo adatok betöltése</button></div></div>`;
    else if (!S.items.size || !S.locs.size) html += `<div class="empty"><b>Hiányzó törzsadat</b>Vedd fel a ${!S.locs.size ? 'lokációkat' : 'cikkeket'} a Törzsadat menüben.</div>`;
    html += `<div class="tiles">${tiles.map(([s, t, sub, cls]) => `<button class="tile ${cls}" data-act="go" data-to="${s}"><b>${t}</b><small>${h(sub)}</small></button>`).join('')}`;
    html += `<button class="tile wide" data-act="go" data-to="admin"><b>Törzsadat</b><small>${S.items.size} cikk · ${S.locs.size} lokáció · mentés${S.cfg.adminPin ? ' · PIN' : ''}</small></button></div>`;
    if (ship.length) html += `<div class="note">Kiadó zónában: ${fmt(ship.reduce((a, x) => a + x.qty, 0))} egység, futárra vár.</div>`;
    const lb = store.get('wms_lastBackup');
    html += `<div class="foot"><span>Operátor: ${h(opName())}</span><button class="btn sm" data-act="opedit">Váltás</button></div>
      <div class="foot"><span>Utolsó mentés: ${lb ? h(tfmt(lb)) : 'még nem volt'}</span><button class="btn sm" data-act="sound">${S.sound ? 'Hang: be' : 'Hang: ki'}</button></div>`;
    return `<div class="stack">${html}</div>`;
  },
  acts: {
    opedit(el, st) { st.opEdit = true; st.op = S.operator; render(); const i = $('#f-op'); if (i) i.focus(); },
    setop(el, st) {
      const v = String(st.op || '').trim().slice(0, 40);
      if (!v) return flash('err', 'Add meg az operátor nevét.');
      S.operator = v; store.set('wms_operator', v); st.opEdit = false; flash('ok', 'Operátor: ' + v); render();
    },
    async demo() {
      if (S.busy) return;
      S.busy = true;
      try { await LocalDB.batch(demoOps()); flash('ok', 'Demo adatok betöltve. Próba: DEMO-1001 rendelés kiszedése.'); }
      catch (e) { flash('err', errMsg(e)); }
      finally { S.busy = false; render(); }
    }
  }
};

/* --- Receiving --- */
SCREENS.recv = {
  title: 'Átvétel',
  init() { const d = store.get('wms_recv') || {}; return { ref: d.ref || '', loc: d.loc || S.cfg.receivingLoc, lines: Array.isArray(d.lines) ? d.lines : [] }; },
  save(st) { store.set('wms_recv', { ref: st.ref, loc: st.loc, lines: st.lines }); },
  onBind(st) { this.save(st); },
  prompt: () => 'Szkenneld a beérkezett cikket',
  onScan(code, st) {
    const r = resolve(code);
    if (r.type === 'loc') {
      if (locType(r.code) === 'SHIP') return flash('err', `${r.code} kiadó zóna, oda nem lehet átvenni.`);
      st.loc = r.code; this.save(st); flash('ok', 'Célhely: ' + r.code); return render();
    }
    if (r.type === 'item') {
      let ln = st.lines.find(l => l.sku === r.sku);
      if (ln) ln.qty = round(ln.qty + 1); else { ln = { sku: r.sku, qty: 1 }; st.lines.unshift(ln); }
      this.save(st); flash('ok', `+1 · ${itemName(r.sku)} · összesen ${fmt(ln.qty)} ${unitOf(r.sku)}`); return render();
    }
    if (r.type === 'order') return flash('err', 'Ez rendelésszám. Átvételnél cikket szkennelj.');
    unknown(code);
  },
  getQty: (st, k) => st.lines.find(l => l.sku === k)?.qty || 0,
  setQty(st, k, v) { const ln = st.lines.find(l => l.sku === k); if (ln) { ln.qty = Math.max(0, round(v)); this.save(st); } },
  render(st) {
    if (!S.loaded) return loading();
    const tot = st.lines.reduce((a, l) => a + l.qty, 0);
    let html = `<div class="grid2"><div class="field"><label for="f-ref">Szállítólevél / PO</label><input class="in" id="f-ref" data-bind="ref" data-enter="scan" value="${h(st.ref)}" placeholder="pl. SZL-2026-0412" autocomplete="off"></div>
      <div class="field"><label>Célhely</label><div style="min-height:46px;display:flex;align-items:center">${locTag(st.loc)}</div></div></div>
      <div class="hint">Más célhelyhez szkenneld a lokáció címkéjét. Minden cikkszkennelés +1.</div>`;
    if (!st.lines.length) html += `<div class="empty"><b>Még nincs tétel</b>Szkenneld az első beérkezett cikket.</div>`;
    else html += `<div class="sec">${st.lines.length} tétel · ${fmt(tot)} egység</div><div class="list">${st.lines.map(l => `<div class="row two"><div class="main">${itemBlock(l.sku)}</div><div class="ctl">${stepper(l.sku, l.qty)}<button class="iconbtn" data-act="rm" data-key="${h(l.sku)}" aria-label="Sor törlése"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div></div>`).join('')}</div>`;
    return `<div class="stack">${html}</div>`;
  },
  actions(st) {
    const n = st.lines.filter(l => l.qty > 0).length;
    return `${armBtn('clear', 'Ürítés', 'Biztosan ürít?', '', !st.lines.length)}<button class="btn primary" data-act="post" ${!n || S.busy ? 'disabled' : ''}>${S.busy ? 'Könyvelés folyamatban' : `Könyvelés · ${n} tétel`}</button>`;
  },
  acts: {
    rm(el, st) { st.lines = st.lines.filter(l => l.sku !== el.dataset.key); SCREENS.recv.save(st); render(); },
    clear(p, st) { st.lines = []; st.ref = ''; SCREENS.recv.save(st); flash('info', 'Átvétel ürítve.'); render(); },
    async post(el, st) {
      if (S.busy || !st.lines.length) return;
      if (!st.loc) return flash('err', 'Nincs célhely. Szkennelj lokációt.');
      S.busy = true; render();
      const logs = []; let units = 0;
      try {
        for (const ln of st.lines.slice()) {
          if (ln.qty > 0) { await changeStock([{ loc: st.loc, sku: ln.sku, delta: ln.qty }]); logs.push({ ty: 'RCV', s: ln.sku, to: st.loc, q: ln.qty, r: st.ref || '' }); units += ln.qty; }
          st.lines = st.lines.filter(x => x !== ln); SCREENS.recv.save(st);
        }
        flash('ok', `Könyvelve: ${logs.length} tétel · ${fmt(units)} egység → ${st.loc}`);
        st.ref = ''; SCREENS.recv.save(st);
      } catch (e) { flash('err', errMsg(e)); }
      finally { await appendLog(logs); S.busy = false; render(); }
    }
  }
};

/* --- Putaway --- */
SCREENS.put = {
  title: 'Betárolás',
  init: () => ({ sku: null, from: null, qty: 0 }),
  prompt: st => (st.sku ? 'Szkenneld a célhely címkéjét' : 'Szkenneld a betárolandó cikket'),
  pickFrom(sku) { const c = zoneStock('RCV').filter(x => x.sku === sku).sort((a, b) => b.qty - a.qty); return c[0] || null; },
  select(st, sku, from) {
    const src = from ? { loc: from, qty: qtyAt(from, sku) } : this.pickFrom(sku);
    if (!src || src.qty <= 0) return flash('err', `${itemName(sku)} nincs az átvételi zónában.`);
    Object.assign(st, { sku, from: src.loc, qty: src.qty }); flash('ok', `${itemName(sku)} · ${fmt(src.qty)} ${unitOf(sku)} · ${src.loc}`); render();
  },
  onScan(code, st) {
    const r = resolve(code);
    if (r.type === 'item') return this.select(st, r.sku);
    if (r.type === 'loc') {
      if (!st.sku) return flash('err', 'Előbb a cikket szkenneld.');
      if (r.code === st.from) return flash('warn', 'Ez a forráshely. Szkenneld a célhelyet.');
      if (locType(r.code) !== 'STORE') return flash('err', `${r.code} nem tárhely (${LOC_TYPES[locType(r.code)]}).`);
      return this.post(st, r.code);
    }
    if (r.type === 'order') return flash('err', 'Ez rendelésszám. Cikket vagy lokációt szkennelj.');
    unknown(code);
  },
  async post(st, to) {
    if (S.busy) return;
    const q = round(st.qty), max = qtyAt(st.from, st.sku);
    if (q <= 0) return flash('err', 'A mennyiség legyen nagyobb nullánál.');
    if (q > max) return flash('err', `Legfeljebb ${fmt(max)} ${unitOf(st.sku)} tárolható be innen.`);
    S.busy = true; render();
    try {
      await changeStock([{ loc: st.from, sku: st.sku, delta: -q }, { loc: to, sku: st.sku, delta: q }]);
      await appendLog([{ ty: 'PUT', s: st.sku, f: st.from, to, q }]);
      flash('ok', `Betárolva: ${fmt(q)} ${unitOf(st.sku)} ${itemName(st.sku)} → ${to}`);
      Object.assign(st, { sku: null, from: null, qty: 0 });
    } catch (e) { flash('err', errMsg(e)); }
    finally { S.busy = false; render(); }
  },
  getQty: st => st.qty,
  setQty: (st, k, v) => { st.qty = Math.max(0, round(v)); },
  render(st) {
    if (!S.loaded) return loading();
    const rcv = zoneStock('RCV').sort((a, b) => cmpLoc(a.loc, b.loc) || a.sku.localeCompare(b.sku));
    let html = steps(['Cikk', 'Mennyiség', 'Célhely'], st.sku ? 2 : 0);
    if (st.sku) {
      const sug = bySku(st.sku).filter(x => locType(x.loc) === 'STORE').slice(0, 3);
      const used = new Set(stockList().map(x => x.loc));
      const free = [...S.locs.values()].filter(l => l.type === 'STORE' && !used.has(l.code)).map(l => l.code).sort(cmpLoc).slice(0, 3);
      html += `<div class="card focus"><div>${itemBlock(st.sku)}</div>
        <div class="split"><div class="field"><label>Mennyiség (${h(unitOf(st.sku))})</label>${stepper('put', st.qty)}</div><div class="field"><label>Forrás</label>${locTag(st.from)}</div></div>
        <div class="field"><label>Javasolt hely</label><div class="chips">${sug.length ? sug.map(x => locTag(x.loc) + `<span class="sku">${fmt(x.qty)}</span>`).join(' ') : '<span class="note">Nincs meglévő készlet</span>'}</div></div>
        ${free.length ? `<div class="field"><label>Üres tárhely</label><div class="chips">${free.map(c => locTag(c)).join(' ')}</div></div>` : ''}
        <div class="hint">A betárolás a célhely címkéjének szkennelésével zárul.</div></div>`;
    }
    html += `<div class="sec">Átvételi zónában · ${rcv.length} tétel</div>`;
    html += rcv.length ? `<div class="list">${rcv.map(x => `<button class="row ${st.sku === x.sku && st.from === x.loc ? 'done' : ''}" data-act="sel" data-sku="${h(x.sku)}" data-loc="${h(x.loc)}"><div class="main">${itemBlock(x.sku)}</div><div class="side"><span class="n">${fmt(x.qty)}</span>${locTag(x.loc)}</div></button>`).join('')}</div>`
      : `<div class="empty"><b>Nincs betárolandó tétel</b>Az átvételi zóna üres.</div>`;
    return `<div class="stack">${html}</div>`;
  },
  actions: st => (st.sku ? `<button class="btn grow" data-act="cancel">Mégse</button>` : ''),
  acts: {
    sel(el, st) { SCREENS.put.select(st, el.dataset.sku, el.dataset.loc); },
    cancel(el, st) { Object.assign(st, { sku: null, from: null, qty: 0 }); render(); }
  }
};

/* --- Move --- */
SCREENS.move = {
  title: 'Áthelyezés',
  init: () => ({ from: null, sku: null, qty: 0 }),
  prompt: st => (!st.from ? 'Szkenneld a forráshelyet' : !st.sku ? `Szkenneld a cikket (forrás: ${st.from})` : 'Szkenneld a célhelyet'),
  onScan(code, st) {
    const r = resolve(code);
    if (r.type === 'loc') {
      if (!st.sku) { st.from = r.code; flash('ok', 'Forrás: ' + r.code); return render(); }
      if (r.code === st.from) return flash('warn', 'Ez a forráshely. Szkenneld a célhelyet.');
      return this.post(st, r.code);
    }
    if (r.type === 'item') {
      if (!st.from) {
        const locs = bySku(r.sku);
        if (locs.length === 1) { Object.assign(st, { from: locs[0].loc, sku: r.sku, qty: locs[0].qty }); flash('ok', `Forrás: ${locs[0].loc} · ${fmt(locs[0].qty)} ${unitOf(r.sku)}`); return render(); }
        return flash('err', locs.length ? 'Több helyen van készlet. Előbb a forráshelyet szkenneld.' : `${itemName(r.sku)}: nincs készlet.`);
      }
      const q = qtyAt(st.from, r.sku);
      if (q <= 0) return flash('err', `${itemName(r.sku)} nincs a ${st.from} helyen.`);
      Object.assign(st, { sku: r.sku, qty: q }); flash('ok', `${itemName(r.sku)} · ${fmt(q)} ${unitOf(r.sku)}`); return render();
    }
    if (r.type === 'order') return flash('err', 'Ez rendelésszám. Cikket vagy lokációt szkennelj.');
    unknown(code);
  },
  async post(st, to) {
    if (S.busy) return;
    const q = round(st.qty), max = qtyAt(st.from, st.sku);
    if (q <= 0) return flash('err', 'A mennyiség legyen nagyobb nullánál.');
    if (q > max) return flash('err', `Legfeljebb ${fmt(max)} ${unitOf(st.sku)} mozgatható.`);
    S.busy = true; render();
    try {
      await changeStock([{ loc: st.from, sku: st.sku, delta: -q }, { loc: to, sku: st.sku, delta: q }]);
      await appendLog([{ ty: 'MOVE', s: st.sku, f: st.from, to, q }]);
      flash('ok', `Áthelyezve: ${fmt(q)} ${unitOf(st.sku)} · ${st.from} → ${to}`);
      Object.assign(st, { sku: null, qty: 0 });
    } catch (e) { flash('err', errMsg(e)); }
    finally { S.busy = false; render(); }
  },
  getQty: st => st.qty,
  setQty: (st, k, v) => { st.qty = Math.max(0, round(v)); },
  render(st) {
    if (!S.loaded) return loading();
    let html = steps(['Forrás', 'Cikk', 'Célhely'], !st.from ? 0 : !st.sku ? 1 : 2);
    if (!st.from) return `<div class="stack">${html}<div class="empty"><b>Válassz forráshelyet</b>Szkenneld a lokáció címkéjét, vagy egy cikket, ha csak egy helyen van készlete.</div></div>`;
    if (st.sku) html += `<div class="card focus"><div>${itemBlock(st.sku)}</div><div class="split"><div class="field"><label>Mennyiség (${h(unitOf(st.sku))})</label>${stepper('move', st.qty)}</div><div class="field"><label>Forrás</label>${locTag(st.from)}</div></div></div>`;
    const list = byLoc(st.from);
    html += `<div class="sec">${h(st.from)} tartalma</div>`;
    html += list.length ? `<div class="list">${list.map(x => `<button class="row" data-act="sel" data-sku="${h(x.sku)}"><div class="main">${itemBlock(x.sku)}</div><div class="side"><span class="n">${fmt(x.qty)}</span></div></button>`).join('')}</div>` : `<div class="empty"><b>Üres lokáció</b>Ezen a helyen nincs készlet.</div>`;
    return `<div class="stack">${html}</div>`;
  },
  actions: st => (st.from ? `<button class="btn grow" data-act="reset">Újrakezdés</button>` : ''),
  acts: {
    sel(el, st) { const q = qtyAt(st.from, el.dataset.sku); Object.assign(st, { sku: el.dataset.sku, qty: q }); render(); },
    reset(el, st) { Object.assign(st, { from: null, sku: null, qty: 0 }); render(); }
  }
};

/* --- Picking --- */
function computeTasks(o, st) {
  const tasks = [];
  (o.lines || []).forEach((ln, i) => {
    let rem = round(ln.qty - (ln.picked || 0));
    if (ln.short || rem <= 0) return;
    const lineRem = rem;
    const cands = stockList().filter(x => x.sku === ln.sku && x.qty > 0 && locType(x.loc) === 'STORE').sort((a, b) => cmpLoc(a.loc, b.loc));
    for (const c of cands) { if (rem <= 0) break; const q = Math.min(rem, c.qty); tasks.push({ i, sku: ln.sku, loc: c.loc, qty: round(q), lineRem }); rem = round(rem - q); }
    if (rem > 0) tasks.push({ i, sku: ln.sku, loc: null, qty: rem, lineRem });
  });
  tasks.forEach(t => { t.key = t.i + '|' + (t.loc || '-'); });
  tasks.sort((a, b) => (a.loc ? 0 : 1) - (b.loc ? 0 : 1) || cmpLoc(a.loc || '', b.loc || ''));
  const sk = st.skipped || [];
  return tasks.filter(t => !sk.includes(t.key)).concat(tasks.filter(t => sk.includes(t.key)));
}
function curTask(st) {
  const o = S.orders.get(st.no); if (!o) return null;
  const t = computeTasks(o, st)[0]; if (!t) return null;
  if (st.alt && st.alt.key === t.key) return Object.assign({}, t, { loc: st.alt.loc, qty: round(Math.min(t.lineRem, qtyAt(st.alt.loc, t.sku))) });
  return t;
}
async function openOrder(no) {
  const o = S.orders.get(no);
  if (!o) return flash('err', 'Nem található: ' + no);
  if (!['NEW', 'PICKING'].includes(o.status)) return flash('warn', `${no}: ${(ORDER_ST[o.status] || [o.status])[0]}`);
  if (S.screen !== 'pick') go('pick');
  Object.assign(S.st, { mode: 'order', no, step: 'loc', qtyNow: 0, alt: null, skipped: [], armed: null });
  if (o.status === 'PICKING' && o.picker && o.picker !== opName()) flash('warn', `${no}: ${who(o.picker)} kezdte el. Folytatod.`);
  else flash('ok', 'Rendelés megnyitva: ' + no);
  render();
  if (o.status === 'NEW' || o.picker !== opName()) {
    try { await patchOrder(no, x => { if (x.status === 'NEW') { x.status = 'PICKING'; x.pickStart = nowIso(); } x.picker = opName(); }); }
    catch (e) { flash('err', errMsg(e)); }
    render();
  }
}
async function confirmPick(st, t, q) {
  if (S.busy) return;
  q = round(q);
  if (q <= 0) return flash('err', 'A mennyiség legyen nagyobb nullánál.');
  S.busy = true; render();
  try {
    await changeStock([{ loc: t.loc, sku: t.sku, delta: -q }, { loc: S.cfg.shipLoc, sku: t.sku, delta: q }]);
    const o = await patchOrder(st.no, x => {
      const ln = x.lines[t.i]; ln.picked = round((ln.picked || 0) + q);
      if (x.status === 'NEW') x.status = 'PICKING';
      x.picker = opName();
      if (x.lines.every(l => l.short || round(l.picked || 0) >= l.qty)) { x.status = 'PICKED'; x.pickedAt = nowIso(); }
    });
    await appendLog([{ ty: 'PICK', s: t.sku, f: t.loc, to: S.cfg.shipLoc, q, o: st.no }]);
    Object.assign(st, { step: 'loc', qtyNow: 0, alt: null });
    flash('ok', o.status === 'PICKED' ? `Rendelés kiszedve: ${st.no}` : `Kiszedve: ${fmt(q)} ${unitOf(t.sku)} ${itemName(t.sku)}`);
  } catch (e) { flash('err', errMsg(e)); }
  finally { S.busy = false; render(); }
}
SCREENS.pick = {
  title: 'Kiszedés',
  init: () => ({ mode: 'list', no: null, step: 'loc', qtyNow: 0, alt: null, skipped: [] }),
  back(st) { if (st.mode === 'order') { st.mode = 'list'; st.no = null; render(); return true; } },
  prompt(st) {
    if (st.mode === 'list') return 'Szkenneld a rendelésszámot vagy válassz';
    const t = curTask(st);
    if (!t) return 'A rendelés kész. Szkenneld a következőt';
    if (!t.loc) return 'Nincs készlet a tárhelyeken';
    return st.step === 'loc' ? `Menj a ${t.loc} helyre, szkenneld a címkét` : `Szkenneld a cikket · ${fmt(st.qtyNow)} / ${fmt(t.qty)}`;
  },
  onScan(code, st) {
    const r = resolve(code);
    if (r.type === 'order') { if (r.no !== st.no) return openOrder(r.no); return flash('info', 'Ez a rendelés már nyitva van.'); }
    if (st.mode === 'list') return r.type === 'unknown' ? unknown(code) : flash('err', 'Rendelésszámot szkennelj.');
    const t = curTask(st);
    if (!t) return flash('warn', 'Ebben a rendelésben nincs több szedendő tétel.');
    if (st.step === 'loc' || r.type === 'loc') {
      if (r.type !== 'loc') return flash('err', 'Előbb a lokációt szkenneld' + (t.loc ? ': ' + t.loc : '.'));
      if (!t.loc) return flash('err', 'Ennek a tételnek nincs készlete. Rögzíts hiányt vagy hagyd ki.');
      if (r.code === t.loc) { if (st.step === 'loc') { st.step = 'item'; st.qtyNow = 0; flash('ok', 'Lokáció rendben: ' + r.code); render(); } return; }
      if (locType(r.code) === 'STORE' && qtyAt(r.code, t.sku) > 0) {
        st.alt = { loc: r.code, key: t.key }; st.step = 'item'; st.qtyNow = 0;
        flash('warn', `Alternatív hely: ${r.code} (${fmt(qtyAt(r.code, t.sku))} ${unitOf(t.sku)})`); return render();
      }
      return flash('err', `Rossz lokáció: ${r.code}. Várt: ${t.loc}`);
    }
    if (r.type !== 'item') return unknown(code);
    if (r.sku !== t.sku) return flash('err', `Rossz cikk: ${itemName(r.sku)}. Várt: ${itemName(t.sku)}`);
    st.qtyNow = round(st.qtyNow + 1);
    if (st.qtyNow >= t.qty) return confirmPick(st, t, t.qty);
    flash('ok', `+1 · ${fmt(st.qtyNow)} / ${fmt(t.qty)} ${unitOf(t.sku)}`); render();
  },
  getQty: st => st.qtyNow,
  setQty: (st, k, v) => { st.qtyNow = Math.max(0, round(v)); },
  render(st) {
    if (!S.loaded) return loading();
    if (st.mode === 'list') {
      const list = ordersBy('NEW', 'PICKING').sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || cmpLoc(a.orderNo, b.orderNo));
      if (!list.length) return `<div class="empty"><b>Nincs nyitott rendelés</b>Új rendelést a Törzsadat › Rendelések menüben lehet importálni.</div>`;
      return `<div class="stack"><div class="sec">${list.length} nyitott rendelés</div><div class="list">${list.map(o => {
        const tq = o.lines.reduce((a, l) => a + l.qty, 0), pq = o.lines.reduce((a, l) => a + (l.picked || 0), 0);
        return `<button class="row" data-act="open" data-no="${h(o.orderNo)}"><div class="main"><div class="name mono">${h(o.orderNo)}</div><div class="sku">${o.lines.length} tétel · ${fmt(tq)} egység${o.customer ? ' · ' + h(o.customer) : ''}</div>${pq ? `<div class="bar"><i style="width:${Math.min(100, pq / tq * 100)}%"></i></div>` : ''}</div><div class="side">${o.carrier ? chip(o.carrier, 'info') : ''}${stChip(o.status)}${o.picker ? `<span class="sku">${h(who(o.picker))}</span>` : ''}</div></button>`;
      }).join('')}</div></div>`;
    }
    const o = S.orders.get(st.no);
    if (!o) return `<div class="empty"><b>A rendelés lezárult</b>Már nincs a nyitott rendelések között.</div>`;
    const t = curTask(st);
    const tq = o.lines.reduce((a, l) => a + l.qty, 0), pq = o.lines.reduce((a, l) => a + (l.picked || 0), 0);
    let html = `<div class="split"><div><div class="name mono" style="font-size:20px">${h(o.orderNo)}</div><div class="sku">${o.customer ? h(o.customer) + ' · ' : ''}${fmt(pq)} / ${fmt(tq)} egység</div></div><div class="chips">${o.carrier ? chip(o.carrier, 'info') : ''}${stChip(o.status)}</div></div><div class="bar"><i style="width:${tq ? Math.min(100, pq / tq * 100) : 0}%"></i></div>`;
    if (t) {
      html += `<div class="card focus">${steps(['Lokáció', 'Cikk'], st.step === 'loc' ? 0 : 1)}
        <div class="split"><div>${locTag(t.loc, 'big')}</div><div class="qty-big">${fmt(t.qty)}<small>${h(unitOf(t.sku))}</small></div></div>
        <div>${itemBlock(t.sku)}</div>
        ${st.alt ? chip('Alternatív hely', 'warn') : ''}
        ${!t.loc ? `<div class="note">A tárhelyeken nincs elég készlet ebből a cikkből. Rögzíts hiányt, vagy hagyd ki és folytasd a többi tétellel.</div>` : ''}
        ${st.step === 'item' && t.loc ? `<div class="split"><div class="field"><label>Szedett mennyiség</label>${stepper('pick', st.qtyNow)}</div><button class="btn primary" data-act="confirm" ${S.busy ? 'disabled' : ''}>Megerősít</button></div>` : ''}
      </div>`;
      const nx = computeTasks(o, st).filter(x => x.key !== t.key).slice(0, 3);
      if (nx.length) html += `<div class="sec">Következő</div><div class="list">${nx.map(x => `<div class="row"><div class="main">${itemBlock(x.sku)}</div><div class="side"><span class="n">${fmt(x.qty)}</span>${locTag(x.loc)}</div></div>`).join('')}</div>`;
    } else {
      html += `<div class="card"><div class="qty-big">Kész</div><div class="note">A kiszedett áru a ${h(S.cfg.shipLoc)} kiadó zónába került${o.carrier ? `, ${h(o.carrier)} futárra vár` : ''}.</div></div>`;
    }
    html += `<div class="sec">Tételek</div><div class="list">${o.lines.map(l => {
      const done = l.short || (l.picked || 0) >= l.qty;
      return `<div class="row ${done ? 'done' : ''}"><div class="main">${itemBlock(l.sku)}</div><div class="side"><span class="n">${fmt(l.picked || 0)} / ${fmt(l.qty)}</span>${l.short ? chip('Hiány', 'err') : done ? chip('Kész', 'ok') : ''}</div></div>`;
    }).join('')}</div>`;
    return `<div class="stack">${html}</div>`;
  },
  actions(st) {
    if (st.mode === 'list') return '';
    const t = curTask(st);
    if (!t) return `<button class="btn primary" data-act="tolist">Következő rendelés</button>`;
    return `<button class="btn" data-act="tolist">Lista</button><button class="btn grow" data-act="skip">Kihagy</button>${armBtn('short', 'Hiány', 'Hiány rögzítése?', 'danger grow', S.busy)}`;
  },
  acts: {
    open(el) { openOrder(el.dataset.no); },
    tolist(el, st) { Object.assign(st, { mode: 'list', no: null }); render(); },
    skip(el, st) {
      const o = S.orders.get(st.no), t = curTask(st);
      if (!t || computeTasks(o, st).length < 2) return flash('warn', 'Nincs másik tétel, amire ugorhatnál.');
      st.skipped = (st.skipped || []).filter(k => k !== t.key).concat(t.key);
      Object.assign(st, { step: 'loc', qtyNow: 0, alt: null }); render();
    },
    confirm(el, st) { const t = curTask(st); if (t) confirmPick(st, t, Math.min(st.qtyNow, t.qty)); },
    async short(p, st) {
      const t = curTask(st); if (!t || S.busy) return;
      const got = st.step === 'item' && t.loc ? Math.min(st.qtyNow, t.qty) : 0;
      if (got > 0) await confirmPick(st, t, got);
      S.busy = true; render();
      try {
        const o = await patchOrder(st.no, x => {
          const ln = x.lines[t.i]; ln.short = true;
          if (x.lines.every(l => l.short || round(l.picked || 0) >= l.qty)) { x.status = 'PICKED'; x.pickedAt = nowIso(); }
        });
        const ln = o.lines[t.i];
        await appendLog([{ ty: 'SHORT', s: t.sku, q: round(ln.qty - (ln.picked || 0)), o: st.no, f: t.loc || '' }]);
        Object.assign(st, { step: 'loc', qtyNow: 0, alt: null });
        flash('warn', `Hiány rögzítve: ${itemName(t.sku)} · ${fmt(ln.qty - (ln.picked || 0))} ${unitOf(t.sku)}`);
      } catch (e) { flash('err', errMsg(e)); }
      finally { S.busy = false; render(); }
    }
  }
};

/* --- Cycle count --- */
SCREENS.count = {
  title: 'Leltár',
  init() { const d = store.get('wms_count'); return d && d.loc ? { step: d.step === 'review' ? 'review' : 'count', loc: d.loc, counts: d.counts || [] } : { step: 'loc', loc: null, counts: [] }; },
  save(st) { if (st.loc) store.set('wms_count', { step: st.step, loc: st.loc, counts: st.counts }); else store.del('wms_count'); },
  prompt: st => (st.step === 'loc' ? 'Szkenneld a leltározandó lokációt' : st.step === 'count' ? 'Szkenneld a cikkeket · minden szkennelés +1' : 'Ellenőrizd az eltéréseket'),
  onScan(code, st) {
    const r = resolve(code);
    if (r.type === 'loc') {
      if (st.step !== 'loc' && st.counts.length && r.code !== st.loc) return flash('err', `Folyamatban van a ${st.loc} leltára. Könyveld vagy dobd el előbb.`);
      Object.assign(st, { step: 'count', loc: r.code }); this.save(st); flash('ok', 'Leltár: ' + r.code); return render();
    }
    if (r.type === 'item') {
      if (!st.loc) return flash('err', 'Előbb a lokációt szkenneld.');
      let c = st.counts.find(x => x.sku === r.sku);
      if (c) c.qty = round(c.qty + 1); else { c = { sku: r.sku, qty: 1 }; st.counts.unshift(c); }
      st.step = 'count'; this.save(st); flash('ok', `+1 · ${itemName(r.sku)} · ${fmt(c.qty)}`); return render();
    }
    if (r.type === 'order') return flash('err', 'Ez rendelésszám. Leltárnál lokációt és cikket szkennelj.');
    unknown(code);
  },
  getQty: (st, k) => st.counts.find(x => x.sku === k)?.qty || 0,
  setQty(st, k, v) { const c = st.counts.find(x => x.sku === k); if (c) { c.qty = Math.max(0, round(v)); this.save(st); } },
  diffs(st) {
    const m = new Map();
    byLoc(st.loc).forEach(x => m.set(x.sku, { sku: x.sku, sys: x.qty, cnt: 0 }));
    st.counts.forEach(c => { const e = m.get(c.sku) || { sku: c.sku, sys: 0, cnt: 0 }; e.cnt = c.qty; m.set(c.sku, e); });
    return [...m.values()].map(e => Object.assign({}, e, { d: round(e.cnt - e.sys) })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d) || a.sku.localeCompare(b.sku));
  },
  render(st) {
    if (!S.loaded) return loading();
    const blind = S.cfg.blindCount;
    if (st.step === 'loc') return `<div class="stack">${steps(['Lokáció', 'Számolás', 'Ellenőrzés'], 0)}<div class="empty"><b>Lokáció leltár</b>Szkenneld a polc címkéjét, majd egyenként a rajta lévő cikkeket.${blind ? ' Vak leltár: a rendszerkészlet csak az ellenőrzésnél látszik.' : ''}</div></div>`;
    let html = steps(['Lokáció', 'Számolás', 'Ellenőrzés'], st.step === 'count' ? 1 : 2) + `<div>${locTag(st.loc, 'big')}</div>`;
    if (st.step === 'count') {
      html += st.counts.length ? `<div class="sec">Számolt tételek · ${st.counts.length}</div><div class="list">${st.counts.map(c => `<div class="row two"><div class="main">${itemBlock(c.sku)}${blind ? '' : `<div class="sku">Rendszer: ${fmt(qtyAt(st.loc, c.sku))}</div>`}</div><div class="ctl">${stepper(c.sku, c.qty)}</div></div>`).join('')}</div>` : `<div class="empty"><b>Még nincs számolt tétel</b>Szkenneld a polcon lévő cikkeket. Üres polcnál nyomd meg az Ellenőrzést.</div>`;
      if (!blind) {
        const rest = byLoc(st.loc).filter(x => !st.counts.some(c => c.sku === x.sku));
        if (rest.length) html += `<div class="sec">Rendszer szerint itt van, még nem számolt</div><div class="list">${rest.map(x => `<div class="row done"><div class="main">${itemBlock(x.sku)}</div><span class="n">${fmt(x.qty)}</span></div>`).join('')}</div>`;
      }
    } else {
      const d = this.diffs(st), bad = d.filter(x => x.d);
      html += `<div class="note">${bad.length ? `${bad.length} eltérés · többlet ${fmt(bad.filter(x => x.d > 0).reduce((a, x) => a + x.d, 0))} · hiány ${fmt(-bad.filter(x => x.d < 0).reduce((a, x) => a + x.d, 0))}` : 'Nincs eltérés. A könyvelés rögzíti az egyezést.'}</div>`;
      html += d.length ? `<div class="tscroll"><table class="tbl"><thead><tr><th>Cikk</th><th class="num">Rendszer</th><th class="num">Számolt</th><th class="num">Eltérés</th></tr></thead><tbody>${d.map(x => `<tr><td><div class="name">${h(itemName(x.sku))}</div><div class="sku">${h(x.sku)}</div></td><td class="num">${fmt(x.sys)}</td><td class="num">${fmt(x.cnt)}</td><td class="num ${x.d > 0 ? 'pos' : x.d < 0 ? 'neg' : ''}">${x.d > 0 ? '+' : ''}${fmt(x.d)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty"><b>Üres lokáció</b>A rendszer és a számolás szerint is üres.</div>`;
    }
    return `<div class="stack">${html}</div>`;
  },
  actions(st) {
    if (st.step === 'loc') return '';
    if (st.step === 'count') return `${armBtn('drop', 'Elvetés', 'Biztosan elveted?', '')}<button class="btn primary" data-act="review">Ellenőrzés</button>`;
    return `<button class="btn" data-act="recount">Vissza</button><button class="btn primary" data-act="post" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Könyvelés folyamatban' : 'Leltár könyvelése'}</button>`;
  },
  acts: {
    review(el, st) { st.step = 'review'; SCREENS.count.save(st); render(); },
    recount(el, st) { st.step = 'count'; SCREENS.count.save(st); render(); },
    drop(p, st) { Object.assign(st, { step: 'loc', loc: null, counts: [] }); SCREENS.count.save(st); flash('info', 'Leltár elvetve.'); render(); },
    async post(el, st) {
      if (S.busy) return;
      S.busy = true; render();
      const logs = [];
      try {
        const d = SCREENS.count.diffs(st).filter(x => x.d);
        for (const x of d) {
          const ap = await changeStock([{ loc: st.loc, sku: x.sku, set: x.cnt, force: true }]);
          ap.forEach(a => logs.push({ ty: 'COUNT', s: a.sku, f: a.loc, q: round(a.to - a.from), r: `rendszer ${fmt(a.from)} → számolt ${fmt(a.to)}` }));
        }
        if (!logs.length) logs.push({ ty: 'COUNT', s: '', f: st.loc, q: 0, r: 'egyezik' });
        flash('ok', `Leltár könyvelve: ${st.loc} · ${d.length} eltérés`);
        Object.assign(st, { step: 'loc', loc: null, counts: [] }); SCREENS.count.save(st);
      } catch (e) { flash('err', errMsg(e)); }
      finally { await appendLog(logs); S.busy = false; render(); }
    }
  }
};

/* --- Stock inquiry --- */
SCREENS.stock = {
  title: 'Készlet',
  init: () => ({ kind: null, key: null, q: '' }),
  back(st) { if (st.kind) { st.kind = null; st.key = null; render(); return true; } },
  prompt: () => 'Szkennelj cikket, lokációt vagy rendelést',
  onScan(code, st) {
    const r = resolve(code);
    if (r.type === 'item') Object.assign(st, { kind: 'item', key: r.sku });
    else if (r.type === 'loc') Object.assign(st, { kind: 'loc', key: r.code });
    else if (r.type === 'order') Object.assign(st, { kind: 'order', key: r.no });
    else return unknown(code);
    beep('ok'); render();
  },
  onBind(st, key) { if (key === 'q') { const el = $('#results'); if (el) el.innerHTML = this.results(st); } },
  results(st) {
    const q = st.q.trim().toLowerCase();
    if (q.length < 2) return '';
    const hits = [...S.items.values()].filter(it => it.sku.toLowerCase().includes(q) || (it.name || '').toLowerCase().includes(q) || (it.eans || []).some(e => e.includes(q))).slice(0, 30);
    const locs = [...S.locs.keys()].filter(c => c.toLowerCase().includes(q)).sort(cmpLoc).slice(0, 10);
    if (!hits.length && !locs.length) return `<div class="note">Nincs találat.</div>`;
    return `<div class="list">${locs.map(c => `<button class="row" data-act="show" data-kind="loc" data-key="${h(c)}"><div class="main">${locTag(c)}</div><span class="n">${fmt(byLoc(c).reduce((a, x) => a + x.qty, 0))}</span></button>`).join('')}${hits.map(it => `<button class="row" data-act="show" data-kind="item" data-key="${h(it.sku)}"><div class="main">${itemBlock(it.sku)}</div><span class="n">${fmt(bySku(it.sku).reduce((a, x) => a + x.qty, 0))}</span></button>`).join('')}</div>`;
  },
  render(st) {
    if (!S.loaded) return loading();
    if (st.kind === 'item') {
      const it = itemOf(st.key), rows = bySku(st.key);
      const tot = rows.reduce((a, x) => a + x.qty, 0), inStore = rows.filter(x => locType(x.loc) === 'STORE').reduce((a, x) => a + x.qty, 0), dem = demand(st.key);
      return `<div class="stack"><div>${itemBlock(st.key)}</div>${it?.eans?.length > 1 ? `<div class="sku">Vonalkódok: ${it.eans.map(h).join(', ')}</div>` : ''}
        <div class="kpis"><div class="kpi"><b>${fmt(tot)}</b><small>Összes (${h(unitOf(st.key))})</small></div><div class="kpi"><b>${fmt(dem)}</b><small>Foglalt rendelésre</small></div><div class="kpi"><b class="${inStore - dem < 0 ? 'neg' : ''}">${fmt(inStore - dem)}</b><small>Szabad a tárhelyeken</small></div></div>
        <div class="sec">Lokációk</div>${rows.length ? `<div class="list">${rows.map(x => `<button class="row" data-act="show" data-kind="loc" data-key="${h(x.loc)}"><div class="main">${locTag(x.loc)}<span class="sku">${h(LOC_TYPES[locType(x.loc)])}</span></div><span class="n ${x.qty < 0 ? 'neg' : ''}">${fmt(x.qty)}</span></button>`).join('')}</div>` : `<div class="empty"><b>Nincs készlet</b>Ebből a cikkből egyik lokáción sincs.</div>`}</div>`;
    }
    if (st.kind === 'loc') {
      const rows = byLoc(st.key), l = S.locs.get(st.key);
      return `<div class="stack"><div class="split"><div>${locTag(st.key, 'big')}</div>${chip(LOC_TYPES[locType(st.key)] || '', '')}</div>${!l ? `<div class="note">Ez a kód nincs a lokációtörzsben.</div>` : ''}
        <div class="sec">${rows.length} cikk · ${fmt(rows.reduce((a, x) => a + x.qty, 0))} egység</div>${rows.length ? `<div class="list">${rows.map(x => `<button class="row" data-act="show" data-kind="item" data-key="${h(x.sku)}"><div class="main">${itemBlock(x.sku)}</div><span class="n ${x.qty < 0 ? 'neg' : ''}">${fmt(x.qty)}</span></button>`).join('')}</div>` : `<div class="empty"><b>Üres lokáció</b>Ezen a helyen nincs készlet.</div>`}</div>`;
    }
    if (st.kind === 'order') {
      const o = S.orders.get(st.key);
      if (!o) return `<div class="empty"><b>${h(st.key)}</b>A rendelés már átadva vagy törölve.</div>`;
      const ho = o.handoverId ? S.handovers.get(o.handoverId) : null;
      return `<div class="stack"><div class="split"><div class="name mono" style="font-size:20px">${h(o.orderNo)}</div><div class="chips">${o.carrier ? chip(o.carrier, 'info') : ''}${stChip(o.status)}</div></div>
        <div class="sku">${o.customer ? h(o.customer) + ' · ' : ''}${o.tracking ? 'Követőszám: ' + h(o.tracking) : 'Nincs követőszám'}${ho ? ' · Átadás: ' + h(ho.id) : ''}</div>
        <div class="list">${o.lines.map(l => `<div class="row"><div class="main">${itemBlock(l.sku)}</div><div class="side"><span class="n">${fmt(l.picked || 0)} / ${fmt(l.qty)}</span>${l.short ? chip('Hiány', 'err') : ''}</div></div>`).join('')}</div></div>`;
    }
    const all = stockList(), skus = new Set(all.map(x => x.sku)).size, used = new Set(all.map(x => x.loc)).size;
    const zones = [...S.locs.values()].filter(l => l.type !== 'STORE').sort((a, b) => cmpLoc(a.code, b.code));
    return `<div class="stack"><div class="kpis"><div class="kpi"><b>${skus}</b><small>Cikk készleten</small></div><div class="kpi"><b>${fmt(all.reduce((a, x) => a + x.qty, 0))}</b><small>Összes egység</small></div><div class="kpi"><b>${used} / ${S.locs.size}</b><small>Foglalt lokáció</small></div></div>
      <div class="field"><label for="f-q">Keresés név, cikkszám vagy hely szerint</label><input class="in" id="f-q" data-bind="q" data-enter="scan" value="${h(st.q)}" placeholder="min. 2 karakter" autocomplete="off"></div>
      <div id="results">${this.results(st)}</div>
      ${zones.length ? `<div class="sec">Zónák</div><div class="list">${zones.map(z => `<button class="row" data-act="show" data-kind="loc" data-key="${h(z.code)}"><div class="main">${locTag(z.code)}<span class="sku">${h(LOC_TYPES[z.type])}</span></div><span class="n">${fmt(byLoc(z.code).reduce((a, x) => a + x.qty, 0))}</span></button>`).join('')}</div>` : ''}</div>`;
  },
  actions: st => (st.kind ? '' : `<button class="btn grow" data-act="export">Készlet export (CSV)</button>`),
  acts: {
    show(el, st) { Object.assign(st, { kind: el.dataset.kind, key: el.dataset.key }); render(); window.scrollTo(0, 0); },
    export() {
      const rows = [['lokacio', 'tipus', 'cikkszam', 'megnevezes', 'mennyiseg', 'me']].concat(stockList().sort((a, b) => cmpLoc(a.loc, b.loc) || a.sku.localeCompare(b.sku)).map(x => [x.loc, LOC_TYPES[locType(x.loc)], x.sku, itemName(x.sku), String(x.qty).replace('.', ','), unitOf(x.sku)]));
      saveCsv(`keszlet_${today()}.csv`, rows);
    }
  }
};

/* --- Courier handover / loading --- */
async function shipScan(code) {
  const st = S.st, r = resolve(code);
  if (r.type !== 'order') return r.type === 'unknown' ? unknown(code) : flash('err', 'Rendelés- vagy követőszámot szkennelj.');
  const o = S.orders.get(r.no);
  if (!o) return flash('err', 'Nem található: ' + code);
  if (o.status === 'LOADED') return flash('warn', `Már felrakva: ${o.orderNo}`);
  if (o.status !== 'PICKED') return flash('err', `${o.orderNo}: ${(ORDER_ST[o.status] || [o.status])[0]}. Csak kiszedett rendelés rakható fel.`);
  const ho = st.mode === 'ho' ? S.handovers.get(st.hoId) : (o.carrier ? openHoFor(o.carrier) : null);
  if (!ho) return flash('err', o.carrier ? `Nincs nyitott ${o.carrier} átadás. Indíts újat.` : 'A rendelésnek nincs futára. Nyiss meg egy átadást, és abban szkenneld.');
  if (ho.status !== 'OPEN') return flash('err', 'Ez az átadás már lezárult.');
  if (o.carrier && o.carrier !== ho.carrier) return flash('err', `Más futár: ${o.carrier}. Ez a ${ho.carrier} átadás.`);
  if (S.busy) return;
  S.busy = true; render();
  try {
    await patchHandover(ho.id, x => {
      if (x.status !== 'OPEN') throw { code: 'closed', message: 'Az átadás már lezárult.' };
      if (x.orders.some(y => y.no === o.orderNo)) throw { code: 'dup', message: `Már felrakva: ${o.orderNo}` };
      x.orders.push({ no: o.orderNo, tr: o.tracking || '', p: o.parcels || 1, c: o.customer || '', lines: o.lines.filter(l => (l.picked || 0) > 0).map(l => ({ sku: l.sku, q: l.picked })), t: nowIso(), by: opName(), out: false });
    });
    await patchOrder(o.orderNo, x => { x.status = 'LOADED'; x.handoverId = ho.id; x.loadedAt = nowIso(); });
    if (st.mode !== 'ho') Object.assign(st, { mode: 'ho', hoId: ho.id });
    const n = (S.handovers.get(ho.id) || { orders: [] }).orders.length;
    flash('ok', `Felrakva: ${o.orderNo} · ${ho.carrier} · ${n}. rendelés`);
  } catch (e) { flash(e && e.code === 'dup' ? 'warn' : 'err', errMsg(e)); }
  finally { S.busy = false; render(); }
}
SCREENS.ship = {
  title: 'Rakodás',
  init: () => ({ mode: 'list', hoId: null, carrier: null, plate: '', driver: '' }),
  back(st) { if (st.mode !== 'list') { Object.assign(st, { mode: 'list', hoId: null }); render(); return true; } },
  prompt(st) {
    if (st.mode === 'ho') { const ho = S.handovers.get(st.hoId); return ho && ho.status === 'OPEN' ? 'Szkenneld a csomagot vagy rendelésszámot' : null; }
    return 'Szkennelj rendelést: a futár nyitott átadásába kerül';
  },
  onScan(code) { shipScan(code); },
  render(st) {
    if (!S.loaded) return loading();
    const hos = [...S.handovers.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (st.mode === 'ho') {
      const ho = S.handovers.get(st.hoId);
      if (!ho) return `<div class="empty"><b>Az átadás nem található</b>Lépj vissza a listához.</div>`;
      const parcels = ho.orders.reduce((a, x) => a + (x.p || 1), 0);
      let html = `<div class="split"><div><div class="name" style="font:700 26px/1 var(--f-display);text-transform:uppercase">${h(ho.carrier)}</div><div class="sku">${h(ho.id)}</div></div>${ho.status === 'OPEN' ? chip('Nyitott', 'warn') : chip('Lezárt', 'ok')}</div>
        <div class="kpis"><div class="kpi"><b>${ho.orders.length}</b><small>Rendelés</small></div><div class="kpi"><b>${parcels}</b><small>Csomag</small></div><div class="kpi"><b class="mono" style="font-size:18px">${h(ho.plate || '–')}</b><small>Rendszám</small></div></div>
        <div class="sku">Nyitva: ${tfmt(ho.createdAt)}${ho.closedAt ? ' · Lezárva: ' + tfmt(ho.closedAt) : ''}${ho.driver ? ' · Sofőr: ' + h(ho.driver) : ''}</div>`;
      if (ho.status === 'OPEN') {
        const pending = ordersBy('PICKED').filter(o => o.carrier === ho.carrier);
        html += `<div class="sec">Kész, még nincs felrakva · ${pending.length}</div>` + (pending.length ? `<div class="list">${pending.map(o => `<div class="row"><div class="main"><div class="name mono">${h(o.orderNo)}</div><div class="sku">${o.tracking ? h(o.tracking) : 'nincs követőszám'}${o.customer ? ' · ' + h(o.customer) : ''}</div></div><span class="n">${o.parcels || 1}</span></div>`).join('')}</div>` : `<div class="note">Minden kiszedett ${h(ho.carrier)} rendelés fent van.</div>`);
      }
      html += `<div class="sec">Felrakva · ${ho.orders.length}</div>` + (ho.orders.length ? `<div class="list">${ho.orders.slice().reverse().map(x => `<div class="row"><div class="main"><div class="name mono">${h(x.no)}</div><div class="sku">${x.tr ? h(x.tr) + ' · ' : ''}${hms(x.t)}${x.c ? ' · ' + h(x.c) : ''}</div></div><span class="n">${x.p || 1}</span>${ho.status === 'OPEN' ? armBtn('unload:' + x.no, 'Le', 'Levesz?', 'sm') : ''}</div>`).join('')}</div>` : `<div class="empty"><b>Üres rakomány</b>Szkenneld az első csomagot.</div>`);
      return `<div class="stack">${html}</div>`;
    }
    const open = hos.filter(x => x.status === 'OPEN'), closed = hos.filter(x => x.status === 'CLOSED').slice(0, 10);
    const ready = ordersBy('PICKED'), byC = {};
    ready.forEach(o => { const c = o.carrier || 'Futár nélkül'; byC[c] = (byC[c] || 0) + 1; });
    let html = '';
    html += `<div class="sec">Nyitott átadások</div>` + (open.length ? `<div class="list">${open.map(x => `<button class="row" data-act="openho" data-id="${h(x.id)}"><div class="main"><div class="name">${h(x.carrier)}</div><div class="sku">${tfmt(x.createdAt)}${x.plate ? ' · ' + h(x.plate) : ''}</div></div><div class="side"><span class="n">${x.orders.length}</span><span class="sku">rendelés</span></div></button>`).join('')}</div>` : `<div class="note">Nincs nyitott átadás.</div>`);
    html += `<div class="sec">Futárra kész rendelések</div>` + (ready.length ? `<div class="chips">${Object.keys(byC).map(c => chip(`${c}: ${byC[c]}`, 'info')).join('')}</div>` : `<div class="note">Nincs kiszedett, felrakásra váró rendelés.</div>`);
    html += `<div class="card"><div class="sec" style="padding-top:0">Új átadás indítása</div><div class="chips">${S.cfg.carriers.map(c => `<button class="btn sm ${st.carrier === c ? 'primary' : ''}" style="flex:none" data-act="carrier" data-c="${h(c)}">${h(c)}${openHoFor(c) ? ' · nyitott' : ''}</button>`).join('')}</div>
      <div class="grid2"><div class="field"><label for="f-plate">Rendszám</label><input class="in" id="f-plate" data-bind="plate" data-enter="scan" value="${h(st.plate)}" placeholder="ABC-123" autocomplete="off"></div><div class="field"><label for="f-driver">Sofőr</label><input class="in" id="f-driver" data-bind="driver" data-enter="scan" value="${h(st.driver)}" placeholder="opcionális" autocomplete="off"></div></div>
      <button class="btn primary" data-act="newho" ${!st.carrier || S.busy ? 'disabled' : ''}>${st.carrier ? (openHoFor(st.carrier) ? `${h(st.carrier)} átadás megnyitása` : `${h(st.carrier)} átadás indítása`) : 'Válassz futárt'}</button></div>`;
    if (closed.length) html += `<div class="sec">Lezárt átadások</div><div class="list">${closed.map(x => `<button class="row" data-act="openho" data-id="${h(x.id)}"><div class="main"><div class="name">${h(x.carrier)}</div><div class="sku">${tfmt(x.closedAt)}${x.plate ? ' · ' + h(x.plate) : ''}</div></div><div class="side"><span class="n">${x.orders.length}</span>${chip('Lezárt', 'ok')}</div></button>`).join('')}</div>`;
    return `<div class="stack">${html}</div>`;
  },
  actions(st) {
    if (st.mode !== 'ho') return '';
    const ho = S.handovers.get(st.hoId); if (!ho) return '';
    if (ho.status === 'OPEN') return `<button class="btn" data-act="tolist">Lista</button>${armBtn('close', `Lezárás · ${ho.orders.length} rendelés`, 'Átadod a futárnak?', 'primary', !ho.orders.length || S.busy)}`;
    return `<button class="btn" data-act="tolist">Lista</button><button class="btn primary" data-act="manifest">Manifeszt (CSV)</button>`;
  },
  acts: {
    tolist(el, st) { Object.assign(st, { mode: 'list', hoId: null }); render(); },
    openho(el, st) { Object.assign(st, { mode: 'ho', hoId: el.dataset.id }); render(); },
    carrier(el, st) { st.carrier = el.dataset.c; render(); },
    async newho(el, st) {
      if (!st.carrier || S.busy) return;
      const ex = openHoFor(st.carrier);
      if (ex) { Object.assign(st, { mode: 'ho', hoId: ex.id }); return render(); }
      const d = new Date();
      const id = `HO-${ymd(d).replace(/-/g, '')}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${st.carrier.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`;
      S.busy = true; render();
      try {
        const doc = { id, carrier: st.carrier, status: 'OPEN', plate: st.plate.trim().toUpperCase(), driver: st.driver.trim(), createdAt: nowIso(), createdBy: opName(), orders: [] };
        await hoRef(id).set(doc);
        S.handovers.set(id, doc);
        Object.assign(st, { mode: 'ho', hoId: id, plate: '', driver: '' });
        flash('ok', `${doc.carrier} átadás megnyitva. Szkenneld a csomagokat.`);
      } catch (e) { flash('err', errMsg(e)); }
      finally { S.busy = false; render(); }
    },
    async unload(no, st) {
      if (S.busy) return;
      S.busy = true; render();
      try {
        await patchHandover(st.hoId, x => { if (x.status !== 'OPEN') throw { code: 'closed', message: 'Az átadás már lezárult.' }; x.orders = x.orders.filter(y => y.no !== no); });
        await patchOrder(no, x => { if (x.status === 'LOADED') { x.status = 'PICKED'; x.handoverId = null; } });
        flash('info', `Levéve: ${no}`);
      } catch (e) { flash('err', errMsg(e)); }
      finally { S.busy = false; render(); }
    },
    async close(p, st) {
      const ho = S.handovers.get(st.hoId);
      if (!ho || S.busy) return;
      S.busy = true; render();
      const logs = [];
      try {
        const list = ho.orders.filter(x => !x.out);
        for (const e of list) {
          if (e.lines.length) await changeStock(e.lines.map(l => ({ loc: S.cfg.shipLoc, sku: l.sku, delta: -l.q, force: true })));
          try { await patchOrder(e.no, x => { x.status = 'SHIPPED'; x.shippedAt = nowIso(); }); } catch (err) { if (!err || err.code !== 'missing') throw err; }
          await patchHandover(ho.id, x => { const y = x.orders.find(z => z.no === e.no); if (y) y.out = true; });
          e.lines.forEach(l => logs.push({ ty: 'SHIP', s: l.sku, f: S.cfg.shipLoc, q: l.q, o: e.no, r: ho.carrier }));
        }
        await patchHandover(ho.id, x => { x.status = 'CLOSED'; x.closedAt = nowIso(); x.closedBy = opName(); });
        flash('ok', `Átadva: ${ho.carrier} · ${ho.orders.length} rendelés`);
      } catch (e) { flash('err', errMsg(e)); }
      finally { await appendLog(logs); S.busy = false; render(); }
    },
    manifest(el, st) {
      const ho = S.handovers.get(st.hoId); if (!ho) return;
      const rows = [['atadas', 'futar', 'rendszam', 'sofor', 'lezarva', 'rendeles', 'kovetoszam', 'csomag', 'cimzett', 'felrakva']].concat(ho.orders.map(x => [ho.id, ho.carrier, ho.plate || '', ho.driver || '', tfmt(ho.closedAt), x.no, x.tr || '', x.p || 1, x.c || '', tfmt(x.t)]));
      saveCsv(`manifeszt_${ho.id}.csv`, rows);
    }
  }
};

/* --- Journal --- */
SCREENS.log = {
  title: 'Napló',
  init: () => ({ date: today(), entries: null, loading: false, f: 'ALL' }),
  enter(st) { this.load(st); },
  onBind(st, key) { if (key === 'date') this.load(st); },
  async load(st) {
    if (!S.db) return;
    st.loading = true; render();
    try {
      const snap = await S.db.collection('log').where('date', '==', st.date).get();
      const all = [];
      snap.docs.forEach(d => (d.data().entries || []).forEach(e => all.push(e)));
      all.sort((a, b) => String(b.t).localeCompare(String(a.t)));
      st.entries = all;
    } catch (e) { st.entries = []; flash('err', errMsg(e)); }
    st.loading = false; render();
  },
  render(st) {
    const types = ['ALL'].concat(Object.keys(LOG_TY));
    let html = `<div class="field"><label for="f-date">Nap</label><input class="in" type="date" id="f-date" data-bind="date" value="${h(st.date)}"></div>
      <div class="tabs">${types.map(t => `<button class="btn sm ${st.f === t ? 'on' : ''}" data-act="filt" data-t="${t}">${t === 'ALL' ? 'Mind' : LOG_TY[t]}</button>`).join('')}</div>`;
    if (st.loading || !st.entries) return `<div class="stack">${html}${loading()}</div>`;
    const list = st.entries.filter(e => st.f === 'ALL' || e.ty === st.f);
    html += `<div class="sec">${list.length} mozgás</div>`;
    html += list.length ? `<div class="list">${list.slice(0, 300).map(e => `<div class="row"><div class="main"><div class="chips">${chip(LOG_TY[e.ty] || e.ty, e.ty === 'SHORT' ? 'err' : e.ty === 'COUNT' ? 'warn' : '')}<span class="sku">${hms(e.t)} · ${h(who(e.u))}</span></div>${e.s ? `<div class="name">${h(itemName(e.s))}</div><div class="sku">${h(e.s)}</div>` : ''}<div class="chips">${e.f ? locTag(e.f) : ''}${e.f && e.to ? '<span class="sku">→</span>' : ''}${e.to ? locTag(e.to) : ''}${e.o ? `<span class="sku">${h(e.o)}</span>` : ''}${e.r ? `<span class="sku">${h(e.r)}</span>` : ''}</div></div><span class="n ${e.q < 0 ? 'neg' : ''}">${e.q > 0 && e.ty === 'COUNT' ? '+' : ''}${fmt(e.q)}</span></div>`).join('')}</div>` : `<div class="empty"><b>Nincs mozgás</b>Ezen a napon nem volt könyvelés.</div>`;
    return `<div class="stack">${html}</div>`;
  },
  actions: st => `<button class="btn" data-act="reload">Frissítés</button><button class="btn grow" data-act="export" ${!st.entries || !st.entries.length ? 'disabled' : ''}>Export (CSV)</button>`,
  acts: {
    filt(el, st) { st.f = el.dataset.t; render(); },
    reload(el, st) { SCREENS.log.load(st); },
    export(el, st) {
      const rows = [['idopont', 'tipus', 'cikkszam', 'megnevezes', 'honnan', 'hova', 'mennyiseg', 'rendeles', 'megjegyzes', 'operator']].concat((st.entries || []).map(e => [tfmt(e.t) + ':' + pad(new Date(e.t).getSeconds()), LOG_TY[e.ty] || e.ty, e.s || '', e.s ? itemName(e.s) : '', e.f || '', e.to || '', String(e.q ?? '').replace('.', ','), e.o || '', e.r || '', who(e.u)]));
      saveCsv(`naplo_${st.date}.csv`, rows);
    }
  }
};

/* --- Master data, backup, settings --- */
async function bulk(st, label, ops) {
  S.busy = true; st.progress = `${label}: ${ops.length} tétel mentése`; render();
  try { for (let i = 0; i < ops.length; i += 500) await LocalDB.batch(ops.slice(i, i + 500)); return { ok: ops.length, errs: [] }; }
  catch (e) { return { ok: 0, errs: [errMsg(e)] }; }
  finally { S.busy = false; st.progress = null; }
}
const emptyItem = () => ({ sku: '', name: '', eans: '', unit: 'db', editing: false });
SCREENS.admin = {
  title: 'Törzsadat',
  init: () => ({ tab: 'items', pin: '', f: emptyItem(), lf: { code: '', type: 'STORE' }, gen: { prefix: 'A-01-', b1: 1, b2: 10, l1: 1, l2: 4, type: 'STORE' }, csv: '', ocsv: '', q: '', days: 30, cfg: null, progress: null, report: '', restore: null }),
  onBind(st, key) {
    if (key === 'q') { const el = $('#ilist'); if (el) el.innerHTML = this.itemList(st); }
    if (key.indexOf('gen.') === 0) { const el = $('#genprev'); if (el) el.textContent = this.genPreview(st); }
  },
  itemList(st) {
    const q = st.q.trim().toLowerCase();
    const list = [...S.items.values()].filter(it => !q || it.sku.toLowerCase().includes(q) || (it.name || '').toLowerCase().includes(q) || (it.eans || []).some(e => e.includes(q))).sort((a, b) => a.sku.localeCompare(b.sku)).slice(0, 100);
    return list.length ? `<div class="list">${list.map(it => `<button class="row" data-act="edititem" data-sku="${h(it.sku)}"><div class="main">${itemBlock(it.sku)}</div><span class="sku">${h(it.unit || 'db')}</span></button>`).join('')}</div>` : `<div class="note">Nincs cikk.</div>`;
  },
  genCodes(st) {
    const g = st.gen, out = [];
    const b1 = Math.floor(num(g.b1)), b2 = Math.floor(num(g.b2)), l1 = Math.floor(num(g.l1)), l2 = Math.floor(num(g.l2));
    if (b2 < b1 || l2 < l1 || (b2 - b1 + 1) * (l2 - l1 + 1) > 1000) return out;
    for (let b = b1; b <= b2; b++) for (let l = l1; l <= l2; l++) out.push(`${String(g.prefix || '').trim().toUpperCase()}${pad(b)}-${pad(l)}`);
    return out;
  },
  genPreview(st) { const c = this.genCodes(st); return c.length ? `${c.length} lokáció: ${c[0]} … ${c[c.length - 1]}` : 'Érvénytelen tartomány (legfeljebb 1000 lokáció egyszerre).'; },
  async loadRestore(file, st) {
    try {
      const j = JSON.parse(await readFileText(file));
      if (!j || j.app !== 'pda-raktar' || !j.docs || typeof j.docs !== 'object') throw new Error('format');
      const docs = {};
      Object.keys(j.docs).forEach(k => { const v = j.docs[k]; if (/^[^/]+(\/[^/]+)+$/.test(k) && v && typeof v === 'object' && !Array.isArray(v)) docs[k] = v; });
      st.restore = { docs, n: Object.keys(docs).length, at: j.exportedAt || '', name: file.name };
    } catch (e) { st.restore = null; flash('err', 'Ez nem PDA Raktár mentésfájl.'); }
    render();
  },
  render(st) {
    if (!S.loaded) return loading();
    if (!adminOk()) return `<div class="stack"><div class="card"><div class="sec" style="padding-top:0">Törzsadat zárolva</div><div class="field"><label for="f-pin">PIN</label><input class="in mono" id="f-pin" type="password" inputmode="numeric" data-bind="pin" data-enter="unlock" autocomplete="off"></div><button class="btn primary" data-act="unlock">Belépés</button></div></div>`;
    const tabs = [['items', 'Cikkek'], ['locs', 'Lokációk'], ['orders', 'Rendelések'], ['backup', 'Mentés'], ['settings', 'Beállítások']];
    let html = `<div class="tabs">${tabs.map(([k, l]) => `<button class="btn sm ${st.tab === k ? 'on' : ''}" data-act="tab" data-t="${k}">${l}</button>`).join('')}</div>`;
    if (st.progress) html += `<div class="note mono">${h(st.progress)}</div>`;
    if (st.report) html += `<div class="hint">${h(st.report)}</div>`;
    if (st.tab === 'items') {
      const f = st.f;
      html += `<div class="card"><div class="sec" style="padding-top:0">${f.editing ? 'Cikk szerkesztése' : 'Új cikk'}</div>
        <div class="grid2"><div class="field"><label for="f-sku">Cikkszám</label><input class="in mono" id="f-sku" data-bind="f.sku" value="${h(f.sku)}" ${f.editing ? 'readonly' : ''} autocomplete="off"></div>
        <div class="field"><label for="f-unit">Mértékegység</label><select class="in" id="f-unit" data-bind="f.unit">${['db', 'karton', 'raklap', 'kg', 'm', 'l'].map(u => `<option ${f.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div></div>
        <div class="field"><label for="f-name">Megnevezés</label><input class="in" id="f-name" data-bind="f.name" value="${h(f.name)}" autocomplete="off"></div>
        <div class="field"><label for="f-eans">Vonalkódok (EAN, vesszővel)</label><input class="in mono" id="f-eans" data-bind="f.eans" value="${h(f.eans)}" placeholder="Koppints ide és szkenneld" autocomplete="off"></div>
        <div class="chips"><button class="btn primary" data-act="saveitem" ${S.busy ? 'disabled' : ''}>Mentés</button>${f.editing ? `<button class="btn" data-act="newitem">Új cikk</button>${armBtn('delitem', 'Törlés', 'Biztosan törlöd?', 'danger')}` : ''}</div></div>
        <div class="field"><label for="f-iq">Keresés</label><input class="in" id="f-iq" data-bind="q" value="${h(st.q)}" autocomplete="off" placeholder="${S.items.size} cikk"></div>
        <div id="ilist">${this.itemList(st)}</div>
        <div class="card"><div class="sec" style="padding-top:0">CSV import</div><div class="hint">Oszlopok: cikkszám ; megnevezés ; ean ; me. Több EAN: | jellel. Elválasztó: ; vagy tab vagy vessző. Fejléc sor kihagyva.</div>
        <textarea class="in" id="f-csv" data-bind="csv" placeholder="SKU-001;Termék neve;5991234567890;db">${h(st.csv)}</textarea>
        <div class="field"><label for="f-csvfile">Vagy CSV fájl</label><input class="in" type="file" id="f-csvfile" data-file="csv" accept=".csv,.txt,text/csv,text/plain"></div>
        <button class="btn primary" data-act="importitems" ${S.busy ? 'disabled' : ''}>Cikkek importálása</button></div>`;
    }
    if (st.tab === 'locs') {
      const locs = [...S.locs.values()].sort((a, b) => cmpLoc(a.code, b.code)), used = new Set(stockList().map(x => x.loc));
      const typeSel = (id, bind, val) => `<select class="in" id="${id}" data-bind="${bind}">${Object.keys(LOC_TYPES).map(k => `<option value="${k}" ${val === k ? 'selected' : ''}>${LOC_TYPES[k]}</option>`).join('')}</select>`;
      html += `<div class="card"><div class="sec" style="padding-top:0">Egy lokáció</div><div class="grid2"><div class="field"><label for="f-lc">Kód</label><input class="in mono" id="f-lc" data-bind="lf.code" value="${h(st.lf.code)}" autocomplete="off" placeholder="B-03-02"></div><div class="field"><label for="f-lt">Típus</label>${typeSel('f-lt', 'lf.type', st.lf.type)}</div></div><button class="btn primary" data-act="saveloc" ${S.busy ? 'disabled' : ''}>Mentés</button></div>
        <div class="card"><div class="sec" style="padding-top:0">Tartomány generálása</div><div class="field"><label for="f-gp">Előtag (sor)</label><input class="in mono" id="f-gp" data-bind="gen.prefix" value="${h(st.gen.prefix)}" autocomplete="off"></div>
        <div class="grid2"><div class="field"><label for="f-gb1">Oszloptól</label><input class="in" id="f-gb1" inputmode="numeric" data-bind="gen.b1" value="${h(st.gen.b1)}"></div><div class="field"><label for="f-gb2">Oszlopig</label><input class="in" id="f-gb2" inputmode="numeric" data-bind="gen.b2" value="${h(st.gen.b2)}"></div>
        <div class="field"><label for="f-gl1">Szinttől</label><input class="in" id="f-gl1" inputmode="numeric" data-bind="gen.l1" value="${h(st.gen.l1)}"></div><div class="field"><label for="f-gl2">Szintig</label><input class="in" id="f-gl2" inputmode="numeric" data-bind="gen.l2" value="${h(st.gen.l2)}"></div></div>
        <div class="field"><label for="f-gt">Típus</label>${typeSel('f-gt', 'gen.type', st.gen.type)}</div><div class="hint" id="genprev">${h(this.genPreview(st))}</div><button class="btn primary" data-act="genlocs" ${S.busy ? 'disabled' : ''}>Generálás</button></div>
        <div class="sec">${locs.length} lokáció</div>${locs.length ? `<div class="list">${locs.map(l => `<div class="row"><div class="main">${locTag(l.code)}<span class="sku">${h(LOC_TYPES[l.type] || l.type)}${used.has(l.code) ? ' · készlet van rajta' : ''}</span></div>${used.has(l.code) ? '' : armBtn('delloc:' + l.code, 'Törlés', 'Töröl?', 'sm')}</div>`).join('')}</div>` : ''}`;
    }
    if (st.tab === 'orders') {
      const list = [...S.orders.values()].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      html += `<div class="card"><div class="sec" style="padding-top:0">Rendelés import (CSV)</div><div class="hint">Oszlopok: rendelésszám ; futár ; cikkszám ; db ; címzett ; követőszám ; csomagszám. Rendelésenként több sor. Futár: ${h(S.cfg.carriers.join(', '))}.</div>
        <textarea class="in" id="f-ocsv" data-bind="ocsv" placeholder="WEB-10045;GLS;SKU-001;2;;GLS123456;1">${h(st.ocsv)}</textarea>
        <div class="field"><label for="f-ocsvfile">Vagy CSV fájl</label><input class="in" type="file" id="f-ocsvfile" data-file="ocsv" accept=".csv,.txt,text/csv,text/plain"></div>
        <button class="btn primary" data-act="importorders" ${S.busy ? 'disabled' : ''}>Rendelések importálása</button></div>
        <div class="sec">${list.length} aktív rendelés</div>${list.length ? `<div class="list">${list.map(o => `<div class="row"><div class="main"><div class="name mono">${h(o.orderNo)}</div><div class="sku">${o.lines.length} tétel · ${tfmt(o.createdAt)}</div></div><div class="side">${o.carrier ? chip(o.carrier, 'info') : ''}${stChip(o.status)}</div>${o.status === 'NEW' ? armBtn('delorder:' + o.orderNo, 'Törlés', 'Töröl?', 'sm') : ''}</div>`).join('')}</div>` : ''}
        <div class="card"><div class="sec" style="padding-top:0">Archív takarítás</div><div class="hint">Törli az átadott rendeléseket, a lezárt átadásokat és a naplót, ami régebbi a megadott napnál. Előtte készíts mentést.</div>
        <div class="field"><label for="f-days">Napnál régebbi</label><input class="in" id="f-days" inputmode="numeric" data-bind="days" value="${h(st.days)}"></div>${armBtn('purge', 'Takarítás', 'Biztosan törlöd?', 'danger', S.busy)}</div>`;
    }
    if (st.tab === 'backup') {
      const lb = store.get('wms_lastBackup');
      html += `<div class="card"><div class="sec" style="padding-top:0">Biztonsági mentés</div>
        <div class="hint">Minden adat ezen a készüléken van. Az alkalmazás eltávolítása vagy az alkalmazásadatok törlése mindent töröl. A mentés a Documents/PDA-Raktar/Mentes mappába kerül, onnan USB-n vagy a Megosztás gombbal viheted át. ${S.cfg.autoBackup !== false ? 'Napi automatikus mentés bekapcsolva, az utolsó 14 marad meg.' : 'Napi automatikus mentés kikapcsolva.'}</div>
        <div class="note">Utolsó mentés: ${lb ? h(tfmt(lb)) : 'még nem volt'} · ${LocalDB.count()} tárolt dokumentum</div>
        <button class="btn primary" data-act="backup" ${S.busy ? 'disabled' : ''}>Mentés most</button></div>
        <div class="card"><div class="sec" style="padding-top:0">Visszaállítás</div><div class="hint">Mentésfájlból tölti vissza az összes adatot. A készüléken lévő jelenlegi adatok elvesznek.</div>
        <div class="field"><label for="f-restore">Mentésfájl (.json)</label><input class="in" type="file" id="f-restore" accept=".json,application/json"></div>
        ${st.restore ? `<div class="note">${h(st.restore.name)} · ${st.restore.n} dokumentum${st.restore.at ? ' · készült: ' + h(tfmt(st.restore.at)) : ''}</div>${armBtn('restore', 'Visszaállítás', 'Felülírod a mostani adatokat?', 'danger', S.busy)}` : ''}</div>`;
    }
    if (st.tab === 'settings') {
      const c = st.cfg || (st.cfg = Object.assign({}, S.cfg, { carriers: S.cfg.carriers.join(', ') }));
      const opts = type => [...S.locs.values()].filter(l => l.type === type).map(l => l.code).sort(cmpLoc);
      const sel = (id, bind, type, val) => { const o = opts(type); if (val && !o.includes(val)) o.unshift(val); return `<select class="in mono" id="${id}" data-bind="${bind}">${o.map(x => `<option ${x === val ? 'selected' : ''}>${h(x)}</option>`).join('')}</select>`; };
      const hasDemo = [...S.items.values()].some(i => i.demo) || [...S.orders.values()].some(o => o.demo);
      html += `<div class="card"><div class="grid2"><div class="field"><label for="c-rl">Átvételi hely</label>${sel('c-rl', 'cfg.receivingLoc', 'RCV', c.receivingLoc)}</div><div class="field"><label for="c-sl">Kiadó hely</label>${sel('c-sl', 'cfg.shipLoc', 'SHIP', c.shipLoc)}</div></div>
        <div class="field"><label for="c-car">Futárszolgálatok (vesszővel)</label><input class="in" id="c-car" data-bind="cfg.carriers" value="${h(c.carriers)}"></div>
        <div class="field"><label for="c-pin">Törzsadat PIN (üres = nincs védelem)</label><input class="in mono" id="c-pin" inputmode="numeric" data-bind="cfg.adminPin" value="${h(c.adminPin || '')}" autocomplete="off"></div>
        <label class="check"><input type="checkbox" id="c-bl" data-bind="cfg.blindCount" ${c.blindCount ? 'checked' : ''}>Vak leltár (rendszerkészlet rejtve számoláskor)</label>
        <label class="check"><input type="checkbox" id="c-neg" data-bind="cfg.allowNegative" ${c.allowNegative ? 'checked' : ''}>Negatív készlet engedélyezése</label>
        <label class="check"><input type="checkbox" id="c-ab" data-bind="cfg.autoBackup" ${c.autoBackup !== false ? 'checked' : ''}>Napi automatikus mentés</label>
        <button class="btn primary" data-act="savecfg" ${S.busy ? 'disabled' : ''}>Beállítások mentése</button></div>
        <div class="card"><div class="sec" style="padding-top:0">Demo adatok</div><div class="hint">DEMO jelölésű cikkek, lokációk, készlet és rendelések. A saját adataidat nem érinti.</div>${hasDemo ? armBtn('cleardemo', 'Demo adatok törlése', 'Biztosan törlöd?', 'danger', S.busy) : `<button class="btn" data-act="loaddemo" ${S.busy ? 'disabled' : ''}>Demo adatok betöltése</button>`}</div>
        <div class="hint">Eszköz: ${h(DEVICE_ID)}${Native ? '' : ' · böngészős tesztmód'}</div>`;
    }
    return `<div class="stack">${html}</div>`;
  },
  acts: {
    unlock(el, st) {
      if (String(st.pin || '') === String(S.cfg.adminPin || '')) { S.adminUnlocked = true; st.pin = ''; render(); }
      else { st.pin = ''; flash('err', 'Hibás PIN.'); render(); }
    },
    tab(el, st) { st.tab = el.dataset.t; st.report = ''; render(); },
    edititem(el, st) { const it = itemOf(el.dataset.sku); if (!it) return; st.f = { sku: it.sku, name: it.name || '', eans: (it.eans || []).join(', '), unit: it.unit || 'db', editing: true }; render(); window.scrollTo(0, 0); },
    newitem(el, st) { st.f = emptyItem(); render(); },
    async saveitem(el, st) {
      const f = st.f, sku = f.sku.trim();
      if (!sku || sku.length > 60) return flash('err', 'Adj meg cikkszámot (legfeljebb 60 karakter).');
      if (!f.name.trim()) return flash('err', 'Adj meg megnevezést.');
      if (!f.editing && S.items.has(sku)) return flash('err', 'Ez a cikkszám már létezik.');
      const eans = [...new Set(f.eans.split(/[,;\s|]+/).map(s => s.trim()).filter(Boolean))];
      const clash = eans.find(e => { const o = S.codeIndex.get(e); return o && o !== sku; }) || (S.locs.has(sku) ? sku : null);
      if (clash) return flash('err', `A ${clash} kód már másik cikkhez vagy lokációhoz tartozik.`);
      try {
        const prev = itemOf(sku) || {};
        await S.db.doc(P.item(sku)).set(Object.assign({}, prev, { sku, name: f.name.trim(), eans, unit: f.unit || 'db', ts: nowIso() }));
        flash('ok', 'Cikk mentve: ' + sku);
        st.f = emptyItem();
      } catch (e) { flash('err', errMsg(e)); }
      render();
    },
    async delitem(p, st) {
      const sku = st.f.sku;
      if (bySku(sku).length) return flash('err', 'Készleten lévő cikk nem törölhető.');
      if (demand(sku) > 0) return flash('err', 'Nyitott rendelésben szereplő cikk nem törölhető.');
      try { await S.db.doc(P.item(sku)).delete(); flash('ok', 'Törölve: ' + sku); st.f = emptyItem(); } catch (e) { flash('err', errMsg(e)); }
      render();
    },
    async importitems(el, st) {
      const rows = dropHeader(parseRows(st.csv), /^(sku|cikk|cikkszám|cikkszam|item)$/i).filter(r => r[0]);
      if (!rows.length) return flash('err', 'Nincs importálható sor.');
      const ops = rows.map(r => {
        const sku = r[0].slice(0, 60), prev = itemOf(sku) || {};
        const eans = (r[2] || '').split(/[|,\s]+/).map(s => s.trim()).filter(Boolean);
        return [P.item(sku), Object.assign({}, prev, { sku, name: r[1] || prev.name || sku, eans: eans.length ? eans : (prev.eans || []), unit: r[3] || prev.unit || 'db', ts: nowIso() })];
      });
      const res = await bulk(st, 'Cikkek', ops);
      st.report = `Importálva: ${res.ok} / ${rows.length}${res.errs.length ? ' · Hiba: ' + res.errs[0] : ''}`;
      if (!res.errs.length) st.csv = '';
      flash(res.errs.length ? 'warn' : 'ok', st.report); render();
    },
    async saveloc(el, st) {
      const code = st.lf.code.trim().toUpperCase();
      if (!code || code.length > 40) return flash('err', 'Adj meg lokációkódot (legfeljebb 40 karakter).');
      if (S.codeIndex.has(code)) return flash('err', 'Ez a kód már cikkhez tartozik.');
      try { await S.db.doc(P.loc(code)).set({ code, type: st.lf.type, ts: nowIso() }); flash('ok', 'Lokáció mentve: ' + code); st.lf.code = ''; } catch (e) { flash('err', errMsg(e)); }
      render();
    },
    async genlocs(el, st) {
      const codes = SCREENS.admin.genCodes(st).filter(c => !S.locs.has(c));
      if (!codes.length) return flash('warn', 'Nincs új lokáció a tartományban.');
      const res = await bulk(st, 'Lokációk', codes.map(code => [P.loc(code), { code, type: st.gen.type, ts: nowIso() }]));
      st.report = `Létrehozva: ${res.ok} lokáció${res.errs.length ? ' · Hiba: ' + res.errs[0] : ''}`;
      flash(res.errs.length ? 'warn' : 'ok', st.report); render();
    },
    async delloc(code) {
      if (byLoc(code).length) return flash('err', 'Készletes lokáció nem törölhető.');
      try { await S.db.doc(P.loc(code)).delete(); flash('ok', 'Törölve: ' + code); } catch (e) { flash('err', errMsg(e)); }
      render();
    },
    async importorders(el, st) {
      const rows = dropHeader(parseRows(st.ocsv), /^(rendelés|rendeles|rendelésszám|rendelesszam|order|orderno|order_no)$/i).filter(r => r[0]);
      if (!rows.length) return flash('err', 'Nincs importálható sor.');
      const map = new Map(), errs = [];
      rows.forEach((r, i) => {
        const no = r[0].slice(0, 60), sku = r[2], q = round(num(r[3]));
        if (!S.items.has(sku)) { errs.push(`${i + 1}. sor: ismeretlen cikkszám ${sku}`); return; }
        if (q <= 0) { errs.push(`${i + 1}. sor: hibás mennyiség`); return; }
        const o = map.get(no) || { orderNo: no, carrier: '', customer: '', tracking: '', parcels: 1, lines: [] };
        o.carrier = o.carrier || (r[1] || ''); o.customer = o.customer || (r[4] || ''); o.tracking = o.tracking || (r[5] || ''); if (r[6]) o.parcels = Math.max(1, Math.floor(num(r[6])));
        const ex = o.lines.find(l => l.sku === sku); if (ex) ex.qty = round(ex.qty + q); else o.lines.push({ sku, qty: q, picked: 0, short: false });
        map.set(no, o);
      });
      const fresh = [];
      for (const o of map.values()) {
        if ((await orderRef(o.orderNo).get()).exists) errs.push(`${o.orderNo}: már létezik, kihagyva`);
        else fresh.push(o);
      }
      const t = nowIso();
      const res = await bulk(st, 'Rendelések', fresh.map(o => [P.order(o.orderNo), Object.assign({}, o, { status: 'NEW', createdAt: t, createdBy: opName() })]));
      const all = errs.concat(res.errs);
      st.report = `Importálva: ${res.ok} rendelés${all.length ? ' · ' + all.slice(0, 4).join(' · ') : ''}`;
      if (!all.length) st.ocsv = '';
      flash(all.length ? 'warn' : 'ok', st.report); render();
    },
    async delorder(no) {
      const o = S.orders.get(no);
      if (!o || o.status !== 'NEW') return flash('err', 'Csak még el nem kezdett rendelés törölhető.');
      try { await orderRef(no).delete(); flash('ok', 'Törölve: ' + no); } catch (e) { flash('err', errMsg(e)); }
      render();
    },
    async purge(p, st) {
      const days = Math.max(1, Math.floor(num(st.days)));
      const cut = new Date(Date.now() - days * 86400000), cutIso = cut.toISOString(), cutDay = ymd(cut);
      const ops = [];
      (await S.db.collection('orders').where('status', '==', 'SHIPPED').get()).docs.forEach(d => { const x = d.data(); if (String(x.shippedAt || '') < cutIso) ops.push([P.order(x.orderNo), null]); });
      (await S.db.collection('handovers').where('status', '==', 'CLOSED').get()).docs.forEach(d => { const x = d.data(); if (String(x.closedAt || '') < cutIso) ops.push([P.ho(x.id), null]); });
      (await S.db.collection('log').where('date', '<', cutDay).get()).docs.forEach(d => ops.push(['log/' + d.id, null]));
      if (!ops.length) { st.report = 'Nincs törlendő régi adat.'; flash('info', st.report); return render(); }
      const res = await bulk(st, 'Takarítás', ops);
      st.report = res.errs.length ? 'Hiba: ' + res.errs[0] : `Törölve: ${res.ok} dokumentum (${days} napnál régebbi).`;
      flash(res.errs.length ? 'err' : 'ok', st.report); render();
    },
    async backup() { if (S.busy) return; S.busy = true; render(); try { await backupNow(false); } finally { S.busy = false; render(); } },
    async restore(p, st) {
      if (!st.restore || S.busy) return;
      S.busy = true; render();
      try {
        await LocalDB.replaceAll(st.restore.docs);
        S.logPart = {};
        flash('ok', `Visszaállítva: ${st.restore.n} dokumentum.`);
        st.restore = null;
        const fi = $('#f-restore'); if (fi) fi.value = '';
      } catch (e) { flash('err', errMsg(e)); }
      finally { S.busy = false; render(); }
    },
    async savecfg(el, st) {
      const c = st.cfg;
      const carriers = String(c.carriers).split(',').map(s => s.trim()).filter(Boolean);
      if (!carriers.length) return flash('err', 'Adj meg legalább egy futárszolgálatot.');
      const pin = String(c.adminPin || '').trim();
      if (pin && !/^\d{4,8}$/.test(pin)) return flash('err', 'A PIN 4–8 számjegy legyen.');
      try {
        await S.db.doc('config/main').set({ receivingLoc: c.receivingLoc, shipLoc: c.shipLoc, carriers, blindCount: !!c.blindCount, allowNegative: !!c.allowNegative, autoBackup: !!c.autoBackup, adminPin: pin, ts: nowIso() });
        if (pin) S.adminUnlocked = true;
        flash('ok', 'Beállítások mentve.'); st.cfg = null;
      } catch (e) { flash('err', errMsg(e)); }
      render();
    },
    async loaddemo(el, st) {
      const res = await bulk(st, 'Demo', demoOps());
      flash(res.errs.length ? 'err' : 'ok', res.errs.length ? res.errs[0] : 'Demo adatok betöltve.'); render();
    },
    async cleardemo(p, st) {
      const demoSkus = new Set([...S.items.values()].filter(i => i.demo).map(i => i.sku));
      const ops = [];
      stockList().filter(x => demoSkus.has(x.sku)).forEach(x => ops.push([P.stock(x.loc, x.sku), null]));
      (await S.db.collection('orders').where('demo', '==', true).get()).docs.forEach(d => ops.push([P.order(d.data().orderNo), null]));
      demoSkus.forEach(s => ops.push([P.item(s), null]));
      [...S.locs.values()].filter(l => l.demo && !stockList().some(x => x.loc === l.code && !demoSkus.has(x.sku))).forEach(l => ops.push([P.loc(l.code), null]));
      if (!ops.length) return flash('info', 'Nincs demo adat.');
      const res = await bulk(st, 'Demo törlés', ops);
      st.report = res.errs.length ? 'Hiba: ' + res.errs[0] : `Törölve: ${res.ok} demo dokumentum.`; flash(res.errs.length ? 'err' : 'ok', st.report); render();
    }
  }
};

/* ---------- navigation & render ---------- */
const view = $('#view'), actionsEl = $('#actions'), scanbar = $('#scanbar'), scanInput = $('#scan');
function go(name, init) {
  if (name === 'home') S.adminUnlocked = false;
  S.screen = name;
  const scr = SCREENS[name];
  S.st = Object.assign(scr.init ? scr.init() : {}, init || {});
  render();
  window.scrollTo(0, 0);
  if (scr.enter) scr.enter(S.st);
}
function renderStatus() {
  const el = $('#status');
  let cls = 'warn', txt = 'Betöltés';
  if (S.dbState === 'ok') { cls = S.operator ? 'ok' : 'warn'; txt = S.operator || 'Nincs operátor'; }
  else if (S.dbState === 'none') { cls = 'err'; txt = 'Tárolási hiba'; }
  el.innerHTML = `<span class="dot ${cls}"></span>${h(txt)}`;
}
function render() {
  const scr = SCREENS[S.screen];
  $('#title').textContent = scr.title;
  $('#back').hidden = S.screen === 'home';
  renderStatus();
  const p = scr.prompt ? scr.prompt(S.st) : null;
  scanbar.hidden = !p || (S.screen === 'admin');
  if (p) $('#prompt').textContent = p;
  view.innerHTML = scr.render(S.st);
  const a = scr.actions ? scr.actions(S.st) : '';
  actionsEl.innerHTML = a; actionsEl.hidden = !a;
  S.dirty = false;
  focusScan();
}
function editingInput() {
  const a = document.activeElement;
  return a && a !== scanInput && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && (view.contains(a) || actionsEl.contains(a));
}
function requestRender(fromData) {
  if (fromData && editingInput()) { S.dirty = true; return; }
  render();
}
function focusScan() {
  if (scanbar.hidden) return;
  const a = document.activeElement;
  if (!a || a === document.body || a === scanInput) { try { scanInput.focus({ preventScroll: true }); } catch (e) {} }
}
function handleScan(raw) {
  const code = String(raw || '').trim();
  if (!code) return;
  if (!S.db || !S.loaded) return flash('err', 'Az adatok még nem töltődtek be.');
  if (S.busy) return flash('warn', 'Mentés folyamatban, várj egy pillanatot.');
  const scr = SCREENS[S.screen];
  if (scr.onScan) scr.onScan(code, S.st);
}
const setPath = (o, path, v) => { const k = path.split('.'); let t = o; for (let i = 0; i < k.length - 1; i++) { t[k[i]] = t[k[i]] || {}; t = t[k[i]]; } t[k[k.length - 1]] = v; };

/* ---------- events ---------- */
const GLOBAL_ACTS = {
  back() { const scr = SCREENS[S.screen]; if (scr.back && scr.back(S.st)) return; go('home'); },
  go(el) { go(el.dataset.to); },
  kbd() { S.kbd = !S.kbd; scanInput.setAttribute('inputmode', S.kbd ? 'text' : 'none'); $('#kbd').classList.toggle('on', S.kbd); scanInput.blur(); setTimeout(() => scanInput.focus(), 40); },
  sound() { S.sound = !S.sound; store.set('wms_sound', S.sound); if (S.sound) beep('ok'); render(); },
  sharefile() { shareLast(); },
  quickadd(el) { const code = el.dataset.code; $('#flash').hidden = true; go('admin', { tab: 'items' }); S.st.f = { sku: '', name: '', eans: code, unit: 'db', editing: false }; render(); },
  step(el) {
    const scr = SCREENS[S.screen], k = el.dataset.key;
    if (!scr.setQty) return;
    scr.setQty(S.st, k, Math.max(0, round(scr.getQty(S.st, k) + Number(el.dataset.d))));
    render();
  },
  arm(el) {
    const key = el.dataset.key, scr = SCREENS[S.screen];
    if (S.st.armed === key) {
      S.st.armed = null;
      const parts = key.split(':');
      const fn = scr.acts && scr.acts[parts[0]];
      if (fn) fn(parts.slice(1).join(':'), S.st);
      render();
      return;
    }
    S.st.armed = key; render();
    setTimeout(() => { if (S.st.armed === key) { S.st.armed = null; render(); } }, 4000);
  }
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const name = el.dataset.act, scr = SCREENS[S.screen];
  if (name !== 'arm' && S.st.armed) S.st.armed = null;
  const fn = (name !== 'arm' && scr.acts && scr.acts[name]) || GLOBAL_ACTS[name];
  if (fn) { e.preventDefault(); fn(el, S.st); }
});
document.addEventListener('input', e => {
  const el = e.target, scr = SCREENS[S.screen];
  if (el.dataset.qty !== undefined && scr.setQty) { scr.setQty(S.st, el.dataset.qty, num(el.value)); return; }
  if (el.dataset.bind) {
    setPath(S.st, el.dataset.bind, el.type === 'checkbox' ? el.checked : el.value);
    if (scr.onBind) scr.onBind(S.st, el.dataset.bind);
  }
});
document.addEventListener('change', async e => {
  const el = e.target;
  if (el.tagName === 'SELECT' && el.dataset.bind) { setPath(S.st, el.dataset.bind, el.value); return; }
  if (el.type === 'checkbox' && el.dataset.bind) { setPath(S.st, el.dataset.bind, el.checked); return; }
  if (el.id === 'f-restore' && el.files && el.files[0]) return SCREENS.admin.loadRestore(el.files[0], S.st);
  if (el.dataset.file && el.files && el.files[0]) {
    try { S.st[el.dataset.file] = await readFileText(el.files[0]); render(); } catch (err) { flash('err', 'A fájl nem olvasható.'); }
  }
});
document.addEventListener('keydown', e => {
  const a = document.activeElement;
  if (!a || a === scanInput || e.key !== 'Enter') return;
  if (a.dataset.enter === 'setop' || a.dataset.enter === 'unlock') { e.preventDefault(); const fn = SCREENS[S.screen].acts[a.dataset.enter]; a.blur(); if (fn) fn(a, S.st); return; }
  if (a.dataset.enter === 'scan' || a.dataset.qty !== undefined) {
    e.preventDefault(); a.blur();
    if (a.dataset.qty !== undefined && S.screen === 'pick') { const t = curTask(S.st); if (t && S.st.step === 'item') return confirmPick(S.st, t, Math.min(S.st.qtyNow, t.qty)); }
    focusScan();
  }
});
document.addEventListener('focusout', () => { setTimeout(() => { if (S.dirty && !editingInput()) render(); else if (!editingInput()) focusScan(); }, 60); });

// Scanner input: keyboard-wedge (Enter/Tab suffix) plus suffix-less bursts and direct fill
let lastIn = 0, fast = 0, autoT = null, prevLen = 0;
scanInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' || (e.key === 'Tab' && scanInput.value.trim())) {
    e.preventDefault(); clearTimeout(autoT);
    const v = scanInput.value; scanInput.value = ''; prevLen = 0; handleScan(v);
  }
});
scanInput.addEventListener('input', () => {
  const now = performance.now(), dt = now - lastIn; lastIn = now;
  const len = scanInput.value.length, jump = len - prevLen; prevLen = len;
  fast = dt < 45 ? fast + 1 : 0;
  clearTimeout(autoT);
  if (!S.kbd && (fast >= 3 || jump >= 4)) autoT = setTimeout(() => { const v = scanInput.value; if (v.trim()) { scanInput.value = ''; prevLen = 0; handleScan(v); } }, 160);
});
scanInput.addEventListener('focus', () => { $('#scanhint').innerHTML = '<span class="dot ok"></span>Szkenner kész'; });
scanInput.addEventListener('blur', () => { $('#scanhint').innerHTML = '<span class="dot"></span>Koppints a mezőbe a szkenneléshez'; });
// Wedge keystrokes that arrive while nothing is focused
let kbuf = '', kt = 0;
document.addEventListener('keydown', e => {
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
  if (e.key === 'Enter') { if (kbuf.length) { const v = kbuf; kbuf = ''; e.preventDefault(); handleScan(v); } return; }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { const now = Date.now(); if (now - kt > 400) kbuf = ''; kt = now; kbuf += e.key; }
});

/* ---------- boot ---------- */
function rebuildCodeIndex() {
  S.codeIndex.clear();
  for (const it of S.items.values()) { S.codeIndex.set(it.sku, it.sku); S.codeIndex.set(it.sku.toUpperCase(), it.sku); (it.eans || []).forEach(e => S.codeIndex.set(String(e), it.sku)); }
}
function markGot(k) { S.got[k] = true; const was = S.loaded; S.loaded = ['items', 'locs', 'stock', 'orders', 'ho', 'cfg'].every(x => S.got[x]); if (!was && S.loaded) setTimeout(maybeAutoBackup, 3000); }
function subscribe() {
  const db = S.db;
  const sub = (q, fn) => q.onSnapshot(snap => { fn(snap); requestRender(true); });
  sub(db.collection('items'), s => { S.items.clear(); s.docs.forEach(d => { const x = d.data(); if (x && x.sku) S.items.set(x.sku, x); }); rebuildCodeIndex(); markGot('items'); });
  sub(db.collection('locations'), s => { S.locs.clear(); s.docs.forEach(d => { const x = d.data(); if (x && x.code) S.locs.set(x.code, x); }); markGot('locs'); });
  sub(db.collection('stock'), s => { S.stock.clear(); s.docs.forEach(d => { const x = d.data(); if (x && x.loc && x.sku && typeof x.qty === 'number' && x.qty !== 0) S.stock.set(x.loc + '|' + x.sku, { loc: x.loc, sku: x.sku, qty: x.qty }); }); markGot('stock'); });
  sub(db.collection('orders').where('status', 'in', ['NEW', 'PICKING', 'PICKED', 'LOADED']), s => {
    S.orders.clear(); S.orderIndex.clear();
    s.docs.forEach(d => { const x = d.data(); if (!x || !x.orderNo) return; S.orders.set(x.orderNo, x); S.orderIndex.set(x.orderNo, x.orderNo); S.orderIndex.set(x.orderNo.toUpperCase(), x.orderNo); if (x.tracking) S.orderIndex.set(String(x.tracking), x.orderNo); });
    markGot('orders');
  });
  sub(db.collection('handovers').orderBy('createdAt', 'desc').limit(60), s => { S.handovers.clear(); s.docs.forEach(d => { const x = d.data(); if (x && x.id) S.handovers.set(x.id, x); }); markGot('ho'); });
  sub(db.doc('config/main'), s => { const c = s.exists ? s.data() : {}; S.cfg = Object.assign({}, DEFAULT_CFG, c, { carriers: Array.isArray(c.carriers) && c.carriers.length ? c.carriers : DEFAULT_CFG.carriers }); markGot('cfg'); });
}
async function boot() {
  S.st = SCREENS.home.init();
  render();
  try { await LocalDB.init(); S.db = LocalDB; S.dbState = 'ok'; }
  catch (e) { S.dbState = 'none'; render(); return; }
  subscribe();
  if (Native && Native.App) {
    try {
      Native.App.addListener('backButton', () => {
        if (S.screen !== 'home') return GLOBAL_ACTS.back();
        if (Native.App.minimizeApp) Native.App.minimizeApp(); else Native.App.exitApp();
      });
      Native.App.addListener('resume', () => { focusScan(); maybeAutoBackup(); });
    } catch (e) {}
  }
  setInterval(maybeAutoBackup, 15 * 60 * 1000);
}
boot();
})();
