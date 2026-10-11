'use strict';
/* Campus Companion – offline-first client.
   Every screen reads from IndexedDB. Writes are applied locally at once and
   queued in an outbox; sync() pushes the queue to the ESP32 hub and pulls
   whatever changed since the last revision we saw. */

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SYNC_EVERY_MS = 15000;

// Keep in sync with kSpecs in store.cpp (the first field is required there).
const SCHEMA = {
  announcements: { admin: true, one: 'announcement', fields: [
    { n: 'title', l: 'Title', t: 'text', max: 80, req: true },
    { n: 'body', l: 'Message', t: 'textarea', max: 600 },
    { n: 'priority', l: 'Priority', t: 'select', opts: ['normal', 'high'] },
    { n: 'author', l: 'Posted by', t: 'text', max: 40, def: () => prefs.name },
  ] },
  events: { admin: true, one: 'event', fields: [
    { n: 'title', l: 'Title', t: 'text', max: 80, req: true },
    { n: 'start', l: 'Starts', t: 'datetime', req: true },
    { n: 'end', l: 'Ends', t: 'datetime' },
    { n: 'location', l: 'Where', t: 'text', max: 60 },
    { n: 'body', l: 'Details', t: 'textarea', max: 400 },
  ] },
  timetable: { admin: true, one: 'class', fields: [
    { n: 'course', l: 'Course', t: 'text', max: 60, req: true },
    { n: 'day', l: 'Day', t: 'select', opts: DAYS, def: () => state.ui.day },
    { n: 'start', l: 'Starts', t: 'time', req: true },
    { n: 'end', l: 'Ends', t: 'time' },
    { n: 'room', l: 'Room', t: 'text', max: 30 },
    { n: 'group', l: 'Group / section', t: 'text', max: 20, def: () => prefs.group },
    { n: 'teacher', l: 'Teacher', t: 'text', max: 40 },
  ] },
  lostfound: { admin: false, one: 'lost & found post', fields: [
    { n: 'item', l: 'What', t: 'text', max: 60, req: true },
    { n: 'kind', l: 'I…', t: 'select', opts: ['lost', 'found'], labels: ['lost this', 'found this'] },
    { n: 'location', l: 'Where', t: 'text', max: 60 },
    { n: 'contact', l: 'How to reach you', t: 'text', max: 60, def: () => prefs.name },
    { n: 'body', l: 'Details', t: 'textarea', max: 300 },
    { n: 'resolved', l: 'Resolved', t: 'bool' },
  ] },
  board: { admin: false, one: 'post', fields: [
    { n: 'body', l: 'Message', t: 'textarea', max: 280, req: true },
    { n: 'author', l: 'Name', t: 'text', max: 40, def: () => prefs.name },
  ] },
};

const TITLES = { home: 'Campus Companion', news: 'Announcements', classes: 'Timetable', events: 'Events',
  more: 'More', lost: 'Lost & Found', board: 'Notice Board', map: 'Campus Map', me: 'Me & Settings' };
const TAB_OF = { lost: 'more', board: 'more', map: 'more', me: 'more' };

/* ------------------------------------------------------------------ utils */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const text = s => esc(s).replace(/\n/g, '<br>');
const pad = n => String(n).padStart(2, '0');
const todayKey = () => WEEK[new Date().getDay()];
const nowHM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const hex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
const newId = () => Date.now().toString(36) + '-' + hex(4); // crypto.randomUUID needs HTTPS; this doesn't

function lsGet(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } }
function ssGet(k) { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } }
function ssSet(k, v) { try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch { /* blocked */ } }

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString([], { day: 'numeric', month: 'short' });
}
function fmtWhen(str) {
  const d = new Date(str);
  if (isNaN(d)) return '';
  return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
const clock = ms => ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

/* ------------------------------------------------------------------ state */
const prefs = Object.assign({ name: '', group: '' }, lsGet('cc.prefs', {}));
const state = {
  data: {}, notes: [], pending: 0,
  syncing: false, online: null, lastSync: 0,
  admin: !!ssGet('cc.pin'),
  hub: null, hubAt: 0, campus: lsGet('cc.campus', null),
  ui: { day: DAYS.includes(todayKey()) ? todayKey() : 'Mon', group: prefs.group, lf: 'open', place: '', mapQ: '' },
};
let meta = { rev: 0, epoch: '', ownerKey: '', mine: [] };

const items = col => state.data[col] || [];
const find = (col, id) => items(col).find(i => i.id === id);
const pick = (col, it) => Object.fromEntries(SCHEMA[col].fields.filter(f => it[f.n] !== undefined).map(f => [f.n, it[f.n]]));
const canAdd = col => state.admin || !SCHEMA[col].admin;
const canEdit = (col, it) => state.admin || (!SCHEMA[col].admin && meta.mine.includes(it.id));

async function loadMeta() {
  meta = Object.assign(meta, await DB.get('meta', 'sync'));
  if (!meta.ownerKey) { meta.ownerKey = hex(12); await saveMeta(); }
}
const saveMeta = () => DB.put('meta', meta, 'sync');

async function refresh() {
  const data = Object.fromEntries(Object.keys(SCHEMA).map(k => [k, []]));
  for (const it of await DB.all('items')) (data[it.col] ||= []).push(it);
  state.data = data;
  state.notes = await DB.all('mine');
  state.pending = await DB.count('outbox');
}

/* ------------------------------------------------------------ local writes */
async function mutate(col, op, data, id) {
  id = id || newId();
  const key = `${col}:${id}`;
  const existing = find(col, id);
  if (op === 'del') {
    await DB.del('items', key);
  } else {
    await DB.put('items', { ...data, key, col, id, ts: existing?.ts || Math.floor(Date.now() / 1000), _pending: true });
    if (!existing && !SCHEMA[col].admin) { meta.mine.push(id); await saveMeta(); }
  }
  await DB.put('outbox', { col, id, op, data: op === 'del' ? null : data });
  await refresh();
  render();
  setTimeout(sync, 50);
}

/* ------------------------------------------------------------------- sync */
async function api(path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(path, body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal,
    } : { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

async function clearHubItems() {
  const keep = new Set((await DB.all('outbox')).map(o => `${o.col}:${o.id}`));
  const all = await DB.all('items');
  await DB.batch('items', s => all.forEach(it => { if (!keep.has(it.key)) s.del(it.key); }));
}

async function applyItems(list) {
  if (!list.length) return;
  const queued = new Set((await DB.all('outbox')).map(o => `${o.col}:${o.id}`));
  await DB.batch('items', s => {
    for (const it of list) {
      const key = `${it.col}:${it.id}`;
      if (queued.has(key)) continue; // our newer local edit wins until it is pushed
      if (it.deleted) s.del(key); else s.put({ ...it, key });
    }
  });
}

/* Returns the last hub response, or null when the hub is unreachable. */
async function sync() {
  if (state.syncing) return null;
  state.syncing = true;
  updatePill();
  let last = null;
  try {
    const batch = (await DB.all('outbox')).slice(0, 20);
    let { rev: since, epoch } = meta;
    let after = since, first = true, rejected = false, resetDone = false;

    for (let guard = 0; guard < 100; guard++) {
      const pin = ssGet('cc.pin');
      const body = { since, after, epoch, clientTime: Date.now(), ops: [] };
      if (pin) body.pin = pin;
      if (first) body.ops = batch.map(o => ({ col: o.col, id: o.id, op: o.op, data: o.data, key: meta.ownerKey }));

      const res = last = await api('/api/sync', body);

      if (first) {
        first = false;
        const results = res.results || [];
        for (let i = 0; i < results.length; i++) {
          await DB.del('outbox', batch[i].seq);
          if (!results[i].ok) { rejected = true; toast(`Hub rejected a change: ${results[i].err}`); }
        }
        if (pin && !res.admin) { ssSet('cc.pin', ''); state.admin = false; toast('Admin PIN not accepted — admin mode off'); }
      }

      // Start over from scratch if the hub says our copy may be stale, or if
      // it rejected a write (so the optimistic local copy gets replaced).
      if (res.reset || (rejected && !resetDone)) {
        resetDone = true;
        await clearHubItems();
        since = after = 0;
        epoch = '';
        continue;
      }
      await applyItems(res.items || []);
      after = res.cursor;
      if (!res.more) {
        meta.rev = res.cursor;
        meta.epoch = res.epoch;
        await saveMeta();
        break;
      }
    }
    state.online = true;
    state.lastSync = Date.now();
  } catch (err) {
    state.online = false;
    last = null;
  } finally {
    state.syncing = false;
    await refresh();
    render({ background: true });
  }
  if (state.online && state.pending) setTimeout(sync, 200); // more than one batch queued
  return last;
}

/* ------------------------------------------------------------------ views */
const empty = msg => `<p class="empty">${esc(msg)}</p>`;
const pendingTag = it => it._pending ? '<span class="tag pend" title="Saved on this phone, will upload when the hub is in range">⏳ not synced yet</span>' : '';
const addButton = col => canAdd(col) ? `<button class="btn primary block" data-act="add" data-col="${col}">＋ New ${esc(SCHEMA[col].one)}</button>` : '';
function actions(col, it, extra = '') {
  if (!canEdit(col, it)) return '';
  return `<div class="acts">${extra}<button class="btn ghost sm" data-act="edit" data-col="${col}" data-id="${esc(it.id)}">Edit</button><button class="btn ghost sm danger" data-act="del" data-col="${col}" data-id="${esc(it.id)}">Delete</button></div>`;
}

const annSort = (a, b) => (b.priority === 'high') - (a.priority === 'high') || (b.ts || 0) - (a.ts || 0) || (b.rev || 0) - (a.rev || 0);
const cardAnn = it => `<article class="card ${it.priority === 'high' ? 'hi' : ''}">
  <h3>${it.priority === 'high' ? '📌 ' : ''}${esc(it.title)}</h3>
  <p class="meta">${esc([it.author, ago(it.ts)].filter(Boolean).join(' · '))} ${pendingTag(it)}</p>
  ${it.body ? `<p>${text(it.body)}</p>` : ''}${actions('announcements', it)}</article>`;

function eventsSplit() {
  const now = Date.now();
  const all = items('events').map(e => ({ ...e, _s: Date.parse(e.start) || 0, _e: Date.parse(e.end) || Date.parse(e.start) || 0 }));
  return {
    upcoming: all.filter(e => e._e >= now).sort((a, b) => a._s - b._s),
    past: all.filter(e => e._e < now).sort((a, b) => b._s - a._s),
  };
}
const cardEvent = it => {
  const live = it._s <= Date.now() && it._e >= Date.now();
  return `<article class="card evt">
  <div class="date"><b>${new Date(it._s).getDate() || '?'}</b><span>${it._s ? new Date(it._s).toLocaleString([], { month: 'short' }) : ''}</span></div>
  <div class="grow"><h3>${esc(it.title)} ${live ? '<span class="tag live">happening now</span>' : ''}</h3>
  <p class="meta">🕒 ${esc(fmtWhen(it.start))}${it.end ? ' – ' + esc(fmtWhen(it.end).split(', ').pop()) : ''}${it.location ? ' · 📍 ' + esc(it.location) : ''} ${pendingTag(it)}</p>
  ${it.body ? `<p>${text(it.body)}</p>` : ''}${actions('events', it)}</div></article>`;
};

function classesFor(day, group) {
  return items('timetable').filter(c => c.day === day && (!group || c.group === group)).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
}
function classRow(c, today) {
  const t = nowHM();
  const now = today && c.start <= t && (c.end || c.start) > t;
  const done = today && (c.end || c.start) <= t;
  return `<article class="card row cls ${now ? 'now' : ''} ${done ? 'done' : ''}">
  <div class="time"><b>${esc(c.start)}</b><span>${esc(c.end || '')}</span></div>
  <div class="grow"><h3>${esc(c.course)} ${now ? '<span class="tag live">now</span>' : ''}</h3>
  <p class="meta">${esc([c.room && '🚪 ' + c.room, c.teacher].filter(Boolean).join(' · '))} ${c.group ? `<span class="tag">${esc(c.group)}</span>` : ''} ${pendingTag(c)}</p>
  ${actions('timetable', c)}</div></article>`;
}

function viewHome() {
  const day = todayKey();
  const today = classesFor(day, prefs.group);
  const t = nowHM();
  const next = today.find(c => c.start > t);
  const news = items('announcements').slice().sort(annSort).slice(0, 3);
  const { upcoming } = eventsSplit();
  const openLF = items('lostfound').filter(i => !i.resolved).length;
  const hello = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening';
  return `
  <section class="hero">
    <p class="muted">${esc(new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }))}</p>
    <h2>${hello}${prefs.name ? ', ' + esc(prefs.name) : ''} 👋</h2>
    <p>${today.length ? `${today.length} class${today.length > 1 ? 'es' : ''} today${next ? ` · next: <b>${esc(next.course)}</b> at ${esc(next.start)}${next.room ? ' in ' + esc(next.room) : ''}` : ' · all done for today'}` : 'No classes today.'}</p>
    ${!prefs.group ? '<p class="small"><a href="#me">Set your group</a> to see only your classes.</p>' : ''}
  </section>
  ${today.length ? `<h2 class="sec">Today${prefs.group ? ` · ${esc(prefs.group)}` : ''} <a href="#classes">Week →</a></h2>${today.map(c => classRow(c, true)).join('')}` : ''}
  <h2 class="sec">Latest news <a href="#news">All →</a></h2>
  ${news.length ? news.map(cardAnn).join('') : empty('Nothing yet.')}
  <h2 class="sec">Coming up <a href="#events">All →</a></h2>
  ${upcoming.length ? upcoming.slice(0, 3).map(cardEvent).join('') : empty('No upcoming events.')}
  <div class="tiles">
    <a class="tile" href="#lost"><span>🔎</span><b>${openLF}</b> open lost &amp; found</a>
    <a class="tile" href="#board"><span>💬</span><b>${items('board').length}</b> board posts</a>
    <a class="tile" href="#map"><span>🗺️</span>Campus map</a>
    <a class="tile" href="#me"><span>📝</span><b>${state.notes.filter(n => !n.done).length}</b> my to-dos</a>
  </div>`;
}

function viewNews() {
  const list = items('announcements').slice().sort(annSort);
  return addButton('announcements') + (list.length ? list.map(cardAnn).join('') : empty('No announcements yet.'));
}

function viewClasses() {
  const groups = [...new Set(items('timetable').map(c => c.group).filter(Boolean))].sort();
  const g = state.ui.group;
  const list = classesFor(state.ui.day, g);
  return `
  <div class="chips">${DAYS.map(d => `<button class="chip ${d === state.ui.day ? 'on' : ''}" data-act="day" data-v="${d}">${d}${d === todayKey() ? ' •' : ''}</button>`).join('')}</div>
  <label class="inline">Group
    <select id="group-sel"><option value="">All groups</option>${groups.map(x => `<option ${x === g ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
  </label>
  ${addButton('timetable')}
  ${list.length ? list.map(c => classRow(c, state.ui.day === todayKey())).join('') : empty(`No classes on ${state.ui.day}${g ? ' for ' + g : ''}.`)}`;
}

function viewEvents() {
  const { upcoming, past } = eventsSplit();
  return addButton('events') +
    (upcoming.length ? upcoming.map(cardEvent).join('') : empty('No upcoming events.')) +
    (past.length ? `<details class="past"><summary>Past events (${past.length})</summary>${past.map(cardEvent).join('')}</details>` : '');
}

function viewLost() {
  const f = state.ui.lf;
  const list = items('lostfound')
    .filter(i => f === 'resolved' ? i.resolved : !i.resolved && (f === 'open' || i.kind === f))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const seg = [['open', 'All open'], ['lost', 'Lost'], ['found', 'Found'], ['resolved', 'Resolved']];
  return `
  <div class="chips">${seg.map(([v, l]) => `<button class="chip ${v === f ? 'on' : ''}" data-act="lf" data-v="${v}">${l}</button>`).join('')}</div>
  ${addButton('lostfound')}
  ${list.length ? list.map(it => `<article class="card ${it.resolved ? 'done' : ''}">
    <h3><span class="tag ${it.kind === 'found' ? 'ok' : 'warn'}">${it.kind === 'found' ? 'FOUND' : 'LOST'}</span> ${esc(it.item)} ${it.resolved ? '<span class="tag">resolved</span>' : ''}</h3>
    <p class="meta">${esc([it.location && '📍 ' + it.location, ago(it.ts)].filter(Boolean).join(' · '))} ${pendingTag(it)}</p>
    ${it.body ? `<p>${text(it.body)}</p>` : ''}
    ${it.contact ? `<p class="small">Contact: <b>${esc(it.contact)}</b></p>` : ''}
    ${actions('lostfound', it, `<button class="btn ghost sm" data-act="resolve" data-col="lostfound" data-id="${esc(it.id)}">${it.resolved ? 'Reopen' : 'Mark resolved'}</button>`)}
  </article>`).join('') : empty('Nothing here.')}`;
}

function viewBoard() {
  const list = items('board').slice().sort((a, b) => (b.ts || 0) - (a.ts || 0) || (b.rev || 0) - (a.rev || 0));
  return `
  <form class="card composer" data-form="board">
    <textarea name="body" maxlength="280" rows="3" required placeholder="Share something with campus…"></textarea>
    <div class="row between"><input name="author" maxlength="40" placeholder="Your name" value="${esc(prefs.name)}"><button class="btn primary">Post</button></div>
  </form>
  ${list.length ? list.map(it => `<article class="card post">
    <p>${text(it.body)}</p>
    <p class="meta">— ${esc(it.author || 'Anonymous')} · ${esc(ago(it.ts))} ${pendingTag(it)}</p>
    ${actions('board', it)}</article>`).join('') : empty('Be the first to post.')}`;
}

function viewMap() {
  const c = state.campus;
  if (!c) { loadCampus(); return empty('Loading map…'); }
  const sel = state.ui.place;
  const W = c.width || 400, H = c.height || 300;
  const shapes = (c.places || []).map(p => `<g class="place ${p.type || ''} ${p.id === sel ? 'sel' : ''}" data-act="place" data-id="${esc(p.id)}">
    <rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="4"/>
    <text x="${p.x + p.w / 2}" y="${p.y + p.h / 2}">${esc(p.short || p.name)}</text></g>`).join('');
  const paths = (c.paths || []).map(d => `<path class="walk" d="${esc(d)}"/>`).join('');
  return `
  <div class="card mapwrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Campus map">${paths}${shapes}</svg></div>
  <input id="map-q" type="search" placeholder="Search buildings, offices, services…" value="${esc(state.ui.mapQ)}">
  <div id="dir">${dirList()}</div>`;
}
function dirList() {
  const q = state.ui.mapQ.trim().toLowerCase();
  const list = (state.campus?.places || []).filter(p => !q || JSON.stringify(p).toLowerCase().includes(q))
    .sort((a, b) => (b.id === state.ui.place) - (a.id === state.ui.place)); // selected building first
  return list.length ? list.map(p => `<article class="card place-card ${p.id === state.ui.place ? 'sel' : ''}" data-act="place" data-id="${esc(p.id)}">
    <h3>${esc(p.name)}</h3>
    ${p.desc ? `<p>${esc(p.desc)}</p>` : ''}
    <p class="meta">${esc([p.hours && '🕒 ' + p.hours, p.phone && '☎️ ' + p.phone].filter(Boolean).join(' · '))}</p></article>`).join('') : empty('No matches.');
}
async function loadCampus() {
  if (loadCampus.busy) return;
  loadCampus.busy = true;
  try {
    const r = await fetch('campus.json', { cache: 'no-cache' });
    if (r.ok) { state.campus = await r.json(); lsSet('cc.campus', state.campus); }
  } catch { /* offline: keep the cached copy */ }
  loadCampus.busy = false;
  if (!state.campus) state.campus = { places: [] };
  if (route() === 'map') render({ background: true });
}

function viewMore() {
  const t = (href, icon, title, sub) => `<a class="tile big" href="${href}"><span>${icon}</span><b>${title}</b><small>${sub}</small></a>`;
  return `<div class="tiles">
    ${t('#lost', '🔎', 'Lost &amp; Found', 'Report or claim items')}
    ${t('#board', '💬', 'Notice Board', 'Posts from students')}
    ${t('#map', '🗺️', 'Campus Map', 'Buildings &amp; offices')}
    ${t('#me', '⚙️', 'Me &amp; Settings', 'Profile, to-dos, admin')}
  </div>`;
}

function viewMe() {
  if (Date.now() - state.hubAt > 10000) loadHub();
  const h = state.hub;
  const groups = [...new Set(items('timetable').map(c => c.group).filter(Boolean))].sort();
  const notes = state.notes.slice().sort((a, b) => a.done - b.done || b.ts - a.ts);
  return `
  <form class="card" data-form="prefs">
    <h3>Profile</h3>
    <label>Name<input name="name" maxlength="40" value="${esc(prefs.name)}" placeholder="Used as the default author"></label>
    <label>My group / section<input name="group" maxlength="20" list="groups" value="${esc(prefs.group)}" placeholder="e.g. CSE-A"></label>
    <datalist id="groups">${groups.map(g => `<option value="${esc(g)}">`).join('')}</datalist>
    <button class="btn primary">Save</button>
  </form>

  <section class="card">
    <h3>My to-dos <span class="muted small">· only on this phone</span></h3>
    <form class="row" data-form="note"><input name="text" maxlength="200" required placeholder="Submit lab record…"><button class="btn primary">Add</button></form>
    ${notes.length ? `<ul class="todo">${notes.map(n => `<li class="${n.done ? 'done' : ''}">
      <label><input type="checkbox" data-act="note-toggle" data-id="${esc(n.id)}" ${n.done ? 'checked' : ''}> ${esc(n.text)}</label>
      <button class="btn ghost sm" data-act="note-del" data-id="${esc(n.id)}" aria-label="Delete">✕</button></li>`).join('')}</ul>` : '<p class="muted small">No to-dos.</p>'}
  </section>

  <section class="card">
    <h3>Admin</h3>
    ${state.admin
      ? `<p>Admin mode is <b>on</b> for this tab. You can add and edit announcements, events and the timetable.</p><button class="btn ghost" data-act="logout">Turn off admin mode</button>`
      : `<form class="row" data-form="login"><input name="pin" type="password" inputmode="numeric" autocomplete="off" required placeholder="Admin PIN"><button class="btn primary">Unlock</button></form>`}
  </section>

  <section class="card">
    <h3>Hub &amp; sync</h3>
    <dl class="kv">
      <dt>Status</dt><dd>${state.online ? '🟢 connected' : state.online === false ? '⚪ out of range' : '…'}</dd>
      <dt>Last sync</dt><dd>${state.lastSync ? esc(clock(state.lastSync)) : 'never this session'}</dd>
      <dt>Waiting to upload</dt><dd>${state.pending}</dd>
      <dt>Local revision</dt><dd>${meta.rev}</dd>
      ${h ? `<dt>Hub</dt><dd>${esc(h.name)} v${esc(h.version)}</dd>
      <dt>Hub uptime</dt><dd>${Math.floor(h.uptime / 3600)}h ${Math.floor(h.uptime % 3600 / 60)}m</dd>
      <dt>Phones connected</dt><dd>${h.stations}</dd>
      <dt>Records on hub</dt><dd>${h.records} (rev ${h.rev})</dd>
      <dt>Free memory</dt><dd>${Math.round(h.heap / 1024)} KB${h.psram ? ` + ${Math.round(h.psram / 1024)} KB PSRAM` : ''}</dd>
      <dt>Storage used</dt><dd>${h.fsUsed}%</dd>` : ''}
      <dt>Offline storage</dt><dd>${DB.isPersistent ? 'IndexedDB ✔' : '⚠️ memory only (private mode?)'}</dd>
    </dl>
    <div class="row"><button class="btn primary" data-act="sync">Sync now</button><button class="btn ghost danger" data-act="reset">Clear local copy</button></div>
  </section>
  <p class="muted small center">Campus Companion · works without internet · runs on an ESP32-S3</p>`;
}
async function loadHub() {
  state.hubAt = Date.now();
  try { state.hub = await api('/api/info'); } catch { state.hub = null; }
  if (route() === 'me') render({ background: true });
}

/* ----------------------------------------------------------------- render */
const ROUTES = { home: viewHome, news: viewNews, classes: viewClasses, events: viewEvents, more: viewMore,
  lost: viewLost, board: viewBoard, map: viewMap, me: viewMe };
const route = () => { const r = location.hash.slice(1); return ROUTES[r] ? r : 'home'; };
let deferred = false;

function render({ background = false } = {}) {
  // Don't yank the page out from under someone who is typing.
  const a = document.activeElement;
  if (background && a && $('#view').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { deferred = true; updatePill(); return; }
  deferred = false;
  const r = route();
  $('#view').innerHTML = ROUTES[r]();
  $('#page-title').textContent = TITLES[r];
  document.querySelectorAll('.tabs a').forEach(el => el.classList.toggle('on', el.dataset.tab === (TAB_OF[r] || r)));
  updatePill();
}

function updatePill() {
  let cls = '', txt = 'Connecting…';
  if (state.syncing) { cls = 'busy'; txt = 'Syncing…'; }
  else if (state.online) { cls = 'ok'; txt = state.pending ? `${state.pending} queued` : `Synced ${clock(state.lastSync)}`; }
  else if (state.online === false) { cls = 'off'; txt = 'Offline' + (state.pending ? ` · ${state.pending} queued` : ''); }
  $('#sync-pill').className = 'pill ' + cls;
  $('#sync-text').textContent = txt;
}

/* ------------------------------------------------------------------ forms */
function fieldHTML(f, it) {
  const v = it ? it[f.n] : (f.def ? f.def() : undefined);
  const req = f.req ? 'required' : '';
  const max = f.max ? `maxlength="${f.max}"` : '';
  switch (f.t) {
    case 'textarea': return `<label>${f.l}<textarea name="${f.n}" rows="4" ${max} ${req}>${esc(v)}</textarea></label>`;
    case 'select': return `<label>${f.l}<select name="${f.n}">${f.opts.map((o, i) => `<option value="${o}" ${o === v ? 'selected' : ''}>${esc(f.labels ? f.labels[i] : o)}</option>`).join('')}</select></label>`;
    case 'bool': return `<label class="check"><input type="checkbox" name="${f.n}" ${v ? 'checked' : ''}> ${f.l}</label>`;
    case 'datetime': return `<label>${f.l}<input type="datetime-local" name="${f.n}" value="${esc(v)}" ${req}></label>`;
    case 'time': return `<label>${f.l}<input type="time" name="${f.n}" value="${esc(v)}" ${req}></label>`;
    default: return `<label>${f.l}<input name="${f.n}" value="${esc(v)}" ${max} ${req}></label>`;
  }
}

function openForm(col, it) {
  const s = SCHEMA[col];
  const modal = $('#modal'), form = $('#modal-form');
  form.innerHTML = `<h2>${it ? 'Edit' : 'New'} ${esc(s.one)}</h2>
    ${s.fields.filter(f => it || f.t !== 'bool').map(f => fieldHTML(f, it)).join('')}
    ${s.admin ? '' : '<p class="muted small">Only this phone (or an admin) can edit or delete it later.</p>'}
    <div class="row end"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Save</button></div>`;
  modal.returnValue = '';
  modal.onclose = async () => {
    if (modal.returnValue !== 'ok') return;
    const data = {};
    for (const f of s.fields) {
      const el = form.elements[f.n];
      if (!el) continue;
      data[f.n] = f.t === 'bool' ? el.checked : el.value.trim();
    }
    await mutate(col, 'put', data, it?.id);
    toast(state.online === false ? 'Saved on this phone — will sync when the hub is in range' : 'Saved');
  };
  modal.showModal();
  form.querySelector('input,textarea,select')?.focus();
}

/* ----------------------------------------------------------------- events */
$('#view').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const { act, col, id } = b.dataset;
  switch (act) {
    case 'add': return openForm(col);
    case 'edit': return openForm(col, find(col, id));
    case 'del':
      if (confirm('Delete this for everyone?')) await mutate(col, 'del', null, id);
      return;
    case 'resolve': {
      const it = find(col, id);
      return mutate(col, 'put', { ...pick(col, it), resolved: !it.resolved }, id);
    }
    case 'day': state.ui.day = b.dataset.v; return render();
    case 'lf': state.ui.lf = b.dataset.v; return render();
    case 'place': state.ui.place = state.ui.place === id ? '' : id; return render();
    case 'sync': {
      const r = await sync();
      return toast(r ? 'Synced with hub' : 'Hub not reachable — connect to the CampusCompanion Wi-Fi');
    }
    case 'logout': ssSet('cc.pin', ''); state.admin = false; return render();
    case 'note-toggle': {
      const n = state.notes.find(x => x.id === id);
      await DB.put('mine', { ...n, done: !n.done });
      break;
    }
    case 'note-del': await DB.del('mine', id); break;
    case 'reset':
      if (!confirm('Remove the downloaded campus data from this phone? Unsynced changes are kept, your to-dos too.')) return;
      await clearHubItems();
      meta.rev = 0; meta.epoch = '';
      await saveMeta();
      await refresh(); render();
      await sync();
      return;
    default: return;
  }
  await refresh();
  render();
});

$('#view').addEventListener('submit', async e => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(f));
  switch (f.dataset.form) {
    case 'board':
      if (v.author) { prefs.name = prefs.name || v.author.trim(); lsSet('cc.prefs', prefs); }
      await mutate('board', 'put', { body: v.body.trim(), author: (v.author || '').trim() });
      break;
    case 'prefs':
      prefs.name = v.name.trim(); prefs.group = v.group.trim();
      state.ui.group = prefs.group;
      lsSet('cc.prefs', prefs);
      toast('Profile saved');
      render();
      break;
    case 'note':
      await DB.put('mine', { id: newId(), text: v.text.trim(), done: false, ts: Date.now() });
      await refresh(); render();
      $('#view input[name=text]')?.focus();
      break;
    case 'login': {
      ssSet('cc.pin', v.pin);
      const r = await sync();
      if (r?.admin) { state.admin = true; toast('Admin mode on'); }
      else if (!r) { ssSet('cc.pin', ''); toast('Hub not reachable — the PIN is checked by the hub'); }
      render();
      break;
    }
  }
});

$('#view').addEventListener('change', e => {
  if (e.target.id === 'group-sel') { state.ui.group = e.target.value; render(); }
});
$('#view').addEventListener('input', e => {
  if (e.target.id === 'map-q') { state.ui.mapQ = e.target.value; $('#dir').innerHTML = dirList(); }
});
$('#view').addEventListener('focusout', () => setTimeout(() => {
  if (deferred && !$('#view').contains(document.activeElement)) render();
}, 0));

$('#sync-pill').addEventListener('click', async () => {
  const r = await sync();
  toast(r ? 'Synced with hub' : 'Hub not reachable — connect to the CampusCompanion Wi-Fi');
});
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
window.addEventListener('online', () => sync());
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
setInterval(() => { if (!document.hidden) sync(); }, SYNC_EVERY_MS);
setInterval(() => { if (!document.hidden && !state.syncing) render({ background: true }); }, 60000); // "now"/"next" badges

/* ------------------------------------------------------------------- boot */
(async function boot() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  await loadMeta();
  await refresh();
  render();
  sync();
  if (!state.campus) loadCampus();
})();
