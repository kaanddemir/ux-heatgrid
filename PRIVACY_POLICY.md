# Privacy Policy

Last updated: October 8, 2026

## UX HeatGrid Chrome Extension

UX HeatGrid is a local-first page inspection tool. It analyzes the active page and, only when you explicitly start recording, captures your interaction with that page to create a local interaction map.

## Data collected and processed

HeatGrid does not send personal data, browsing activity or page data to the developer or to any external service. It has no analytics, advertising, telemetry or tracking SDK.

To provide its features, the extension processes the following information locally in your browser:

- Page structure, computed layout and styling needed for prediction.
- Short accessible-name-like labels for page regions and controls.
- During an explicit recording: pointer positions, clicks, keyboard/assistive control activations, hover duration, focus events, visibility/exposure timing and scroll depth.
- Page origin/path and a bounded page title for multi-page recording continuity. Query strings and URL fragments are not retained in recording results.

HeatGrid does **not** read or store form values, password values, textarea contents, selected values, clipboard data, cookies, authentication data or the actual keys you press.

## Local storage and retention

Processing occurs on-device.

- Prediction data and completed recording results are held by the injected runtime in the inspected tab.
- During a recording that crosses full-page navigation, finalized page segments are temporarily kept in `chrome.storage.session`. This allows the Manifest V3 service worker to resume the same recording after navigation or worker suspension.
- Temporary session data is removed when the recording is stopped and collected, explicitly cleared, replaced by a new recording, or when the tab closes. `chrome.storage.session` is also cleared when the browser session ends.

HeatGrid does not use synchronized or permanent extension storage for recorded activity.

## Network communication and sharing

HeatGrid makes no application network requests and does not transmit processed data to the developer, analytics providers, advertisers or other third parties. Chrome may separately handle installation, updates and Chrome Web Store services under Google's policies.

We do not sell or share user data.

HeatGrid's use of information received through Chrome APIs adheres to the Chrome Web Store User Data Policy, including its Limited Use requirements. Data is used only to provide the user-facing page inspection and recording features described above; it is not used for advertising, credit decisions or unrelated purposes, and the developer does not receive or read it.

## Permissions

| Permission | Purpose |
| --- | --- |
| `activeTab` | Temporarily access the current tab after the user invokes HeatGrid. |
| `scripting` | Inject the HeatGrid runtime on demand. |
| `sidePanel` | Display the Overview · Predict · Record inspector. |
| `storage` | Use session-only storage for lifecycle recovery and multi-page recording continuity. |

HeatGrid requests no broad host permissions and does not automatically inject into every visited page.

## User control

Prediction and recording start only from explicit HeatGrid actions. You can stop or clear a recording from the side panel. Closing the inspected tab removes its temporary lifecycle and recording storage.

## Security

HeatGrid uses local extension code only. Page overlays are isolated in closed Shadow DOM roots, page-facing overlay nodes are pointer-transparent except for their own controls, and user-facing labels are inserted as text rather than executable HTML.

## Changes and contact

Material changes to this policy will be reflected by updating the date above. Questions can be submitted through the project's GitHub issue tracker.
