/**
 * Page-side resource inventory.
 *
 * Like the CSS collector, this function is stringified into the page by
 * `chrome.scripting.executeScript`, so it must stay self-contained.
 *
 * It answers "what files does this page actually consist of?" by combining the
 * Resource Timing API (what the network loaded) with a DOM sweep (what the
 * markup references, including things not fetched yet).
 */
export function pageInventoryRunner() {
  const found = new Map();

  function classify(url, hint) {
    const path = url.split('?')[0].split('#')[0].toLowerCase();
    const ext = (path.match(/\.([a-z0-9]+)$/) || [])[1] || '';
    if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'].includes(ext)) return 'script';
    if (ext === 'css' || ext === 'scss' || ext === 'less') return 'style';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp'].includes(ext)) return 'image';
    if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(ext)) return 'font';
    if (['json', 'webmanifest', 'map'].includes(ext)) return 'data';
    if (['mp4', 'webm', 'ogg', 'mp3', 'wav', 'm4a', 'mov'].includes(ext)) return 'media';
    if (['html', 'htm', 'php', 'asp', 'aspx', 'jsp'].includes(ext)) return 'document';
    if (ext === 'wasm') return 'wasm';
    if (hint === 'css' || hint === 'link') return 'style';
    if (hint === 'script') return 'script';
    if (hint === 'img' || hint === 'image') return 'image';
    if (hint === 'font') return 'font';
    if (hint === 'xmlhttprequest' || hint === 'fetch') return 'data';
    if (hint === 'iframe' || hint === 'frame' || hint === 'document') return 'document';
    if (hint === 'video' || hint === 'audio') return 'media';
    return 'other';
  }

  function add(rawUrl, kind, origin, size) {
    if (!rawUrl) return;
    let absolute;
    try {
      absolute = new URL(rawUrl, document.baseURI).href;
    } catch (err) {
      return;
    }
    if (!/^https?:|^file:/.test(absolute)) return; // skip data:, blob:, javascript:
    const existing = found.get(absolute);
    if (existing) {
      if (!existing.origins.includes(origin)) existing.origins.push(origin);
      if (size && !existing.size) existing.size = size;
      return;
    }
    found.set(absolute, {
      url: absolute,
      kind: kind || classify(absolute, origin),
      origins: [origin],
      size: size || 0
    });
  }

  // 1. What the network actually loaded.
  try {
    performance.getEntriesByType('resource').forEach((entry) => {
      add(entry.name, classify(entry.name, entry.initiatorType), entry.initiatorType,
        entry.decodedBodySize || entry.transferSize || 0);
    });
  } catch (err) {
    /* Resource Timing unavailable */
  }

  // 2. What the markup references.
  document.querySelectorAll('script[src]').forEach((el) => add(el.src, 'script', 'script[src]'));
  document.querySelectorAll('link[href]').forEach((el) => {
    const rel = (el.getAttribute('rel') || '').toLowerCase();
    const kind =
      rel.includes('stylesheet') ? 'style' :
      rel.includes('icon') ? 'image' :
      rel.includes('manifest') ? 'data' : null;
    add(el.href, kind, 'link[rel=' + (rel || '?') + ']');
  });
  document.querySelectorAll('img[src], img[data-src]').forEach((el) => {
    add(el.currentSrc || el.src, 'image', 'img');
    add(el.getAttribute('data-src'), 'image', 'img[data-src]');
  });
  document.querySelectorAll('[srcset]').forEach((el) => {
    (el.getAttribute('srcset') || '').split(',').forEach((candidate) => {
      add(candidate.trim().split(/\s+/)[0], 'image', 'srcset');
    });
  });
  document.querySelectorAll('video, audio, source, track').forEach((el) => {
    add(el.getAttribute('src'), null, el.tagName.toLowerCase());
    add(el.getAttribute('poster'), 'image', 'poster');
  });
  document.querySelectorAll('iframe[src], frame[src]').forEach((el) => add(el.src, 'document', 'iframe'));
  document.querySelectorAll('object[data], embed[src]').forEach((el) =>
    add(el.getAttribute('data') || el.getAttribute('src'), null, 'object')
  );
  document.querySelectorAll('use[href], use[*|href], image[href]').forEach((el) =>
    add(el.getAttribute('href') || el.getAttribute('xlink:href'), 'image', 'svg-use')
  );

  // 3. url() references inside readable stylesheets (fonts and background art
  //    the page may not have requested yet).
  Array.from(document.styleSheets).forEach((sheet) => {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch (err) {
      return;
    }
    const walk = (list) => {
      for (const rule of list) {
        if (rule.cssRules) {
          walk(rule.cssRules);
          continue;
        }
        const text = rule.cssText || '';
        const matches = text.match(/url\((['"]?)([^'")]+)\1\)/g) || [];
        matches.forEach((match) => {
          const ref = match.replace(/^url\((['"]?)/, '').replace(/(['"]?)\)$/, '');
          if (/^data:/.test(ref)) return;
          let absolute = ref;
          try {
            absolute = new URL(ref, sheet.href || document.baseURI).href;
          } catch (err) {
            return;
          }
          add(absolute, null, 'css url()');
        });
      }
    };
    walk(rules);
  });

  // 4. Inline scripts have no URL of their own.
  const inlineScripts = [];
  document.querySelectorAll('script:not([src])').forEach((el, index) => {
    const text = el.textContent || '';
    if (!text.trim()) return;
    const type = (el.type || 'text/javascript').toLowerCase();
    inlineScripts.push({
      index: index + 1,
      type,
      id: el.id || '',
      text
    });
  });

  let serviceWorker = '';
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      serviceWorker = navigator.serviceWorker.controller.scriptURL;
      add(serviceWorker, 'script', 'service worker');
    }
  } catch (err) {
    /* not available in this context */
  }

  return {
    url: location.href,
    title: document.title,
    isTopFrame: window === window.top,
    renderedHtml: '<!doctype html>\n' + document.documentElement.outerHTML,
    inlineScripts,
    serviceWorker,
    resources: Array.from(found.values())
  };
}
