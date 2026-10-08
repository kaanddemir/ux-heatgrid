<p align="center">
  <img src="icons/icon128.png" alt="UX HeatGrid" width="96">
</p>

<h1 align="center">UX HeatGrid</h1>

<p align="center">
  A Chrome extension that shows which controls stand out on a page, records how you use it,<br>
  and draws both right on the page from a side panel.
</p>


## How it works

1. Open any web page and click the **UX HeatGrid** icon in the Chrome toolbar. The side panel opens.
2. Under **Predict**, press **Start** to see which controls stand out in the page's structure.
3. Under **Record**, press **Start**, use the page as usual, then press **Stop** to see your session.
4. Press **Show on page** in either view to draw the results directly on the page.

## Predict


Predict ranks every button, link and control on the page into **High**, **Medium** and **Low** structural prominence. It looks at size, position, visual style, text contrast, nearby competing controls and page context. No recording is needed.

- Results grouped by band, with filters for band and control type
- **Why** reasons, page area and confidence for every element
- **Show on page** outlines the controls by band, with an on-page legend and filter
- Marks results as stale when the page changes, with **Re-run** and **Reset**

Predict is a structural estimate of prominence. It does not forecast real clicks or user attention.

## Record


Record captures your own session on the page and turns it into a report and an on-page map.

- Live duration, clicks and scroll depth while recording
- **Interacted Elements** with clicks, hover, focus and time in view for each control
- **No Interaction** for controls that were in view but never used
- On-page **heatmap**, **click markers** and **scroll depth**, each with its own toggle
- Continues across same-site navigations and reloads as one session

A recording describes your session in your browser, not the behaviour of a site's visitors.

## Inspect


Expand any result to see the evidence behind it: the structural reasons in Predict, or the measured clicks, hover, focus and time in view in Record. The matching element is highlighted on the live page.

## Installation

**From the Chrome Web Store:** search for **UX HeatGrid** and choose **Add to Chrome**.

**From source** (Chrome 116 or newer, Node.js 18 or newer):

```bash
npm install
npm run build
```

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and select the `dist` folder.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Access the current tab, only after you click the toolbar icon |
| `scripting` | Load UX HeatGrid into that tab when you use it |
| `sidePanel` | Show the Overview, Predict and Record panel |
| `storage` | Keep a recording going across page navigations (session only) |

UX HeatGrid requests no host permissions and never runs on a page until you open it there.

## Privacy

UX HeatGrid has no accounts, servers, analytics or tracking, and makes no network requests. Page analysis and recordings stay in your browser and are cleared when you reset them, close the tab or end the browser session. Form values and the keys you type are never read.

Read the full [Privacy Policy](PRIVACY_POLICY.md).

## Good to know

- Works on regular websites. Chrome's own pages and the Chrome Web Store cannot be inspected.
- Content inside cross-origin iframes is not analysed or recorded.
- Results are not saved between browser sessions.

## Development

```bash
npm run dev         # rebuild dist on every change
npm test            # unit tests
npm run check       # typecheck, tests and production build
```

Browser regression checks are described in [tests/browser](tests/browser/README.md). Release notes are in the [Changelog](CHANGELOG.md).

## License

Released under the [MIT License](LICENSE).
