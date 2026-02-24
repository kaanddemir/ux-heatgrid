# UX HeatGrid

<p align="center">
  <img src="icons/icon128.png" alt="UX HeatGrid Logo" width="128" height="128">
</p>

<p align="center">
  <strong>Grid-based UX heatmap analyzer for measuring attention, content density, and layout structure in real time.</strong>
</p>

## Overview
**UX HeatGrid** is a privacy-first Chrome extension that redefines how designers, developers, and UX researchers evaluate page quality. Traditional heatmap tools are limited to click tracking — UX HeatGrid goes further with its **proprietary attention-tracking algorithm** that fuses **element-level dwell time**, **scroll velocity analysis**, and **DOM-based layout metrics** into a single, real-time attention map. This custom-built scoring engine is not based on any existing library or framework — it is an original system designed and calibrated specifically for UX HeatGrid.

The extension automatically detects whether a page uses a light or dark theme and adapts its heatmap rendering accordingly — using `multiply` blend mode on light backgrounds and additive overlays on dark ones. A **draggable, always-on-top pinned panel** lets you monitor your UX Score, content density, readability, white space, and complexity without switching tabs or opening DevTools.

Every metric is computed locally, in real time, with zero external requests. UX HeatGrid gives you an objective, data-driven snapshot of any page's design quality — directly inside the browser.

## Features
*   **Dual-Source Heatmap Engine:** Combines two independent heat layers — element dwell scores (cumulative attention per DOM node) and mouse proximity heat (150px radius with quadratic falloff) — into a unified 15×15px grid visualization updated every 500ms.
*   **Adaptive Theme Detection:** Automatically identifies light and dark page backgrounds by sampling `<body>`, `<html>`, and `<main>` elements, then switches between `multiply` and additive blend modes for optimal heatmap visibility.
*   **Pinned Floating Panel:** A draggable, always-on-top panel that displays live UX Score, readability, complexity, white space, and density metrics with color-coded grade indicators — no popup required.
*   **Proprietary UX Scoring System:** A custom-built 0–100 composite score built from 4 weighted categories (Content Density, White Space, Complexity, Readability) — an original scoring formula designed exclusively for UX HeatGrid, calibrated with tolerance-tuned ideal ranges so well-designed pages can realistically score 70+.
*   **WCAG-Aware Readability Analysis:** Measures average font size, line-height ratio, characters per line, and foreground/background contrast ratio against WCAG 2.1 guidelines.
*   **Pause & Resume with Score Caching:** Pausing the tracker preserves your current UX evaluation. The score only recomputes when the DOM structure or viewport changes — not on every analytics tick.
*   **Dynamic Layout Tracking:** Uses `MutationObserver` to detect DOM changes and automatically re-analyzes elements, ensuring accurate results on SPAs and dynamically loaded content.
*   **High-Performance Rendering:** 60fps canvas overlays powered by `Float32Array` spatial grids, `requestAnimationFrame`, and efficient spatial indexing.
*   **Visual Grade System:** Five-tier color-coded labels — Excellent (85+), Good (70+), Average (55+), Dense (40+), Fatiguing (<40) — for instant, at-a-glance design quality assessment.

## How It Works

### Heatmap Engine

The heatmap updates every **500ms** using a 15×15px grid overlay. Two independent heat sources feed into the visualization:

#### 1. Element Dwell Score
Every visible text/interactive element accumulates a dwell score based on attention signals:

| Signal | Effect |
|--------|--------|
| **Mouse hover** | Element heats up 2× faster when cursor is directly over it |
| **Passive viewing** | Visible elements slowly accumulate heat (×0.3 base rate) |
| **Scroll speed** | Fast scrolling reduces heat gain by up to 90% |
| **Element priority** | Higher-priority elements heat up faster |

Element priority weights:

| Priority | Elements |
|:--------:|----------|
| 2.0× | Buttons |
| 1.8× | Links |
| 1.4× | H1 headings |
| 1.0× | Paragraphs |
| 0.4× | Spans |

Dwell scores max out at **5.0** and do not decay — they represent cumulative attention.

#### 2. Mouse Heat
The cursor position generates a **150px radius** heat zone:
- Strongest at center, fades with distance (quadratic falloff)
- Clicks add a **+2.5 instant boost**
- Mouse heat **decays over time** (×0.96 per frame), unlike dwell scores

#### Color Scale
Grid cell scores are mapped to colors:

| Score | Color | Meaning |
|:-----:|:-----:|---------|
| 0.0 | Transparent | No attention |
| 0.2 | 🔵 Blue | Low interest / scanning |
| 0.5 | 🟡 Yellow | Moderate focus |
| 1.0 | 🔴 Red | High attention / reading |

## UX Score Algorithm

The UX Score is a **proprietary evaluation system** designed exclusively for UX HeatGrid. It measures **page design quality** on a 0–100 scale by analyzing the live DOM structure — not user behavior. Unlike generic auditing tools, this custom-built algorithm combines content density, spacing, complexity, and readability into a single, opinionated score built from **4 categories**, each worth **25 points**.

### Content Density (25 pts)
Measures how much of the page is covered by content. Child elements inside other elements are de-duplicated to prevent double-counting.

| Sub-metric | Weight | What it measures |
|------------|:------:|------------------|
| **Overall Density** | 40% | Total element area ÷ page area. Ideal: 10–55% |
| **Above-the-fold** | 35% | First viewport density. Ideal: 10–60% |
| **Consistency** | 25% | Variance across screen-sized slices. Low variance = good |

### White Space (25 pts)
Measures the real pixel gaps between consecutive block elements (P, H1–H6, LI, etc.), sorted by position.

- **0px** average gap → 0%
- **48px+** average gap → 100%
- Ideal range: 25–85%

### Complexity (25 pts)
Counts the average number of tracked elements per viewport height.

- `totalElements ÷ (pageHeight ÷ viewportHeight)`
- Ideal range: 5–25 elements per screen

### Readability (25 pts)
Composite of 4 sub-scores, each measured via `getComputedStyle`:

| Sub-metric | Ideal | Score mapping |
|------------|-------|---------------|
| **Font Size** | 16px+ | 8px = 0, 16px = 100 |
| **Line Height** | 1.2–2.0× font size | 1.0 = 0, 1.2–2.0 = 100 |
| **Line Length** | 35–90 chars/line | <15 or >140 = 0 |
| **Contrast** | WCAG 4.5:1+ | 7:1+ = 100, <4.5:1 = low |

### Scoring
Each category uses a `rangeScore()` function that gives full points when the value is in the ideal range and decreases proportionally as it moves toward the worst-case boundary.

| Score | Label |
|:-----:|-------|
| 85+ | Excellent |
| 70+ | Good |
| 55+ | Average |
| 40+ | Dense |
| <40 | Fatiguing |

## Use Cases
*   **UX Researchers & CRO Specialists:** Pinpoint whether high-value CTAs and value propositions are receiving sustained attention or getting buried beneath dense content. Use the pinned panel to compare UX Scores across landing page variants without leaving the tab.
*   **Content Strategists:** Audit long-form articles and editorial pages to identify exactly where reader attention drops off — the heatmap reveals which sections are being read, which are skimmed, and where white space or heading structure needs adjustment.
*   **Frontend Developers:** Validate spacing, density, and readability standards during the design-to-code handoff. The real-time UX Score acts as a live lint check for visual quality — flag issues before they reach code review.
*   **Accessibility Auditors:** Evaluate contrast ratios (WCAG 2.1), heading hierarchy, font sizing, and line-height compliance in a single pass. The readability sub-score highlights pages that may cause visual fatigue.
*   **Product Managers:** Get an objective, quantified "design health check" on any live page in seconds — no analytics setup, no third-party scripts, no waiting for user data to accumulate.
*   **Design System Teams:** Benchmark component pages and pattern libraries against consistent UX Score thresholds to enforce design quality standards across a product.

## Privacy
UX HeatGrid is a strictly **local-first, zero-telemetry** application. Your data never leaves your machine — period.

*   **100% Client-Side Processing:** All heatmap generation, attention tracking, DOM analysis, and UX scoring run entirely within your browser's JavaScript sandbox. There is no server component.
*   **Zero Data Collection:** No browsing history, page content, personal identifiers, cookies, or metadata are ever captured, stored, or transmitted.
*   **No Network Requests:** The extension makes absolutely zero outbound HTTP requests — no analytics endpoints, no CDN calls, no update pings. You can verify this in DevTools → Network.
*   **Minimal Permissions:** Only requires `activeTab` (to inject the content script on the current page) and `scripting` (to programmatically execute the tracking engine). No background service worker, no persistent storage, no cross-origin access.

See our [Privacy Policy](PRIVACY_POLICY.md) for the full policy.

## Tech Stack
*   **Core:** Vanilla JavaScript (ES6+), CSS3 with Custom Properties, HTML5
*   **Architecture:** Chrome Extension Manifest V3 — popup + on-demand content script injection via `chrome.scripting.executeScript`
*   **Heatmap Engine:** Dual-layer grid system (15×15px cells) combining element dwell scores and mouse proximity heat with spatial indexing via row-based `Map` lookup
*   **Rendering:** HTML5 Canvas API at native grid resolution, upscaled via CSS, driven by `requestAnimationFrame` at 60fps
*   **Spatial Processing:** `Float32Array`-backed grid for memory-efficient per-cell heat computation
*   **Theme Pipeline:** Multi-element background color sampling → luminance calculation → automatic blend mode selection (`multiply` for light, additive for dark)
*   **Scoring Engine:** 4-category `rangeScore()` system with tolerance-tuned ideal bands, `MutationObserver`-driven dirty flagging, and result caching for pause/resume stability
*   **Communication:** Bidirectional `chrome.runtime.sendMessage` / `onMessage` bridge for real-time popup ↔ content script synchronization

## Installation

### From Chrome Web Store
[Available on the Chrome Web Store](https://chromewebstore.google.com/detail/ux-heatgrid/apdgicimbpoimklcanijmfbpfkekiajn)

### Manual Installation (Developer Mode)
1.  **Clone** this repository.
2.  Open Chrome and go to `chrome://extensions/`.
3.  Enable **Developer mode** in the top right.
4.  Click **Load unpacked**.
5.  Select the directory where you cloned this repository.

## Project Structure
```text
UXHeatGrid/
├── icons/             # Extension application icons
├── content.js         # Core tracking and heatmap engine
├── content.css        # Content script styles
├── popup.html         # Popup UI Layout
├── popup.js           # Popup Logic
├── popup.css          # Popup Styles
├── manifest.json      # Extension configuration (Manifest V3)
└── README.md          # Documentation
```

## License
Distributed under the MIT License. See `LICENSE` for more information.

---
Built by **heykaan.dev**
