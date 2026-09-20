/**
 * Site capture: several pages of one site into a single archive.
 *
 * Discovery is deliberately two-step. The pages on offer come from links the
 * current page already contains, so opening the picker costs nothing; going
 * deeper is something you ask for. Nothing is fetched until you have seen the
 * list, and robots.txt is consulted before any of it.
 */

import { createCapture, addResource, finishCapture, shortHash, kindOf } from './bundle.js';
import { scanHtml, pageLinksRunner, normalizePageUrl, sameOrigin } from './html-scan.js';
import { loadRobots, USER_AGENT } from './robots.js';
import { pageInventoryRunner } from './page-inventory.js';
import { cssCopierRunner } from './css-collector.js';
import { formatByKind } from './format.js';

export const SITE_DEFAULTS = {
  maxPages: 25,
  renderPages: false,
  pageLoadTimeoutMs: 20000,
  discoveryFetchLimit: 25
};

/** `pages/docs/en/overview.html` for `https://site.test/docs/en/overview` */
export function pagePathFor(pageUrl) {
  let parsed;
  try {
    parsed = new URL(pageUrl);
  } catch (err) {
    return 'pages/page-' + shortHash(String(pageUrl)) + '.html';
  }
  let path = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  if (!path || path.endsWith('/')) path += 'index';
  if (parsed.search) path += '~' + shortHash(parsed.search);
  if (!/\.html?$/i.test(path)) path += '.html';
  return 'pages/' + path;
}

/**
 * Links on the page you are standing on, plus the robots.txt that governs them.
 * @returns {{ origin, current, robots, pages: Array<{url, title, allowed, reason}> }}
 */
export async function discoverPages(config) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: config.tabId },
    func: pageLinksRunner
  });
  if (!result) throw new Error('This page cannot be read.');

  const robots = await loadRobots(result.origin, config.fetchText, config.userAgent || USER_AGENT);

  const pages = [
    { url: result.url, title: result.title || result.url, allowed: robots.allowed(result.url), current: true }
  ];
  const seen = new Set([result.url]);

  result.links.forEach((link) => {
    if (seen.has(link.url)) return;
    seen.add(link.url);
    pages.push({ url: link.url, title: link.text || link.url, allowed: robots.allowed(link.url) });
  });

  pages.forEach((page) => {
    if (!page.allowed) page.reason = 'blocked by robots.txt';
  });

  return { origin: result.origin, current: result.url, robots, pages };
}

/**
 * One level deeper: fetches the given pages and returns the links they add.
 * Pages already known are not returned again.
 */
export async function expandDiscovery(config) {
  const known = new Set(config.known || []);
  const robots = config.robots;
  const limit = config.fetchLimit || SITE_DEFAULTS.discoveryFetchLimit;
  const found = [];
  const errors = [];

  const sources = (config.urls || []).filter((url) => !robots || robots.allowed(url)).slice(0, limit);

  for (const url of sources) {
    if (config.onProgress) config.onProgress({ message: 'Looking for links on ' + url });
    let html;
    try {
      html = await config.fetchText(url);
    } catch (err) {
      errors.push({ url, error: err.message });
      continue;
    }
    if (!html) continue;

    scanHtml(html, url).links.forEach((link) => {
      const normalized = normalizePageUrl(link, url);
      if (!normalized || known.has(normalized) || !sameOrigin(normalized, config.origin)) return;
      known.add(normalized);
      found.push({
        url: normalized,
        title: normalized,
        allowed: robots ? robots.allowed(normalized) : true,
        reason: robots && !robots.allowed(normalized) ? 'blocked by robots.txt' : undefined
      });
    });
  }

  return { pages: found, errors };
}

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = async () => {
      let tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch (err) {
        return reject(new Error('the tab closed before the page loaded'));
      }
      if (tab.status === 'complete') return setTimeout(resolve, 500); // let late scripts settle
      if (Date.now() - started > timeoutMs) return reject(new Error('page did not finish loading in time'));
      setTimeout(poll, 200);
    };
    poll();
  });
}

/** Loads a page in a background tab and reads it the way the live page is read. */
async function renderPage(url, timeoutMs) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabLoad(tab.id, timeoutMs);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageInventoryRunner
    });
    if (!result) throw new Error('the page could not be read');
    return result;
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch (err) {
      /* already gone */
    }
  }
}

async function collectCssFromTab(tabId, options) {
  const frames = (
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: cssCopierRunner,
      args: [
        {
          mode: 'collect',
          options: { usedOnly: options.usedCssOnly, includeInlineAttributes: options.includeInlineAttributes }
        }
      ]
    })
  )
    .map((entry) => entry.result)
    .filter(Boolean);

  return frames
    .flatMap((frame) =>
      frame.blocks.map(
        (block) =>
          '/* ===== ' + block.label + ' ===== */\n\n' +
          (block.media ? '@media ' + block.media + ' {\n' + block.css + '\n}' : block.css)
      )
    )
    .join('\n\n\n');
}

/**
 * @param {object} config
 * @param {number} config.tabId        the tab the capture started from
 * @param {string[]} config.urls       pages to capture, in order
 * @param {object} [config.robots]     the matcher from discoverPages
 * @param {object} [config.options]    capture options + SITE_DEFAULTS
 */
export async function captureSelectedPages(config) {
  const options = Object.assign({}, SITE_DEFAULTS, config.options || {});
  const onProgress = config.onProgress || (() => {});
  const primaryUrl = config.primaryUrl;
  const urls = (config.urls || []).slice(0, options.maxPages);

  const ctx = createCapture({
    primaryUrl,
    options: Object.assign({}, options, { followCssUrls: true }),
    onProgress,
    getBody: config.getBody
  });

  let blockedByRobots = 0;
  let index = 0;

  for (const url of urls) {
    index++;
    onProgress({ message: 'Page ' + index + ' of ' + urls.length + ': ' + url, done: index - 1, total: urls.length });

    if (config.robots && !config.robots.allowed(url)) {
      blockedByRobots++;
      ctx.pages.push({ url, path: null, mode: '—', status: 'skipped', error: 'blocked by robots.txt' });
      continue;
    }

    const isPrimary = url === primaryUrl;
    let descriptor = null;
    let mode = 'served';

    try {
      if (isPrimary) {
        // The tab is right here, so the page you started from is always the
        // rendered one — shadow DOM, iframes and all.
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: config.tabId },
          func: pageInventoryRunner
        });
        descriptor = result;
        mode = 'rendered';
      } else if (options.renderPages) {
        descriptor = await renderPage(url, options.pageLoadTimeoutMs);
        mode = 'rendered';
      } else {
        const html = await ctx.fetchText(url);
        if (!html) throw new Error('empty response');
        const scanned = scanHtml(html, url);
        descriptor = {
          url,
          title: scanned.title,
          renderedHtml: html,
          resources: scanned.resources,
          inlineScripts: scanned.inlineScripts
        };
      }
    } catch (err) {
      ctx.pages.push({ url, path: null, mode, status: 'failed', error: err.message });
      ctx.stats.failures.push({ url, error: 'page: ' + err.message });
      continue;
    }

    const html = options.prettyPrint ? formatByKind('html', descriptor.renderedHtml) : descriptor.renderedHtml;
    const written = await ctx.zip.add(ctx.root + '/' + pagePathFor(url), html);
    ctx.stats.files++;

    const slug = pagePathFor(url).replace(/^pages\//, '').replace(/\.html?$/i, '');
    (descriptor.inlineScripts || []).forEach((script, scriptIndex) => {
      const isJson = (script.type || '').includes('json');
      const name = ctx.root + '/inline-scripts/' + slug + '/inline-' + (scriptIndex + 1) + (isJson ? '.json' : '.js');
      ctx.zip.add(name, options.prettyPrint ? formatByKind(isJson ? 'json' : 'js', script.text) : script.text);
      ctx.stats.files++;
    });

    let stored = 0;
    const skipKinds = options.includeAssets ? new Set() : new Set(['image', 'font', 'media']);
    for (const resource of descriptor.resources || []) {
      if (skipKinds.has(resource.kind || kindOf(resource.url, ''))) continue;
      const path = await addResource(ctx, resource);
      if (path) stored++;
    }

    ctx.pages.push({
      url,
      title: descriptor.title || '',
      path: written.slice(ctx.root.length + 1),
      mode,
      status: 'captured',
      resources: stored
    });
  }

  // The stylesheet of the page you started from, with everything the CSSOM knows.
  try {
    onProgress({ message: 'Collecting CSS…', done: urls.length, total: urls.length });
    const css = await collectCssFromTab(config.tabId, options);
    if (css.trim()) {
      await ctx.zip.add(ctx.root + '/collected.css', css + '\n');
      ctx.stats.files++;
    }
  } catch (err) {
    ctx.stats.failures.push({ url: primaryUrl, error: 'CSS collection: ' + err.message });
  }

  onProgress({ message: 'Writing the archive…', done: urls.length, total: urls.length });
  return finishCapture(ctx, {
    mode: 'site',
    primaryUrl,
    origin: config.origin || primaryUrl,
    robots: config.robots,
    blockedByRobots,
    renderPages: options.renderPages
  });
}
