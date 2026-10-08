# Chrome Web Store listing — HeatGrid 2.0.0

## Name
UX HeatGrid  (manifest name; the UI and docs use "HeatGrid" — rename both together if desired)

## Summary (≤132 characters)
Predict which controls stand out on a page and record your own session as an on-page interaction map. Local and private.

## Category
Developer Tools

## Description
HeatGrid is a side-panel inspector for designers and developers. It shows which controls on a page stand out structurally, records how you yourself move through the page, and draws both directly on the page.

PREDICT
• Ranks the page's buttons, links and controls into High, Medium and Low structural prominence
• Explains each result: size, position, visual style, contrast and competing controls nearby
• Shows the bands on the page with an on-page legend and filter
• Needs no recording data. Predict is a structural heuristic; it does not forecast real clicks or attention.

RECORD
• Records your own session: clicks, pointer presence, hover, focus, time in view and scroll depth
• Lists the elements you interacted with, and the ones that were in view but never used
• Draws a heatmap, click markers and scroll depth on the page, each with its own toggle
• Continues across same-site page navigations as one session
• A recording describes one session in your browser, not the behaviour of a site's visitors.

PRIVATE BY DESIGN
• Runs only on a tab after you click the HeatGrid icon
• No servers, analytics or tracking; no network requests
• Never reads form values or the keys you press
• Temporary data is cleared when you stop, clear or close the tab

## Single purpose
Inspect the current web page: estimate the structural prominence of its controls and visualise the user's own recorded interaction with it.

## Permission justifications
- activeTab: access the current tab only after the user clicks the toolbar icon, to analyse and record that page.
- scripting: inject the HeatGrid runtime into the active tab on demand.
- sidePanel: display the HeatGrid inspector.
- storage: session-only storage that keeps an in-progress recording across page navigations; cleared when the tab closes.
- Remote code: none.

## Data usage disclosures
Collected by the developer: none. Data is processed locally and never transmitted.
(Website content and user activity are processed on-device only to provide the feature.)

## Privacy policy URL
https://github.com/kaanddemir/ux-heatgrid/blob/main/PRIVACY_POLICY.md

## Images
- Screenshots (1280×800): regenerate with capture.mjs + compose.mjs (output: final/)
- Store icon (128×128): ../../icons/icon128.png
- Small promo tile (440×280): not yet produced — required by the store.
