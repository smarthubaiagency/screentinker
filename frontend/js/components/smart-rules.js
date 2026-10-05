// Smart playlist rule editor (server: lib/smart-playlist.js). One modal used both when creating a
// smart playlist and when editing its rules. It shows a live preview of what the rules select, so
// the operator sees the result before anything is saved, let alone published.

import { api } from '../api.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

const FIELD_OPS = {
  tag: ['has', 'lacks'],
  meta: ['eq', 'neq', 'contains', 'exists', 'missing'],
  type: ['is', 'not'],
  folder: ['in', 'not_in'],
  name: ['contains', 'not_contains'],
};
const TYPES = ['image', 'video', 'audio', 'stream', 'youtube', 'web', 'other'];

export const DEFAULT_RULES = { match: 'all', rules: [{ field: 'tag', op: 'has', value: '' }], sort: 'name', limit: 200, image_duration: 10 };

/** One-line plain-language summary of a rule set, for the playlist page and cards. */
export function rulesSummary(rules, folders = []) {
  if (!rules || !Array.isArray(rules.rules) || !rules.rules.length) return '';
  const folderName = (id) => (folders.find((f) => f.id === id) || {}).name || id;
  const parts = rules.rules.map((r) => {
    const val = r.field === 'folder' ? folderName(r.value) : r.field === 'type' ? t(`smart.type.${r.value}`) : r.value;
    return t(`smart.sum.${r.field}.${r.op}`, { key: r.key || '', value: val == null ? '' : String(val) });
  });
  return parts.join(rules.match === 'any' ? ` ${t('smart.or')} ` : ` ${t('smart.and')} `);
}

// The folders API is a flat list with parent_id; show it as an indented tree.
export async function loadFolders() {
  let rows = [];
  try { const raw = await api.getFolders(); rows = Array.isArray(raw) ? raw : []; } catch { return []; }
  const kids = new Map();
  for (const f of rows) {
    const k = f.parent_id || '';
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(f);
  }
  const ids = new Set(rows.map((f) => f.id));
  const out = [];
  const walk = (parent, depth) => {
    for (const f of kids.get(parent) || []) {
      if (out.length > rows.length) return;   // a parent cycle in bad data must not hang the page
      out.push({ id: f.id, name: f.name, depth });
      walk(f.id, depth + 1);
    }
  };
  walk('', 0);
  // Orphans (parent outside this workspace) still get listed, at the top level.
  for (const f of rows) if (f.parent_id && !ids.has(f.parent_id)) { out.push({ id: f.id, name: f.name, depth: 0 }); walk(f.id, 1); }
  return out;
}

/**
 * Open the editor. `onSave(rules)` must return a promise; the modal closes when it resolves and
 * stays open (showing the error) when it rejects.
 */
let modalOpen = false;

export async function openSmartRulesModal({ title, initial, saveLabel, onSave, onCancel }) {
  // The folder fetch happens before anything is shown, so a double click would open two modals.
  if (modalOpen) return;
  modalOpen = true;
  let folders;
  try { folders = await loadFolders(); } catch { folders = []; }
  const state = JSON.parse(JSON.stringify(initial || DEFAULT_RULES));
  if (!Array.isArray(state.rules) || !state.rules.length) state.rules = [{ field: 'tag', op: 'has', value: '' }];

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:720px;max-width:100%;max-height:90vh;overflow:auto">
      <h3 style="margin-bottom:6px;color:var(--text-primary)">${esc(title || t('smart.title'))}</h3>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">${t('smart.intro')}</p>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;color:var(--text-secondary)">
        ${t('smart.match_prefix')}
        <select id="smMatch" class="input" style="width:auto">
          <option value="all">${t('smart.match_all')}</option>
          <option value="any">${t('smart.match_any')}</option>
        </select>
        ${t('smart.match_suffix')}
      </div>
      <div id="smRules" style="display:flex;flex-direction:column;gap:8px;margin-bottom:8px"></div>
      <button class="btn btn-secondary btn-sm" id="smAdd">${t('smart.add_rule')}</button>
      <div style="display:flex;flex-wrap:wrap;gap:16px;margin:16px 0;font-size:13px;color:var(--text-secondary)">
        <label>${t('smart.sort')}
          <select id="smSort" class="input" style="width:auto;margin-left:6px">
            <option value="name">${t('smart.sort_name')}</option>
            <option value="newest">${t('smart.sort_newest')}</option>
            <option value="oldest">${t('smart.sort_oldest')}</option>
          </select>
        </label>
        <label>${t('smart.limit')}
          <input id="smLimit" type="number" class="input" min="1" max="500" style="width:80px;margin-left:6px">
        </label>
        <label>${t('smart.image_duration')}
          <input id="smImage" type="number" class="input" min="1" style="width:70px;margin-left:6px"> ${t('playlist.sec')}
        </label>
      </div>
      <div style="background:var(--bg-input);border-radius:var(--radius);padding:12px;margin-bottom:12px">
        <div id="smCount" style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:6px"></div>
        <div id="smPreview" style="font-size:12px;color:var(--text-muted);max-height:140px;overflow:auto"></div>
      </div>
      <div id="smError" style="color:var(--danger);font-size:13px;min-height:18px;margin-bottom:8px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-secondary" id="smCancel">${t('common.cancel')}</button>
        <button class="btn btn-primary" id="smSave">${esc(saveLabel || t('smart.save'))}</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const $ = (id) => modal.querySelector('#' + id);
  let saved = false;
  function close() {
    modal.remove();
    modalOpen = false;
    if (!saved && typeof onCancel === 'function') onCancel();
  }
  $('smMatch').value = state.match === 'any' ? 'any' : 'all';
  $('smSort').value = state.sort || 'name';
  $('smLimit').value = state.limit || 200;
  $('smImage').value = state.image_duration || 10;

  const valueInput = (r, i) => {
    if (r.field === 'type') {
      return `<select class="input sm-value" data-i="${i}" style="flex:1">${TYPES.map((ty) => `<option value="${ty}" ${r.value === ty ? 'selected' : ''}>${t(`smart.type.${ty}`)}</option>`).join('')}</select>`;
    }
    if (r.field === 'folder') {
      return `<select class="input sm-value" data-i="${i}" style="flex:1">${folders.length
        ? folders.map((f) => `<option value="${esc(f.id)}" ${r.value === f.id ? 'selected' : ''}>${'&nbsp;&nbsp;'.repeat(f.depth)}${esc(f.name)}</option>`).join('')
        : `<option value="">${t('smart.no_folders')}</option>`}</select>`;
    }
    if (r.field === 'meta' && (r.op === 'exists' || r.op === 'missing')) return '<span style="flex:1"></span>';
    return `<input class="input sm-value" data-i="${i}" value="${esc(r.value || '')}" placeholder="${esc(t(r.field === 'tag' ? 'smart.ph_tag' : r.field === 'meta' ? 'smart.ph_meta_value' : 'smart.ph_name'))}" style="flex:1">`;
  };

  function paintRules() {
    $('smRules').innerHTML = state.rules.map((r, i) => `
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <select class="input sm-field" data-i="${i}" style="width:auto">
          ${Object.keys(FIELD_OPS).map((f) => `<option value="${f}" ${r.field === f ? 'selected' : ''}>${t(`smart.field.${f}`)}</option>`).join('')}
        </select>
        ${r.field === 'meta' ? `<input class="input sm-key" data-i="${i}" value="${esc(r.key || '')}" placeholder="${esc(t('smart.ph_meta_key'))}" style="width:110px">` : ''}
        <select class="input sm-op" data-i="${i}" style="width:auto">
          ${FIELD_OPS[r.field].map((op) => `<option value="${op}" ${r.op === op ? 'selected' : ''}>${t(`smart.op.${op}`)}</option>`).join('')}
        </select>
        ${valueInput(r, i)}
        <button class="btn btn-secondary btn-sm sm-del" data-i="${i}" title="${esc(t('smart.remove_rule'))}" ${state.rules.length < 2 ? 'disabled' : ''}>✕</button>
      </div>`).join('');
    // What a select DISPLAYS is what gets saved. A stored value that is no longer an option (a deleted
    // folder) would otherwise show one folder while silently keeping another.
    state.rules.forEach((r, i) => {
      const v = modal.querySelector(`select.sm-value[data-i="${i}"]`);
      if (v && v.value !== r.value) r.value = v.value;
    });
  }

  function collect() {
    return {
      match: $('smMatch').value,
      sort: $('smSort').value,
      limit: Number($('smLimit').value) || 200,
      image_duration: Number($('smImage').value) || 10,
      rules: state.rules.map((r) => {
        const out = { field: r.field, op: r.op };
        if (r.field === 'meta') out.key = (r.key || '').trim();
        if (!(r.field === 'meta' && (r.op === 'exists' || r.op === 'missing'))) {
          let v = String(r.value || '').trim();
          // Tags are shown as "#lobby" everywhere, so people type the '#'. Stored tags never have one.
          if (r.field === 'tag') v = v.replace(/^#+/, '').toLowerCase();
          out.value = v;
        }
        return out;
      }),
    };
  }

  function incomplete(rules) {
    return rules.rules.some((r) => (r.field === 'meta' && !r.key) || ('value' in r && !r.value));
  }

  let previewTimer = null;
  let previewSeq = 0;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const rules = collect();
      // Bump first, so a request already in flight for the old rules cannot land on top of this.
      const seq = ++previewSeq;
      $('smError').textContent = '';
      if (incomplete(rules)) {
        $('smCount').textContent = t('smart.preview_incomplete');
        $('smPreview').innerHTML = '';
        return;
      }
      try {
        const r = await api.smartPlaylistPreview(rules);
        if (seq !== previewSeq) return;
        $('smCount').textContent = t('smart.preview_count', { n: r.count });
        $('smPreview').innerHTML = r.items.length
          ? r.items.map((it) => `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(it.filename)} <span style="opacity:0.6">· ${esc(t(`smart.type.${it.type}`))}</span></div>`).join('')
          : `<div>${t('smart.preview_none')}</div>`;
        $('smError').textContent = '';
      } catch (err) {
        if (seq !== previewSeq) return;
        $('smCount').textContent = '';
        $('smError').textContent = err.message;
      }
    }, 250);
  }

  modal.addEventListener('change', (e) => {
    const i = Number(e.target.dataset.i);
    if (e.target.classList.contains('sm-field')) {
      state.rules[i] = { field: e.target.value, op: FIELD_OPS[e.target.value][0], value: '' };
      paintRules();
    } else if (e.target.classList.contains('sm-op')) {
      state.rules[i].op = e.target.value;
      paintRules();
    } else if (e.target.classList.contains('sm-value')) {
      state.rules[i].value = e.target.value;
    }
    schedulePreview();
  });
  modal.addEventListener('input', (e) => {
    const i = Number(e.target.dataset.i);
    if (e.target.classList.contains('sm-value')) state.rules[i].value = e.target.value;
    else if (e.target.classList.contains('sm-key')) state.rules[i].key = e.target.value;
    else if (!['smLimit', 'smImage'].includes(e.target.id)) return;
    schedulePreview();
  });
  // Close on the backdrop only when the press started there: selecting text in an input and releasing
  // over the backdrop fires a click on it, and must not throw away the rules being written.
  let downOnBackdrop = false;
  modal.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === modal; });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) { if (downOnBackdrop) close(); return; }
    const del = e.target.closest('.sm-del');
    if (del && state.rules.length > 1) {
      state.rules.splice(Number(del.dataset.i), 1);
      paintRules();
      schedulePreview();
    }
  });
  $('smAdd').addEventListener('click', () => {
    if (state.rules.length >= 20) return;
    state.rules.push({ field: 'tag', op: 'has', value: '' });
    paintRules();
    schedulePreview();
  });
  $('smCancel').addEventListener('click', () => close());
  $('smSave').addEventListener('click', async () => {
    const rules = collect();
    if (incomplete(rules)) { $('smError').textContent = t('smart.preview_incomplete'); return; }
    const btn = $('smSave');
    btn.disabled = true;
    try {
      await onSave(rules);
      saved = true;
      close();
    } catch (err) {
      $('smError').textContent = err.message;
      btn.disabled = false;
    }
  });

  paintRules();
  schedulePreview();
}
