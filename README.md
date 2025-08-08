TradingView Finviz Industry Ranks (Firefox)

Overview
- Adds a tiny, unobtrusive widget on TradingView pages showing the stock’s Finviz industry and its rank among industries for 1D/1W/1M/3M/6M performance.
- Useful to quickly gauge how the stock’s industry has performed over multiple timeframes.

How it works
- The content script detects the current ticker on TradingView (URL, title, or data attributes).
- The background service worker queries Finviz:
  - `quote.ashx?t=SYMBOL` to extract the industry name.
  - `groups.ashx?g=industry&v=210&o=name` to read industry performance values.
- It ranks the industry vs all industries for each period and sends results back to the page.

Install (Temporary, for development)
1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click “Load Temporary Add-on…”.
3. Select this repo’s `manifest.json`.
4. Open any TradingView chart/symbol page (e.g., `https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL`).
5. A small “Finviz” widget appears at bottom-right. Click the square icon to collapse/expand.

Notes
- Some symbols (ETFs, FX, Crypto) do not have an industry on Finviz — the widget will show “No data”.
- If Finviz temporarily blocks automated requests, data may not load. Try again later.
- The widget aims to be subtle; position is bottom-right with a small, collapsible card.

Development
- Files:
  - `manifest.json`: WebExtension manifest (MV3).
  - `src/background.js`: Fetches/parses Finviz pages and computes ranks.
  - `src/contentScript.js`: Detects symbol on TradingView and renders the widget.
  - `src/contentStyles.css`: Minimal styles for the floating widget.

Packaging
- For distribution, zip the files maintaining folder structure and submit to AMO. During review, ensure your permissions are minimal — only Finviz host permissions are required for cross-origin fetch.

Privacy
- No data is persisted remotely. The extension only reads the current TradingView URL to extract the symbol and queries Finviz. A collapsed/expanded preference is stored locally via `localStorage`.

