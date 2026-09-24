#!/usr/bin/env node
// Renders every post in content/posts.json for every platform and size,
// plus captions, a posting calendar (CSV) and a preview gallery.
//
//   npm run build                               # everything
//   npm run build -- --post 01-editing          # one post (comma-separate for more)
//   npm run build -- --platform instagram,x     # some platforms
//   npm run build -- --content my-posts.json --out dist
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PLATFORMS } from './formats.js';
import { renderHtml, carouselLength, escapeHtml } from './template.js';
import { captionFor } from './captions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = { content: 'content/posts.json', brand: 'brand.json', out: 'output' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!['post', 'platform', 'content', 'brand', 'out'].includes(key)) {
      throw new Error(`Unknown option ${argv[i]}`);
    }
    opts[key] = argv[++i];
  }
  const list = (v) => v?.split(',').map((s) => s.trim()).filter(Boolean);
  opts.post = list(opts.post);
  opts.platform = list(opts.platform);
  return opts;
}

async function launch() {
  try {
    return await chromium.launch();
  } catch (err) {
    const fallback = '/opt/pw-browsers/chromium';
    if (existsSync(fallback)) return chromium.launch({ executablePath: fallback });
    throw new Error(`${err.message}\n\nRun "npx playwright install chromium" once, then try again.`);
  }
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brand = JSON.parse(readFileSync(path.resolve(ROOT, opts.brand), 'utf8'));
  const allPosts = JSON.parse(readFileSync(path.resolve(ROOT, opts.content), 'utf8'));
  const posts = opts.post ? allPosts.filter((p) => opts.post.includes(p.id)) : allPosts;
  const platforms = opts.platform ?? Object.keys(PLATFORMS);
  for (const p of platforms) if (!PLATFORMS[p]) throw new Error(`Unknown platform "${p}". Try: ${Object.keys(PLATFORMS).join(', ')}`);
  if (!posts.length) throw new Error('No posts matched.');

  const outDir = path.resolve(ROOT, opts.out);
  const browser = await launch();
  const page = await browser.newPage();
  const calendar = [['date', 'post', 'platform', 'format', 'images', 'title', 'caption']];
  const warnings = [];
  let imageCount = 0;

  for (const post of posts) {
    const postDir = path.join(outDir, post.id);
    const cache = new Map(); // same size + slide renders once, then gets reused
    const captionsMd = [`# ${post.id}\n`];

    const render = async (format, slide) => {
      const key = `${format.w}x${format.h}x${format.safe || 0}x${slide}`;
      if (!cache.has(key)) {
        await page.setViewportSize({ width: format.w, height: format.h });
        await page.setContent(renderHtml({ post, brand, format, slide, baseDir: ROOT }));
        await page.waitForSelector('body[data-ready="1"]');
        const scale = Number(await page.getAttribute('body', 'data-scale'));
        if (scale < 0.5) warnings.push(`${post.id} (${format.w}×${format.h}): text had to shrink a lot; consider shorter copy.`);
        cache.set(key, await page.screenshot({ type: 'png' }));
      }
      return cache.get(key);
    };

    for (const platform of platforms) {
      const spec = PLATFORMS[platform];
      const dir = path.join(postDir, platform);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const caption = captionFor(post, brand, platform);
      warnings.push(...caption.warnings.map((w) => `${post.id}: ${w}`));

      let jobs;
      if (post.type === 'carousel') {
        const name = spec.carousel;
        const count = Math.min(carouselLength(post), spec.maxImages ?? Infinity);
        if (count < carouselLength(post)) {
          warnings.push(`${post.id}: ${spec.label} allows ${count} images, so only the first ${count} slides were made.`);
        }
        jobs = [{ name, format: spec.formats[name], slides: [...Array(count).keys()] }];
      } else {
        jobs = Object.entries(spec.formats).map(([name, format]) => ({ name, format, slides: [0] }));
      }

      for (const job of jobs) {
        const files = [];
        for (const slide of job.slides) {
          const file = job.slides.length > 1 ? `${job.name}-${slide + 1}.png` : `${job.name}.png`;
          writeFileSync(path.join(dir, file), await render(job.format, slide));
          files.push(path.join(post.id, platform, file));
          imageCount++;
        }
        if (post.type === 'carousel' && spec.carouselPdf) {
          const pdf = await carouselPdf(browser, dir, job, files.map((f) => path.join(outDir, f)));
          files.push(path.join(post.id, platform, pdf));
        }
        calendar.push([post.date || '', post.id, spec.label, job.name, files.join('; '), caption.title || '', caption.text]);
      }

      writeFileSync(path.join(dir, 'caption.txt'), (caption.title ? `${caption.title}\n\n` : '') + caption.text + '\n');
    }

    for (const [platform, spec] of Object.entries(PLATFORMS)) {
      const caption = captionFor(post, brand, platform);
      captionsMd.push(`## ${spec.label}\n`, ...(caption.title ? [`**Title:** ${caption.title}\n`] : []), '```', caption.text, '```\n');
    }
    writeFileSync(path.join(postDir, 'captions.md'), captionsMd.join('\n'));
    console.log(`✓ ${post.id}`);
  }

  await browser.close();
  // Keep rows for posts and platforms that weren't rebuilt this time.
  writeFileSync(path.join(outDir, 'calendar.csv'), mergeCalendar(path.join(outDir, 'calendar.csv'), calendar, posts, platforms));
  writeFileSync(path.join(outDir, 'index.html'), galleryHtml(brand, collectGallery(outDir, allPosts)));

  console.log(`\n${imageCount} images for ${posts.length} post(s) in ${path.relative(process.cwd(), outDir) || '.'}/`);
  console.log(`Open ${path.relative(process.cwd(), path.join(outDir, 'index.html'))} to preview them all.`);
  if (warnings.length) console.log(`\nWarnings:\n${[...new Set(warnings)].map((w) => `  ! ${w}`).join('\n')}`);
}

// LinkedIn "document" carousels are PDFs, one slide per page.
async function carouselPdf(browser, dir, job, pngPaths) {
  const page = await browser.newPage();
  const imgs = pngPaths.map((p) => `<img src="data:image/png;base64,${readFileSync(p).toString('base64')}">`).join('');
  await page.setContent(`<style>@page{size:${job.format.w}px ${job.format.h}px;margin:0}
    body{margin:0}img{display:block;width:${job.format.w}px;height:${job.format.h}px;break-after:page}</style>${imgs}`);
  const name = `${job.name}-carousel.pdf`;
  await page.pdf({ path: path.join(dir, name), width: `${job.format.w}px`, height: `${job.format.h}px`, printBackground: true });
  await page.close();
  return name;
}

function mergeCalendar(file, rows, rebuilt, platforms) {
  const ids = new Set(rebuilt.map((p) => p.id));
  const labels = new Set(platforms.map((p) => PLATFORMS[p].label));
  const [header, ...fresh] = rows;
  let kept = [];
  if (existsSync(file)) {
    kept = parseCsv(readFileSync(file, 'utf8')).slice(1).filter((r) => r.length > 1 && !(ids.has(r[1]) && labels.has(r[2])));
  }
  const all = [...kept, ...fresh].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  return [header, ...all].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// The gallery lists everything on disk, so partial rebuilds keep the rest.
function collectGallery(outDir, posts) {
  return posts.map((post) => ({
    post,
    items: Object.entries(PLATFORMS).flatMap(([platform, spec]) => {
      const dir = path.join(outDir, post.id, platform);
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter((f) => f.endsWith('.png'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((file) => {
          const format = spec.formats[file.replace(/(-\d+)?\.png$/, '')];
          return { src: `${post.id}/${platform}/${file}`,
            label: `${spec.label} · ${file.replace('.png', '')}${format ? ` ${format.w}×${format.h}` : ''}` };
        });
    }),
  })).filter((g) => g.items.length);
}

function galleryHtml(brand, gallery) {
  const e = escapeHtml;
  const sections = gallery.map(({ post, items }) => `<section><h2>${e(post.id)} <small>${e(post.date || '')} · ${e(post.type)}</small></h2>
    <div class="grid">${items.map((it) => `<figure><a href="${e(it.src)}" target="_blank"><img loading="lazy" src="${e(it.src)}" alt=""></a>
    <figcaption>${e(it.label)}</figcaption></figure>`).join('')}</div>
    <p><a href="${e(post.id)}/captions.md">Captions for every platform →</a></p></section>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(brand.name)} posts</title><style>
body{margin:0;padding:24px 16px;font-family:system-ui,sans-serif;background:#f4f1ec;color:#1d2b3a}
h1{margin:0 0 8px}section{margin:32px 0}h2 small{font-weight:400;color:#6b7280;font-size:.7em}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;align-items:end}
figure{margin:0}img{width:100%;height:auto;display:block;box-shadow:0 1px 4px rgba(0,0,0,.2)}
figcaption{font-size:12px;color:#6b7280;margin-top:6px}a{color:#9e4b2b}
</style></head><body><h1>${e(brand.name)}: social posts</h1><p>See calendar.csv for dates, captions and file paths.</p>${sections}</body></html>`;
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
