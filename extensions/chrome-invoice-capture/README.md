# Vestiarion Invoice Capture (Chrome)

A Manifest V3 extension that captures an invoice a person selects or chooses, lets them check its fields, and sends it
as a draft to their Vestiarion workspace. The design is
`docs/superpowers/specs/2026-10-15-invoice-capture-design.md`; the user guide is
`content/docs/guides/invoice-capture.mdx`.

```text
extension/            the package Chrome loads, exactly as it ships: no build step
  manifest.json       activeTab, scripting, storage, identity, contextMenus; https://www.vestiarion.xyz/* only
  background.js       the context menu item, and Connect's sign-in window
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

The extension talks to `https://www.vestiarion.xyz` (`extension/lib/config.js`). To try it against a local server,
change `API_BASE` there in your own copy; the server answers CORS only for the ids in its own `CHROME_EXTENSION_IDS`.

## Pack it for the Chrome Web Store

Bump `version` in `extension/manifest.json`, then zip the folder's contents, with `manifest.json` at the root of the
zip. From the repository's root in PowerShell:

```powershell
Compress-Archive -Path extensions/chrome-invoice-capture/extension/* -DestinationPath vestiarion-invoice-capture.zip -Force
```

Upload the zip in the developer dashboard and fill in the listing from `STORE_LISTING.md`. Once the store gives the
item its ID, add that ID to `CHROME_EXTENSION_IDS` beside the unpacked one.

## Change the icons

`node scripts/extension-icons.mjs` renders `src/app/icon.svg` into `extension/icons/`. Commit the PNGs.

## Tests

`tests/chrome-extension-manifest.test.ts` holds the manifest to its exact permissions and host, and the code to having
no remote code, no `eval`, no analytics and no markup written from captured text. `tests/invoice-capture-flow.test.ts`
runs the server's side of every call the extension makes.
