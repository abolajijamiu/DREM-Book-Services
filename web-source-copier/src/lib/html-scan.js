/**
 * Reading a page's markup from the extension side.
 *
 * The live page is scanned in-page by `page-inventory.js`. Pages that site
 * capture merely *fetches* are parsed here with DOMParser instead: it resolves
 * URLs and finds references without executing a single line of the page's
 * JavaScript, and a detached document requests nothing on its own.
 */

/** Absolute, fragment-free, http(s)-only. Returns null for anything else. */
export function normalizePageUrl(candidate, baseUrl) {
  if (!candidate) return null;
  try {
    const url = new URL(candidate, baseUrl);
    if (!/^https?:$/.test(url.protocol)) return null; // mailto:, tel:, javascript:, data:
    url.hash = '';
    return url.href;
  } catch (err) {
    return null;
  }
}

export function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch (err) {
    return false;
  }
}

/** Every `url()` inside a stylesheet, absolute against that stylesheet. */
export function cssUrlReferences(cssText, baseUrl) {
  const found = new Set();
  const pattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let match;
  while ((match = pattern.exec(cssText))) {
    const reference = match[2].trim();
    if (!reference || /^(data:|blob:|about:|#)/i.test(reference)) continue;
    try {
      found.add(new URL(reference, baseUrl).href);
    } catch (err) {
      /* unresolvable reference */
    }
  }
  const importPattern = /@import\s+(?:url\(\s*)?(['"])([^'"]+)\1/gi;
  while ((match = importPattern.exec(cssText))) {
    try {
      found.add(new URL(match[2], baseUrl).href);
    } catch (err) {
      /* unresolvable import */
    }
  }
  return Array.from(found);
}

function classify(url, hint) {
  const path = url.split('?')[0].split('#')[0].toLowerCase();
  const ext = (path.match(/\.([a-z0-9]+)$/) || [])[1] || '';
  if (['js', 'mjs', 'cjs'].includes(ext)) return 'script';
  if (ext === 'css') return 'style';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico'].includes(ext)) return 'image';
  if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(ext)) return 'font';
  if (['json', 'webmanifest', 'map'].includes(ext)) return 'data';
  if (['mp4', 'webm', 'mp3', 'wav', 'ogg'].includes(ext)) return 'media';
  return hint || 'other';
}

/**
 * @param {Document} doc  a parsed (detached) document
 * @param {string} baseUrl  the URL the HTML came from
 * @returns {{ title, resources, links, inlineScripts, inlineStyleUrls }}
 */
export function scanDocument(doc, baseUrl) {
  const base = doc.querySelector('base[href]');
  const documentBase = base ? normalizePageUrl(base.getAttribute('href'), baseUrl) || baseUrl : baseUrl;

  const resources = new Map();
  const add = (candidate, kind, origin) => {
    const url = normalizePageUrl(candidate, documentBase);
    if (!url) return;
    const existing = resources.get(url);
    if (existing) {
      if (!existing.origins.includes(origin)) existing.origins.push(origin);
      return;
    }
    resources.set(url, { url, kind: kind || classify(url, null), origins: [origin] });
  };

  doc.querySelectorAll('script[src]').forEach((el) => add(el.getAttribute('src'), 'script', 'script[src]'));
  doc.querySelectorAll('link[href]').forEach((el) => {
    const rel = (el.getAttribute('rel') || '').toLowerCase();
    if (/alternate|canonical|prev|next|dns-prefetch|preconnect|author|license|search/.test(rel)) return;
    const kind = rel.includes('stylesheet') ? 'style' : rel.includes('icon') ? 'image' : rel.includes('manifest') ? 'data' : null;
    add(el.getAttribute('href'), kind, 'link[rel=' + (rel || '?') + ']');
  });
  doc.querySelectorAll('img[src], img[data-src]').forEach((el) => {
    add(el.getAttribute('src'), 'image', 'img');
    add(el.getAttribute('data-src'), 'image', 'img[data-src]');
  });
  doc.querySelectorAll('[srcset]').forEach((el) => {
    (el.getAttribute('srcset') || '').split(',').forEach((candidate) => add(candidate.trim().split(/\s+/)[0], 'image', 'srcset'));
  });
  doc.querySelectorAll('video, audio, source, track').forEach((el) => {
    add(el.getAttribute('src'), null, el.tagName.toLowerCase());
    add(el.getAttribute('poster'), 'image', 'poster');
  });
  doc.querySelectorAll('object[data], embed[src]').forEach((el) =>
    add(el.getAttribute('data') || el.getAttribute('src'), null, 'object')
  );

  // url() inside <style> blocks and style="" attributes
  doc.querySelectorAll('style').forEach((el) => {
    cssUrlReferences(el.textContent || '', documentBase).forEach((url) => add(url, null, 'style url()'));
  });
  doc.querySelectorAll('[style]').forEach((el) => {
    cssUrlReferences(el.getAttribute('style') || '', documentBase).forEach((url) => add(url, null, 'inline url()'));
  });

  const inlineScripts = [];
  doc.querySelectorAll('script:not([src])').forEach((el, index) => {
    const text = el.textContent || '';
    if (!text.trim()) return;
    inlineScripts.push({ index: index + 1, type: (el.getAttribute('type') || 'text/javascript').toLowerCase(), id: el.id || '', text });
  });

  const links = [];
  const seenLinks = new Set();
  doc.querySelectorAll('a[href], area[href]').forEach((el) => {
    const url = normalizePageUrl(el.getAttribute('href'), documentBase);
    if (!url || seenLinks.has(url) || !sameOrigin(url, baseUrl)) return;
    seenLinks.add(url);
    links.push(url);
  });

  return {
    title: (doc.querySelector('title') || {}).textContent || '',
    resources: Array.from(resources.values()),
    links,
    inlineScripts
  };
}

export function scanHtml(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return scanDocument(doc, baseUrl);
}

/** Injected into the live page to read its links without re-fetching it. */
export function pageLinksRunner() {
  const origin = location.origin;
  const seen = new Set();
  const links = [];
  document.querySelectorAll('a[href], area[href]').forEach((el) => {
    let url;
    try {
      url = new URL(el.getAttribute('href'), document.baseURI);
    } catch (err) {
      return;
    }
    if (!/^https?:$/.test(url.protocol) || url.origin !== origin) return;
    url.hash = '';
    if (seen.has(url.href)) return;
    seen.add(url.href);
    links.push({ url: url.href, text: (el.textContent || '').trim().slice(0, 80) });
  });
  return { url: location.href, origin, title: document.title, links };
}
