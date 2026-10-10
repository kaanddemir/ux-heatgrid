# Browser checks

Real-Chrome checks for the built extension (`dist/`). They are **not** part of `npm test` and
need two things that are not project dependencies:

- `PLAYWRIGHT_DIR` — a directory containing the `playwright` package (e.g. an npx cache)
- `CHROME_PATH` — Chrome for Testing / Chromium (branded Chrome ignores `--load-extension`)

```sh
export PLAYWRIGHT_DIR=… CHROME_PATH=…
npm run test:browser                  # product-check.mjs (builds dist/ first)
SHOT_DIR=/tmp/hg npm run test:browser # screenshots go to SHOT_DIR (default /tmp)
```

| Command | Runs | Network |
| --- | --- | --- |
| `npm run test:browser` | `product-check.mjs` | no |
| `npm run test:browser:continuity` | `continuity-check.mjs` | no |
| `npm run test:browser:validate` | `validate.mjs` (append `-- <section>` for one section) | no |
| `npm run test:release` | `npm run check`, then the three checks above | no |
| `npm run test:sites` | `real-sites.mjs` | yes |
| `npm run test:sites:recorded` | `recorded-real.mjs` | yes |

| Script | Role |
| --- | --- |
| `product-check.mjs` | **Primary release regression.** Toolbar icon → side panel (Overview · Predict · Record) → Predict → Record (survives tab switches) → navigate → Stop → Record tab layers / pages → no-Coach check → Clear → repeat; side-panel reopen, back/forward, tab-close cleanup; 320/360/400/480/560 px, light/dark screenshots. |
| `continuity-check.mjs` | One recording across full navigations and a reload (segments, listeners, cleanup). |
| `validate.mjs` | Analyzer in a real browser (discovery, geometry, contrast, shadow DOM, frames, privacy, read-only) + lifecycle (reinjection, navigation) + Predict stability (`predict`: determinism, scroll/resize, explanation facts, stage timing). Run one section with `node tests/browser/validate.mjs <section>`. |
| `recorded-real.mjs` | Recorded sanity on a real page (needs network for the page load): overhead, counts, scroll depth, Stop time, Clear. |
| `real-sites.mjs` | Real-site calibration sweep (needs network): band distribution, regions, timings. `SITES=url1,url2` to override. |

`harness.mjs` holds the shared launcher; `fixtures/` is served over `http://127.0.0.1`.

Not automated: extension reload (`chrome.runtime.reload()` tears down the service worker the
harness drives Chrome through) — check it manually after reloading the unpacked extension.
