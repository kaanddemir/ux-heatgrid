# HeatGrid

**See how a page is built to be used — and how you actually used it.**

HeatGrid is a Chrome side-panel extension for designers and developers. It estimates which controls on a page stand out structurally, records your own interaction session, and draws both directly on the page. Everything runs locally in your browser.


## Capabilities

| | |
| --- | --- |
| **Overview** | Page title and domain, with compact Predict and Record summaries and one-click Start for each. |
| **Predict** | Ranks the page's interactive controls into **High**, **Medium** and **Low** structural prominence, with the reasons and confidence behind each result. |
| **Record** | Captures your own session — clicks, pointer presence, hover, focus, time in view and scroll depth — and turns it into a report and an on-page map. |

### Predict

Predict analyses the current page's structure: size, position, visual style, contrast, competing controls nearby and page context. It needs no recording data.

- Results grouped by band, filterable by band and control type
- Per-element **Why** reasons, area and confidence
- **Show on page** outlines the controls by band, with an on-page legend and filter
- Marks results as stale when the page changes; re-run or reset at any time

Predict is a deterministic structural heuristic. It describes how prominent a control is in the layout — it does not predict real clicks or user attention.


### Record

Start a recording, use the page as usual, and stop when you are done.

- Duration, clicks, scroll depth and interacted controls
- **Interacted Elements** with clicks, hover, focus and time in view per control
- **No Interaction** — controls that were in view but never used
- On-page **heatmap**, **click markers** and **scroll depth**, each with its own toggle
- Continues across same-site page navigations as one multi-page session

A recording describes one session in one browser — yours — not the behaviour of a site's visitors.


### Inspect

Expand any result to see the evidence behind it, and highlight the element on the page.


## Privacy

HeatGrid has no servers, analytics or tracking, and makes no network requests. Page analysis and recordings stay in your browser; temporary recording data lives only in session storage and is removed when you stop, clear, or close the tab. Form values and typed keys are never read. See [PRIVACY_POLICY.md](PRIVACY_POLICY.md).

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Access the current tab only after you click the HeatGrid toolbar icon. |
| `scripting` | Inject the HeatGrid runtime into that tab on demand. |
| `sidePanel` | Show the Overview · Predict · Record inspector. |
| `storage` | Session-only storage for multi-page recording continuity. |

No host permissions are requested, and HeatGrid never runs on a page you haven't opened it on.

## Supported behaviour and limitations

- Works on regular `http`/`https` pages. Chrome internal pages, the Chrome Web Store and other restricted pages are not supported.
- Same-frame content only; cross-origin iframes are not analysed or recorded.
- A recording continues across navigations within pages Chrome lets HeatGrid access; reaching a page where it cannot run interrupts continuity but keeps earlier data.
- Recordings and predictions are not saved between browser sessions.

## Install

**Chrome Web Store** — install HeatGrid from its store listing.

**From source** (Chrome 116+, Node.js 18+):

```sh
npm install
npm run build
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked** and select the generated `dist/` folder.

## Development

```sh
npm run dev        # watch build into dist/
npm run typecheck  # TypeScript
npm test           # unit tests (Vitest)
npm run check      # typecheck + tests + production build
```

Real-Chrome regression checks live in [tests/browser](tests/browser/README.md).

## Project structure

```text
src/
├── background/     MV3 service worker and recording-continuity store
├── content/        analyzer, prediction, recorder, recorded maps, page overlays
├── shared/         protocol and lifecycle models
├── ui/sidepanel/   Overview · Predict · Record side panel
└── manifest.json
assets/
├── brand/          icon source (SVG) and icon renderer
└── store/          store listing copy and the scripts that capture and compose the screenshots
icons/              extension icons (generated from assets/brand)
scripts/build.mjs   src/ → dist/
tests/              unit and real-Chrome checks
```

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

MIT — see [LICENSE](LICENSE).
