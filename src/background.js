// Background service worker for cross-origin fetch and parsing

// Message protocol:
// { type: 'getIndustryRanks', ticker: 'AAPL' }
// -> { ok: true, industry: 'Semiconductors', ranks: { '1D': 12, '1W': 10, '1M': 8, '3M': 5, '6M': 14 }, values: { '1D': 1.2, ... }, total: 64 }

const GROUPS_URL = 'https://finviz.com/groups.ashx?g=industry&v=210&o=name';

// Listen for TradingView symbol data requests to detect symbol changes reliably
try {
  const filter = { urls: ["https://scanner.tradingview.com/*"], types: ["xmlhttprequest", "beacon", "ping", "other"] };
  browser.webRequest.onBeforeRequest.addListener(async (details) => {
    try {
      if (!details || typeof details.url !== 'string') return;
      const url = new URL(details.url);
      let sym = url.searchParams.get('symbol') || '';
      if (!sym) return;
      // Decode and sanitize: strip trailing '^' and whitespace
      sym = decodeURIComponent(sym).trim().replace(/\^+$/, '');
      if (!sym) return;
      // Notify the content script in this tab
      let delivered = false;
      if (typeof details.tabId === 'number' && details.tabId >= 0) {
        try { await browser.tabs.sendMessage(details.tabId, { type: 'symbolChanged', symbol: sym }); delivered = true; } catch (e) {}
      }
      if (!delivered) {
        try {
          const tabs = await browser.tabs.query({ url: ["*://*.tradingview.com/*", "*://tradingview.com/*"] });
          for (const t of tabs) {
            try { await browser.tabs.sendMessage(t.id, { type: 'symbolChanged', symbol: sym }); delivered = true; } catch (e) {}
          }
        } catch (e) {}
      }
    } catch (e) {
      // ignore
    }
  }, filter, []);
} catch (e) {
  // webRequest may not be available in some contexts; ignore
}

browser.runtime.onMessage.addListener(async (msg, sender) => {
  if (!msg || msg.type !== 'getIndustryRanks') return;
  const ticker = String(msg.ticker || '').trim().toUpperCase();
  if (!ticker) return { ok: false, error: 'EMPTY_TICKER' };
  try {
    const industry = await fetchIndustryForTicker(ticker);
    if (!industry) return { ok: false, error: 'INDUSTRY_NOT_FOUND' };
    const { ranks, values, total } = await fetchIndustryRanks(industry);
    return { ok: true, industry, ranks, values, total };
  } catch (e) {
    return { ok: false, error: 'UNEXPECTED', detail: String(e && e.message || e) };
  }
});

async function fetchIndustryForTicker(ticker) {
  const url = `https://finviz.com/quote.ashx?t=${encodeURIComponent(ticker)}`;
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`Finviz quote fetch failed: ${res.status}`);
  const html = await res.text();

  // 1) Try robust row-based capture: the TD after the label "Industry"
  const rowMatch = html.match(/>\s*Industry\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  if (rowMatch) {
    const cell = rowMatch[1];
    const anchorText = matchFirst(cell, /<a[^>]*>([^<]+)<\/a>/i) || stripTags(cell);
    const txt = textCleanup(anchorText);
    if (txt) return decodeHtmlEntities(txt);
  }

  // 2) Fallback: screener industry links (f=ind_...)
  const scrMatch = html.match(/screener\.ashx\?v=\d+&f=ind_[^"']+["'][^>]*>\s*([^<]+)\s*<\/a>/i);
  if (scrMatch) {
    return decodeHtmlEntities(textCleanup(scrMatch[1]));
  }

  // 3) Fallback: groups industry links
  const grpMatch = html.match(/groups\.ashx\?g=industry[^"']*["'][^>]*>\s*([^<]+)\s*<\/a>/i);
  if (grpMatch) {
    return decodeHtmlEntities(textCleanup(grpMatch[1]));
  }

  // Some tickers (ETFs/FX/Crypto) won't have industry
  return null;
}

async function fetchIndustryRanks(targetIndustry) {
  const res = await fetch(GROUPS_URL, { credentials: 'omit' });
  if (!res.ok) throw new Error(`Finviz groups fetch failed: ${res.status}`);
  const html = await res.text();

  // The page embeds a JS array: var rows = [ { label: 'Industry', perfW: ..., perfM: ... }, ... ];
  const rowsJson = matchFirst(html, /\bvar\s+rows\s*=\s*(\[[\s\S]*?\]);/i) || matchFirst(html, /\brows\s*=\s*(\[[\s\S]*?\]);\s*\n/i);
  if (!rowsJson) throw new Error('ROWS_JSON_NOT_FOUND');
  let rows;
  try {
    rows = JSON.parse(rowsJson);
  } catch (e) {
    // Try to salvage by removing trailing commas or weird characters
    const cleaned = rowsJson.replace(/,(\s*])/, '$1');
    rows = JSON.parse(cleaned);
  }

  const idxExact = rows.findIndex(r => normalize(r.label) === normalize(targetIndustry));
  const idxLoose = idxExact !== -1 ? idxExact : rows.findIndex(r => normalize(r.label).includes(normalize(targetIndustry)) || normalize(targetIndustry).includes(normalize(r.label)));
  const targetIndex = idxLoose;
  if (targetIndex === -1) throw new Error(`INDUSTRY_ROW_NOT_FOUND: ${targetIndustry}`);

  return computeRanksFromRows(rows, targetIndex);
}

function computeRanksFromRows(rows, targetIndex) {
  const total = rows.length;
  const keys = {
    '1D': 'perfT',
    '1W': 'perfW',
    '1M': 'perfM',
    '3M': 'perfQ',
    '6M': 'perfH'
  };
  const values = {};
  const ranks = {};

  for (const k of Object.keys(keys)) {
    const prop = keys[k];
    const targetVal = toNumber(rows[targetIndex][prop]);
    values[k] = Number.isFinite(targetVal) ? targetVal : null;
    const sortable = rows.map((r, i) => ({ i, val: toNumber(r[prop]) })).filter(x => Number.isFinite(x.val));
    sortable.sort((a, b) => b.val - a.val);
    let rank = null;
    if (Number.isFinite(targetVal)) {
      for (let i = 0; i < sortable.length; i++) {
        if (sortable[i].i === targetIndex) { rank = i + 1; break; }
      }
    }
    ranks[k] = rank;
  }
  return { ranks, values, total };
}

function toNumber(s) {
  if (s == null) return NaN;
  const num = parseFloat(String(s).replace(/[%,+]/g, '').trim());
  return Number.isFinite(num) ? num : NaN;
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, '');
}

function textCleanup(s) {
  return String(s).replace(/\s+/g, ' ').replace(/\u00A0/g, ' ').trim();
}

function normalize(s) {
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(str) {
  // Minimal common entities
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function matchFirst(s, re) {
  const m = String(s).match(re);
  return m ? m[1] : '';
}
