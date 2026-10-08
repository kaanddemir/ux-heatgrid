# UX HeatGrid 2.0

UX HeatGrid is a local-first Chrome side-panel extension for inspecting page structure and recording your own interaction session on the active tab.

## Product structure

- **Overview** — current page identity and compact Predict/Record summaries.
- **Predict** — a deterministic, heuristic assessment of which interactive controls are structurally more prominent on the current page. Results are relative bands, not probabilities or observed user behavior.
- **Record** — a local visualization of the clicks, activations, pointer presence, hover, focus, exposure and scrolling captured during your own recording session.

## Privacy and data handling

HeatGrid performs analysis locally and has no analytics, advertising, tracking SDKs or application network service. It does not read form values or key values.

While a recording crosses a full-page navigation, finalized page segments are temporarily stored in `chrome.storage.session` so the service worker can resume the session. Temporary recording data is removed when the recording is collected or cleared, when its tab closes, or when the browser session ends. Prediction and completed-report state otherwise lives in the tab's injected runtime.

See [PRIVACY_POLICY.md](PRIVACY_POLICY.md) for the complete disclosure.

## Permissions

- `activeTab` — grants temporary access to the tab after the user clicks HeatGrid.
- `scripting` — injects the V2 runtime on demand into the active tab.
- `sidePanel` — opens the Overview · Predict · Record inspector.
- `storage` — uses session-only extension storage for lifecycle recovery and multi-page recording continuity.

HeatGrid requests no host permissions and cannot run on restricted Chrome pages or pages for which Chrome has not granted access.

## Development

Requirements: Node.js 18 or newer and Chrome 116 or newer.

```sh
npm install
npm run check
```

`npm run check` runs the TypeScript check, unit suite and production build. The production extension is written to `dist/`.

For watch mode:

```sh
npm run dev
```

## Manual installation

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Choose **Load unpacked**.
5. Select the generated `dist/` directory, not the repository root.

The V1 popup implementation was removed in 2.0.0; it remains available in git history.

## Architecture

```text
src/
├── background/       # MV3 service worker and session-continuity store
├── content/          # analyzer, prediction, recorder and page overlays
├── shared/           # protocol and lifecycle models
├── ui/sidepanel/     # Overview · Predict · Record inspector
└── manifest.json     # production manifest source
scripts/build.mjs      # src/ → dist/
tests/                 # unit and real-Chrome regression checks
```

The extension uses local DOM APIs, Canvas, closed Shadow DOM overlays and typed Chrome messaging. User-facing strings are created with `textContent`; production code does not inject remote scripts or HTML strings.

## License

Distributed under the MIT License. See [LICENSE](LICENSE).
