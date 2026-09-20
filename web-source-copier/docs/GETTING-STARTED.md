# Getting started

Installing Web Source Copier in Chrome and using it for the first time.
Takes about two minutes.

---

## 1. Get the files onto your machine

**Option A — clone the repository** (best if you want updates later):

```bash
git clone -b claude/adoring-brown-ishlr5 \
  https://github.com/abolajijamiu/DREM-Book-Services.git
cd DREM-Book-Services/web-source-copier
pwd    # note this path — you will select this folder in step 2
```

**Option B — download a ZIP** (no git needed):

1. Open the repository on GitHub and switch to the `claude/adoring-brown-ishlr5` branch
2. **Code → Download ZIP**
3. Unzip it somewhere permanent — Chrome reads these files from disk every time
   it starts, so don't leave them in `Downloads` and don't move or delete the
   folder afterwards

Either way, the folder you want is the one containing **`manifest.json`**:

```
web-source-copier/          ← select THIS folder in step 2
├── manifest.json
├── icons/
└── src/
```

No build step, no `npm install`. The extension runs exactly as it sits on disk.
(`npm install` is only needed if you want to run the test suite.)

## 2. Load it into Chrome

1. Open **`chrome://extensions`** (type it in the address bar)
2. Turn on **Developer mode** — toggle in the top-right corner
3. Click **Load unpacked** (top-left)
4. Select the `web-source-copier` folder and confirm

"Web Source Copier 2.0.0" now appears in the list. If Chrome reports an error
instead, you probably selected the parent folder — go back and pick the one
with `manifest.json` directly inside it.

Chrome will warn that the extension can "Read and change all your data on all
websites". That is the `<all_urls>` host permission, and it is what lets the
extension refetch CDN-hosted stylesheets and assets a page is not allowed to
read itself. Nothing is sent anywhere — see [Permissions](../README.md#permissions).

## 3. Pin it to the toolbar

Click the puzzle-piece icon in Chrome's toolbar, find **Web Source Copier**, and
click the pin. The icon now sits next to the address bar.

## 4. First use — the popup

Open any ordinary web page (not `chrome://…`, not the Chrome Web Store) and
click the icon.

**Copy tab**

| Button | What it does |
| --- | --- |
| **Copy CSS** | Every rule the page uses — external stylesheets, `<style>` blocks, shadow DOM, iframes — onto your clipboard |
| **Copy HTML** | The rendered DOM, pretty-printed (this is the page *after* JavaScript ran, not the raw server HTML) |
| **Pick an element →** | Closes the popup and gives you a crosshair |

Two checkboxes shape what **Copy CSS** and the export produce:

- **Only CSS rules used on this page** — drops selectors that match nothing in
  the DOM right now. A page's stylesheet is usually 5–20× bigger than what one
  page actually uses. Open the menu/modal you care about *before* collecting,
  or its styles will look unused.
- **Include `style=""` attributes** — adds inline styles as a commented
  reference block.

**Using the picker:** hover — every element highlights with its size; click —
its HTML, the CSS rules that match it and its children, and its non-default
computed styles land on your clipboard, and the page shows a "Copied" toast.
Press **Esc** to cancel.

**Export tab** — **Export capture (.zip)** downloads the whole page. Keep the
popup open while it runs (clicking the page closes any Chrome popup); for big
sites, use the DevTools panel instead.

**Site tab — capturing more than one page**

1. Open it. The extension reads the links already on the page and the site's
   `robots.txt`, and lists the pages on offer — the one you are on first.
2. Pages `robots.txt` disallows are greyed out with a **robots.txt** tag and
   cannot be selected. That is deliberate and not configurable.
3. **Max pages** starts at 25. The first 25 allowed pages are ticked for you.
   Want more? Raise the number, then **Select first N** — or tick boxes yourself.
   The picker will not let you go past the number you set.
4. **Find more pages** fetches the pages you have selected and adds the links
   *they* contain. Click it again to go deeper.
5. Optional: **Run each page's JavaScript** loads every page in a background tab
   instead of just fetching its HTML. Slower, but required for sites that build
   their content in the browser (React/Vue/Svelte apps).
6. **Capture N pages (.zip)**.

Each page's HTML lands in `pages/`, and assets shared between pages — the
stylesheet, the fonts, the bundle — are stored **once** in `files/`. Links
inside the saved HTML still point at the live site; they are not rewritten.

## 5. The DevTools panel — where the deep work happens

Press **F12** (or **⌥⌘I** on macOS) and pick the **Source Copier** tab. If the
tab bar is crowded, it is under the **»** overflow menu.

The panel sees things the popup cannot: **response bodies for XHR/`fetch` calls
and API endpoints**. For a complete picture, click **Reload & capture** — the
page reloads with the panel recording from the first byte.

- **Filter by URL or type** to find a file
- **Click a row** to read it, pretty-printed
- **Copy** / **Save** for a single file
- **Recover sources** appears on any bundle with a source map — it lists the
  original files; click one to read, copy or save it
- **Export capture (.zip)** here prefers the recorded bodies, which is what puts
  live API responses in the archive
- **Pick element**, **Collect CSS**, **Page HTML** load straight into the viewer

## 6. What you get from an export

```
example.com-2026-09-20/
├── README.md              what was captured, what failed, what is impossible
├── inventory.json         every resource: url, type, size, path in this archive
├── rendered-page.html     the DOM after JavaScript ran
├── original-page.html     the HTML the server actually sent
├── collected.css          every CSS rule, shadow DOM and iframes included
├── inline-scripts/        <script> blocks with no URL of their own
├── files/example.com/…    every asset, in the site's own folder structure
└── src/                   original pre-build sources, if the site ships maps
```

Open `README.md` inside the archive first: it lists anything that failed and
why.

## 7. Things people actually do with it

| Goal | How |
| --- | --- |
| Copy a component's styling | **Pick an element**, paste into CodePen — the snippet carries its own CSS |
| See how a site is built | **Export**, then read `src/` — if the site ships source maps, that is its real source tree |
| Read a minified bundle | DevTools panel → click the bundle → it is pretty-printed for you |
| Grab an API response | DevTools panel → **Reload & capture** → filter to `Data / XHR` → click → **Copy** |
| Archive a page you own | **Export**, keep the ZIP |
| Archive a whole small site | **Site** tab → **Find more pages** → raise the limit → **Capture** |
| Recover your own lost source | If your deployed build shipped `.map` files, **Recover sources** gets the originals back |

## 8. Keeping it up to date

```bash
cd DREM-Book-Services
git pull
```

Then open `chrome://extensions` and click the **↻ reload** icon on the
extension's card. (Downloaded a ZIP instead? Replace the folder contents and
reload the same way.)

## 9. If something does not work

| Symptom | Cause and fix |
| --- | --- |
| "Open a normal web page to copy its source" | You are on `chrome://…`, the Web Store, or a PDF. No extension can script those — open a normal site. |
| The panel list stays empty | It only records while it is open. Click **Reload & capture**. |
| Clicking the page dismissed the popup | Normal Chrome behaviour for any popup. Start long exports from the DevTools panel. |
| Assets missing from the ZIP | Check `README.md` in the archive: it names each failure (403, 404, CORS, size limit). |
| A page you wanted is greyed out | The site's `robots.txt` disallows it. |
| A captured page looks empty | It builds its content in the browser — recapture with **Run each page's JavaScript** ticked. |
| Icon greyed out after a Chrome restart | The extension folder moved or was deleted. Keep it somewhere permanent and reload it. |
| "Errors" badge on `chrome://extensions` | Click **Errors** to see the message. Usually the wrong folder was loaded. |

Works the same in Edge, Brave, Arc and other Chromium browsers (`edge://extensions`
for Edge). Firefox needs a small manifest change — see the README.

## 10. What it does with your data

Nothing leaves your machine. Collection happens in the page and in the
extension; output goes to your clipboard or a file you save. No analytics, no
servers, no stored history. Assets are fetched without cookies, and only if a
server answers 401/403 does it retry with the site's own session — so pages
behind a login still capture.

Captured files remain their owners' copyright, and some sites' terms prohibit
bulk downloading. This is a tool for studying, debugging, archiving and
migrating — not for republishing someone else's site.
