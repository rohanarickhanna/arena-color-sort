// Are.na Color Sort: content script. Adds a "Sort by color" launcher to
// channel pages, reads the channel through the public v3 API, measures each
// block's dominant color, and shows the channel re-sorted. With a personal
// access token it can also write the new order back to the channel.
(() => {
  'use strict';
  if (window.__arenaColorSort) return;
  window.__arenaColorSort = true;

  const { analyzePixels, sortItems, tinyImageUrl } = globalThis.ArenaColor;
  const API = 'https://api.are.na/v3';
  const TOKEN_URL = 'https://www.are.na/settings/personal-access-tokens';
  const CONCURRENCY = 6;
  const SAMPLE = 32;
  // First path segments that are Are.na pages rather than user profiles.
  const RESERVED = new Set([
    'about', 'block', 'blog', 'channels', 'editorial', 'explore', 'feed', 'login',
    'notifications', 'pricing', 'privacy', 'search', 'settings', 'sign_up', 'signup',
    'terms', 'tools', 'upgrade', 'api', 'developers', 'support', 'import', 'oauth',
  ]);
  const MODES = [
    ['channel', 'Channel order'],
    ['spectrum', 'Spectrum'],
    ['light', 'Light to dark'],
    ['vivid', 'Vivid to muted'],
  ];

  // ---------- storage (falls back to memory when chrome.storage is absent) ----------

  const mem = new Map();
  const hasStore = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const store = {
    async get(keys) {
      if (hasStore) return chrome.storage.local.get(keys);
      const out = {};
      for (const k of keys) if (mem.has(k)) out[k] = mem.get(k);
      return out;
    },
    async set(obj) {
      if (hasStore) return chrome.storage.local.set(obj);
      for (const [k, v] of Object.entries(obj)) mem.set(k, v);
    },
    async remove(key) {
      if (hasStore) return chrome.storage.local.remove(key);
      mem.delete(key);
    },
  };

  // ---------- API ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function getToken() {
    return (await store.get(['acs:token']))['acs:token'] || '';
  }

  async function api(path, opts = {}) {
    const token = await getToken();
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (opts.body) headers['Content-Type'] = 'application/json';
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(API + path, { ...opts, headers });
      // A bad or revoked token should not break reading public channels.
      if (res.status === 401 && headers.Authorization && (!opts.method || opts.method === 'GET')) {
        delete headers.Authorization;
        continue;
      }
      if (res.status === 429) {
        await sleep(waitFor(res) || 2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        const err = new Error(`Are.na API ${res.status}`);
        err.status = res.status;
        throw err;
      }
      // Stay under the per-minute budget instead of hitting 429 repeatedly.
      const remaining = Number(res.headers.get('X-RateLimit-Remaining'));
      if (res.headers.has('X-RateLimit-Remaining') && remaining <= 2) await sleep(waitFor(res) || 5000);
      return res.json();
    }
    throw new Error('Are.na API rate limit: gave up after retries');
  }

  function waitFor(res) {
    const retry = Number(res.headers.get('Retry-After'));
    if (retry > 0) return retry * 1000 + 250;
    const reset = Number(res.headers.get('X-RateLimit-Reset'));
    if (!reset) return 0;
    // Epoch seconds or seconds-until-reset; accept either.
    const ms = reset > 1e9 ? reset * 1000 - Date.now() : reset * 1000;
    return Math.min(Math.max(ms, 0), 65000) + 250;
  }

  async function fetchContents(channelId, onPage) {
    const all = [];
    for (let page = 1; ; page++) {
      const res = await api(`/channels/${channelId}/contents?per=100&page=${page}`);
      all.push(...res.data);
      onPage(all.length, res.meta.total_count);
      if (!res.meta.has_more_pages) return all;
    }
  }

  async function moveToTop(connectionId) {
    return api(`/connections/${connectionId}/move`, {
      method: 'POST',
      body: JSON.stringify({ movement: 'move_to_top' }),
    });
  }

  // ---------- color measurement ----------

  function imageSources(block) {
    const img = block.image;
    if (!img) return [];
    const small = img.small && img.small.src;
    return [tinyImageUrl(small || img.src, SAMPLE), small, img.src].filter(Boolean);
  }

  async function measure(url) {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`image ${res.status}`);
    const bitmap = await createImageBitmap(await res.blob(), {
      resizeWidth: SAMPLE, resizeHeight: SAMPLE, resizeQuality: 'medium',
    });
    const canvas = new OffscreenCanvas(SAMPLE, SAMPLE);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, SAMPLE, SAMPLE);
    bitmap.close();
    return analyzePixels(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data);
  }

  const cacheKey = (block) => `acs:c2:${block.id}:${(block.image && block.image.updated_at) || ''}`;

  async function colorBlocks(items, onColor) {
    const cached = await store.get(items.map((it) => cacheKey(it.block)));
    const queue = [];
    for (const it of items) {
      const hit = cached[cacheKey(it.block)];
      if (hit) { it.color = hit; onColor(it); } else if (it.block.image) queue.push(it);
      else onColor(it);
    }
    let pending = {};
    const flush = async () => { const p = pending; pending = {}; if (Object.keys(p).length) await store.set(p); };
    let next = 0;
    async function worker() {
      while (next < queue.length && !state.closed) {
        const it = queue[next++];
        for (const url of imageSources(it.block)) {
          try { it.color = await measure(url); break; } catch (_) { /* try next size */ }
        }
        if (it.color) pending[cacheKey(it.block)] = it.color;
        if (Object.keys(pending).length >= 25) await flush();
        onColor(it);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await flush();
  }

  // ---------- page detection ----------

  function channelSlug() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || RESERVED.has(parts[0])) return null;
    return decodeURIComponent(parts[1]);
  }

  // ---------- UI ----------

  const state = { closed: true };
  const host = document.createElement('div');
  host.id = 'arena-color-sort';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>${CSS()}</style>
    <button class="launch" part="launch" hidden>
      <span class="wheel" aria-hidden="true"></span>Sort by color
    </button>
    <div class="overlay" hidden role="dialog" aria-modal="true" aria-label="Sort by color"></div>`;
  const launch = shadow.querySelector('.launch');
  const overlay = shadow.querySelector('.overlay');

  function mount() {
    if (!host.isConnected) document.documentElement.appendChild(host);
    launch.hidden = !channelSlug() || !state.closed;
  }

  let lastPath = '';
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      if (!state.closed) close();
    }
    mount();
  }, 400);

  launch.addEventListener('click', () => open(channelSlug()));

  // Are.na has single-key shortcuts (f jumps to search). The overlay is modal,
  // so while it is open no key event may reach the page: otherwise typing a
  // token into our field can land in Are.na's search box. This runs at
  // document_start so the window capture listener precedes the page's own.
  // Stopping propagation does not stop typing or implicit form submission.
  for (const type of ['keydown', 'keypress', 'keyup']) {
    window.addEventListener(type, (e) => {
      if (state.closed) return;
      if (type === 'keydown') onKey(e);
      e.stopImmediatePropagation();
    }, true);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    const n = Number(e.key);
    const origin = e.composedPath()[0];
    const typing = origin && origin.closest && origin.closest('input, textarea, [contenteditable]');
    if (n >= 1 && n <= MODES.length && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) setMode(MODES[n - 1][0]);
  }

  function close() {
    state.closed = true;
    if (state.cancelApply) state.cancelApply();
    overlay.hidden = true;
    overlay.innerHTML = '';
    document.documentElement.style.overflow = state.prevOverflow || '';
    mount();
  }

  async function open(slug) {
    if (!slug) return;
    Object.assign(state, {
      closed: false, slug, items: [], mode: 'spectrum', reverse: false,
      channel: null, measured: 0, busy: false, cancelApply: null,
      prevOverflow: document.documentElement.style.overflow,
    });
    document.documentElement.style.overflow = 'hidden';
    launch.hidden = true;
    overlay.hidden = false;
    overlay.innerHTML = `
      <header class="bar">
        <div class="title">
          <span class="eyebrow">Sort by color</span>
          <span class="name">Loading channel</span>
        </div>
        <div class="modes" role="radiogroup" aria-label="Order">
          ${MODES.map(([k, label], i) => `<button role="radio" data-mode="${k}" title="${label} (${i + 1})">${label}</button>`).join('')}
          <button class="rev" aria-pressed="false" title="Reverse">Reverse</button>
        </div>
        <div class="actions">
          <button class="apply" disabled>Apply to channel</button>
          <button class="close" aria-label="Close" title="Close (Esc)">Close</button>
        </div>
      </header>
      <div class="ribbon" aria-hidden="true"></div>
      <div class="notice" hidden></div>
      <p class="status" aria-live="polite">Reading channel</p>
      <main class="grid"></main>`;

    overlay.querySelector('.close').onclick = close;
    overlay.querySelector('.rev').onclick = (e) => {
      state.reverse = !state.reverse;
      e.currentTarget.setAttribute('aria-pressed', state.reverse);
      render(true);
    };
    overlay.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
    overlay.querySelector('.apply').onclick = showApply;
    overlay.querySelector('.ribbon').onclick = (e) => {
      const seg = e.target.closest('[data-id]');
      const tile = seg && state.tiles.get(seg.dataset.id);
      if (tile) { tile.scrollIntoView({ block: 'center', behavior: 'smooth' }); flash(tile); }
    };
    markMode();

    try {
      const channel = await api(`/channels/${encodeURIComponent(slug)}`);
      if (state.closed) return;
      state.channel = channel;
      overlay.querySelector('.name').textContent = channel.title;
      const blocks = await fetchContents(channel.id, (got, total) => {
        status(`Reading channel ${got} / ${total}`);
      });
      if (state.closed) return;
      state.items = blocks.map((block, index) => ({
        block, index, color: null,
        key: String(block.connection ? block.connection.id : `${block.type}-${block.id}`),
      }));
      buildTiles();
      status(`Reading colors 0 / ${state.items.length}`);
      let done = 0;
      await colorBlocks(state.items, (it) => {
        done++;
        paintTile(it);
        if (done % 12 === 0 || done === state.items.length) status(`Reading colors ${done} / ${state.items.length}`);
      });
      if (state.closed) return;
      const measured = state.items.filter((it) => it.color).length;
      const without = state.items.length - measured;
      status(`${measured} blocks sorted by color` + (without ? `, ${without} without an image at the end` : ''));
      overlay.querySelector('.apply').disabled = false;
      render(true);
      showRestoreIfSaved();
    } catch (err) {
      if (state.closed) return;
      status(err.status === 404 || err.status === 401 || err.status === 403
        ? 'This channel could not be read. If it is private, add a personal access token under Apply to channel.'
        : `Something went wrong: ${err.message}`);
      overlay.querySelector('.apply').disabled = false;
    }
  }

  function status(text) {
    const el = overlay.querySelector('.status');
    if (el) el.textContent = text;
  }

  function setMode(mode) {
    state.mode = mode;
    markMode();
    render(true);
  }

  function markMode() {
    overlay.querySelectorAll('[data-mode]').forEach((b) => {
      b.setAttribute('aria-checked', b.dataset.mode === state.mode);
    });
  }

  const rgb = (c) => `rgb(${c[0]} ${c[1]} ${c[2]})`;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function blockUrl(block) {
    if (block.type === 'Channel') {
      const owner = block.owner || block.user;
      return owner ? `https://www.are.na/${owner.slug}/${block.slug}` : `https://www.are.na/channel/${block.slug}`;
    }
    return `https://www.are.na/block/${block.id}`;
  }

  function blockLabel(block) {
    if (block.title) return block.title;
    if (block.type === 'Channel') return 'Channel';
    return block.type || 'Block';
  }

  function textSnippet(block) {
    const c = block.content;
    const md = c && (c.plain || c.markdown || (typeof c === 'string' ? c : ''));
    return (md || block.title || '').slice(0, 280);
  }

  function buildTiles() {
    const grid = overlay.querySelector('.grid');
    grid.innerHTML = state.items.map((it) => {
      const b = it.block;
      const thumb = b.image && b.image.small && b.image.small.src;
      const body = thumb
        ? `<img src="${esc(thumb)}" alt="${esc(b.image.alt_text || '')}" loading="lazy" decoding="async">`
        : `<div class="text">${esc(textSnippet(b)) || esc(blockLabel(b))}</div>`;
      return `<a class="tile" data-id="${esc(it.key)}" href="${esc(blockUrl(b))}" target="_blank" rel="noopener">
          <div class="frame">${body}</div>
          <div class="pal"></div>
          <div class="cap">${esc(blockLabel(b))}</div>
        </a>`;
    }).join('');
    state.tiles = new Map();
    grid.querySelectorAll('.tile').forEach((t) => state.tiles.set(t.dataset.id, t));
  }

  function paintTile(it) {
    const tile = state.tiles && state.tiles.get(it.key);
    if (!tile || !it.color) return;
    tile.querySelector('.pal').innerHTML = it.color.palette
      .map((p) => `<i style="background:${rgb(p.rgb)};flex:${p.weight}"></i>`).join('');
    tile.style.setProperty('--dom', rgb(it.color.rgb));
    tile.title = `${blockLabel(it.block)}\nDominant ${hex(it.color.rgb)}`;
  }

  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

  function currentOrder() {
    if (state.mode === 'channel') {
      const list = state.items.slice();
      return state.reverse ? list.reverse() : list;
    }
    return sortItems(state.items, state.mode, state.reverse);
  }

  function render(animate) {
    if (!state.items.length) return;
    const grid = overlay.querySelector('.grid');
    const order = currentOrder();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const before = animate && !reduce ? new Map() : null;
    if (before) {
      const top = -60, bottom = innerHeight + 60;
      for (const [id, t] of state.tiles) {
        const r = t.getBoundingClientRect();
        if (r.bottom > top && r.top < bottom) before.set(id, r);
      }
    }
    const frag = document.createDocumentFragment();
    for (const it of order) frag.appendChild(state.tiles.get(it.key));
    grid.appendChild(frag);

    if (before && before.size) {
      for (const [id, r0] of before) {
        const t = state.tiles.get(id);
        const r1 = t.getBoundingClientRect();
        const dx = r0.left - r1.left, dy = r0.top - r1.top;
        if (!dx && !dy) continue;
        t.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
          { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' },
        );
      }
    }

    overlay.querySelector('.ribbon').innerHTML = order
      .filter((it) => it.color)
        .map((it) => `<i data-id="${esc(it.key)}" style="background:${rgb(it.color.rgb)}"></i>`).join('');
  }

  function flash(tile) {
    tile.animate([{ outlineColor: 'var(--ink)' }, { outlineColor: 'transparent' }], { duration: 1400 });
  }

  // ---------- writing the order back ----------

  function notice(html) {
    const el = overlay.querySelector('.notice');
    el.innerHTML = html;
    el.hidden = !html;
    return el;
  }

  async function showApply() {
    if (state.busy) return;
    const token = await getToken();
    if (!token) return showTokenForm();
    if (!state.items.length) return;
    const order = currentOrder();
    if (state.mode === 'channel' && !state.reverse) {
      notice(`<p>Pick an order first. The channel is already in this order.</p>
        <div class="row"><button class="ghost" data-act="dismiss">OK</button></div>`)
        .querySelector('[data-act="dismiss"]').onclick = () => notice('');
      return;
    }
    const label = MODES.find(([k]) => k === state.mode)[1] + (state.reverse ? ', reversed' : '');
    const el = notice(`
      <p><strong>Reorder ${state.items.length} blocks as "${esc(label)}"?</strong>
      This changes the channel for everyone who sees it. The current order is saved on this computer so you can put it back.
      ${duration(state.items.length)}</p>
      <div class="row">
        <button class="primary" data-act="go">Reorder channel</button>
        <button class="ghost" data-act="dismiss">Cancel</button>
        <button class="link" data-act="token">Change token</button>
      </div>`);
    el.querySelector('[data-act="dismiss"]').onclick = () => notice('');
    el.querySelector('[data-act="token"]').onclick = showTokenForm;
    el.querySelector('[data-act="go"]').onclick = () => applyOrder(order.map((it) => it.block), 'sorted');
  }

  // One API call per block; a free account allows about 120 a minute.
  function duration(n) {
    const minutes = Math.ceil(n / 110);
    return n < 100 ? 'It takes under a minute.' : `It takes about ${minutes} minutes on a free account.`;
  }

  function showTokenForm() {
    const el = notice(`
      <p><strong>Reordering needs an Are.na personal access token with write access.</strong>
      Create one at <a href="${TOKEN_URL}" target="_blank" rel="noopener">are.na/settings/personal-access-tokens</a>
      and paste it here. It is stored only in this browser and sent only to api.are.na.
      You can reorder channels you own or collaborate on.</p>
      <form class="row">
        <input type="password" placeholder="Personal access token" autocomplete="off" spellcheck="false">
        <button class="primary" type="submit">Save</button>
        <button class="ghost" type="button" data-act="clear">Remove token</button>
        <button class="ghost" type="button" data-act="dismiss">Cancel</button>
      </form>`);
    const input = el.querySelector('input');
    input.focus();
    const save = async () => {
      const v = input.value.trim();
      if (!v) return;
      await store.set({ 'acs:token': v });
      if (!state.items.length) { const slug = state.slug; close(); open(slug); return; }
      showApply();
    };
    el.querySelector('form').onsubmit = (e) => { e.preventDefault(); save(); };
    el.querySelector('[data-act="clear"]').onclick = async () => { await store.remove('acs:token'); notice(''); };
    el.querySelector('[data-act="dismiss"]').onclick = () => notice('');
  }

  const sameIds = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);

  async function applyOrder(blocks, kind) {
    const channelId = state.channel.id;
    const ids = blocks.map((b) => b.connection && b.connection.id).filter(Boolean);
    const current = state.items.map((it) => it.block.connection && it.block.connection.id).filter(Boolean);
    const keys = [`acs:orig:${channelId}`, `acs:applied:${channelId}`];
    const saved = await store.get(keys);
    // Save the pre-sort order, unless the channel is still sitting in an
    // order this extension wrote (then the saved original is the real one).
    // Written after the first successful move, so a rejected token leaves
    // nothing behind.
    let original = kind === 'sorted' && !sameIds(current, saved[keys[1]])
      ? { [keys[0]]: { ids: current, at: Date.now() } } : null;

    state.busy = true;
    let cancelled = false;
    state.cancelApply = () => { cancelled = true; };
    overlay.querySelector('.apply').disabled = true;
    const el = notice(`<p class="prog"><strong>Reordering</strong> <span>0 / ${ids.length}</span>
      Keep this tab open.</p><div class="row"><button class="ghost" data-act="stop">Stop</button></div>`);
    el.querySelector('[data-act="stop"]').onclick = () => { cancelled = true; };
    const counter = el.querySelector('.prog span');

    // Moving each block to the top, last one first, leaves the list in order.
    let moved = 0, failure = null;
    for (let i = ids.length - 1; i >= 0 && !cancelled; i--) {
      try {
        await moveToTop(ids[i]);
        if (original) { await store.set(original); original = null; }
      } catch (err) {
        failure = err;
        break;
      }
      moved++;
      counter.textContent = `${moved} / ${ids.length}`;
    }
    state.busy = false;
    state.cancelApply = null;
    if (state.closed) return;
    overlay.querySelector('.apply').disabled = false;

    if (!failure && !cancelled) {
      await store.set({ [keys[1]]: kind === 'sorted' ? ids : null });
      if (kind === 'restore') await store.remove(keys[0]);
      notice(`<p><strong>${kind === 'restore' ? 'Original order restored.' : 'Channel reordered.'}</strong>
        Reload the page to see it.</p>
        <div class="row"><button class="primary" data-act="reload">Reload</button>
        ${kind === 'sorted' ? '<button class="ghost" data-act="undo">Restore original order</button>' : ''}</div>`);
      overlay.querySelector('[data-act="reload"]').onclick = () => location.reload();
      const undo = overlay.querySelector('[data-act="undo"]');
      if (undo) undo.onclick = restore;
      return;
    }
    const why = !failure ? 'Stopped.'
      : failure.status === 401 ? 'The token was rejected. Check it has write access.'
      : failure.status === 403 ? 'This token cannot reorder this channel. Only the owner and collaborators can.'
      : `Stopped by an error: ${esc(failure.message)}.`;
    notice(moved
      ? `<p><strong>${why}</strong> ${moved} of ${ids.length} blocks were moved, so the channel is partly reordered.</p>
        <div class="row"><button class="ghost" data-act="undo">Restore original order</button>
        <button class="ghost" data-act="token">Change token</button></div>`
      : `<p><strong>${why}</strong> Nothing in the channel was changed.</p>
        <div class="row"><button class="ghost" data-act="token">Change token</button></div>`);
    const undo = overlay.querySelector('[data-act="undo"]');
    if (undo) undo.onclick = restore;
    overlay.querySelector('[data-act="token"]').onclick = showTokenForm;
  }

  async function showRestoreIfSaved() {
    const key = `acs:orig:${state.channel.id}`;
    const saved = (await store.get([key]))[key];
    if (!saved || state.closed || !overlay.querySelector('.notice').hidden) return;
    const when = new Date(saved.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    const el = notice(`<p>You color-sorted this channel on ${esc(when)}. Its earlier order is saved.</p>
      <div class="row"><button class="ghost" data-act="undo">Restore original order</button>
      <button class="ghost" data-act="forget">Forget it</button></div>`);
    el.querySelector('[data-act="undo"]').onclick = restore;
    el.querySelector('[data-act="forget"]').onclick = async () => { await store.remove(key); notice(''); };
  }

  async function restore() {
    if (state.busy) return;
    if (!(await getToken())) return showTokenForm();
    const key = `acs:orig:${state.channel.id}`;
    const saved = (await store.get([key]))[key];
    if (!saved) return notice('<p>No saved order for this channel.</p>');
    // Re-read the channel so moves use live connection ids; blocks added
    // since the sort keep their place at the bottom.
    const live = await fetchContents(state.channel.id, () => {});
    const byConn = new Map(live.map((b) => [b.connection && b.connection.id, b]));
    const blocks = saved.ids.map((id) => byConn.get(id)).filter(Boolean);
    const confirmEl = notice(`<p><strong>Put ${blocks.length} blocks back in their saved order?</strong></p>
      <div class="row"><button class="primary" data-act="go">Restore</button>
      <button class="ghost" data-act="dismiss">Cancel</button></div>`);
    confirmEl.querySelector('[data-act="dismiss"]').onclick = () => notice('');
    confirmEl.querySelector('[data-act="go"]').onclick = () => applyOrder(blocks, 'restore');
  }

  // ---------- styles ----------

  function CSS() {
    return `
      :host { all: initial; }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      .launch, .overlay {
        --paper: #ffffff; --wash: #f4f4f2; --ink: #1d1d1b; --mute: #8a8a86; --line: #e3e3df;
        --accent: #1d1d1b; --on-accent: #ffffff;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
        color: var(--ink); -webkit-font-smoothing: antialiased;
      }
      @media (prefers-color-scheme: dark) {
        .launch, .overlay {
          --paper: #141413; --wash: #1e1e1c; --ink: #ececea; --mute: #8d8d88; --line: #2d2d2a;
          --accent: #ececea; --on-accent: #141413;
        }
      }
      button { font: inherit; color: inherit; cursor: pointer; }
      button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

      .launch {
        position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
        display: inline-flex; align-items: center; gap: 8px;
        padding: 9px 14px 9px 10px; border: 1px solid var(--line); border-radius: 999px;
        background: color-mix(in srgb, var(--paper) 88%, transparent);
        backdrop-filter: blur(12px) saturate(1.4); -webkit-backdrop-filter: blur(12px) saturate(1.4);
        box-shadow: 0 6px 24px rgb(0 0 0 / .08), 0 1px 2px rgb(0 0 0 / .06);
        transition: transform .2s ease, box-shadow .2s ease;
      }
      .launch:hover { transform: translateY(-1px); box-shadow: 0 10px 30px rgb(0 0 0 / .12), 0 1px 2px rgb(0 0 0 / .06); }
      .wheel {
        width: 16px; height: 16px; border-radius: 50%;
        background: conic-gradient(from 20deg, #e5484d, #f59e0b, #e9d63c, #46a758, #12a594, #0090ff, #6e56cf, #d6409f, #e5484d);
        -webkit-mask: radial-gradient(circle, transparent 3.5px, #000 4px);
                mask: radial-gradient(circle, transparent 3.5px, #000 4px);
      }

      .overlay {
        position: fixed; inset: 0; z-index: 2147483647; overflow-y: auto;
        background: var(--paper); overscroll-behavior: contain;
        animation: rise .28s cubic-bezier(.2,.8,.2,1);
      }
      @keyframes rise { from { opacity: 0; transform: translateY(8px); } }
      @media (prefers-reduced-motion: reduce) { .overlay { animation: none; } }

      .bar {
        position: sticky; top: 0; z-index: 2;
        display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
        padding: 14px 24px; background: color-mix(in srgb, var(--paper) 90%, transparent);
        backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
      }
      .title { display: flex; flex-direction: column; min-width: 0; flex: 1 1 200px; }
      .eyebrow { font-size: 11px; color: var(--mute); letter-spacing: .02em; }
      .name { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

      .modes { display: flex; gap: 2px; padding: 3px; background: var(--wash); border-radius: 999px; flex-wrap: wrap; }
      .modes button {
        border: 0; background: transparent; padding: 6px 12px; border-radius: 999px; color: var(--mute);
        transition: background .15s, color .15s;
      }
      .modes button:hover { color: var(--ink); }
      .modes [aria-checked="true"], .modes .rev[aria-pressed="true"] {
        background: var(--paper); color: var(--ink); box-shadow: 0 1px 3px rgb(0 0 0 / .1);
      }
      .modes .rev { margin-left: 6px; }

      .actions { display: flex; gap: 8px; }
      .actions button, .notice button {
        border: 1px solid var(--line); background: var(--paper); padding: 7px 14px; border-radius: 999px;
      }
      .actions button:hover:not(:disabled), .notice button:hover { border-color: var(--mute); }
      .actions button:disabled { opacity: .4; cursor: default; }
      .notice .primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
      .notice .link { border: 0; background: none; color: var(--mute); text-decoration: underline; padding: 7px 4px; }

      .ribbon { display: flex; height: 10px; margin: 0 24px; border-radius: 3px; overflow: hidden; cursor: pointer; background: var(--wash); }
      .ribbon i { flex: 1; min-width: 0; }
      .ribbon i:hover { transform: scaleY(1.6); }

      .notice {
        margin: 16px 24px 0; padding: 14px 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--wash);
        max-width: 760px;
      }
      .notice p { margin: 0 0 10px; }
      .notice a { color: inherit; }
      .notice .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .notice input {
        flex: 1 1 260px; min-width: 0; padding: 7px 12px; border: 1px solid var(--line); border-radius: 999px;
        background: var(--paper); color: var(--ink); font: inherit;
      }

      .status { margin: 14px 24px 0; color: var(--mute); font-size: 12px; font-variant-numeric: tabular-nums; }

      .grid {
        display: grid; gap: 28px 20px; padding: 18px 24px 64px;
        grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      }
      .tile { display: block; color: inherit; text-decoration: none; outline: 2px solid transparent; outline-offset: 4px; border-radius: 4px; }
      .frame {
        aspect-ratio: 1; display: grid; place-items: center; overflow: hidden;
        background: color-mix(in srgb, var(--dom, var(--wash)) 10%, var(--wash));
        border-radius: 4px; transition: background .4s;
      }
      .frame img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
      .text { padding: 12px; font-size: 11px; line-height: 1.45; color: var(--mute); overflow: hidden; height: 100%; width: 100%; word-break: break-word; }
      .pal { display: flex; height: 4px; margin-top: 8px; border-radius: 2px; overflow: hidden; background: var(--line); }
      .pal i { min-width: 0; }
      .cap { margin-top: 6px; font-size: 11px; color: var(--mute); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tile:hover .cap { color: var(--ink); }

      @media (max-width: 640px) {
        .bar { padding: 12px 16px; }
        .ribbon, .notice, .status { margin-left: 16px; margin-right: 16px; }
        .modes { flex-wrap: nowrap; overflow-x: auto; max-width: 100%; scrollbar-width: none; }
        .modes button { white-space: nowrap; }
        .ribbon { margin-top: 2px; }
        .grid { padding: 16px 16px 48px; gap: 20px 12px; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); }
      }
    `;
  }

  mount();
})();
