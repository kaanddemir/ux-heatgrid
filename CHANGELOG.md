# Changelog

## 2.0.0 — October 2026

UX HeatGrid is now a side-panel inspector for the page you are viewing.

- **Side panel** with three views: Overview, Predict and Record. The toolbar icon opens it directly.
- **Predict** ranks a page's controls into High, Medium and Low structural prominence, with reasons, filters and an on-page overlay.
- Predict explains each result with Positive and Negative factors written from the measured values, and its confidence now reflects how settled the band is rather than how many caveats apply.
- **Record** captures your own session (clicks, hover, focus, time in view and scroll depth) and shows it as an on-page heatmap with click markers.
- Recordings continue across same-site navigations.
- All data stays in your browser. Recordings are temporary and cleared when the tab or browser closes.
- New side panel design and icon.
- The 1.x popup and its always-on attention heatmap have been removed.
- Requires Chrome 116 or newer. Adds the `sidePanel` and `storage` permissions; still no host permissions.

## 1.1.1

- Restricted the extension on Chrome Web Store pages; improved disabled button states.
