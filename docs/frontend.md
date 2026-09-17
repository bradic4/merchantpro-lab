# Frontend

The commercial login, client dashboard and admin pages share `src/ui/application.js` and `src/ui/theme.css`. Run `npm run build:ui` to generate the self-contained HTML pages in `ui/`, `src/ui/` and `dist/ui/`. Keep the generated tracked pages in the same change as their sources: the existing production handler serves HTML directly, without a new static-asset route. `npm test` and `npm run build` regenerate these pages. The existing local audit console (`index.html`) is unchanged.

The presentation layer provides common headers, navigation, status indicators, definition lists, panels, tables, filters, chart, configuration form and empty/error states. Browser tests use local fixtures; they do not submit telemetry or configuration to a deployed store. Set `CHROME_PATH` if Chrome/Edge is not in a standard location. The browser test skips when no supported browser is installed.

## Evidence boundaries

- Controlled-test values come from the existing API fields, never hardcoded page values. They remain separate from production `longTaskBlockingMs`. The current API values are store configuration constants without a test ID/date; add provenance before treating them as a reproducible benchmark history.
- Production history summarizes only the returned recent records (maximum 50), explicitly labels its sample size and selected period, and does not claim to cover every record. It uses only explicit mode for Control/Optimized grouping. Missing modes remain unclassified. p75 requires at least 20 valid observations; this is a display threshold, not a statistical-significance claim. Accessible tabular summaries accompany the chart.
- Tracking health concerns script loading only. All observed states for a vendor must explicitly be `loaded` in the available sample within 24 hours to show `Ispravno`. `failed` is an error; `loading`/`deferred` receive a review warning; idle/missing/stale records are unavailable. This does not prove event delivery. General `errorsCount` is not repurposed as a tracking-error count.
- Country is never used to infer a person, customer, bot or Meta crawler. Only the explicit search-engine cohort is classified when a classification field is absent. Geographic and classification subtotals are labeled as overlapping.
- Counts retain the requested session labels with a visible explanation that the API counts telemetry records, not proven unique human sessions. The backend currently creates a new record per telemetry submission and defaults missing blocking/error counters to zero; the frontend cannot recover the original missingness.
- The API's synthetic `lastCheckTime` fallback is ignored. Last observation is derived only from returned timestamped records. Admin list rows use the existing detail endpoints for their observed health and last data.
- `Ispravno` is a conservative presentation rule, not a server-side SLA. Freshness is fixed at 24 hours and disclosed in the UI. No automatic polling is claimed; refresh is explicit.

## Fields needed from the backend

1. Stable session ID and deduplicated period totals; preserve missing versus zero measurements.
2. Explicit actual mode, runtime version and visitor classification on each observation; do not infer actual optimization from cohort/rollout.
3. Full-period time buckets with sample counts, median and p75 by control/optimized mode, consistent eligibility rules, and completeness indicators (or pagination for raw history).
4. Per-vendor check timestamp, tracking-specific error counts and delivery validation, plus documented freshness expectations.
5. Controlled-test ID, date, protocol/profile, sample count and provenance for configured lab results.
6. Business impact populations, orders, revenue/currency, attribution window, conversion rates, revenue per session, sample sizes, observed differences and eligibility/uncertainty rules. `src/ui/contracts.ts` defines future presentation types; current UI deliberately renders the unavailable state.
7. Last observation/runtime and vendor summaries in the admin list endpoint to avoid additional detail requests as the store list grows.

## Operational behavior

Authentication, tenant authorization, API routes and request bodies remain unchanged. Normal configuration uses the existing rollout/killSwitch/vendor payload. Emergency confirmation sends only `{ killSwitch: true }`, preserving saved rollout and vendor values and excluding unsaved form edits. Success means the API accepted the save; the UI makes no claim about propagation to running sessions or edge nodes. No backend/runtime or deployment changes are part of this refactor.
