// Are.na Color Sort: content script. Adds a "Sort by color" launcher to
// channel pages and block search pages, reads them through the Are.na API,
// measures each block's dominant color, and shows them re-sorted. On a channel,
// a personal access token lets it write the new order back.
(() => {
  'use strict';
  if (window.__arenaColorSort) return;
  window.__arenaColorSort = true;

  const { analyzePixels, sortItems, tinyImageUrl, familiesOf, distanceTo, MATCH_DISTANCE, FAMILIES } = globalThis.ArenaColor;
  const API = 'https://api.are.na/v3';
  const TOKEN_URL = 'https://www.are.na/settings/personal-access-tokens';
  const CONCURRENCY = 6;
  const SAMPLE = 32;
  const SEARCH_MAX = 300; // blocks read from a search; the API is not for bulk harvesting
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

  // Used for search only: requests go through the background worker (no CORS
  // limits). Channels keep the plain fetch they always used.
  async function request(url, init) {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return fetch(url, init);
    const r = await chrome.runtime.sendMessage({
      type: 'acs:fetch', url, method: init.method, headers: init.headers, body: init.body,
    });
    if (!r || r.error) {
      const err = new Error(r && r.error ? r.error : 'No response from the extension');
      err.network = true;
      throw err;
    }
    return {
      status: r.status, ok: r.status >= 200 && r.status < 300,
      headers: { get: (k) => r.headers[k.toLowerCase()] || null, has: (k) => k.toLowerCase() in r.headers },
      json: async () => JSON.parse(r.body),
    };
  }

  async function api(path, opts = {}) {
    const token = await getToken();
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (opts.body) headers['Content-Type'] = 'application/json';
    for (let attempt = 0; attempt < 6; attempt++) {
      let res;
      try { res = await (opts.viaBackground ? request : fetch)((opts.base || API) + path, { ...opts, headers }); } catch (e) { e.network = true; throw e; }
      // A bad or revoked token should not break reading public channels.
      if (res.status === 401 && headers.Authorization && !opts.needsAuth && (!opts.method || opts.method === 'GET')) {
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

  // Search can return channels, users and groups next to blocks; drop those and
  // keep anything else, so an unexpected block type label never empties the list.
  const NOT_BLOCKS = new Set(['Channel', 'User', 'Group']);
  const isBlock = (b) => b && !NOT_BLOCKS.has(b.type) && !NOT_BLOCKS.has(b.class);
  const SEARCH_TABS = new Set(['all', 'blocks', 'channels', 'users', 'groups', 'images', 'texts', 'links', 'attachments', 'embeds']);

  // v2 blocks to the v3 shape the rest of this file reads.
  function fromV2(b) {
    const img = b.image;
    const type = b.class === 'Media' ? 'Embed' : b.class;
    return {
      id: b.id, type, title: b.title || b.generated_title || '', updated_at: b.updated_at,
      image: img && (img.thumb || img.display || img.original) ? {
        src: (img.original && img.original.url) || (img.display && img.display.url),
        small: { src: (img.thumb && img.thumb.url) || (img.display && img.display.url) },
        alt_text: '', updated_at: b.updated_at,
      } : null,
      content: b.content ? { plain: b.content } : null,
      connection: null,
    };
  }

  // v3 search needs a token (and Premium). If v3 refuses the account, try the
  // older v2 search; if that fails too, say why instead of a bare network error.
  // What the API actually sent back, for the status line when nothing shows.
  function noteRaw(data, meta) {
    const info = state.searchInfo || (state.searchInfo = { raw: 0, total: 0, types: new Set() });
    info.raw += data.length;
    info.total = (meta && meta.total_count) || info.total;
    for (const d of data) info.types.add(d.type || d.class || '?');
  }

  const PAGE_SIZE = 100;
  const CHUNK_PAGES = SEARCH_MAX / PAGE_SIZE;

  // Reads one chunk of the results: pages chunk*3+1 .. chunk*3+3 of 100 each,
  // i.e. results (chunk*300)+1 .. (chunk*300)+300.
  async function searchBlocks(query, onPage, type = 'Block', chunk = 0) {
    state.searchInfo = null;
    const q = encodeURIComponent(query);
    const all = [];
    let useV2 = false;
    for (let i = 0; i < CHUNK_PAGES; i++) {
      const page = chunk * CHUNK_PAGES + i + 1;
      let batch, more;
      if (!useV2) {
        try {
          const res = await api(`/search?query=${q}&type=${encodeURIComponent(type)}&per=${PAGE_SIZE}&page=${page}`, { needsAuth: true, viaBackground: true });
          batch = res.data.filter(isBlock);
          noteRaw(res.data, res.meta);
          more = res.meta.has_more_pages;
        } catch (err) {
          if (i === 0 && !err.network && (err.status === 401 || err.status === 402 || err.status === 403)) {
            useV2 = true; state.v3Error = err; i--; continue;
          }
          throw err;
        }
      } else {
        try {
          const res = await api(`/search/blocks?q=${q}&per=${PAGE_SIZE}&page=${page}`, { base: 'https://api.are.na/v2', needsAuth: true, viaBackground: true });
          batch = (res.blocks || []).map(fromV2).filter(isBlock);
          noteRaw(res.blocks || [], { total_count: (res.total_pages || 1) * PAGE_SIZE });
          more = page < (res.total_pages || 1) && (res.blocks || []).length > 0;
        } catch (err) {
          err.status = err.status || (state.v3Error && state.v3Error.status);
          err.searchFailed = true;
          throw err;
        }
      }
      all.push(...batch);
      onPage(all.length, state.searchInfo ? state.searchInfo.total : 0);
      if (!more) break;
    }
    return all;
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

  // Are.na's search page keeps its state as JSON in ?q=, e.g.
  // {"term":{"facet":"tree"},"what":{"facets":["BLOCK"]},...}. Pull out the
  // words typed and, when one block kind is chosen, that kind.
  const FACET_TYPES = { IMAGE: 'Image', TEXT: 'Text', LINK: 'Link', ATTACHMENT: 'Attachment', EMBED: 'Embed' };
  function parseSearch(raw) {
    if (raw[0] !== '{') return { query: raw, type: 'Block' };
    try {
      const j = JSON.parse(raw);
      const term = j.term && (typeof j.term === 'string' ? j.term : j.term.facet || j.term.value || j.term.query);
      const facets = ((j.what && j.what.facets) || []).map((f) => String(f).toUpperCase());
      const kinds = facets.filter((f) => FACET_TYPES[f]).map((f) => FACET_TYPES[f]);
      return { query: String(term || '').trim(), type: kinds.length ? kinds.join(',') : 'Block' };
    } catch (_) {
      return { query: raw, type: 'Block' };
    }
  }

  // What this page can be sorted as: a channel, or a block search.
  function pageContext() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts[0] === 'search') {
      const params = new URLSearchParams(location.search);
      const raw = (params.get('q') || params.get('query') || (parts[1] && !SEARCH_TABS.has(parts[1].toLowerCase()) && decodeURIComponent(parts[1])) || '').trim();
      const { query, type } = parseSearch(raw);
      return query ? { kind: 'search', query, type } : null;
    }
    if (parts.length < 2 || RESERVED.has(parts[0])) return null;
    return { kind: 'channel', slug: decodeURIComponent(parts[1]) };
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
    launch.hidden = !pageContext() || !state.closed;
  }

  let lastPath = '';
  setInterval(() => {
    const here = location.pathname + location.search;
    if (here !== lastPath) {
      lastPath = here;
      if (!state.closed) close();
    }
    mount();
  }, 400);

  launch.addEventListener('click', () => open(pageContext()));

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
    // composedPath() stops at a closed shadow root, so ask the root itself
    // which field has focus.
    const origin = shadow.activeElement;
    const typing = origin && (origin.tagName === 'INPUT' || origin.tagName === 'TEXTAREA');
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

  async function open(ctx) {
    if (!ctx) return;
    const isSearch = ctx.kind === 'search';
    Object.assign(state, {
      closed: false, ctx, items: [], mode: ctx.mode || 'spectrum', reverse: !!ctx.reverse, filter: new Set(), search: null,
      channel: null, measured: 0, busy: false, cancelApply: null,
      prevOverflow: document.documentElement.style.overflow,
    });
    document.documentElement.style.overflow = 'hidden';
    launch.hidden = true;
    overlay.hidden = false;
    overlay.innerHTML = `
      <div class="page">
        <header class="head">
          <h1><span class="chan">Loading</span><span class="sep">/</span><span class="here"><span class="wheel" aria-hidden="true"></span>By color</span></h1>
          <div class="actions">
            <button class="btn tok" hidden>Token</button>
            <button class="btn apply" disabled>Apply to channel</button>
            <button class="btn close" title="Close (Esc)">Close</button>
          </div>
        </header>
        <section class="meta">
          <div class="col">
            <div class="label">Order</div>
            <div class="opts" role="radiogroup" aria-label="Order">
              ${MODES.map(([k, label], i) => `<button class="opt" role="radio" data-mode="${k}" title="${label} (${i + 1})">${label}</button>`).join('')}
              <button class="opt rev" aria-pressed="false">Reverse</button>
            </div>
          </div>
          <div class="col colors">
            <div class="label">Colors <button class="clear" hidden>Clear</button></div>
            <form class="search" role="search">
              <label class="swatch" title="Pick a color"><input type="color" value="#2f6fdf" aria-label="Pick a color"></label>
              <input type="search" placeholder="Search a color: red, teal, #3366ff" aria-label="Search by color" spellcheck="false" autocomplete="off">
            </form>
            <div class="chips" role="group" aria-label="Filter by color"></div>
          </div>
          <div class="col">
            <div class="label">Info</div>
            <div class="rows">
              <div class="r"><span>Blocks</span><span class="v-blocks">0</span></div>
              <div class="r"><span>Showing</span><span class="v-showing">0</span></div>
              <div class="r"><span>No image</span><span class="v-none">0</span></div>
            </div>
            <div class="statusrow">
              <p class="status" aria-live="polite">Reading channel</p>
              <span class="pager" hidden>
                <button class="pg prev" aria-label="Previous 300 results" title="Previous 300 results">&larr;</button>
                <span class="range"></span>
                <button class="pg next" aria-label="Next 300 results" title="Next 300 results">&rarr;</button>
              </span>
            </div>
          </div>
        </section>
        <div class="ribbon" aria-hidden="true"></div>
        <div class="notice" hidden></div>
        <main class="grid"></main>
      </div>`;

    overlay.querySelector('.close').onclick = close;
    if (isSearch) {
      overlay.querySelector('.apply').hidden = true; // search results have no order to write back
      const tok = overlay.querySelector('.tok');
      tok.hidden = false;
      tok.onclick = showTokenForm;
      overlay.querySelector('.chan').textContent = `Search: ${ctx.query}`;
      status('Searching');
    }
    overlay.querySelector('.rev').onclick = (e) => {
      state.reverse = !state.reverse;
      e.currentTarget.setAttribute('aria-pressed', state.reverse);
      render(true);
    };
    overlay.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
    overlay.querySelector('.apply').onclick = showApply;
    overlay.querySelector('.chips').onclick = (e) => {
      const chip = e.target.closest('[data-fam]');
      if (!chip) return;
      const f = chip.dataset.fam;
      if (state.filter.has(f)) state.filter.delete(f); else state.filter.add(f);
      render(true);
    };
    overlay.querySelector('.clear').onclick = () => {
      state.filter.clear();
      overlay.querySelector('.search [type="search"]').value = '';
      setSearch(null);
      render(true);
    };
    const form = overlay.querySelector('.search');
    const text = form.querySelector('[type="search"]');
    const picker = form.querySelector('[type="color"]');
    form.onsubmit = (e) => { e.preventDefault(); };
    text.oninput = () => { setSearch(parseColor(text.value)); render(true); };
    picker.oninput = () => { text.value = picker.value; setSearch(parseColor(picker.value)); render(true); };
    overlay.querySelector('.ribbon').onclick = (e) => {
      const seg = e.target.closest('[data-id]');
      const tile = seg && state.tiles.get(seg.dataset.id);
      if (tile) { tile.scrollIntoView({ block: 'center', behavior: 'smooth' }); flash(tile); }
    };
    markMode();
    overlay.querySelector('.rev').setAttribute('aria-pressed', state.reverse);

    try {
      let blocks;
      if (isSearch) {
        if (!(await getToken())) {
          status('');
          showTokenForm('Searching Are.na through the API needs a personal access token (and a Premium account).');
          return;
        }
        blocks = await searchBlocks(ctx.query, (got, total) => {
          status(`Reading results ${got}${total > got ? ' of ' + total : ''}`);
        }, ctx.type, ctx.chunk || 0);
      } else {
        const channel = await api(`/channels/${encodeURIComponent(ctx.slug)}`);
        if (state.closed) return;
        state.channel = channel;
        overlay.querySelector('.chan').textContent = channel.title;
        blocks = await fetchContents(channel.id, (got, total) => {
          status(`Reading channel ${got} / ${total}`);
        });
      }
      if (state.closed) return;
      state.items = blocks.map((block, index) => ({
        block, index, color: null,
        key: String(block.connection ? block.connection.id : `${block.type}-${block.id}`),
      }));
      buildTiles();
      overlay.querySelector('.v-blocks').textContent = state.items.length;
      status(`Reading colors 0 / ${state.items.length}`);
      let done = 0;
      await colorBlocks(state.items, (it) => {
        done++;
        it.checked = true;
        if (state.search) it.dist = distanceTo(it.color, state.search);
        paintTile(it);
        if (done % 12 === 0 || done === state.items.length) {
          status(`Reading colors ${done} / ${state.items.length}`);
          renderIndex();
        }
      });
      if (state.closed) return;
      const measured = state.items.filter((it) => it.color).length;
      const without = state.items.length - measured;
      const info = state.searchInfo;
      status(isSearch && !state.items.length
        ? `No blocks found for "${ctx.query}". Are.na returned ${info ? info.raw : 0} results${info && info.types.size ? ` (types: ${[...info.types].join(', ')})` : ''}.`
        : (without ? 'Blocks without an image go last.' : ''));
      if (isSearch) showPager();
      overlay.querySelector('.apply').disabled = false;
      render(true);
      if (!isSearch) showRestoreIfSaved();
    } catch (err) {
      if (state.closed) return;
      if (isSearch && (err.status === 401 || err.status === 403 || err.status === 402 || err.network)) {
        status(err.status === 401 ? 'Are.na rejected the token. Check it, or replace it with the Token button.'
          : err.status === 402 || err.status === 403 ? 'Are.na search is a Premium feature, and this account was refused.'
          : `Could not reach Are.na search (${err.message}).`);
      } else {
        status(err.status === 404 || err.status === 401 || err.status === 403
          ? 'This channel could not be read. If it is private, add a personal access token under Apply to channel.'
          : `Something went wrong: ${err.message}`);
      }
      overlay.querySelector('.apply').disabled = false;
    }
  }

  // Back/forward through a search, 300 results at a time. Reopens the view on
  // the new chunk and keeps the chosen order.
  function showPager() {
    const info = state.searchInfo;
    const chunk = state.ctx.chunk || 0;
    const start = chunk * SEARCH_MAX + 1;
    const end = chunk * SEARCH_MAX + (info ? info.raw : 0);
    const total = info && info.total;
    const pager = overlay.querySelector('.pager');
    const prev = pager.querySelector('.prev'), next = pager.querySelector('.next');
    pager.querySelector('.range').textContent = end >= start
      ? `${start.toLocaleString()}\u2013${end.toLocaleString()}${total ? ' of ' + total.toLocaleString() : ''}`
      : '';
    prev.disabled = chunk === 0;
    next.disabled = !total || chunk * SEARCH_MAX + SEARCH_MAX >= total || (info && info.raw < SEARCH_MAX);
    const go = (delta) => {
      const ctx = { ...state.ctx, chunk: chunk + delta, mode: state.mode, reverse: state.reverse };
      close();
      open(ctx);
    };
    prev.onclick = () => go(-1);
    next.onclick = () => go(1);
    pager.hidden = false;
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
          <div class="frame${thumb ? '' : ' is-text'}">${body}</div>
          <div class="cap">${esc(blockLabel(b))}</div>
          <div class="dots"></div>
        </a>`;
    }).join('');
    state.tiles = new Map();
    grid.querySelectorAll('.tile').forEach((t) => state.tiles.set(t.dataset.id, t));
  }

  function paintTile(it) {
    const tile = state.tiles && state.tiles.get(it.key);
    if (!tile || !it.color) return;
    it.fams = familiesOf(it.color);
    tile.querySelector('.dots').innerHTML = it.color.palette.slice(0, 4)
      .map((p) => `<i style="background:${rgb(p.rgb)}"></i>`).join('');
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

  const inFilter = (it) => !state.filter.size || (it.fams || []).some((f) => state.filter.has(f));
  const visible = (it) => inFilter(it) && (!state.search || it.dist <= MATCH_DISTANCE);

  // Any CSS color the browser understands: names, hex, rgb(), hsl().
  const parser = new OffscreenCanvas(1, 1).getContext('2d');
  function parseColor(value) {
    const v = value.trim();
    if (!v) return null;
    parser.fillStyle = '#000';
    parser.fillStyle = v;
    const a = parser.fillStyle;
    parser.fillStyle = '#fff';
    parser.fillStyle = v;
    if (a !== parser.fillStyle) return null; // not a color: both defaults survived
    parser.fillRect(0, 0, 1, 1);
    const d = parser.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  }

  function setSearch(target) {
    state.search = target;
    const form = overlay.querySelector('.search');
    form.classList.toggle('on', !!target);
    if (target) {
      form.querySelector('.swatch').style.background = rgb(target);
      form.querySelector('[type="color"]').value = hex(target);
      for (const it of state.items) it.dist = distanceTo(it.color, target);
    } else {
      form.querySelector('.swatch').style.background = '';
    }
  }

  // The color index: one chip per family present in the channel, with counts.
  function renderIndex() {
    const counts = new Map();
    for (const it of state.items) for (const f of it.fams || []) counts.set(f, (counts.get(f) || 0) + 1);
    overlay.querySelector('.chips').innerHTML = FAMILIES.filter(([k]) => counts.has(k)).map(([k, name, c]) =>
      `<button class="chip" data-fam="${k}" aria-pressed="${state.filter.has(k)}" title="${name}: ${counts.get(k)} blocks">
        <i style="background:${rgb(c)}"></i><span>${name}</span><b>${counts.get(k)}</b></button>`).join('');
    overlay.querySelector('.clear').hidden = !state.filter.size && !state.search;
    overlay.querySelector('.v-showing').textContent = state.items.filter(visible).length;
    overlay.querySelector('.v-none').textContent = state.items.filter((it) => !it.color && it.checked).length;
  }

  function render(animate) {
    if (!state.items.length) return;
    const grid = overlay.querySelector('.grid');
    const order = (state.search
      ? state.items.slice().sort((a, b) => a.dist - b.dist)
      : currentOrder()).filter(visible);
    for (const it of state.items) state.tiles.get(it.key).hidden = !visible(it);
    renderIndex();
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

  function showTokenForm(why) {
    const intro = typeof why === 'string' ? why : 'Reordering needs an Are.na personal access token with write access.';
    const el = notice(`
      <p><strong>${esc(intro)}</strong>
      Create one at <a href="${TOKEN_URL}" target="_blank" rel="noopener">are.na/settings/personal-access-tokens</a>
      and paste it here. It is stored only in this browser and sent only to api.are.na.
      ${state.ctx && state.ctx.kind === 'search' ? 'It is sent as a read-only credential with search requests.' : 'You can reorder channels you own or collaborate on.'}</p>
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
      if (!state.items.length) { const ctx = state.ctx; close(); open(ctx); return; }
      if (state.ctx && state.ctx.kind === 'search') { const ctx = state.ctx; close(); open(ctx); return; }
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

  // Matches are.na: its "areal" face (already loaded by the page), #333 ink,
  // #696969 secondary, hairline rules, 3px flat buttons, navy primary.
  function CSS() {
    return `
      :host { all: initial; }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      .launch, .overlay {
        --bg: #fff; --ink: #333; --mute: #696969; --rule: #ededed; --rule2: #f7f7f7;
        --btn: #f7f7f7; --pri: rgb(0 7 95); --on-pri: #fff;
        font: 12.5px/16.875px areal, "areal Fallback", Arial, Helvetica, sans-serif;
        color: var(--ink); -webkit-font-smoothing: antialiased;
      }
      @media (prefers-color-scheme: dark) {
        .launch, .overlay {
          --bg: #000; --ink: #e5e5e5; --mute: #b2b2b2; --rule: #262626; --rule2: #1a1a1a;
          --btn: #1a1a1a; --pri: rgb(226 223 233); --on-pri: #000;
        }
      }
      button { font: inherit; color: inherit; cursor: pointer; background: none; border: 0; padding: 0; text-align: left; }
      button:focus-visible, a:focus-visible, input:focus-visible { outline: 1px solid var(--ink); outline-offset: 2px; }

      .wheel {
        display: inline-block; flex: none; width: 14px; height: 14px; border-radius: 50%;
        background: conic-gradient(from 20deg, #e5484d, #f59e0b, #e9d63c, #46a758, #12a594, #0090ff, #6e56cf, #d6409f, #e5484d);
        -webkit-mask: radial-gradient(circle, transparent 3px, #000 3.5px);
                mask: radial-gradient(circle, transparent 3px, #000 3.5px);
      }

      .btn, .launch, .notice button {
        display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px;
        border: 1px solid transparent; border-radius: 3px; background: var(--btn);
        font-weight: 700; line-height: 0; white-space: nowrap; color: var(--ink);
      }
      .btn:hover:not(:disabled), .notice button:hover { border-color: var(--rule); }
      .btn:disabled { opacity: .4; cursor: default; }
      .notice .primary { background: var(--pri); color: var(--on-pri); }

      .launch {
        position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
        height: 28px; padding: 0 12px 0 9px; box-shadow: 0 1px 4px rgb(0 0 0 / .12);
      }

      .overlay { position: fixed; inset: 0; z-index: 2147483647; overflow-y: auto; background: var(--bg); overscroll-behavior: contain; }
      .page { padding: 0 clamp(16px, 4.5vw, 65px) 80px; }

      .head { display: flex; align-items: center; gap: 15px; padding: 28px 0 0; min-height: 90px; }
      h1 {
        flex: 1; min-width: 0; margin: 0; display: flex; align-items: center; gap: 15px;
        font-size: 28px; line-height: 35px; font-weight: 700; color: var(--ink);
      }
      h1 .chan { color: var(--mute); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
      h1 .sep { color: var(--mute); font-weight: 400; opacity: .6; }
      h1 .here { display: inline-flex; align-items: center; gap: 10px; white-space: nowrap; }
      h1 .wheel { width: 22px; height: 22px; -webkit-mask: radial-gradient(circle, transparent 5px, #000 5.5px); mask: radial-gradient(circle, transparent 5px, #000 5.5px); }
      .actions { display: flex; gap: 5px; }

      .meta { display: grid; grid-template-columns: 1fr 2fr 1fr; gap: 15px; margin-top: 45px; }
      .label {
        display: flex; justify-content: space-between; align-items: baseline;
        color: var(--mute); line-height: 12.5px; padding-bottom: 2px; border-bottom: 1px solid var(--rule); margin-bottom: 15px;
      }
      .clear { color: var(--mute); text-decoration: underline; line-height: 12.5px; }
      .clear:hover { color: var(--ink); }

      .opts { display: flex; flex-direction: column; align-items: flex-start; border-left: 1px solid var(--rule2); }
      .opt { position: relative; padding: 1px 0 1px 10px; font-weight: 700; color: var(--mute); }
      .opt:hover { color: var(--ink); }
      .opt[aria-checked="true"], .opt[aria-pressed="true"] { color: var(--ink); }
      .opt[aria-checked="true"]::before, .opt[aria-pressed="true"]::before {
        content: ""; position: absolute; left: -1px; top: 5px; width: 4px; height: 9px; border-radius: 1px; background: var(--mute);
      }
      .opt.rev { margin-top: 8px; }

      .search { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
      .search input[type="search"] {
        flex: 1; min-width: 0; height: 24px; padding: 0 8px; border: 1px solid var(--rule); border-radius: 3px;
        background: var(--bg); color: var(--ink); font: inherit;
      }
      .search input[type="search"]::placeholder { color: var(--mute); }
      .swatch {
        position: relative; flex: none; width: 24px; height: 24px; border-radius: 50%; cursor: pointer;
        background: conic-gradient(from 20deg, #e5484d, #f59e0b, #e9d63c, #46a758, #12a594, #0090ff, #6e56cf, #d6409f, #e5484d);
        box-shadow: inset 0 0 0 1px rgb(0 0 0 / .08);
      }
      .search.on .swatch { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3px var(--ink); }
      .swatch input { position: absolute; inset: 0; opacity: 0; width: 100%; height: 100%; cursor: pointer; border: 0; padding: 0; }
      .chips { display: flex; flex-wrap: wrap; gap: 8px 18px; }
      .chip { display: inline-flex; align-items: center; gap: 6px; font-weight: 700; color: var(--mute); }
      .chip i {
        width: 16px; height: 16px; border-radius: 50%; flex: none;
        box-shadow: inset 0 0 0 1px rgb(0 0 0 / .08); transition: box-shadow .15s;
      }
      .chip b { font-weight: 400; }
      .chip:hover { color: var(--ink); }
      .chip[aria-pressed="true"] { color: var(--ink); }
      .chip[aria-pressed="true"] i { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3px var(--ink); }

      .rows .r { display: flex; justify-content: space-between; padding: 0 0 2px; margin-bottom: 3px; border-bottom: 1px solid var(--rule2); color: var(--mute); }
      .rows .r span:last-child { color: var(--ink); font-variant-numeric: tabular-nums; }
      .statusrow { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 8px; }
      .status { margin: 0; color: var(--mute); }
      .pager { display: inline-flex; align-items: center; gap: 6px; color: var(--mute); font-variant-numeric: tabular-nums; }
      .pg { width: 22px; height: 22px; border-radius: 3px; background: var(--btn); color: var(--ink); text-align: center; font-weight: 700; }
      .pg:hover:not(:disabled) { box-shadow: inset 0 0 0 1px var(--rule); }
      .pg:disabled { opacity: .35; cursor: default; }

      .ribbon { display: flex; height: 6px; margin-top: 45px; overflow: hidden; cursor: pointer; }
      .ribbon i { flex: 1; min-width: 0; }

      .notice { margin-top: 20px; padding: 12px 14px; background: var(--btn); border-radius: 3px; max-width: 640px; }
      .notice p { margin: 0 0 10px; }
      .notice a { color: inherit; }
      .notice .row { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
      .notice button { background: var(--bg); }
      .notice .primary { background: var(--pri); }
      .notice .link { background: none; text-decoration: underline; font-weight: 400; color: var(--mute); }
      .notice input {
        flex: 1 1 240px; min-width: 0; height: 24px; padding: 0 8px; border: 1px solid var(--rule); border-radius: 3px;
        background: var(--bg); color: var(--ink); font: inherit;
      }

      .grid {
        display: grid; gap: 65px 15px; margin-top: 45px;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      }
      .tile { display: block; color: inherit; text-decoration: none; outline: 1px solid transparent; outline-offset: 6px; }
      .frame { aspect-ratio: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; }
      .frame img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
      .frame.is-text { align-items: stretch; border: 1px solid var(--rule); }
      .text { padding: 15px; font-size: 15px; line-height: 20px; color: var(--ink); overflow: hidden; width: 100%; word-break: break-word; white-space: pre-line; }
      .cap { margin-top: 18px; padding: 0 10px; text-align: center; color: var(--mute); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tile:hover .cap { color: var(--ink); }
      .dots { display: flex; justify-content: center; gap: 4px; margin-top: 6px; min-height: 7px; }
      .dots i { width: 7px; height: 7px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgb(0 0 0 / .08); }

      @media (max-width: 800px) {
        .meta { grid-template-columns: 1fr 1fr; }
        .meta .colors { grid-column: 1 / -1; order: -1; }
      }
      @media (max-width: 560px) {
        .head { flex-wrap: wrap; min-height: 0; padding-top: 20px; }
        h1 { font-size: 22px; line-height: 28px; flex-basis: 100%; }
        .meta { margin-top: 28px; }
        .grid { gap: 40px 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .text { font-size: 12.5px; line-height: 16px; padding: 10px; }
      }
    `;
  }

  mount();
})();
