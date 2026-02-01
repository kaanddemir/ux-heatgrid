# UX HeatGrid

<p align="center">
  <img src="icons/icon128.png" alt="UX HeatGrid Logo" width="128" height="128">
</p>

<p align="center">
  <strong>Grid-based UX heatmap analyzer for measuring attention, content density, and layout structure in real time.</strong>
</p>

## Overview
**UX HeatGrid** is a privacy-first Chrome extension designed to help UX researchers, designers, and developers understand how users interact with web content. Unlike generic heatmap tools that only track clicks, UX HeatGrid uses a **smart, text-focused algorithm** to measure meaningful engagement in real-time.

Whether you are optimizing a landing page for readability, testing a new UI layout, or analyzing content density, UX HeatGrid provides instant, actionable feedback through high-performance visual overlays.

## Features
*   **Intelligent Heatmap Engine:** Hybrid tracking that combines mouse movement, scroll velocity, and element-level dwell time.
*   **Real-Time UX Analytics:** Get immediate scores on content density, white space ratios, and elements-per-screen.
*   **Automated UX Insights:**
    *   **Content:** Identifies dense text areas and readability issues.
    *   **Layout:** Spotlights insufficient white space or cluttered structures.
    *   **Structure:** Evaluates the hierarchy of headings and interactive elements.
*   **Privacy-First Architecture:** All tracking and analysis happen locally in your browser. No data ever leaves your device.
*   **High-Performance Rendering:** Smooth 60fps canvas overlays using spatial indexing and `requestAnimationFrame`.
*   **Visual Legend:** Color-coded insights (Excellent to Fatiguing) for quick UX evaluation.

## How It Works
1.  **Extraction:** When tracking starts, UX HeatGrid intelligently scans the DOM to identify key text blocks (H1-H6, P) and interactive elements (Buttons, Links), assigning each a priority weight.
2.  **Behavioral Analysis:** The extension monitors active dwell time, mouse proximity, and scroll signals to calculate a precise "Attention Score" for every element.
3.  **Visualization:** Data is mapped onto a dynamic grid. Warm colors (Red/Orange) indicate high focus and reading behavior, while cool colors (Blue) show scanning and secondary interest.

## Use Cases
*   **UX Researchers:** Validate if users are actually seeing the Call-to-Action (CTA) or key value propositions.
*   **Content Strategists:** Verify if long-form content is being read or just scrolled through.
*   **Web Developers:** Test layout accessibility and visual hierarchy during development.
*   **Designers:** Optimize white space and element distribution based on real interaction data.

## Privacy
UX HeatGrid is built with a **Privacy-First** philosophy:
*   **No Remote Processing:** All text and behavioral analysis is performed locally in your browser.
*   **No Tracking:** We do not collect browsing history, personal data, or usage metrics.
*   **No External Requests:** The extension never communicates with external servers.

See our [Privacy Policy](PRIVACY_POLICY.md) for more details.

## Tech Stack
*   **Core:** HTML5, CSS3, Modern JavaScript (ES6+)
*   **Architecture:** Chrome Extension Manifest V3
*   **Rendering:** High-performance HTML5 Canvas API
*   **Calculations:** Float32Array for efficient spatial grid processing

## Installation

### From Chrome Web Store
*(Coming Soon)*

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
