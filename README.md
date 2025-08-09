**TradingView Finviz Industry Ranks (Firefox)**

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
4. Open any TradingView chart/symbol page


