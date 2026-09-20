/**
 * The capture pipeline: inventory -> fetch -> source maps -> format -> ZIP.
 *
 * Runs in an extension page (the popup or the DevTools panel), where
 * `host_permissions` allow cross-origin `fetch`, so no content script or
 * message round-trip is needed to read a site's assets.
 */

import { ZipWriter, isAlreadyCompressed } from './zip.js';
import { formatByKind } from './format.js';
import { extractOriginalSources } from './sourcemap.js';
import { pageInventoryRunner } from './page-inventory.js';
import { fetchWithTimeout, forEachPooled } from './net.js';
import { cssUrlReferences } from './html-scan.js';
import { rewriteHtml, rewriteCss } from './rewrite.js';
import { cssCopierRunner } from './css-collector.js';

const TEXT_KINDS = new Set(['script', 'style', 'data', 'document']);

export const DEFAULT_OPTIONS = {
  prettyPrint: true,
  sourceMaps: true,
  includeAssets: true,
  usedCssOnly: false,
  includeInlineAttributes: false,
  maxFileBytes: 12 * 1024 * 1024,
  // Downloads are almost all waiting on the network, so run a few at once.
  concurrency: 8,
  // Pretty-printing costs roughly a millisecond per KB. Past this size a file
  // is stored as served rather than holding up the whole capture.
  maxFormatBytes: 2 * 1024 * 1024,
  // A host that times out repeatedly is not worth waiting for again.
  hostTimeoutsBeforeSkip: 3,
  // One unreachable host must not hold up the whole capture.
  fetchTimeoutMs: 20000,
  // Site capture follows url() references out of fetched stylesheets, since
  // there is no live CSSOM to read them from.
  followCssUrls: false,
  // Repoint captured URLs at their files so the archive browses offline.
  rewriteLinks: true
};

export function kindOf(url, contentType) {
  const type = (contentType || '').toLowerCase();
  if (type.includes('javascript') || type.includes('ecmascript')) return 'script';
  if (type.includes('css')) return 'style';
  if (type.includes('json')) return 'data';
  if (type.includes('html')) return 'document';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('font/') || type.includes('font')) return 'font';
  if (type.startsWith('video/') || type.startsWith('audio/')) return 'media';
  if (type.includes('wasm')) return 'wasm';
  // Framework payloads with no extension: Next.js RSC flight data
  // (text/x-component), text/plain APIs, ld+json, atom+xml …
  if (type.startsWith('text/') || type.includes('+json') || type.includes('+xml')) return 'data';

  const ext = (url.split('?')[0].split('#')[0].match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  return (
    {
      js: 'script', mjs: 'script', cjs: 'script', ts: 'script', tsx: 'script', jsx: 'script',
      css: 'style', scss: 'style', less: 'style',
      json: 'data', webmanifest: 'data', map: 'data', xml: 'data', txt: 'data',
      html: 'document', htm: 'document', php: 'document',
      png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image',
      svg: 'image', ico: 'image',
      woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', eot: 'font',
      mp4: 'media', webm: 'media', mp3: 'media', wav: 'media', ogg: 'media',
      wasm: 'wasm'
    }[ext.toLowerCase()] || 'other'
  );
}

function formatKindFor(kind, url) {
  if (kind === 'script') return 'js';
  if (kind === 'style') return 'css';
  if (kind === 'document') return 'html';
  if (kind === 'data') return /\.(json|webmanifest|map)$/i.test(url.split('?')[0]) ? 'json' : null;
  return null;
}

export function shortHash(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return hash.toString(36).slice(0, 6);
}

/** files/example.com/assets/app.js — the site's own layout, preserved. */
export function zipPathForUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    return 'files/unknown/' + shortHash(String(rawUrl));
  }
  let path = decodeURIComponent(parsed.pathname);
  if (!path || path.endsWith('/')) path += 'index.html';
  if (parsed.search) {
    const dot = path.lastIndexOf('.');
    const suffix = '~' + shortHash(parsed.search);
    path = dot > 0 ? path.slice(0, dot) + suffix + path.slice(dot) : path + suffix;
  }
  return ('files/' + parsed.hostname + path).replace(/\/{2,}/g, '/');
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

async function defaultFetch(url, timeoutMs, signal) {
  const withTimeout = (init) => fetchWithTimeout(url, Object.assign({ redirect: 'follow' }, init), timeoutMs, signal);

  let response = await withTimeout({ credentials: 'omit' });
  if (response.status === 401 || response.status === 403) {
    // Asset behind a login: retry with the site's own cookies.
    response = await withTimeout({ credentials: 'include' });
  }
  if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + response.statusText);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || ''
  };
}

function decodeText(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function looksBinary(bytes) {
  const sample = bytes.subarray(0, 1024);
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const byte = sample[i];
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) control++;
  }
  return control / Math.max(1, sample.length) > 0.1;
}

/**
 * Shared state for one archive. Single-page capture uses one of these for one
 * page; site capture reuses it across every page, so a stylesheet shared by
 * fifty pages is fetched, formatted and stored exactly once.
 */
export function createCapture(config) {
  const options = Object.assign({}, DEFAULT_OPTIONS, config.options || {});
  const onProgress = config.onProgress || (() => {});

  const fetchBody = async (url) => {
    if (config.getBody) {
      const recorded = await config.getBody(url);
      if (recorded && recorded.bytes) return recorded;
    }
    return defaultFetch(url, options.fetchTimeoutMs, config.signal);
  };
  const fetchText = async (url) => {
    const result = await fetchBody(url);
    return result ? decodeText(result.bytes) : null;
  };

  const root =
    (() => {
      try {
        return new URL(config.primaryUrl).hostname.replace(/^www\./, '');
      } catch (err) {
        return 'capture';
      }
    })() + '-' + new Date().toISOString().slice(0, 10);

  return {
    options,
    onProgress,
    fetchBody,
    fetchText,
    root,
    signal: config.signal || null,
    // HTML and CSS are written at the end: rewriting their links needs the
    // finished url -> archive path map.
    deferred: [],
    zip: new ZipWriter(),
    stats: { files: 0, bytes: 0, byKind: {}, failures: [], sourceFiles: 0, maps: 0 },
    storedResources: new Map(), // url -> archive path (deduplicates across pages)
    inflight: new Map(), // url -> promise, so parallel workers never double-fetch
    hostTimeouts: new Map(), // host -> consecutive timeouts
    sourceSeen: new Set(),
    manifestRows: [],
    pages: []
  };
}

/**
 * Fetches one resource into the archive, unpacking its source map if it has
 * one. Returns the path it was stored at, or null when it could not be had.
 */
export function addResource(ctx, resource) {
  if (ctx.storedResources.has(resource.url)) return Promise.resolve(ctx.storedResources.get(resource.url));
  const pending = ctx.inflight.get(resource.url);
  if (pending) return pending;
  const promise = fetchIntoArchive(ctx, resource).finally(() => ctx.inflight.delete(resource.url));
  ctx.inflight.set(resource.url, promise);
  return promise;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (err) {
    return '';
  }
}

async function fetchIntoArchive(ctx, resource) {
  const { options, stats } = ctx;
  if (ctx.signal && ctx.signal.aborted) return null;
  const host = hostOf(resource.url);
  const strikes = ctx.hostTimeouts.get(host) || 0;

  if (strikes >= (options.hostTimeoutsBeforeSkip || Infinity)) {
    stats.failures.push({ url: resource.url, error: 'skipped — ' + host + ' stopped responding' });
    ctx.storedResources.set(resource.url, null);
    return null;
  }

  let body;
  try {
    body = await ctx.fetchBody(resource.url);
    if (strikes) ctx.hostTimeouts.set(host, 0);
  } catch (err) {
    if (/timed out/.test(err.message)) ctx.hostTimeouts.set(host, strikes + 1);
    stats.failures.push({ url: resource.url, error: err.message });
    ctx.storedResources.set(resource.url, null);
    return null;
  }

  if (body.bytes.length > options.maxFileBytes) {
    stats.failures.push({
      url: resource.url,
      error: 'skipped, ' + formatBytes(body.bytes.length) + ' exceeds the size limit'
    });
    ctx.storedResources.set(resource.url, null);
    return null;
  }

  const kind = kindOf(resource.url, body.contentType);
  const isText = TEXT_KINDS.has(kind) && !looksBinary(body.bytes);
  let stored = body.bytes;
  let text = null;

  if (isText) {
    text = decodeText(body.bytes);
    const tooBigToFormat = text.length > (options.maxFormatBytes || Infinity);
    const formatKind = options.prettyPrint && !tooBigToFormat ? formatKindFor(kind, resource.url) : null;
    if (tooBigToFormat) stats.unformatted = (stats.unformatted || 0) + 1;
    stored = formatKind ? formatByKind(formatKind, text) : text;
  }

  const deferRewrite = options.rewriteLinks && isText && (kind === 'style' || kind === 'document');
  let writtenAs;
  if (deferRewrite) {
    // Reserve the name now (so nothing else takes it), write the text later.
    writtenAs = ctx.zip.reservePath(ctx.root + '/' + zipPathForUrl(resource.url));
    ctx.deferred.push({
      name: writtenAs,
      kind: kind === 'style' ? 'css' : 'html',
      text: String(stored),
      sourceUrl: resource.url
    });
  } else {
    writtenAs = await ctx.zip.add(ctx.root + '/' + zipPathForUrl(resource.url), stored, {
      store: !isText && isAlreadyCompressed(resource.url, body.contentType)
    });
  }
  const archivePath = writtenAs.slice(ctx.root.length + 1);
  ctx.storedResources.set(resource.url, archivePath);
  stats.files++;
  stats.bytes += body.bytes.length;
  stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
  ctx.manifestRows.push({
    url: resource.url,
    kind,
    size: body.bytes.length,
    path: archivePath,
    origins: resource.origins || []
  });

  if (options.sourceMaps && text && (kind === 'script' || kind === 'style')) {
    try {
      const extracted = await extractOriginalSources(ctx.fetchText, resource.url, text);
      if (extracted) {
        stats.maps++;
        if (extracted.error) stats.failures.push({ url: extracted.mapUrl, error: extracted.error });
        for (const file of extracted.files) {
          const key = file.path + '|' + file.content.length;
          if (ctx.sourceSeen.has(key)) continue;
          ctx.sourceSeen.add(key);
          await ctx.zip.add(ctx.root + '/src/' + file.path, file.content);
          stats.sourceFiles++;
          stats.files++;
        }
      }
    } catch (err) {
      stats.failures.push({ url: resource.url, error: 'source map: ' + err.message });
    }
  }

  // A stylesheet points at fonts and images of its own.
  if (text && kind === 'style' && options.followCssUrls) {
    const nested = cssUrlReferences(text, resource.url).filter((url) => {
      if (ctx.storedResources.has(url)) return false;
      const nestedKind = kindOf(url, '');
      return options.includeAssets || !['image', 'font', 'media'].includes(nestedKind);
    });
    await forEachPooled(nested, options.concurrency, (url) =>
      addResource(ctx, { url, kind: kindOf(url, ''), origins: ['css url() in ' + archivePath] })
    );
  }

  return archivePath;
}

/**
 * @param {object} config
 * @param {number} config.tabId          tab to inspect
 * @param {object} [config.options]      see DEFAULT_OPTIONS
 * @param {function} [config.onProgress] ({ message, done, total }) => void
 * @param {function} [config.getBody]    async (url) => { bytes, contentType } | null
 *                                       (the DevTools panel passes recorded
 *                                       response bodies here, which covers
 *                                       XHR/API responses a refetch would miss)
 */
export async function captureSite(config) {
  const onProgress = config.onProgress || (() => {});
  onProgress({ message: 'Taking inventory of the page…', done: 0, total: 1 });

  const frames = (
    await chrome.scripting.executeScript({
      target: { tabId: config.tabId, allFrames: true },
      func: pageInventoryRunner
    })
  )
    .map((entry) => entry.result)
    .filter(Boolean);

  if (!frames.length) throw new Error('This page cannot be read (browser pages and the extension store are off limits).');

  const top = frames.find((frame) => frame.isTopFrame) || frames[0];

  // One context, shared by every step below — the same one site capture uses.
  const ctx = createCapture({
    primaryUrl: top.url,
    options: config.options,
    onProgress,
    getBody: config.getBody,
    signal: config.signal
  });
  const { options, stats } = ctx;

  const resources = new Map();
  frames.forEach((frame) => {
    frame.resources.forEach((resource) => {
      const existing = resources.get(resource.url);
      if (existing) {
        resource.origins.forEach((origin) => {
          if (!existing.origins.includes(origin)) existing.origins.push(origin);
        });
        return;
      }
      resources.set(resource.url, Object.assign({}, resource));
    });
  });

  const skippedKinds = options.includeAssets ? new Set() : new Set(['image', 'font', 'media']);
  const queue = Array.from(resources.values()).filter((resource) => !skippedKinds.has(resource.kind));

  // 1. The page itself, as rendered and as served. Both are held back so the
  //    rewrite pass can repoint them at the files next to them.
  const renderedHtml = options.prettyPrint ? formatByKind('html', top.renderedHtml) : top.renderedHtml;
  const renderedName = ctx.zip.reservePath(ctx.root + '/rendered-page.html');
  ctx.deferred.push({ name: renderedName, kind: 'html', text: renderedHtml, sourceUrl: top.url });
  stats.files++;
  ctx.pages.push({ url: top.url, title: top.title || '', path: 'rendered-page.html', mode: 'rendered', status: 'captured' });

  try {
    const original = await ctx.fetchBody(top.url);
    const originalText = decodeText(original.bytes);
    const originalName = ctx.zip.reservePath(ctx.root + '/original-page.html');
    ctx.deferred.push({
      name: originalName,
      kind: 'html',
      text: options.prettyPrint ? formatByKind('html', originalText) : originalText,
      sourceUrl: top.url
    });
    stats.files++;
  } catch (err) {
    stats.failures.push({ url: top.url, error: 'original HTML: ' + err.message });
  }

  // 2. Inline <script> blocks, which have no URL of their own.
  let inlineIndex = 0;
  frames.forEach((frame) => {
    frame.inlineScripts.forEach((script) => {
      inlineIndex++;
      const isJson = script.type.includes('json');
      const name =
        ctx.root + '/inline-scripts/inline-' + inlineIndex + (script.id ? '-' + script.id : '') + (isJson ? '.json' : '.js');
      const body = options.prettyPrint ? formatByKind(isJson ? 'json' : 'js', script.text) : script.text;
      ctx.zip.add(name, body);
      stats.files++;
    });
  });

  // 3. The stylesheet the CSS collector builds (includes shadow DOM + iframes).
  try {
    const cssFrames = (
      await chrome.scripting.executeScript({
        target: { tabId: config.tabId, allFrames: true },
        func: cssCopierRunner,
        args: [
          {
            mode: 'collect',
            options: {
              usedOnly: options.usedCssOnly,
              includeInlineAttributes: options.includeInlineAttributes
            }
          }
        ]
      })
    )
      .map((entry) => entry.result)
      .filter(Boolean);

    const css = cssFrames
      .flatMap((frame) =>
        frame.blocks.map(
          (block) =>
            '/* ===== ' + block.label + ' ===== */\n\n' +
            (block.media ? '@media ' + block.media + ' {\n' + block.css + '\n}' : block.css)
        )
      )
      .join('\n\n\n');
    if (css.trim()) {
      await ctx.zip.add(ctx.root + '/collected.css', css + '\n');
      stats.files++;
    }
  } catch (err) {
    stats.failures.push({ url: top.url, error: 'CSS collection: ' + err.message });
  }

  // 4. Every resource the page uses, a few at a time.
  let done = 0;
  await forEachPooled(
    queue,
    options.concurrency,
    async (resource) => {
      done++;
      onProgress({
        message: 'Downloading ' + resource.url.split('/').pop().slice(0, 40),
        done,
        total: queue.length
      });
      await addResource(ctx, resource);
    },
    ctx.signal
  );

  if (ctx.signal && ctx.signal.aborted) {
    stats.stopped = { after: done, of: queue.length };
  }

  // Stable order in the report, whatever order the downloads finished in.
  ctx.manifestRows.sort((a, b) => a.path.localeCompare(b.path));

  // 5. A report that says what was captured and what cannot be captured at all.
  onProgress({ message: 'Writing the archive…', done: queue.length, total: queue.length });
  const result = await finishCapture(ctx, {
    primaryUrl: top.url,
    report: buildReport({ top, stats, manifestRows: ctx.manifestRows, options, frames })
  });
  return Object.assign(result, { resourceCount: queue.length });
}

/** Writes the report, the inventory and the page index, then seals the archive. */
export async function finishCapture(ctx, meta) {
  await flushDeferred(ctx);
  const report = meta && meta.mode === 'site' ? buildSiteReport(ctx, meta) : meta.report;
  await ctx.zip.add(ctx.root + '/README.md', report);
  await ctx.zip.add(
    ctx.root + '/inventory.json',
    JSON.stringify(
      {
        url: meta.primaryUrl,
        capturedAt: new Date().toISOString(),
        pages: ctx.pages,
        resources: ctx.manifestRows
      },
      null,
      2
    )
  );
  if (ctx.pages.length > 1) {
    await ctx.zip.add(ctx.root + '/pages/pages.json', JSON.stringify(ctx.pages, null, 2));
  }
  const blob = await ctx.zip.finish();
  return {
    blob,
    stats: ctx.stats,
    filename: ctx.root + '.zip',
    pages: ctx.pages,
    resourceCount: ctx.manifestRows.length
  };
}

/**
 * Writes the HTML and CSS held back for rewriting, now that every captured URL
 * has a known home in the archive.
 */
async function flushDeferred(ctx) {
  const map = new Map();
  ctx.storedResources.forEach((archivePath, url) => {
    if (archivePath) map.set(url, archivePath);
  });
  ctx.pages.forEach((page) => {
    if (page.path && page.url) map.set(page.url, page.path);
  });
  const lookup = (url) => map.get(url) || null;

  for (const entry of ctx.deferred) {
    const fromPath = entry.name.slice(ctx.root.length + 1);
    let text = entry.text;
    if (ctx.options.rewriteLinks) {
      text =
        entry.kind === 'css'
          ? rewriteCss(text, { baseUrl: entry.sourceUrl, fromPath, lookup })
          : rewriteHtml(text, { pageUrl: entry.sourceUrl, fromPath, lookup });
    }
    await ctx.zip.add(entry.name, text, { preserveName: true });
  }
  ctx.deferred = [];
}

const SERVER_SIDE_NOTE = `## What a browser can never give you

This archive contains everything the server **sent** to the browser. It cannot
contain the code that ran **on** the server to produce it:

- PHP, Ruby, Python, Node, Java or .NET source
- server-side templates (Blade, Twig, ERB, Jinja, Razor, JSP)
- database schemas, queries or contents
- \`.env\` files, API keys, config, cron jobs, server routes

A \`.php\` URL in \`inventory.json\` is the *output* of a PHP script, not the script.
If \`src/\` has content, those are the site's real pre-build sources (TypeScript,
JSX, SCSS, Vue/Svelte), published by the site's own source maps.

The files here remain the copyright of their owners. Use them for study,
debugging, archiving or migration of your own work — not for republishing
someone else's site.
`;

function buildSiteReport(ctx, meta) {
  const { stats, manifestRows, options } = ctx;
  const pages = ctx.pages;
  const captured = pages.filter((page) => page.status === 'captured');

  const pageRows = pages
    .map(
      (page) =>
        '| ' + page.url + ' | ' + (page.path ? '`' + page.path + '`' : '—') + ' | ' + page.mode + ' | ' + page.status +
        (page.error ? ' (' + page.error + ')' : '') + ' |'
    )
    .join('\n');

  const byKind = Object.entries(stats.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => '| ' + kind + ' | ' + count + ' |')
    .join('\n');

  const failures = stats.failures.length
    ? stats.failures.map((failure) => '- `' + failure.url + '` — ' + failure.error).join('\n')
    : '_None._';

  const robots = meta.robots || {};
  const robotsLine =
    robots.status === 'loaded'
      ? 'Read from `' + robots.url + '`. ' + (meta.blockedByRobots || 0) + ' discovered page(s) were excluded by it.'
      : robots.status === 'missing'
        ? 'This site publishes no robots.txt, so nothing was excluded.'
        : 'robots.txt could not be read, so nothing was excluded.';

  return `# Site capture of ${meta.origin}
${stats.stopped ? '\n> **Stopped early.** You pressed Stop; the pages below are what had been captured.\n' : ''}
- **Started from:** ${meta.primaryUrl}
- **Captured:** ${new Date().toISOString()}
- **Pages captured:** ${captured.length} of ${pages.length} selected
- **Files in this archive:** ${stats.files}
- **Downloaded:** ${formatBytes(stats.bytes)}
- **Source maps found:** ${stats.maps} (${stats.sourceFiles} original source files recovered)
- **Options:** pretty-print ${options.prettyPrint ? 'on' : 'off'}, source maps ${options.sourceMaps ? 'on' : 'off'}, binary assets ${options.includeAssets ? 'included' : 'skipped'}, pages ${meta.renderPages ? 'rendered in a background tab' : 'captured as served'}, ${options.concurrency} downloads at a time${stats.unformatted ? ', ' + stats.unformatted + ' file(s) left unformatted for being over ' + formatBytes(options.maxFormatBytes) : ''}

## robots.txt

${robotsLine}

## Pages

Each page's HTML is under \`pages/\`. Assets shared between pages are stored once
in \`files/\`, so the archive does not repeat a stylesheet fifty times.

${options.rewriteLinks
  ? 'Links were **rewritten for offline browsing**: every URL that was captured now points at its file in this archive, so you can open a page straight from disk. Anything that was *not* captured keeps its original address and still needs the internet.'
  : 'Links were **not** rewritten — they still point at the live site.'}

| Page | File | How | Result |
| --- | --- | --- | --- |
${pageRows || '| — | — | — | — |'}

## Layout

| Path | What it is |
| --- | --- |
| \`pages/\` | One HTML file per captured page, plus \`pages.json\` |
| \`collected.css\` | Every CSS rule in play on the page you started from, shadow DOM and iframes included |
| \`inline-scripts/\` | \`<script>\` blocks that have no URL of their own |
| \`files/<host>/…\` | Every downloaded asset, in the site's own folder structure |
| \`src/\` | **Original pre-build sources recovered from source maps** |
| \`inventory.json\` | Every resource and page with its URL, type, size and archive path |

## What is in here, by type

| Type | Files |
| --- | --- |
${byKind || '| — | 0 |'}

## Not captured

${failures}

${SERVER_SIDE_NOTE}`;
}

function buildReport({ top, stats, manifestRows, options, frames }) {
  const stoppedNote = stats.stopped
    ? '\n> **Stopped early.** You pressed Stop after ' + stats.stopped.after + ' of ' + stats.stopped.of +
      ' resources. Everything already downloaded is in this archive.\n'
    : '';
  const byKind = Object.entries(stats.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => '| ' + kind + ' | ' + count + ' |')
    .join('\n');

  const failures = stats.failures.length
    ? stats.failures.map((failure) => '- `' + failure.url + '` — ' + failure.error).join('\n')
    : '_None._';

  const biggest = manifestRows
    .slice()
    .sort((a, b) => b.size - a.size)
    .slice(0, 15)
    .map((row) => '| `' + row.path + '` | ' + row.kind + ' | ' + formatBytes(row.size) + ' |')
    .join('\n');

  return `# Capture of ${top.url}
${stoppedNote}
- **Captured:** ${new Date().toISOString()}
- **Page title:** ${top.title || '(none)'}
- **Frames scanned:** ${frames.length}
- **Files in this archive:** ${stats.files}
- **Downloaded:** ${formatBytes(stats.bytes)}
- **Source maps found:** ${stats.maps} (${stats.sourceFiles} original source files recovered)
- **Options:** pretty-print ${options.prettyPrint ? 'on' : 'off'}, source maps ${options.sourceMaps ? 'on' : 'off'}, binary assets ${options.includeAssets ? 'included' : 'skipped'}${options.usedCssOnly ? ', CSS filtered to used rules' : ''}

## Layout

| Path | What it is |
| --- | --- |
| \`rendered-page.html\` | The DOM as the browser built it, after JavaScript ran |
| \`original-page.html\` | The HTML the server actually sent, before scripts touched it |
| \`collected.css\` | Every CSS rule in play, including shadow DOM and iframes |
| \`inline-scripts/\` | \`<script>\` blocks that have no URL of their own |
| \`files/<host>/…\` | Every downloaded asset, in the site's own folder structure |
| \`src/\` | **Original pre-build sources recovered from source maps** |
| \`inventory.json\` | Every resource with its URL, type, size and archive path |

## What is in here, by type

| Type | Files |
| --- | --- |
${byKind || '| — | 0 |'}

## Largest files

| Path | Type | Size |
| --- | --- | --- |
${biggest || '| — | — | — |'}

## Not captured

${failures}

## What a browser can never give you

This archive contains everything the server **sent** to the browser. It cannot
contain the code that ran **on** the server to produce it:

- PHP, Ruby, Python, Node, Java or .NET source
- server-side templates (Blade, Twig, ERB, Jinja, Razor, JSP)
- database schemas, queries or contents
- \`.env\` files, API keys, config, cron jobs, server routes

A \`.php\` URL in \`inventory.json\` is the *output* of a PHP script, not the script.
If \`src/\` has content, those are the site's real pre-build sources (TypeScript,
JSX, SCSS, Vue/Svelte), published by the site's own source maps.

The files here remain the copyright of their owners. Use them for study,
debugging, archiving or migration of your own work — not for republishing
someone else's site.
`;
}
