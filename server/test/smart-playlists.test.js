'use strict';

/*
 * Smart playlists (lib/smart-playlist.js) and "play every N" (lib/repeat-every.js), end to end
 * through the real server: both resolve at publish into an ordinary flat published_snapshot, so
 * these tests read that snapshot, which is exactly what a screen receives.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, BASE, DATA_DIR;
let A, B;   // two tenants: { jwt, workspaceId, userId }

const J = (t, b, m = 'POST') => ({
  method: m,
  headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
  ...(b === undefined ? {} : { body: JSON.stringify(b) }),
});
const api = async (p, ...a) => { const r = await fetch(BASE + p, ...a); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const dbHandle = () => new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db'));
const snapshot = (pl) => {
  const raw = dbHandle();
  const row = raw.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(pl);
  raw.close();
  return row && row.published_snapshot ? JSON.parse(row.published_snapshot) : null;
};
const names = (snap) => (snap || []).map((i) => i.filename);

function addContent(t, filename, { mime = 'image/png', tags = [], meta = {}, dur = null, created = null } = {}) {
  const raw = dbHandle();
  const id = crypto.randomUUID();
  raw.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, duration_sec, tags, meta, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%s','now')))`)
    .run(id, t.userId, t.workspaceId, filename, `uploads/${filename}`, mime, dur, JSON.stringify(tags), JSON.stringify(meta), created);
  raw.close();
  return id;
}

async function register(tag) {
  const reg = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `${tag}${Date.now()}${crypto.randomBytes(2).toString('hex')}@example.com`, password: 'Passw0rd123', name: tag,
  }))).json();
  const raw = dbHandle();
  const u = raw.prepare('SELECT id FROM users WHERE id = ?').get(reg.user && reg.user.id) || raw.prepare('SELECT id FROM users ORDER BY created_at DESC LIMIT 1').get();
  raw.close();
  return { jwt: reg.token, workspaceId: reg.current_workspace_id, userId: u.id };
}

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-'));
  const logFd = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(path.join(DATA_DIR, 'server.log'), 'utf8').slice(-2000));
  A = await register('smarta');
  B = await register('smartb');
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

const LOBBY = { match: 'all', rules: [{ field: 'tag', op: 'has', value: 'lobby' }], sort: 'name' };

test('a smart playlist publishes exactly the content its rules select, as ordinary items', async () => {
  addContent(A, 'lobby-b.png', { tags: ['lobby'] });
  addContent(A, 'lobby-a.mp4', { mime: 'video/mp4', tags: ['lobby'], dur: 31.2 });
  addContent(A, 'kitchen.png', { tags: ['kitchen'] });
  const pl = (await api('/api/playlists', J(A.jwt, { name: 'Lobby', smart_rules: { ...LOBBY, image_duration: 7 } }))).body;
  assert.ok(pl.id, JSON.stringify(pl));
  assert.equal((await api(`/api/playlists/${pl.id}/publish`, J(A.jwt, {}))).status, 200);
  const snap = snapshot(pl.id);
  assert.deepEqual(names(snap), ['lobby-a.mp4', 'lobby-b.png']);
  assert.equal(snap[0].duration_sec, 32, 'video keeps its own length, rounded up');
  assert.equal(snap[1].duration_sec, 7, 'images get the playlist image duration');
  assert.ok(snap.every((i) => i.filepath && i.content_id), 'pinnable like any item');
  assert.deepEqual(snap[0].tags, ['lobby']);
});

test('⚠️ rules never cross tenants: the other workspace\'s matching content is not selected', async () => {
  addContent(B, 'other-tenant-lobby.png', { tags: ['lobby'] });
  const pl = (await api('/api/playlists', J(A.jwt, { name: 'Lobby 2', smart_rules: LOBBY }))).body;
  await api(`/api/playlists/${pl.id}/publish`, J(A.jwt, {}));
  assert.ok(!names(snapshot(pl.id)).includes('other-tenant-lobby.png'));
  const prev = await api('/api/playlists/smart-preview', J(A.jwt, { smart_rules: LOBBY }));
  assert.equal(prev.status, 200);
  assert.ok(!prev.body.items.some((i) => i.filename === 'other-tenant-lobby.png'));
});

test('meta, type, any-match, sort and limit', async () => {
  addContent(A, 'chi-1.png', { meta: { store: 'Chicago' }, created: 1000 });
  addContent(A, 'chi-2.mp4', { mime: 'video/mp4', meta: { store: 'chicago' }, dur: 10, created: 3000 });
  addContent(A, 'nyc-1.png', { meta: { store: 'nyc' }, created: 2000 });
  const r = async (rules) => (await api('/api/playlists/smart-preview', J(A.jwt, { smart_rules: rules }))).body;

  const chi = await r({ rules: [{ field: 'meta', key: 'store', op: 'eq', value: 'CHICAGO' }], sort: 'newest' });
  assert.deepEqual(chi.items.map((i) => i.filename), ['chi-2.mp4', 'chi-1.png'], 'case-insensitive eq, newest first');

  const chiImg = await r({ match: 'all', rules: [{ field: 'meta', key: 'store', op: 'eq', value: 'chicago' }, { field: 'type', op: 'is', value: 'image' }] });
  assert.deepEqual(chiImg.items.map((i) => i.filename), ['chi-1.png']);

  const either = await r({ match: 'any', rules: [{ field: 'meta', key: 'store', op: 'eq', value: 'nyc' }, { field: 'name', op: 'contains', value: 'chi-2' }], sort: 'oldest' });
  assert.deepEqual(either.items.map((i) => i.filename), ['nyc-1.png', 'chi-2.mp4']);

  const one = await r({ rules: [{ field: 'meta', key: 'store', op: 'exists' }], limit: 1, sort: 'name' });
  assert.deepEqual(one.items.map((i) => i.filename), ['chi-1.png']);
});

test('invalid rule sets are refused, and an empty rule set is not "match everything"', async () => {
  for (const bad of [{ rules: [] }, { rules: [{ field: 'nope', op: 'has', value: 'x' }] }, { rules: [{ field: 'tag', op: 'eq', value: 'x' }] }, { rules: [{ field: 'type', op: 'is', value: 'spreadsheet' }] }, 'not json']) {
    const r = await api('/api/playlists', J(A.jwt, { name: 'bad', smart_rules: bad }));
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
});

test('items cannot be hand-added to a smart playlist', async () => {
  const pl = (await api('/api/playlists', J(A.jwt, { name: 'Lobby 3', smart_rules: LOBBY }))).body;
  const cid = addContent(A, 'manual.png');
  assert.equal((await api(`/api/playlists/${pl.id}/items`, J(A.jwt, { content_id: cid }))).status, 400);
  assert.equal((await api(`/api/playlists/${pl.id}/items/bulk`, J(A.jwt, { content_ids: [cid] }))).status, 400);
});

test('⚠️ tagging content republishes a PUBLISHED smart playlist by itself; a draft one waits', async () => {
  const live = (await api('/api/playlists', J(A.jwt, { name: 'Promo live', smart_rules: { rules: [{ field: 'tag', op: 'has', value: 'promo' }] } }))).body;
  const draft = (await api('/api/playlists', J(A.jwt, { name: 'Promo draft', smart_rules: { rules: [{ field: 'tag', op: 'has', value: 'promo' }] } }))).body;
  addContent(A, 'promo-1.png', { tags: ['promo'] });
  await api(`/api/playlists/${live.id}/publish`, J(A.jwt, {}));
  assert.deepEqual(names(snapshot(live.id)), ['promo-1.png']);

  const cid = addContent(A, 'promo-2.png');
  const put = await api(`/api/content/${cid}`, J(A.jwt, { tags: ['promo'] }, 'PUT'));
  assert.equal(put.status, 200, JSON.stringify(put.body));
  let snap;
  // The refresh is a trailing debounce (10s of quiet, lib/smart-playlist.js), so allow ~15s.
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    snap = snapshot(live.id);
    if (snap && snap.length === 2) break;
  }
  assert.deepEqual(names(snap), ['promo-1.png', 'promo-2.png'], 'the new match went live without a manual publish');
  assert.equal(snapshot(draft.id), null, 'a never-published smart playlist is not put live by a content edit');
});

test('a smart playlist nests inside an ordinary one like any child', async () => {
  const child = (await api('/api/playlists', J(A.jwt, { name: 'Lobby child', smart_rules: LOBBY }))).body;
  const parent = (await api('/api/playlists', J(A.jwt, { name: 'Parent' }))).body;
  const cid = addContent(A, 'intro.png');
  await api(`/api/playlists/${parent.id}/items`, J(A.jwt, { content_id: cid, duration_sec: 5 }));
  assert.equal((await api(`/api/playlists/${parent.id}/items`, J(A.jwt, { child_playlist_id: child.id }))).status, 201);
  await api(`/api/playlists/${child.id}/publish`, J(A.jwt, {}));
  await api(`/api/playlists/${parent.id}/publish`, J(A.jwt, {}));
  assert.deepEqual(names(snapshot(parent.id)), ['intro.png', 'lobby-a.mp4', 'lobby-b.png']);
});

test('discard restores the published rules after an unpublished rule edit', async () => {
  const pl = (await api('/api/playlists', J(A.jwt, { name: 'Discard me', smart_rules: LOBBY }))).body;
  await api(`/api/playlists/${pl.id}/publish`, J(A.jwt, {}));
  await api(`/api/playlists/${pl.id}`, J(A.jwt, { smart_rules: { rules: [{ field: 'tag', op: 'has', value: 'kitchen' }] } }, 'PUT'));
  const editing = (await api(`/api/playlists/${pl.id}`, J(A.jwt, undefined, 'GET'))).body;
  assert.equal(editing.status, 'draft');
  assert.deepEqual(editing.smart.items.map((i) => i.filename), ['kitchen.png'], 'the editor shows the new matches');
  assert.equal((await api(`/api/playlists/${pl.id}/discard`, J(A.jwt, {}))).status, 200);
  const back = (await api(`/api/playlists/${pl.id}`, J(A.jwt, undefined, 'GET'))).body;
  assert.deepEqual(back.smart.rules.rules, LOBBY.rules);
});

test('"play every N": a flagged item is woven through the published loop', async () => {
  const pl = (await api('/api/playlists', J(A.jwt, { name: 'Every minute' }))).body;
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(addContent(A, `slide-${String(i).padStart(2, '0')}.png`));
  for (const id of ids) await api(`/api/playlists/${pl.id}/items`, J(A.jwt, { content_id: id, duration_sec: 10 }));
  const promo = addContent(A, 'promo-every.png');
  const added = await api(`/api/playlists/${pl.id}/items`, J(A.jwt, { content_id: promo, duration_sec: 10 }));
  const itemId = added.body.id;
  assert.ok(itemId, JSON.stringify(added.body));

  assert.equal((await api(`/api/playlists/${pl.id}/items/${itemId}`, J(A.jwt, { repeat_every_sec: 5 }, 'PUT'))).status, 400);
  assert.equal((await api(`/api/playlists/${pl.id}/items/${itemId}`, J(A.jwt, { repeat_every_sec: 40 }, 'PUT'))).status, 200);
  await api(`/api/playlists/${pl.id}/publish`, J(A.jwt, {}));
  const snap = snapshot(pl.id);
  const plays = snap.filter((i) => i.filename === 'promo-every.png').length;
  assert.ok(plays >= 3, `promo plays ${plays}x in a 2-minute loop`);
  assert.equal(snap.filter((i) => i.filename === 'slide-00.png').length, 1);
  assert.ok(snap.every((i) => !('repeat_every_sec' in i)), 'the flag never reaches a player');

  // Shuffle has no spacing to keep, so the weave is off there.
  await api(`/api/playlists/${pl.id}`, J(A.jwt, { playback_order: 'shuffle' }, 'PUT'));
  await api(`/api/playlists/${pl.id}/publish`, J(A.jwt, {}));
  assert.equal(snapshot(pl.id).filter((i) => i.filename === 'promo-every.png').length, 1);
});

test('the interval survives duplicate and discard', async () => {
  const pl = (await api('/api/playlists', J(A.jwt, { name: 'Copies' }))).body;
  const a = addContent(A, 'x1.png'); const b = addContent(A, 'x2.png');
  await api(`/api/playlists/${pl.id}/items`, J(A.jwt, { content_id: a }));
  const it = (await api(`/api/playlists/${pl.id}/items`, J(A.jwt, { content_id: b }))).body;
  await api(`/api/playlists/${pl.id}/items/${it.id}`, J(A.jwt, { repeat_every_sec: 60 }, 'PUT'));
  await api(`/api/playlists/${pl.id}/items/${it.id}/duplicate`, J(A.jwt, {}));
  await api(`/api/playlists/${pl.id}/publish`, J(A.jwt, {}));
  await api(`/api/playlists/${pl.id}/items/${it.id}`, J(A.jwt, { repeat_every_sec: null }, 'PUT'));
  await api(`/api/playlists/${pl.id}/discard`, J(A.jwt, {}));
  const items = (await api(`/api/playlists/${pl.id}`, J(A.jwt, undefined, 'GET'))).body.items;
  assert.equal(items.filter((i) => i.repeat_every_sec === 60).length, 2, 'both the original and its duplicate kept 60s');
});

const waitFor = async (fn, ms = 16000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(250); }
  return fn();
};
const setTags = (cid, tags) => api(`/api/content/${cid}`, J(A.jwt, { tags }, 'PUT'));

test('⚠️ nesting renumbers sort_order: players that re-sort keep the parent\'s order', async () => {
  const child = (await api('/api/playlists', J(A.jwt, { name: 'Order child', smart_rules: LOBBY }))).body;
  const parent = (await api('/api/playlists', J(A.jwt, { name: 'Order parent' }))).body;
  await api(`/api/playlists/${parent.id}/items`, J(A.jwt, { content_id: addContent(A, 'first.png'), duration_sec: 5 }));
  await api(`/api/playlists/${parent.id}/items`, J(A.jwt, { child_playlist_id: child.id }));
  await api(`/api/playlists/${parent.id}/items`, J(A.jwt, { content_id: addContent(A, 'last.png'), duration_sec: 5 }));
  await api(`/api/playlists/${parent.id}/publish`, J(A.jwt, {}));
  const snap = snapshot(parent.id);
  const resorted = snap.slice().sort((a, b) => a.sort_order - b.sort_order).map((i) => i.filename);
  assert.deepEqual(resorted, names(snap), 'sorting by sort_order (as Tizen does) changes nothing');
  assert.equal(names(snap)[0], 'first.png');
  assert.equal(names(snap).at(-1), 'last.png');
});

test('a never-published smart child keeps its published parent current', async () => {
  const child = (await api('/api/playlists', J(A.jwt, { name: 'Draft child', smart_rules: { rules: [{ field: 'tag', op: 'has', value: 'news' }] } }))).body;
  const parent = (await api('/api/playlists', J(A.jwt, { name: 'Live parent' }))).body;
  addContent(A, 'news-1.png', { tags: ['news'] });
  await api(`/api/playlists/${parent.id}/items`, J(A.jwt, { child_playlist_id: child.id }));
  await api(`/api/playlists/${parent.id}/publish`, J(A.jwt, {}));
  assert.deepEqual(names(snapshot(parent.id)), ['news-1.png']);
  const cid = addContent(A, 'news-2.png');
  await setTags(cid, ['news']);
  const snap = await waitFor(() => { const s = snapshot(parent.id); return s && s.length === 2 ? s : null; });
  assert.deepEqual(names(snap), ['news-1.png', 'news-2.png']);
  assert.equal(snapshot(child.id), null, 'the child itself stays unpublished');
});

test('⚠️ approval-gated workspace: a refresh may REMOVE matches, never ADD them', async () => {
  const G = await register('gated');
  addContent(G, 'g-keep.png', { tags: ['promo'] });
  const drop = addContent(G, 'g-drop.png', { tags: ['promo'] });
  const pl = (await api('/api/playlists', J(G.jwt, { name: 'Gated', smart_rules: { rules: [{ field: 'tag', op: 'has', value: 'promo' }] } }))).body;
  assert.equal((await api(`/api/playlists/${pl.id}/publish`, J(G.jwt, {}))).status, 200);
  assert.deepEqual(names(snapshot(pl.id)), ['g-drop.png', 'g-keep.png']);
  const raw = dbHandle(); raw.prepare('UPDATE workspaces SET require_approval = 1 WHERE id = ?').run(G.workspaceId); raw.close();

  // Addition: tagged new content must NOT go live without an approved release.
  const added = addContent(G, 'g-new.png');
  assert.equal((await api(`/api/content/${added}`, J(G.jwt, { tags: ['promo'] }, 'PUT'))).status, 200);
  await sleep(12000);
  assert.deepEqual(names(snapshot(pl.id)), ['g-drop.png', 'g-keep.png'], 'the addition waits for approval');

  // Removal: untag one published item (and withdraw the pending addition). The result only removes,
  // so it goes live by itself: content taken off a gated workspace's screens must not wait.
  await api(`/api/content/${added}`, J(G.jwt, { tags: [] }, 'PUT'));
  await api(`/api/content/${drop}`, J(G.jwt, { tags: [] }, 'PUT'));
  const snap = await waitFor(() => { const s = snapshot(pl.id); return s && s.length === 1 ? s : null; });
  assert.deepEqual(names(snap), ['g-keep.png'], 'the removal went live without an approval');
});

test('hand-adding through other routes is refused on a smart playlist', async () => {
  const pl = (await api('/api/playlists', J(A.jwt, { name: 'Guarded', smart_rules: LOBBY }))).body;
  const cid = addContent(A, 'guard.png');
  const paste = await api(`/api/playlists/${pl.id}/items/selection`, J(A.jwt, { action: 'paste', items: [{ content_id: cid, duration_sec: 10 }] }));
  assert.equal(paste.status, 400);
  const normal = (await api('/api/playlists', J(A.jwt, { name: 'Has child' }))).body;
  await api(`/api/playlists/${normal.id}/items`, J(A.jwt, { child_playlist_id: pl.id }));
  const toSmart = await api(`/api/playlists/${normal.id}`, J(A.jwt, { smart_rules: LOBBY }, 'PUT'));
  assert.equal(toSmart.status, 400, 'a playlist that nests others cannot become smart');
});
