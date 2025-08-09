// Content script injected on TradingView to display Finviz industry ranks

const WIDGET_ID = 'tv-finviz-industry-widget';
const EMBED_ID = 'tv-finviz-industry-embedded';
let lastSymbol = null;
let loading = false;
let pendingTimer = null;
let pollTimer = null;
let overrideSymbol = null;
let displayMode = 'embedded';
let lastModel = null;

init();

function init() {
  // Only run widget logic in top frame
  if (window.top !== window) return;
  // Initial run and then observe SPA URL/symbol changes
  loadSettings().then(() => tick());
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

function loadSettings() {
  try {
    const s = (browser && browser.storage && browser.storage.local) ? browser.storage.local : null;
    if (!s) return Promise.resolve();
    return s.get('displayMode').then((res) => {
      displayMode = (res && res.displayMode) ? String(res.displayMode) : 'embedded';
      // React to runtime changes
      try {
        browser.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes.displayMode) {
            displayMode = changes.displayMode.newValue || 'embedded';
            // Re-render the current model in the new mode
            if (lastModel) scheduleRenderImmediate();
          }
        });
      } catch {}
    });
  } catch {
    return Promise.resolve();
  }
}

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
  lastModel = model;
  if (displayMode === 'embedded') {
    removeFloatingRoot();
    renderEmbedded(model);
  } else {
    removeEmbeddedRoot();
    renderFloating(model);
  }
}

function renderFloating(model) {
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

function renderEmbedded(model) {
  const compact = localStorage.getItem('tvfvz-collapsed') === '1';

  // Prefer to insert as a sibling before the Key Stats panel wrapper identified by 'details-key-stats'
  const keyStatsEl = findDetailsKeyStatsPanel();
  if (!keyStatsEl || !keyStatsEl.parentElement) {
    // Retry shortly; TradingView UI can be async
    setTimeout(() => { if (lastModel && displayMode === 'embedded') renderEmbedded(lastModel); }, 500);
    return;
  }

  const anchor = keyStatsEl;
  const parentForInsert = keyStatsEl.parentElement;

  let root = document.getElementById(EMBED_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = EMBED_ID;
    root.className = 'tvfvz-embedded-root';
  }
  // Ensure it's positioned before the Key Stats panel block
  try {
    const needsInsert = !root.parentNode || root.parentNode !== parentForInsert || (anchor.previousSibling !== root);
    if (needsInsert) {
      if (root.parentNode) root.parentNode.removeChild(root);
      parentForInsert.insertBefore(root, anchor);
    }
  } catch {
    try {
      if (root.parentNode) root.parentNode.removeChild(root);
      parentForInsert.insertBefore(root, anchor);
    } catch {}
  }

  // Ensure a separator is placed after our panel for spacing
  try { ensureSeparatorAfter(root, parentForInsert, anchor); } catch {}
  // Build a native-like panel by copying classes from Key Stats
  const mimic = sniffDetailsKeyStatsClasses(keyStatsEl);

  if (model.state === 'loading') {
    root.className = `tvfvz-embedded-root ${mimic.panelClass}`.trim();
    root.innerHTML = `${sectionHeaderHtml('Industry Performance', mimic)}
      <div class="tvfvz-panel-list"><div class="tvfvz-panel-row">Loading ${escapeHtml(model.symbol)}…</div></div>`;
    return;
  }
  if (model.state === 'error') {
    root.className = `tvfvz-embedded-root ${mimic.panelClass}`.trim();
    const msg = `No data${model.error ? ` (${escapeHtml(model.error)})` : ''}`;
    root.innerHTML = `${sectionHeaderHtml('Industry Performance', mimic)}
      <div class="tvfvz-panel-list"><div class="tvfvz-panel-row">${msg}</div></div>`;
    return;
  }
  if (model.state === 'idle') {
    root.className = `tvfvz-embedded-root ${mimic.panelClass}`.trim();
    const msg = model.note || '';
    root.innerHTML = `${sectionHeaderHtml('Industry Performance', mimic)}
      <div class="tvfvz-panel-list"><div class="tvfvz-panel-row">${escapeHtml(msg)}</div></div>`;
    return;
  }

  const { symbol, industry, ranks, values, total } = model;
  const pos = (k) => ranks[k] ? `#${ranks[k]} / ${total}` : '—';
  const val = (k) => values[k] == null ? '' : `${values[k] > 0 ? '+' : ''}${values[k].toFixed(2)}%`;

  const row = (label) => `
    <div class="tvfvz-panel-row">
      <span class="tvfvz-k">${label}</span>
      <span class="tvfvz-v">${pos(label)}</span>
      <span class="tvfvz-p ${values[label] < 0 ? 'tvfvz-neg' : 'tvfvz-pos'}">${val(label)}</span>
    </div>`;

  root.className = `tvfvz-embedded-root ${mimic.panelClass}`.trim();
  root.innerHTML = `${sectionHeaderHtml('Industry Performance', mimic)}
    <div class="tvfvz-panel-list">
      ${row('1D')}
      ${row('1W')}
      ${row('1M')}
      ${row('3M')}
      ${row('6M')}
    </div>`;
}

function removeFloatingRoot() {
  const root = document.getElementById(WIDGET_ID);
  if (root && root.parentNode) root.parentNode.removeChild(root);
}

function removeEmbeddedRoot() {
  const root = document.getElementById(EMBED_ID);
  if (root && root.parentNode) {
    const parent = root.parentNode;
    const next = root.nextSibling;
    parent.removeChild(root);
    // Remove adjacent separator we may have added
    if (next && next.nodeType === 1 && next.classList && next.classList.contains('separator-BSF4XTsE')) {
      try { parent.removeChild(next); } catch {}
    }
  }
}

function scheduleRenderImmediate() {
  if (!lastModel) return;
  renderWidget(lastModel);
}

// Old generic injection anchor (kept as fallback)
function findInjectionAnchor() {
  const isVisible = (el) => !!(el && el.getClientRects().length && el.offsetParent !== null);
  const rect = (el) => (el.getBoundingClientRect ? el.getBoundingClientRect() : { top: 0, left: 0 });
  const scoreBottomRight = (el) => {
    const r = rect(el);
    return r.top * 10000 + r.left; // prefer bottom-most, then right-most
  };

  const normalizeText = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const contains = (s, needle) => normalizeText(s).toLowerCase().includes(needle);

  const candidates = Array.from(document.querySelectorAll('h1, h2, h3, header *, [data-name], [class], div, span, p, a, td, th, li'))
    .filter(isVisible)
    .map(el => ({ el, txt: normalizeText(el.textContent || '') }))
    .filter(x => x.txt && x.txt.length >= 6);

  // 1) Prefer the Key Stats -> Next earnings report row
  const earningsLabels = candidates.filter(x => contains(x.txt, 'next earnings'))
    .sort((a, b) => scoreBottomRight(b.el) - scoreBottomRight(a.el));
  for (const cand of earningsLabels) {
    // Ensure it's under a Key Stats section if possible
    const section = cand.el.closest('section, div, table, ul, ol');
    const sectionText = section ? normalizeText(section.textContent || '') : '';
    if (!section || /key\s*stats/i.test(sectionText) || /key\s*statistics/i.test(sectionText)) {
      // Insert after the row containing this label
      const row = cand.el.closest('tr, li, [role="row"], [class*="row"], div');
      if (row && row.parentNode) return row;
      return cand.el;
    }
  }

  // 3) Known containers
  const header = document.querySelector('[data-name="symbol-header"], [data-name*="symbol"], [class*="symbol"][class*="header"], header');
  if (header) return header;

  // 4) Fallback to bottom-right-most visible block
  const blocks = Array.from(document.querySelectorAll('div, section, header')).filter(isVisible);
  blocks.sort((a, b) => scoreBottomRight(b) - scoreBottomRight(a));
  return blocks[0] || null;
}

function chooseEmbeddedVariant(anchor) {
  try {
    if (!anchor) return 'inline';
    const rowLike = anchor.closest && anchor.closest('tr, li, [role="row"], [class*="row"], table, ul, ol');
    return rowLike ? 'block' : 'inline';
  } catch { return 'inline'; }
}

function findKeyStatsPanelAndContainer() {
  // 1) Try heading match
  const head = findElementByText(/\bkey\s*stat(s|istics)?\b/i);
  if (head) {
    const panel = findPanelWrapperFromHeading(head);
    if (panel && panel.parentElement) return { panel, parent: panel.parentElement };
  }
  // 2) Fallback: a known row like "Next earnings" and infer panel
  const row = findElementByText(/next\s+earnings/i);
  if (row) {
    const panel = findPanelWrapperFromRow(row);
    if (panel && panel.parentElement) return { panel, parent: panel.parentElement };
  }
  // 3) As a last resort, fallback to previous generic anchor and insert after it
  const generic = findInjectionAnchor();
  if (generic && generic.parentElement) return { panel: generic.nextSibling, parent: generic.parentElement };
  return null;
}

function renderEmbeddedSectionHeader() {
  return '<div class="tvfvz-section-title">Industry Performance</div>';
}

function findElementByText(re) {
  try {
    const isVisible = (el) => !!(el && el.getClientRects().length && el.offsetParent !== null);
    const nodes = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, span, div, p, a, li, td, th'))
      .filter(isVisible)
      .filter(el => re.test((el.textContent || '').trim()));
    // Choose the bottom-right-most match to bias towards the lower details panel
    nodes.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return (rb.top * 10000 + rb.left) - (ra.top * 10000 + ra.left);
    });
    return nodes[0] || null;
  } catch { return null; }
}

function findPanelWrapperFromHeading(headingEl) {
  try {
    const rowSelector = 'tr, li, [role="row"], [class*="row"]';
    let node = headingEl;
    for (let i = 0; i < 8 && node && node.parentElement; i++) {
      const cand = node.parentElement;
      // candidate must contain the heading and have a list of rows after it
      const hasRows = cand.querySelector(rowSelector);
      if (hasRows) return cand;
      node = cand;
    }
    return headingEl.parentElement || headingEl;
  } catch { return headingEl; }
}

function findPanelWrapperFromRow(rowEl) {
  try {
    let node = rowEl;
    for (let i = 0; i < 8 && node && node.parentElement; i++) {
      const cand = node.parentElement;
      const hasHeading = cand.querySelector('h1,h2,h3,h4,[role="heading"]');
      const manyRows = cand.querySelectorAll('tr, li, [role="row"], [class*="row"]').length >= 3;
      if (manyRows && hasHeading) return cand;
      node = cand;
    }
    return rowEl.parentElement || rowEl;
  } catch { return rowEl; }
}

// Note: no longer escalating to a higher container; we insert before the Key Stats panel in its immediate parent

function sectionHeaderHtml(text, mimic) {
  const tag = (mimic && mimic.headingTag) || 'h3';
  const cls = (mimic && mimic.headingClass) ? ` ${mimic.headingClass}` : '';
  return `<${tag} class="tvfvz-section-title${cls}">${escapeHtml(text)}</${tag}>`;
}

function ensureSeparatorAfter(root, parent, beforeNode) {
  if (!root || !parent || !beforeNode) return;
  const next = root.nextSibling;
  if (next && next.nodeType === 1 && next.classList && next.classList.contains('separator-BSF4XTsE')) return;
  const sep = document.createElement('div');
  sep.className = 'separator-BSF4XTsE';
  parent.insertBefore(sep, beforeNode);
}

function findDetailsKeyStatsPanel() {
  const selectors = [
    '#details-key-stats',
    '.details-key-stats',
    '[data-name="details-key-stats"]',
    '[data-widget="details-key-stats"]',
    '[id*="details-key-stats"]',
    '[class*="details-key-stats"]'
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }
  // Fallback to heading-based search
  const head = findElementByText(/\bkey\s*stat(s|istics)?\b/i);
  if (head) return findPanelWrapperFromHeading(head);
  // Fallback to earnings row
  const row = findElementByText(/next\s+earnings/i);
  if (row) return findPanelWrapperFromRow(row);
  return null;
}

function sniffDetailsKeyStatsClasses(panelEl) {
  try {
    // Use the panel's own class to mimic card/frame visuals
    const panelClass = (panelEl && panelEl.className) ? panelEl.className : '';
    // Use the heading tag/class inside panel
    const head = panelEl.querySelector('h1, h2, h3, h4, [role="heading"]');
    const headingTag = head ? head.tagName.toLowerCase() : 'h3';
    const headingClass = head ? head.className : '';
    return { panelClass, headingTag, headingClass };
  } catch {
    return { panelClass: '', headingTag: 'h3', headingClass: '' };
  }
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

  // Dragging support on header (ignore clicks on toggle) - only in floating mode
  const header = root.querySelector('.tvfvz-header');
  const isEmbedded = root.id === EMBED_ID || root.classList.contains('tvfvz-embedded-root') || root.closest && root.closest('.tvfvz-embedded-root');
  if (header && !isEmbedded) {
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
