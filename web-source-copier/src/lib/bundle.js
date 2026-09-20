/**
 * The capture pipeline: inventory -> fetch -> source maps -> format -> ZIP.
 *
 * Runs in an extension page (the popup or the DevTools panel), where
 * `host_permissions` allow cross-origin `fetch`, so no content script or
 * message round-trip is needed to read a site's assets.
 */

import { ZipWriter } from './zip.js';
import { formatByKind } from './format.js';
import { extractOriginalSources } from './sourcemap.js';
import { pageInventoryRunner } from './page-inventory.js';
import { fetchWithTimeout } from './net.js';
import { cssCopierRunner } from './css-collector.js';

const TEXT_KINDS = new Set(['script', 'style', 'data', 'document']);

export const DEFAULT_OPTIONS = {
  prettyPrint: true,
  sourceMaps: true,
  includeAssets: true,
  usedCssOnly: false,
  includeInlineAttributes: false,
  maxFileBytes: 12 * 1024 * 1024,
  // One unreachable host must not hold up the whole capture.
  fetchTimeoutMs: 20000
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

function shortHash(text) {
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

async function defaultFetch(url, timeoutMs) {
  const withTimeout = (init) => fetchWithTimeout(url, Object.assign({ redirect: 'follow' }, init), timeoutMs);

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
  const options = Object.assign({}, DEFAULT_OPTIONS, config.options || {});
  const onProgress = config.onProgress || (() => {});
  const fetchBody = async (url) => {
    if (config.getBody) {
      const recorded = await config.getBody(url);
      if (recorded && recorded.bytes) return recorded;
    }
    return defaultFetch(url, options.fetchTimeoutMs);
  };
  const fetchText = async (url) => {
    const result = await fetchBody(url);
    return result ? decodeText(result.bytes) : null;
  };

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

  const zip = new ZipWriter();
  const root = (() => {
    try {
      return new URL(top.url).hostname.replace(/^www\./, '');
    } catch (err) {
      return 'capture';
    }
  })() + '-' + new Date().toISOString().slice(0, 10);

  const stats = { files: 0, bytes: 0, byKind: {}, failures: [], sourceFiles: 0, maps: 0 };
  const sourceSeen = new Set();
  const manifestRows = [];

  // 1. The page itself, as rendered and as served.
  const renderedHtml = options.prettyPrint ? formatByKind('html', top.renderedHtml) : top.renderedHtml;
  await zip.add(root + '/rendered-page.html', renderedHtml);
  stats.files++;

  try {
    const original = await fetchBody(top.url);
    const originalText = decodeText(original.bytes);
    await zip.add(
      root + '/original-page.html',
      options.prettyPrint ? formatByKind('html', originalText) : originalText
    );
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
        root + '/inline-scripts/inline-' + inlineIndex + (script.id ? '-' + script.id : '') + (isJson ? '.json' : '.js');
      const body = options.prettyPrint ? formatByKind(isJson ? 'json' : 'js', script.text) : script.text;
      zip.add(name, body);
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
      await zip.add(root + '/collected.css', css + '\n');
      stats.files++;
    }
  } catch (err) {
    stats.failures.push({ url: top.url, error: 'CSS collection: ' + err.message });
  }

  // 4. Every resource the page uses.
  let done = 0;
  for (const resource of queue) {
    done++;
    onProgress({
      message: 'Downloading ' + resource.url.split('/').pop().slice(0, 40),
      done,
      total: queue.length
    });

    let body;
    try {
      body = await fetchBody(resource.url);
    } catch (err) {
      stats.failures.push({ url: resource.url, error: err.message });
      continue;
    }

    if (body.bytes.length > options.maxFileBytes) {
      stats.failures.push({
        url: resource.url,
        error: 'skipped, ' + formatBytes(body.bytes.length) + ' exceeds the size limit'
      });
      continue;
    }

    const kind = kindOf(resource.url, body.contentType);
    const path = zipPathForUrl(resource.url);
    const isText = TEXT_KINDS.has(kind) && !looksBinary(body.bytes);
    let stored = body.bytes;
    let text = null;

    if (isText) {
      text = decodeText(body.bytes);
      const formatKind = options.prettyPrint ? formatKindFor(kind, resource.url) : null;
      stored = formatKind ? formatByKind(formatKind, text) : text;
    }

    const writtenAs = await zip.add(root + '/' + path, stored);
    stats.files++;
    stats.bytes += body.bytes.length;
    stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
    manifestRows.push({
      url: resource.url,
      kind,
      size: body.bytes.length,
      // Relative to the archive root, so it matches what you see once unzipped.
      path: writtenAs.slice(root.length + 1),
      origins: resource.origins
    });

    // 5. Original sources hiding behind the bundle.
    if (options.sourceMaps && text && (kind === 'script' || kind === 'style')) {
      try {
        const extracted = await extractOriginalSources(fetchText, resource.url, text);
        if (extracted) {
          stats.maps++;
          if (extracted.error) {
            stats.failures.push({ url: extracted.mapUrl, error: extracted.error });
          }
          for (const file of extracted.files) {
            const key = file.path + '|' + file.content.length;
            if (sourceSeen.has(key)) continue;
            sourceSeen.add(key);
            await zip.add(root + '/src/' + file.path, file.content);
            stats.sourceFiles++;
            stats.files++;
          }
        }
      } catch (err) {
        stats.failures.push({ url: resource.url, error: 'source map: ' + err.message });
      }
    }
  }

  // 6. A report that says what was captured and what cannot be captured at all.
  onProgress({ message: 'Writing the archive…', done: queue.length, total: queue.length });
  await zip.add(root + '/README.md', buildReport({ top, stats, manifestRows, options, frames }));
  await zip.add(
    root + '/inventory.json',
    JSON.stringify({ url: top.url, capturedAt: new Date().toISOString(), resources: manifestRows }, null, 2)
  );

  const blob = await zip.finish();
  return { blob, stats, filename: root + '.zip', resourceCount: queue.length };
}

function buildReport({ top, stats, manifestRows, options, frames }) {
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
