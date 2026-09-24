# DREM Book: Social Post Generator

Every image uses the DREM Book brand kit (`brand/drem-book-brand-kit.html`):
the fanned-page mark and wordmark, the Midnight / Ember / Moonlight / Paper
palette, Open Sans with Zilla Slab italic accents, the duotone icons, the ember
pill button with its moonlight ring, and copy in the kit's voice.

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
npm run build -- --post 01-editing,08-every-book-a-dream
npm run build -- --platform instagram,linkedin
```

## 1. Set up your brand (`brand.json`)

| Field | What it does |
|---|---|
| `word1`, `word2` | The wordmark: **DREM** (heavy) and Book (light), beside the mark |
| `website`, `handle`, `email` | **Empty for now; fill these in.** The first one set appears next to the logo on every image, and all of them go at the end of captions. |
| `cta` | Button text on service, announcement and carousel posts |
| `logo` | Optional path to a logo file (PNG/SVG/JPG) that replaces the built-in mark and wordmark |
| `colors` | The brand kit palette. Change a hex here and every image follows. |
| `defaultHashtags` | Added to every post after the post's own hashtags |

The fonts in `assets/fonts/` come from the brand kit (SIL Open Font License,
see `FONT-LICENSES.txt`). They cover Western European languages; other
scripts fall back to a system font.

## 2. Write posts (`content/posts.json`)

The sample posts cover editing, cover design, printing, ebook & audiobook, a
writing tip, a quote, a 7-slide carousel and a brand announcement. They follow
the brand kit's services and voice. **Check the wording against what you
actually offer before you post.**

Every post has:

- `id`: the folder name, e.g. `"09-launch-day"`
- `date`: when to post it (used for `calendar.csv`)
- `type`: one of the post types below
- `theme`: `"midnight"` (dark), `"paper"` (cream) or `"moonlight"` (pale yellow)
- `caption`: the full caption (Instagram, Facebook and LinkedIn use this)
- `short`: a shorter version for X, Threads, TikTok, WhatsApp and Pinterest
- `hashtags`: the post's own hashtags
- `captions`: *(optional)* your own caption for one platform, e.g. `{ "linkedin": "…" }`

Fields for each post type:

| `type` | Fields |
|---|---|
| `service` | `eyebrow`, `title`, `subtitle`, `points` (3 short lines), optional `icon` and `cta` |
| `tip` | `eyebrow`, `title`, `points` (numbered steps) |
| `quote` | `quote`, `author`, optional `source` |
| `announcement` | `eyebrow`, `title`, `body`, optional `cta` |
| `carousel` | `title`, `subtitle`, `slides` (each `{ "title", "body" }`), optional `eyebrow` and `outro` |

Wrap words in asterisks to set them in the Zilla Slab italic accent, like the
brand kit's headline: `"Every book starts as a *dream*."`

`icon` is any brand kit icon: book, open-book, editing, design, printing,
ebook, audiobook, distribution, marketing, pricing, quality, speed, eco,
support, royalty, upload, check, star, heart, trophy, expert, search, phone,
user, arrow, download, mail, play, bookshop, isbn, dream (plus menu).

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
