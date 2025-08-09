# Repository Guidelines

## Project Structure & Module Organization
- `manifest.json`: WebExtension manifest (Firefox MV2).
- `src/background.js`: Fetches Finviz pages and computes industry ranks.
- `src/contentScript.js`: Detects the TradingView symbol, renders the widget, wires events.
- `src/contentStyles.css`: Styles for the floating widget.
- `src/pageHook.js`: Page-context hook for fetch/XHR to detect symbol changes.
- `assets/`: Icons and static assets (e.g., `favicon.png`).

## Build, Test, and Development Commands
- Load temporarily (Firefox): open `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → select `manifest.json`.
- Package for review: `zip -r dist/finviz-bar.zip manifest.json src assets` (create `dist/` first).
- Quick reload: after edits, use the “Reload” button in `about:debugging`.

## Coding Style & Naming Conventions
- Indentation: 2 spaces; use `const`/`let`, single quotes, end lines with semicolons.
- Filenames: camelCase for JS (`contentScript.js`), kebab-case not used.
- Functions: small, single-purpose helpers (e.g., `fetchIndustryRanks`, `parseSymbol`).
- No build tooling or bundlers; keep dependencies zero and APIs WebExtension-compatible.

## Testing Guidelines
- Manual smoke tests on TradingView pages:
  - Symbol detection: change symbols via URL and UI; verify widget updates.
  - Data fetch: validate industry name and ranks for several tickers (e.g., AAPL, MSFT).
  - Error states: try non-equity symbols (FX/Crypto/ETFs) → shows “No data”.
  - UI: collapse/expand, drag-to-move, position persistence across reloads.
- Run through common layouts (chart, symbol overview) and light/dark themes.

## Commit & Pull Request Guidelines
- Commits: imperative subject, <= 72 chars; include rationale in body.
  - Example scopes: `background:`, `contentScript:`, `styles:`, `manifest:`.
- PRs: clear description, linked issues (if any), before/after screenshots or GIFs for UI changes, and test notes (tickers tried, pages visited).
- Keep permissions minimal; call out any manifest changes explicitly.

## Security & Configuration Tips
- Limit host permissions to Finviz and TradingView; avoid wildcards you don’t need.
- Do not persist user data beyond local UI preferences; never send PII.
- Handle network failures gracefully; avoid tight polling or aggressive retries.
