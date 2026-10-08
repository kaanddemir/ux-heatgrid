# HeatGrid Privacy Policy

Last updated: October 8, 2026 · Applies to HeatGrid 2.0.0

HeatGrid is a Chrome extension that inspects the page you are viewing. It analyses page structure (**Predict**) and, only when you start it, records your own interaction with the page (**Record**). All processing happens locally in your browser.

## Summary

- HeatGrid makes no network requests. It has no servers, analytics, advertising, telemetry or tracking code.
- Nothing HeatGrid processes is sent to the developer or to any third party.
- HeatGrid runs only on a tab after you click its toolbar icon, and only Predict or Record when you start them.
- Form values, passwords, typed text and the keys you press are never read.
- Recorded data is temporary and is removed when you clear it, start a new recording, close the tab or end the browser session.

## What HeatGrid processes

**Page information (Predict and Record).** When you start Predict or Record, HeatGrid reads the page's structure in your browser: interactive controls, their size, position, computed style and colour contrast, and nearby headings and landmarks. To name controls it uses accessible labels — `aria-label`, `title`, `alt`, `placeholder` and visible text of the control itself. It never reads the content of form fields.

**Interaction data (Record only).** While a recording is running, HeatGrid captures your:

- pointer positions (sampled) and the control under the pointer
- clicks, and activations of controls by keyboard or assistive technology (it registers *that* a control was activated, not which key was pressed)
- hover and focus on controls
- how long controls were visible in the viewport, and scroll depth

**Page identity (Record only).** For each recorded page it keeps the page's origin and path and a title shortened to 80 characters. Query strings and URL fragments are not kept.

**Side panel.** The side panel shows the current tab's title and domain, which Chrome provides after you click the toolbar icon.

## Where data is kept and for how long

| Data | Where | Removed when |
| --- | --- | --- |
| Prediction results | Memory of the page's HeatGrid runtime | You reset it, the page is reloaded or navigated away, or the tab closes |
| Completed recording report | Memory of the page's HeatGrid runtime | You clear it, start a new recording, navigate away, or the tab closes |
| Recording segments during multi-page sessions | `chrome.storage.session` | The recording is stopped (collected into the report), cleared or replaced, or the tab closes |
| Small per-tab status record (session state and totals, no page content) | `chrome.storage.session` | The tab closes |

`chrome.storage.session` is held in memory by Chrome and is cleared when the browser session ends. HeatGrid does not use `storage.local`, `storage.sync`, cookies or any persistent storage, and recordings are never saved between browser sessions.

## Sharing

HeatGrid does not transmit, sell or share any data. The developer never receives it. Chrome itself may handle installation and updates under Google's policies.

HeatGrid's use of information received through Chrome APIs adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements. Data is used only to provide the page-inspection and recording features described here.

## Permissions

| Permission | Purpose |
| --- | --- |
| `activeTab` | Temporary access to the current tab after you click the HeatGrid toolbar icon. |
| `scripting` | Inject the HeatGrid runtime into that tab on demand. |
| `sidePanel` | Display the Overview · Predict · Record side panel. |
| `storage` | Session-only storage used to continue a recording across page navigations. |

HeatGrid requests no host permissions and is not injected into pages automatically.

## Your control

- Predict and Record start only when you choose **Start**.
- Stop a recording at any time; **Clear recording** and **Reset prediction** remove results immediately.
- Closing the tab removes all of HeatGrid's data for that tab.
- Uninstalling HeatGrid removes the extension and its storage.

## Changes and contact

Changes to this policy will be published in this file with an updated date. Questions can be raised on the project's GitHub issue tracker: <https://github.com/kaanddemir/ux-heatgrid/issues>.
