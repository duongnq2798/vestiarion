# Vestiarion Invoice Capture (Chrome)

A Manifest V3 extension that captures an invoice a person selects or chooses, lets them check its fields, and sends it
as a draft to their Vestiarion workspace. The design is
`docs/superpowers/specs/2026-10-15-invoice-capture-design.md`; the user guide is
`content/docs/guides/invoice-capture.mdx`.

```text
extension/            the package Chrome loads, exactly as it ships: no build step
  manifest.json       activeTab, scripting, storage, identity, contextMenus, alarms; no host permission
  background.js       the context menu item, Connect's sign-in window and every token refresh
  popup.html/.css/.js the popup: first run, connect, capture, check, send
  lib/                config (the one server), PKCE, connection, draft calls, the selection, the fields
  icons/              made from the brand mark by scripts/extension-icons.mjs
STORE_LISTING.md      the Chrome Web Store's fields, permission justifications and privacy answers
```

## Load it unpacked

1. In Chrome, open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick the
   `extension` folder.
2. Copy the ID Chrome shows under the extension's name (32 letters, a to p).
3. Add it to `CHROME_EXTENSION_IDS` on the deployment (Vercel: Project, Settings, Environment Variables; several ids are
   separated by commas), then redeploy. An unpacked extension's ID comes from the folder's path, so a copy in another
   folder has another ID.
4. Migration `0121_invoice_capture.sql` must have run on the deployment's database.

The extension asks for no host permission. Its calls go to `https://www.vestiarion.xyz` (`extension/lib/config.js`)
as cross-origin requests, which work because Vestiarion answers CORS for the extension ids in its
`CHROME_EXTENSION_IDS`, and never with cookies: the token is the only credential. `chrome.identity.launchWebAuthFlow`,
and `activeTab` with `scripting` for the selection, need no host permission either. To try it against a local server,
change `API_BASE` in your own copy; that server answers CORS only for the ids in its own `CHROME_EXTENSION_IDS`.

The access token is kept in `chrome.storage.session` (memory only); the refresh token and the workspace's name in
`chrome.storage.local`. The service worker asks Chrome to keep local storage from content scripts
(`setAccessLevel`, `TRUSTED_CONTEXTS`) where the browser supports it for local storage, and goes on without it where it
does not; the extension has no content scripts either way.

## Pack it for the Chrome Web Store

Bump `version` in `extension/manifest.json`, then zip the package's files with `manifest.json` at the root of the zip.
From the repository's root in PowerShell, where `tar.exe` is the one Windows 10 and later ship:

```text
tar.exe -a -c -f vestiarion-invoice-capture.zip -C extensions/chrome-invoice-capture/extension manifest.json background.js popup.html popup.css popup.js lib icons
```

`tar.exe` writes entries with forward slashes, as the Chrome Web Store needs; Windows PowerShell 5.1's
`Compress-Archive` writes backslashes, and its zip does not load. `tests/chrome-extension-manifest.test.ts` holds the
command's list to every file and folder of the package, so a new one cannot be left out.

Upload the zip in the developer dashboard and fill in the listing from `STORE_LISTING.md`. Once the store gives the
item its ID, add that ID to `CHROME_EXTENSION_IDS` beside the unpacked one.

## Change the icons

`node scripts/extension-icons.mjs` renders `src/app/icon.svg` into `extension/icons/`. Commit the PNGs.

## Tests

`tests/chrome-extension-manifest.test.ts` holds the manifest to its exact permissions and no host, and the code to
having no remote code, no `eval`, no cookies sent, no analytics and no markup written from captured text.
`tests/chrome-extension-popup.test.ts` drives the popup and the service worker's refresh in a DOM.
`tests/invoice-capture-flow.test.ts` runs the server's side of every call the extension makes.
