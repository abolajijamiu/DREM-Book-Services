/**
 * Rewriting a capture so it browses offline.
 *
 * Every URL that was actually captured is repointed at its file inside the
 * archive; everything else is left absolute, so a link to a page you did not
 * capture still works when you are online. The rewrite is textual — attribute
 * values and `url()` references are replaced in place — so the markup you saved
 * is otherwise byte-for-byte what the site served.
 */

const URL_ATTRIBUTES = ['src', 'href', 'poster', 'data-src', 'data-href', 'data-background'];
const SKIP_VALUE = /^\s*(#|mailto:|tel:|sms:|javascript:|data:|blob:|about:)/i;

/** A path from one file in the archive to another: pages/a.html → files/x/y.css */
export function relativePath(fromPath, toPath) {
  const from = String(fromPath).split('/').slice(0, -1);
  const to = String(toPath).split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  const up = from.length - shared;
  const parts = new Array(up).fill('..').concat(to.slice(shared));
  return parts.join('/');
}

function replaceAttribute(html, attribute, replacer) {
  const pattern = new RegExp('(\\s' + attribute + '\\s*=\\s*)(")([^"]*)"|(\\s' + attribute + "\\s*=\\s*)(')([^']*)'", 'gi');
  return html.replace(pattern, (match, prefixD, quoteD, valueD, prefixS, quoteS, valueS) => {
    const prefix = prefixD || prefixS;
    const quote = quoteD || quoteS;
    const value = prefixD !== undefined ? valueD : valueS;
    const replaced = replacer(value);
    return replaced === null || replaced === undefined ? match : prefix + quote + replaced + quote;
  });
}

/**
 * @param {string} css
 * @param {object} config
 * @param {string} config.baseUrl   where this stylesheet came from
 * @param {string} config.fromPath  where it lives in the archive
 * @param {function} config.lookup  (absoluteUrl) => archivePath | null
 */
export function rewriteCss(css, config) {
  const point = (raw) => {
    const value = String(raw).trim();
    if (!value || SKIP_VALUE.test(value)) return null;
    let absolute;
    try {
      absolute = new URL(value, config.baseUrl).href;
    } catch (err) {
      return null;
    }
    const target = config.lookup(absolute);
    return target ? relativePath(config.fromPath, target) : null;
  };

  return String(css)
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, value) => {
      const replaced = point(value);
      return replaced === null ? match : 'url(' + quote + replaced + quote + ')';
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, value) => {
      const replaced = point(value);
      return replaced === null ? match : '@import ' + quote + replaced + quote;
    });
}

/**
 * @param {string} html
 * @param {object} config
 * @param {string} config.pageUrl   the URL this HTML came from
 * @param {string} config.fromPath  where it lives in the archive
 * @param {function} config.lookup  (absoluteUrl) => archivePath | null
 */
export function rewriteHtml(html, config) {
  const point = (raw) => {
    const value = String(raw).trim();
    if (!value || SKIP_VALUE.test(value)) return null;
    let parsed;
    try {
      parsed = new URL(value, config.pageUrl);
    } catch (err) {
      return null;
    }
    // Pages are keyed without their fragment; put it back on the way out.
    const hash = parsed.hash;
    parsed.hash = '';
    const target = config.lookup(parsed.href);
    if (!target) return null;
    return relativePath(config.fromPath, target) + hash;
  };

  let out = String(html);

  // <base href> would resolve everything against the live site again.
  out = out.replace(/(<base\b[^>]*?)\shref\s*=\s*(['"])([^'"]*)\2/gi, '$1 data-original-href=$2$3$2');

  URL_ATTRIBUTES.forEach((attribute) => {
    out = replaceAttribute(out, attribute, point);
  });

  ['srcset', 'imagesrcset'].forEach((attribute) => {
    out = replaceAttribute(out, attribute, (value) =>
      value
        .split(',')
        .map((candidate) => {
          const parts = candidate.trim().split(/\s+/);
          if (!parts[0]) return candidate.trim();
          const replaced = point(parts[0]);
          return [replaced === null ? parts[0] : replaced].concat(parts.slice(1)).join(' ');
        })
        .join(', ')
    );
  });

  // url() inside <style> blocks and style="" attributes
  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (match, open, body, close) =>
    open + rewriteCss(body, { baseUrl: config.pageUrl, fromPath: config.fromPath, lookup: config.lookup }) + close
  );
  out = replaceAttribute(out, 'style', (value) =>
    value.includes('url(')
      ? rewriteCss(value, { baseUrl: config.pageUrl, fromPath: config.fromPath, lookup: config.lookup })
      : null
  );

  return out;
}

/**
 * Builds the lookup the rewrite pass uses.
 *
 * Exact URL first. Failing that, the same path without its query string: sites
 * routinely load one asset as `/app.js?build=123` while their markup points at
 * plain `/app.js`. The fallback is only used when exactly one captured file
 * shares that path, so two genuinely different `?size=` variants never get
 * confused for one another.
 */
export function buildLookup(entries) {
  const exact = new Map();
  const byPath = new Map();

  entries.forEach(({ url, path }) => {
    if (!url || !path) return;
    exact.set(url, path);
    let key;
    try {
      const parsed = new URL(url);
      key = parsed.origin + parsed.pathname;
    } catch (err) {
      return;
    }
    const known = byPath.get(key);
    if (!known) byPath.set(key, { path, count: 1 });
    else if (known.path !== path) known.count++;
  });

  return (url) => {
    const hit = exact.get(url);
    if (hit) return hit;
    let key;
    try {
      const parsed = new URL(url);
      key = parsed.origin + parsed.pathname;
    } catch (err) {
      return null;
    }
    const candidate = byPath.get(key);
    return candidate && candidate.count === 1 ? candidate.path : null;
  };
}
