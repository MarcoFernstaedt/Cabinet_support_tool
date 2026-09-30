# Web Console local interaction preview

Run `npm ci`, `npm test`, then `npm start` in `src/CabinetPlatform.Web`. Open `http://127.0.0.1:4173` on the same machine. The server binds only to loopback. This preview is not added to the solution, published, or exposed through the Cabinet Server.

The first web surface is a cabinet-scoped Event Viewer. It supports event selection, detail inspection, local filter/search, copyable collected message, keyboard row navigation, narrow layouts and a clear empty state. Its four records are fictional and intentionally labelled synthetic. The interface reuses the Console's navy, cyan and status palette. The runtime `createEventInspector(document, events)` accepts collected records from a future authenticated server adapter; it does not fetch data, save tokens or call the existing password login. The sample records belong only to this local preview.

This is **not** a working support login or a connected web Console. MFA, staff identity mapping, server-side authorization and audit, secure browser session, authenticated data adapter, CSRF/revocation tests, security review and real Windows/browser accessibility acceptance are required before a deployed web UI. Do not expose this preview on a network or treat its records as cabinet evidence. The existing WPF Console remains the operational UI.
