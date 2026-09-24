# DREM Book Services: Social Post Generator

Write your posts once in `content/posts.json`. One command turns them into
ready-to-upload images and captions for every platform and size:

| Platform | Sizes produced |
|---|---|
| Instagram | Portrait 1080×1350 · Tall 1080×1440 · Square 1080×1080 · Landscape 1080×566 · Story/Reel 1080×1920 |
| Facebook | Landscape 1200×630 · Square 1080×1080 · Portrait 1080×1350 · Story/Reel 1080×1920 |
| X / Twitter | Landscape 1200×675 · Square 1080×1080 · Portrait 1080×1350 |
| LinkedIn | Landscape 1200×627 · Square 1080×1080 · Portrait 1080×1350 · carousel as a PDF document |
| Threads | Portrait 1080×1350 · Square 1080×1080 |
| Pinterest | Pin 1000×1500 |
| TikTok | Vertical 1080×1920 |
| WhatsApp Status | 1080×1920 |

Story and vertical sizes keep text clear of the areas the app covers with its own
buttons. Long copy shrinks automatically so it never spills off the image.

## Quick start

```bash
cd social-post-generator
npm install
npm run build
```

Then open `output/index.html` to see every image. For each post you get:

```
output/
  index.html                 preview gallery
  calendar.csv               date, platform, image files and caption for every post
  01-editing/
    captions.md              captions for every platform, ready to copy
    instagram/portrait.png   one image per size…
    instagram/caption.txt    …plus that platform's caption
    linkedin/…
```

`calendar.csv` opens in Excel or Google Sheets. Use it as your posting schedule,
or import it into a scheduler such as Buffer, Later or Meta Business Suite.

Rebuild only part of it:

```bash
npm run build -- --post 01-editing,08-now-booking
npm run build -- --platform instagram,linkedin
```

## 1. Set up your brand (`brand.json`)

| Field | What it does |
|---|---|
| `name`, `tagline` | Shown in the footer of every image |
| `website`, `handle`, `email` | **Empty for now; fill these in.** The first one set replaces the tagline in the footer, and all of them go at the end of captions. |
| `cta` | Button text on service and announcement posts |
| `logo` | Path to a logo file (PNG/SVG/JPG). Leave it empty to use the built-in open-book mark. |
| `colors` | `ink` (dark), `paper` (light), `accent` + `accentDeep` (terracotta), `gold` |
| `defaultHashtags` | Added to every post after the post's own hashtags |

## 2. Write posts (`content/posts.json`)

The sample posts cover editing, proofreading, cover design, formatting, a
writing tip, a quote, a 7-slide carousel and a "now booking" announcement.
**Check the service names and wording against what you actually offer before
you post.**

Every post has:

- `id`: the folder name, e.g. `"09-launch-day"`
- `date`: when to post it (used for `calendar.csv`)
- `type`: one of the post types below
- `theme`: `"dark"` (navy), `"light"` (cream) or `"accent"` (terracotta)
- `caption`: the full caption (Instagram, Facebook and LinkedIn use this)
- `short`: a shorter version for X, Threads, TikTok, WhatsApp and Pinterest
- `hashtags`: the post's own hashtags
- `captions`: *(optional)* your own caption for one platform, e.g. `{ "linkedin": "…" }`

Fields for each post type:

| `type` | Fields |
|---|---|
| `service` | `eyebrow`, `title`, `subtitle`, `points` (3 short lines), optional `cta` |
| `tip` | `eyebrow`, `title`, `points` (numbered steps) |
| `quote` | `quote`, `author`, optional `source` |
| `announcement` | `eyebrow`, `title`, `body`, optional `cta` |
| `carousel` | `title`, `subtitle`, `slides` (each `{ "title", "body" }`), optional `outro` |

Captions are fitted to each platform's limit: 280 characters on X, 500 on
Threads and Pinterest, 2,200 on Instagram, and so on. Each platform also gets
its usual number of hashtags. If a caption has to be cut, or text had to
shrink a lot to fit an image, the build prints a warning.

Carousels are made in each platform's carousel size. X allows at most 4
images, so it gets only the first 4 slides.

## Tests

```bash
npm test
```
