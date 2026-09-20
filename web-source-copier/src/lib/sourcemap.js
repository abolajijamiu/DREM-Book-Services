/**
 * Source map handling: this is what recovers the site's *original* files.
 *
 * Production bundles usually ship a `.map` alongside them, and those maps very
 * often carry `sourcesContent` — the pre-build TypeScript, JSX, Vue/Svelte or
 * SCSS, with the project's folder structure intact.
 */

const JS_REF = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)[ \t]*$/m;
const CSS_REF = /\/\*[#@]\s*sourceMappingURL=([^\s'"*]+)\s*\*\//;

export function findSourceMappingUrl(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  // Bundles put the comment last; only scan the tail of very large files.
  const tail = text.length > 200000 ? text.slice(-8000) : text;
  const match = tail.match(JS_REF) || tail.match(CSS_REF);
  return match ? match[1].trim() : null;
}

export function resolveSourceMapUrl(reference, resourceUrl) {
  if (reference.startsWith('data:')) return reference;
  try {
    return new URL(reference, resourceUrl).href;
  } catch (err) {
    return null;
  }
}

function decodeDataUrl(url) {
  const comma = url.indexOf(',');
  if (comma === -1) return null;
  const meta = url.slice(5, comma);
  const body = url.slice(comma + 1);
  if (/;base64/i.test(meta)) {
    const binary = atob(body);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return decodeURIComponent(body);
}

/** Turns `webpack://app/./src/App.vue?vue&type=script` into `app/src/App.vue`. */
export function normalizeSourcePath(rawPath, index) {
  let path = String(rawPath || '').split('?')[0].split('#')[0];
  path = path.replace(/^webpack-internal:\/{2,3}/, '').replace(/^webpack:\/{2,3}/, '');
  path = path.replace(/^[a-z][a-z0-9+.-]*:\/{2,3}/i, '');
  path = path.replace(/^\/+/, '').replace(/(^|\/)\.\//g, '$1').replace(/\.\.\//g, '');
  path = path.replace(/^~/, 'node_modules/');
  if (!path || path.endsWith('/')) path += 'source-' + (index + 1);
  if (!/\.[a-z0-9]+$/i.test(path)) path += '.txt';
  return path;
}

function collectFromMap(map, out, missing) {
  if (map && Array.isArray(map.sections)) {
    map.sections.forEach((section) => collectFromMap(section.map, out, missing));
    return;
  }
  if (!map || !Array.isArray(map.sources)) return;

  const root = map.sourceRoot ? String(map.sourceRoot).replace(/\/?$/, '/') : '';
  map.sources.forEach((source, index) => {
    const content = map.sourcesContent && map.sourcesContent[index];
    const path = normalizeSourcePath(root + source, index);
    if (typeof content === 'string' && content.length) out.push({ path, content });
    else missing.push(path);
  });
}

/**
 * @param fetchText  async (url) => string|null
 * @returns { mapUrl, files: [{path, content}], missing: string[], error? }
 */
export async function extractOriginalSources(fetchText, resourceUrl, text) {
  const reference = findSourceMappingUrl(text);
  if (!reference) return null;

  const mapUrl = resolveSourceMapUrl(reference, resourceUrl);
  if (!mapUrl) return null;

  let raw;
  try {
    raw = mapUrl.startsWith('data:') ? decodeDataUrl(mapUrl) : await fetchText(mapUrl);
  } catch (err) {
    return { mapUrl, files: [], missing: [], error: String(err && err.message ? err.message : err) };
  }
  if (!raw) return { mapUrl, files: [], missing: [], error: 'source map could not be fetched' };

  let map;
  try {
    map = JSON.parse(raw);
  } catch (err) {
    return { mapUrl, files: [], missing: [], error: 'source map is not valid JSON' };
  }

  const files = [];
  const missing = [];
  collectFromMap(map, files, missing);
  return { mapUrl, files, missing };
}
