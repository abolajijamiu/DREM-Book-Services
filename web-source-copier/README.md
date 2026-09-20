# Web Source Copier

A Chrome/Edge (Manifest V3) extension that inspects and copies **everything a
website is built from** — HTML, CSS, JavaScript, JSON/API responses, images,
fonts, wasm — and, where the site ships source maps, the **original pre-build
sources** behind its bundles: TypeScript, JSX, Vue/Svelte, SCSS.

| Popup — quick copy and export | DevTools panel — the deep work |
| --- | --- |
| ![popup](docs/popup.png) | ![panel](docs/panel.png) |

## First, the honest limit

A browser extension can copy everything the server **sent**. It can never copy
the code that ran **on** the server to produce it:

- PHP, Ruby, Python, Node, Java, .NET source
- server-side templates (Blade, Twig, ERB, Jinja, Razor, JSP)
- database schemas, queries or contents
- `.env` files, API keys, routes, cron jobs

A `.php` URL in a capture is the *output* of a PHP script, not the script. Any
tool that claims otherwise is lying to you.

The nearest honest equivalent is **source maps**, and this extension goes after
them: most production sites publish `.js.map` / `.css.map` files next to their
bundles, and those maps usually embed `sourcesContent` — the real, unminified
project tree as it existed before the build. When a site ships them, `src/` in
your capture is the site's actual development source.

## What it does

### Popup — one click, two tabs

**Copy**
- **Copy CSS** — every rule in play: external stylesheets (including
  cross-origin ones the page itself cannot read), `<style>` blocks, constructed
  and adopted stylesheets, open shadow roots, and every iframe. Optionally
  filtered to only the rules that match something in the live DOM.
- **Copy HTML** — the rendered DOM, pretty-printed.
- **Pick an element** — closes the popup, hands you a crosshair; click anything
  and its HTML plus *only the CSS that matches it and its children* (plus the
  `@font-face`/`@keyframes` in scope and its non-default computed styles) lands
  on your clipboard.

**Export**
- **Export capture (.zip)** — the whole site as the browser sees it, written
  client-side (no server, no upload).

### DevTools panel — "Source Copier"

Open DevTools → **Source Copier**. The panel listens to the network as the page
loads, so it sees **response bodies the popup cannot**: XHR and `fetch` JSON,
API responses, POST results, and anything loaded before you clicked the toolbar
icon. Click **Reload & capture** to record a page from its first byte.

- Filter by URL or type, click any resource to view it pretty-printed
- **Copy** or **Save** any single file
- **Recover sources** on any bundle with a source map — lists the original
  files, click one to read it, copy or save it
- **Export capture (.zip)** here prefers recorded bodies over refetching, which
  is what puts live API responses into the archive
- **Pick element**, **Collect CSS** and **Page HTML** feed straight into the
  viewer

## What a capture contains

```
example.com-2026-09-20/
├── README.md              what was captured, what failed, what is impossible
├── inventory.json         every resource: url, type, size, archive path
├── rendered-page.html     the DOM after JavaScript ran
├── original-page.html     the HTML the server actually sent
├── collected.css          every CSS rule, shadow DOM and iframes included
├── inline-scripts/        <script> blocks that have no URL of their own
├── files/example.com/…    every asset, in the site's own folder structure
└── src/                   ORIGINAL sources recovered from source maps
    └── my-app/src/components/Button.tsx
```

Options: pretty-print minified code, recover source maps, include or skip
binary assets.

## How it works

| Problem | Approach |
| --- | --- |
| Cross-origin stylesheets throw on `sheet.cssRules` | The extension refetches them with host permissions (service worker for the popup's CSS copy, direct `fetch` from the extension page for exports) |
| "Which rules are actually used?" | Every selector is tested against the live DOM with `querySelector`, recursing into `@media`/`@supports`/`@container` and dropping emptied groups. Pseudo-elements and state pseudo-classes are stripped first, so `a:hover` survives as long as an `a` exists |
| XHR/API bodies are not refetchable | The DevTools panel reads them out of the network recording (`getContent`) instead |
| Minified bundles are unreadable | Tokenizer-based formatters that only ever *insert* whitespace — strings, comments, regex literals and template literals are passed through untouched |
| ZIP without a library | `CompressionStream('deflate-raw')` plus a hand-written central directory |
| Original sources | `sourceMappingURL` (including inline `data:` maps and index maps with `sections`) → `sourcesContent` → a real folder tree |

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this `web-source-copier` folder
3. Pin it; open any page; click the icon, or open DevTools → **Source Copier**

Chrome, Edge, Brave, Arc and other Chromium browsers. Firefox needs a
`browser_specific_settings` key and a background *scripts* entry instead of a
module service worker; the rest is API-compatible.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Touch the page only when you click the toolbar button |
| `scripting` | Inject the collectors into the page's frames |
| `host_permissions: <all_urls>` | Refetch cross-origin stylesheets and assets the page itself is not allowed to read. Without it, CDN-hosted CSS and JS come back empty |

Nothing is uploaded anywhere. Collection happens in the page and in the
extension; output goes to your clipboard or a local file. No analytics, no
remote endpoint, no storage between sessions. Assets are fetched without
credentials; only on a `401`/`403` does the extension retry with the site's own
cookies, so logged-in pages still capture.

## Layout

```
manifest.json
src/
  popup/                  toolbar popup (copy + export)
  devtools/               DevTools page + "Source Copier" panel
  background/             service worker: cross-origin stylesheet fetches
  lib/
    css-collector.js      page-side CSS walker           (injected)
    page-inventory.js     page-side resource inventory   (injected)
    element-inspector.js  page-side element picker       (injected)
    bundle.js             capture pipeline → ZIP
    zip.js                ZIP writer (deflate-raw)
    format.js             JS/CSS/HTML/JSON pretty-printers
    sourcemap.js          source map → original sources
tests/
  unit.test.mjs           zip, formatters, source maps (Node)
  e2e.test.mjs            the real popup and panel in Chromium
  fixtures/site.mjs       two-origin fixture site
```

The three files marked *injected* are stringified by
`chrome.scripting.executeScript`, so they must stay self-contained — no
imports, no references to anything outside their own body.

## Tests

```bash
npm install
npm test                 # unit + e2e
npm run test:unit        # no browser needed
npm run test:e2e         # CHROME_PATH=/path/to/chrome to pick a binary
```

The e2e test loads the unpacked extension into Chromium against a two-origin
fixture (the second origin deliberately sends no CORS headers) and drives the
shipped UI: both CSS modes, a full ZIP export (unzipped and inspected file by
file, including source-map recovery), the DevTools panel's list/viewer/recovery,
the element picker clicking a real page, and a panel export that proves recorded
API bodies beat refetching.

Only two seams are stubbed, because Playwright cannot reach them: the popup's
`chrome.tabs.query` (it would otherwise target the test tab itself) and the
panel's `chrome.devtools` host object. Everything below those is shipped code.

## Known limits

- Browser-internal pages (`chrome://`, the extension store, the PDF viewer)
  cannot be scripted.
- Closed shadow roots are invisible to any extension by design.
- The element picker's CSS comes from stylesheets the page can read; a
  cross-origin sheet's rules show up in **Copy CSS** and in exports, not in a
  pick.
- `@import` inside a *fetched* cross-origin stylesheet is not followed.
- Files over 12 MB are skipped by the exporter (configurable in `bundle.js`).
- Keep the popup open while an export runs; long captures belong in the panel.

## Using this responsibly

Captured files stay the copyright of their owners, and some sites' terms
prohibit bulk downloading. This is built for studying how a page is made,
debugging your own site, archiving work you own, and migrating a site you are
responsible for — not for republishing someone else's.
