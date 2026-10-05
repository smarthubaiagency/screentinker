'use strict';

// "Play this item every N minutes" (lib/repeat-every.js). The weave is pure, so it is pinned here
// directly; the publish-path integration is in smart-playlists.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyRepeatEvery, normalizeRepeatEvery } = require('../lib/repeat-every');

const item = (name, dur = 10, extra = {}) => ({ filename: name, content_id: name, duration_sec: dur, ...extra });

// Seconds between the starts of consecutive plays of `name`, around the loop.
function gaps(list, name) {
  const starts = [];
  let t = 0;
  for (const it of list) { if (it.filename === name) starts.push(t); t += it.duration_sec; }
  return starts.map((s, i) => (i + 1 < starts.length ? starts[i + 1] - s : t - s + starts[0]));
}

test('the Discord example: 30 x 10s items, one set to every 60s, plays about once a minute', () => {
  const list = Array.from({ length: 29 }, (_, i) => item(`c${i}`));
  list.splice(7, 0, item('promo', 10, { repeat_every_sec: 60 }));
  const out = applyRepeatEvery(list);
  const g = gaps(out, 'promo');
  assert.ok(g.length >= 5, `promo plays ${g.length}x per loop`);
  for (const gap of g) assert.ok(gap >= 50 && gap <= 70, `gap ${gap}s is about a minute`);
  // Every other item still plays exactly once per loop, in its original order.
  const rest = out.filter((it) => it.filename !== 'promo').map((it) => it.filename);
  assert.deepEqual(rest, list.filter((it) => it.filename !== 'promo').map((it) => it.filename));
});

test('an interval longer than one loop repeats the loop so the item plays once every few loops', () => {
  const list = [item('a'), item('b'), item('c'), item('promo', 10, { repeat_every_sec: 120 })];
  const out = applyRepeatEvery(list);
  const g = gaps(out, 'promo');
  for (const gap of g) assert.ok(gap >= 100 && gap <= 140, `gap ${gap}s is about two minutes`);
  assert.ok(out.filter((it) => it.filename === 'a').length > 1, 'the base loop is repeated');
});

test('two flagged items are staggered, never stacked back to back', () => {
  const list = Array.from({ length: 12 }, (_, i) => item(`c${i}`));
  list.push(item('p1', 10, { repeat_every_sec: 40 }), item('p2', 10, { repeat_every_sec: 40 }));
  const out = applyRepeatEvery(list);
  for (let i = 1; i < out.length; i++) {
    assert.ok(!(/^p/.test(out[i].filename) && /^p/.test(out[i - 1].filename)), `p items adjacent at ${i}`);
  }
});

test('⚠️ copies are renumbered: a player that re-sorts by sort_order keeps the spacing', () => {
  const list = Array.from({ length: 6 }, (_, i) => item(`s${i}`, 10, { sort_order: i }));
  list.push(item('promo', 10, { sort_order: 6, repeat_every_sec: 20 }));
  const out = applyRepeatEvery(list);
  const resorted = out.slice().sort((a, b) => a.sort_order - b.sort_order);   // what Tizen does
  assert.deepEqual(resorted.map((i) => i.filename), out.map((i) => i.filename));
  assert.ok(gaps(resorted, 'promo').every((g) => g <= 40), 'still spaced after the re-sort');
});

test('a flagged open-ended live stream is not woven (each copy would park the screen)', () => {
  const list = [item('a'), item('b'), item('live', 0, { mime_type: 'video/hls', repeat_every_sec: 30 })];
  assert.equal(applyRepeatEvery(list).filter((i) => i.filename === 'live').length, 1);
});

test('no flag, no change: same array, field stripped, order intact', () => {
  const list = [item('a'), item('b'), item('c')];
  const out = applyRepeatEvery(list);
  assert.deepEqual(out.map((i) => i.filename), ['a', 'b', 'c']);
  assert.ok(out.every((i) => !('repeat_every_sec' in i)));
});

test('the flag never reaches a player', () => {
  const out = applyRepeatEvery([item('a'), item('b'), item('p', 10, { repeat_every_sec: 30 })]);
  assert.ok(out.every((i) => !('repeat_every_sec' in i)));
});

test('zones are woven independently: an item only repeats against its own zone', () => {
  const list = [
    item('a', 10, { zone_id: 'main' }), item('b', 10, { zone_id: 'main' }), item('c', 10, { zone_id: 'main' }),
    item('p', 10, { zone_id: 'main', repeat_every_sec: 20 }),
    item('ticker', 60, { zone_id: 'side' }),
  ];
  const out = applyRepeatEvery(list);
  assert.equal(out.filter((i) => i.zone_id === 'side').length, 1, 'the other zone is untouched');
  assert.ok(out.filter((i) => i.filename === 'p').length >= 2);
});

test('a live stream that stays until skipped cannot be timed, so the list is left alone', () => {
  const list = [item('live', 0, { mime_type: 'video/hls' }), item('p', 10, { repeat_every_sec: 30 })];
  assert.equal(applyRepeatEvery(list).length, 2);
});

test('when every item is flagged there is nothing to weave into', () => {
  const list = [item('a', 10, { repeat_every_sec: 30 }), item('b', 10, { repeat_every_sec: 30 })];
  assert.deepEqual(applyRepeatEvery(list).map((i) => i.filename), ['a', 'b']);
});

test('output is capped', () => {
  const list = Array.from({ length: 400 }, (_, i) => item(`c${i}`, 1));
  list.push(item('p', 10, { repeat_every_sec: 86400 }));
  assert.ok(applyRepeatEvery(list).length <= 1000);
});

test('normalizeRepeatEvery: empty clears, 10s..24h accepted, anything else refused', () => {
  assert.equal(normalizeRepeatEvery(null), null);
  assert.equal(normalizeRepeatEvery(''), null);
  assert.equal(normalizeRepeatEvery(0), null);
  assert.equal(normalizeRepeatEvery(60), 60);
  assert.equal(normalizeRepeatEvery('90.7'), 90);
  assert.equal(normalizeRepeatEvery(5), false);
  assert.equal(normalizeRepeatEvery(90000), false);
  assert.equal(normalizeRepeatEvery('soon'), false);
});
