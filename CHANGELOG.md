# Changelog

## 2.0.0 — 2026-10

A complete rebuild of HeatGrid as a side-panel inspector.

### New
- **Side panel** with three views: Overview · Predict · Record. The toolbar icon opens it directly.
- **Predict** — ranks a page's interactive controls into High, Medium and Low structural prominence, with per-element reasons, confidence, filters and an on-page overlay. Detects when the page has changed.
- **Record** — records your own session (clicks, pointer presence, hover, focus, time in view, scroll depth) and shows a report with Interacted Elements, controls left untouched, and an on-page heatmap, click markers and scroll depth.
- Multi-page recordings across same-site navigations.
- New icon and visual identity.

### Changed
- Permissions: `activeTab`, `scripting`, `sidePanel`, `storage` (session only). No host permissions.
- All data stays local; temporary recording data lives only in `chrome.storage.session`.

### Removed
- The 1.x popup and its always-on attention heatmap.

## 1.1.1
- Restricted the extension on Chrome Web Store pages; improved disabled button states.
