# Coach engine — inactive

Coach was removed from the HeatGrid V2 product, which ships two capabilities only:
**Predict** and **Record** (side panel: Overview · Predict · Record).

The engine is kept here, unchanged, so it can be revisited later. It is **not reachable from any
production entry point** (`content/index.ts`, `background/sw.ts`, `ui/sidepanel/panel.ts`), so
esbuild leaves it out of `dist/` entirely: no Coach code, listeners, caches or messages ship.

## What is preserved

| File | Role |
| --- | --- |
| `evidence.ts` | Extracts structure / prediction / recorded evidence from engine results |
| `rules.ts` | Insight rules over that evidence |
| `strategies.ts` | Suggestion phrasing per rule |
| `composer.ts` | Deterministic sentence composition (stable hash, word limits) |
| `confidence.ts` | Confidence + caveats |
| `rank.ts` | Dedupe and ranking (per-category and total caps) |
| `engine.ts` | `runCoach()` — the pure pipeline |
| `controller.ts` | `CoachController` cache + `toCoachView()` (the old protocol view) |
| `lint.ts` | Banned-language lint for every composed string |
| `copy.ts` | Former side-panel Coach copy (category / caveat / evidence labels) |
| `pageCoverage.ts` | Analysis coverage notes (the former Coach "Limitations" section) |
| `types.ts` | Engine types |

Thresholds live alongside the rules and confidence code. All of it is covered by
`tests/unit/coach.test.ts` (rules, evidence requirements, composition, ranking, multi-page).

## What was removed

- Side-panel Coach tab, Overview Coach card, previews, filters, finding rows/details, empty states.
- Protocol messages `GET_COACH`, `RUN_COACH`, `FOCUS_COACH_SUBJECT`, `GET_PAGE_COVERAGE`
  (now rejected as unknown request types).
- `CoachController` wiring and diagnostics in `tabRuntime.ts`.
- The on-page Coach subject highlight (`overlay/coach.ts`, `heatgrid-coach` host) and Coach CSS tokens.

## Re-enabling later

1. Construct `CoachController` in `tabRuntime.ts` with `{ analyzer, prediction, recorded }` and
   re-add request handlers (only explicit requests should run it — never on Predict/Record completion).
2. Re-add the message types + payload validation in `shared/protocol.ts`.
3. Build a side-panel view on `CoachView` using `copy.ts`; add an on-page highlight if needed
   (register its host tag with the analyzer / stale-watcher / recorder ignore lists).
