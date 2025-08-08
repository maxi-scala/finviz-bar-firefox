// Content script injected on TradingView to display Finviz industry ranks

const WIDGET_ID = 'tv-finviz-industry-widget';
let lastSymbol = null;
let loading = false;
let pendingTimer = null;
let pollTimer = null;
let overrideSymbol = null;

init();

function init() {
  // Only run widget logic in top frame
  if (window.top !== window) return;
  // Initial run and then observe SPA URL/symbol changes
  tick();
  observeUrlChanges();
  installNetworkSniffer();
  injectPageHook();
  // Listen for page-context events
  window.addEventListener('tvfvz-symbol', (ev) => {
    try {
      const sym = (ev && ev.detail) ? String(ev.detail).trim() : '';
      if (sym) { overrideSymbol = sym; scheduleTick(10); }
    } catch {}
  }, false);
}
// End init

function observeUrlChanges() {
  const onChange = () => scheduleTick(100);
  window.addEventListener('popstate', onChange);
  window.addEventListener('hashchange', onChange);
}

function scheduleTick(delay = 0) {
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(tick, delay);
}

// Removed polling; rely on network intercept + URL events

async function tick() {
  const urlSym = getSymbolFromUrl();
  // Prefer live network-detected symbol; fall back to URL, then DOM
  const symbol = overrideSymbol || urlSym || getCurrentSymbolDom();
  if (!symbol) {
    renderWidget({ state: 'idle', note: 'No symbol detected' });
    return;
  }
  if (symbol === lastSymbol && !loading) return;
  lastSymbol = symbol;
  loading = true;
  renderWidget({ state: 'loading', symbol });
  try {
    const { baseTicker } = parseSymbol(symbol);
    const resp = await browser.runtime.sendMessage({ type: 'getIndustryRanks', ticker: baseTicker });
    loading = false;
    if (!resp || !resp.ok) {
      renderWidget({ state: 'error', symbol, error: resp && resp.error });
      return;
    }
    renderWidget({
      state: 'ready',
      symbol,
      industry: resp.industry,
      ranks: resp.ranks,
      values: resp.values,
      total: resp.total
    });
  } catch (e) {
    loading = false;
    renderWidget({ state: 'error', symbol, error: e && e.message });
  }
}

function getCurrentSymbolDom() {
  // URL-based detection removed from DOM fallback; see getSymbolFromUrl()

  // Try visible links containing a symbol path
  const link = Array.from(document.querySelectorAll('a[href*="/symbol/"]'))
    .filter(a => a.offsetParent !== null)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
  if (link) {
    const mm = link.getAttribute('href').match(/\/symbol\/([^\/?#]+)/i);
    if (mm) return decodeURIComponent(mm[1]);
  }

  // Try links with symbol query param
  const link2 = Array.from(document.querySelectorAll('a[href*="symbol="]'))
    .filter(a => a.offsetParent !== null)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
  if (link2) {
    try {
      const u = new URL(link2.href, location.href);
      const sym = u.searchParams.get('symbol');
      if (sym) return decodeURIComponent(sym);
    } catch {}
  }

  // Try TradingView header symbol search area
  const searchRoot = document.querySelector('[data-name="symbol-search-input"], [data-name="header-toolbar-symbol-search"]');
  if (searchRoot) {
    const inp = searchRoot.querySelector('input');
    if (inp && inp.offsetParent !== null && inp.value) {
      const val = inp.value.trim();
      const mm = val.match(/([A-Za-z]+:)?([A-Z][A-Z0-9.]{0,9})/);
      if (mm) return mm[2];
    }
    // contenteditable variant
    const ce = searchRoot.querySelector('[contenteditable="true"]');
    if (ce && ce.offsetParent !== null) {
      const txt = (ce.textContent || '').trim();
      const mm = txt.match(/([A-Za-z]+:)?([A-Z][A-Z0-9.]{0,9})/);
      if (mm) return mm[2];
    }
  }

  // Any visible contenteditable element that looks like ticker
  const ceAny = Array.from(document.querySelectorAll('[contenteditable="true"]'))
    .filter(el => el.offsetParent !== null)
    .map(el => (el.textContent || '').trim())
    .find(txt => /\b[A-Z][A-Z0-9.]{0,9}\b/.test(txt));
  if (ceAny) {
    const mm = ceAny.match(/([A-Za-z]+:)?([A-Z][A-Z0-9.]{0,9})/);
    if (mm) return mm[2];
  }

  // Try visible inputs whose value looks like a ticker
  const tickerInput = Array.from(document.querySelectorAll('input'))
    .filter(inp => inp.offsetParent !== null && typeof inp.value === 'string' && inp.value.trim())
    .map(inp => ({ el: inp, rect: inp.getBoundingClientRect(), val: inp.value.trim() }))
    .filter(x => /^[A-Z][A-Z0-9.]{0,9}$/.test(x.val))
    .sort((a, b) => a.rect.top - b.rect.top)[0];
  if (tickerInput) return tickerInput.val;

  // Try from title (often like "AAPL Stock Price & Chart ...")
  const t = document.title || '';
  const tm = t.match(/^[A-Z.]{1,6}\b/);
  if (tm) return tm[0];

  // Try common element with data-symbol
  const el = document.querySelector('[data-symbol], [data-symbol-short], [data-main-symbol], [data-symbol-full]');
  if (el) return el.getAttribute('data-symbol') || el.getAttribute('data-symbol-short');

  return null;
}

function getSymbolFromUrl() {
  try {
    const u = new URL(location.href);
    const sym = u.searchParams.get('symbol');
    if (sym) return decodeURIComponent(sym);
  } catch {}
  const m = location.pathname.match(/\/symbol\/([^\/]+)/i);
  if (m) return decodeURIComponent(m[1]);
  return null;
}

// Listen to background symbol change hints from TradingView requests
try {
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'symbolChanged') return;
    const raw = String(msg.symbol || '').trim();
    if (!raw) return;
    overrideSymbol = raw;
    // Force quick refresh
    scheduleTick(10);
  });
} catch {}

function normalizeSymbol(s) {
  return String(s || '').trim().toUpperCase();
}

function parseSymbol(symbol) {
  // Inputs like: NASDAQ:AAPL, NASDAQ-AAPL, AAPL, FX:EURUSD -> take rightmost token
  const s = String(symbol).trim();
  const partsColon = s.split(':');
  const lastColon = partsColon[partsColon.length - 1];
  const partsDash = lastColon.split('-');
  const last = partsDash[partsDash.length - 1];
  // Remove forex/crypto pairs like EURUSD -> not suitable for Finviz
  return { baseTicker: last.replace(/[^A-Za-z.]/g, '').toUpperCase() };
}

// Lightweight page-level network sniffer to catch TradingView symbol requests
function installNetworkSniffer() {
  try {
    if (window.__tvfvz_sniffer_installed) return;
    window.__tvfvz_sniffer_installed = true;

    const tryUrl = (u) => {
      if (!u || typeof u !== 'string') return;
      if (!u.includes('scanner.tradingview.com')) return;
      try {
        const url = new URL(u, location.href);
        if (!/\/symbol(\b|\?|#|\/)/.test(url.pathname)) return;
        let sym = url.searchParams.get('symbol') || '';
        if (!sym) return;
        sym = decodeURIComponent(sym).trim().replace(/\^+$/, '');
        if (!sym) return;
        overrideSymbol = sym;
        scheduleTick(10);
      } catch {}
    };

    // Wrap fetch
    const _fetch = window.fetch;
    if (typeof _fetch === 'function') {
      window.fetch = function(input, init) {
        try {
          const url = typeof input === 'string' ? input : (input && input.url);
          tryUrl(url);
        } catch {}
        return _fetch.apply(this, arguments);
      };
    }

    // Wrap XHR open
    const _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      try { tryUrl(url); } catch {}
      return _open.apply(this, arguments);
    };
  } catch {}
}

// Inject a script into the page context to hook fetch/XHR in the same JS world as TradingView
function injectPageHook() {
  try {
    if (document.getElementById('tvfvz-page-hook')) return;
    const s = document.createElement('script');
    s.id = 'tvfvz-page-hook';
    s.src = (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getURL)
      ? browser.runtime.getURL('src/pageHook.js')
      : (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
        ? chrome.runtime.getURL('src/pageHook.js')
        : '';
    if (!s.src) return;
    (document.head || document.documentElement).appendChild(s);
  } catch {}
}

function renderWidget(model) {
  let root = document.getElementById(WIDGET_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = WIDGET_ID;
    document.documentElement.appendChild(root);
  }
  root.className = 'tvfvz-root';
  applySavedPosition(root);

  const compact = localStorage.getItem('tvfvz-collapsed') === '1';

  if (model.state === 'loading') {
    root.innerHTML = widgetShell(compact, `Loading ${escapeHtml(model.symbol)}…`);
    attachHandlers(root);
    return;
  }
  if (model.state === 'error') {
    root.innerHTML = widgetShell(compact, `No data${model.error ? ` (${escapeHtml(model.error)})` : ''}`);
    attachHandlers(root);
    return;
  }
  if (model.state === 'idle') {
    root.innerHTML = widgetShell(compact, model.note || '');
    attachHandlers(root);
    return;
  }

  const { symbol, industry, ranks, values, total } = model;
  const pos = (k) => ranks[k] ? `#${ranks[k]} / ${total}` : '—';
  const val = (k) => values[k] == null ? '' : `${values[k] > 0 ? '+' : ''}${values[k].toFixed(2)}%`;

  const content = `
    <div class="tvfvz-row tvfvz-title">
      <span class="tvfvz-pill">${escapeHtml(symbol)}</span>
      <span class="tvfvz-sep">·</span>
      <span class="tvfvz-industry" title="Finviz industry">${escapeHtml(industry)}</span>
    </div>
    <div class="tvfvz-grid">
      ${metricRow('1D', pos('1D'), val('1D'))}
      ${metricRow('1W', pos('1W'), val('1W'))}
      ${metricRow('1M', pos('1M'), val('1M'))}
      ${metricRow('3M', pos('3M'), val('3M'))}
      ${metricRow('6M', pos('6M'), val('6M'))}
    </div>
  `;

  root.innerHTML = widgetShell(compact, content);
  attachHandlers(root);
}

function widgetShell(compact, innerHtml) {
  return `
    <div class="tvfvz-frame ${compact ? 'tvfvz-collapsed' : ''}">
      <div class="tvfvz-header">
        <span class="tvfvz-badge">Finviz</span>
        <button class="tvfvz-toggle" title="Collapse/expand" aria-label="Toggle">${compact ? '▸' : '▾'}</button>
      </div>
      <div class="tvfvz-body">${innerHtml}</div>
    </div>
  `;
}

function metricRow(label, pos, val) {
  return `
    <div class="tvfvz-metric">
      <span class="tvfvz-k">${label}</span>
      <span class="tvfvz-v" title="Rank among industries">${pos}</span>
      <span class="tvfvz-p ${val.startsWith('-') ? 'tvfvz-neg' : 'tvfvz-pos'}" title="Performance">${val}</span>
    </div>
  `;
}

function attachHandlers(root) {
  const btn = root.querySelector('.tvfvz-toggle');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const frame = root.querySelector('.tvfvz-frame');
      frame.classList.toggle('tvfvz-collapsed');
      const collapsed = frame.classList.contains('tvfvz-collapsed') ? '1' : '0';
      localStorage.setItem('tvfvz-collapsed', collapsed);
      // Update icon
      btn.textContent = collapsed === '1' ? '▸' : '▾';
    });
  }

  // Dragging support on header (ignore clicks on toggle)
  const header = root.querySelector('.tvfvz-header');
  if (header) {
    let dragging = false;
    let sx = 0, sy = 0, startLeft = 0, startTop = 0;

    function onMouseMove(ev) {
      if (!dragging) return;
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      let left = startLeft + dx;
      let top = startTop + dy;
      const rect = root.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const maxLeft = vw - rect.width;
      const maxTop = vh - rect.height;
      left = Math.max(0, Math.min(left, maxLeft));
      top = Math.max(0, Math.min(top, maxTop));
      root.style.left = left + 'px';
      root.style.top = top + 'px';
    }

    function onMouseUp() {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      persistPosition(root);
    }

    header.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      if (ev.target && ev.target.closest && ev.target.closest('.tvfvz-toggle')) return;
      ev.preventDefault();
      const rect = root.getBoundingClientRect();
      root.style.left = rect.left + 'px';
      root.style.top = rect.top + 'px';
      root.style.right = '';
      root.style.bottom = '';
      sx = ev.clientX; sy = ev.clientY;
      startLeft = rect.left; startTop = rect.top;
      dragging = true;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    window.addEventListener('resize', () => ensureInViewport(root));
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Position helpers for drag-to-move
function applySavedPosition(root) {
  try {
    const raw = localStorage.getItem('tvfvz-pos');
    if (!raw) return;
    const pos = JSON.parse(raw);
    if (typeof pos.left === 'number' && typeof pos.top === 'number') {
      root.style.left = pos.left + 'px';
      root.style.top = pos.top + 'px';
      root.style.right = '';
      root.style.bottom = '';
      ensureInViewport(root);
    }
  } catch {}
}

function persistPosition(root) {
  const rect = root.getBoundingClientRect();
  const pos = { left: Math.round(rect.left), top: Math.round(rect.top) };
  try { localStorage.setItem('tvfvz-pos', JSON.stringify(pos)); } catch {}
}

function ensureInViewport(root) {
  const rect = root.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = rect.left, top = rect.top;
  let changed = false;
  if (left + rect.width > vw) { left = Math.max(0, vw - rect.width); changed = true; }
  if (top + rect.height > vh) { top = Math.max(0, vh - rect.height); changed = true; }
  if (left < 0) { left = 0; changed = true; }
  if (top < 0) { top = 0; changed = true; }
  if (changed) {
    root.style.left = left + 'px';
    root.style.top = top + 'px';
    root.style.right = '';
    root.style.bottom = '';
    persistPosition(root);
  }
}
