/**
 * Driving the element picker from an extension context.
 *
 * A page cannot read a cross-origin stylesheet, and the picker runs inside the
 * page, so on its own it would miss every rule served from a CDN. The fix is to
 * fetch those sheets here first — where `host_permissions` apply — and hand the
 * text to the picker, which parses it into constructed stylesheets and matches
 * against it like any other source.
 */

import { elementInspectorRunner } from './element-inspector.js';
import { fetchWithTimeout } from './net.js';

const FETCH_TIMEOUT_MS = 15000;

/** Injected: which stylesheets does this page refuse to let us read? */
export function blockedSheetHrefsRunner() {
  const hrefs = [];
  Array.from(document.styleSheets).forEach((sheet) => {
    try {
      // Touching cssRules is what throws on a cross-origin sheet.
      void sheet.cssRules;
    } catch (err) {
      if (sheet.href) hrefs.push(sheet.href);
    }
  });
  return hrefs;
}

/**
 * Rewrites relative `url()` references against the stylesheet's own URL.
 * Fetched CSS is re-parsed inside the page, where a relative path would
 * otherwise resolve against the page instead of the stylesheet.
 */
export function absolutizeCssUrls(css, baseHref) {
  if (!baseHref) return css;
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, reference) => {
    const trimmed = reference.trim();
    if (!trimmed || /^(data:|blob:|about:|#|https?:|\/\/)/i.test(trimmed)) return match;
    try {
      return 'url(' + quote + new URL(trimmed, baseHref).href + quote + ')';
    } catch (err) {
      return match;
    }
  });
}

/** Every stylesheet the page cannot read, fetched and ready to re-parse. */
export async function fetchExternalCss(tabId) {
  let hrefs = [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: blockedSheetHrefsRunner
    });
    hrefs = Array.from(new Set(results.flatMap((entry) => entry.result || [])));
  } catch (err) {
    return [];
  }

  const fetched = await Promise.all(
    hrefs.map(async (href) => {
      try {
        let response = await fetchWithTimeout(href, { credentials: 'omit' }, FETCH_TIMEOUT_MS);
        if (response.status === 401 || response.status === 403) {
          response = await fetchWithTimeout(href, { credentials: 'include' }, FETCH_TIMEOUT_MS);
        }
        if (!response.ok) return null;
        return { href, css: absolutizeCssUrls(await response.text(), href) };
      } catch (err) {
        return null;
      }
    })
  );

  return fetched.filter(Boolean);
}

/**
 * @param {object} config
 * @param {number} config.tabId
 * @param {'clipboard'|'return'} [config.deliver] 'clipboard' lets the page copy
 *        from inside its own click handler, which is what makes the popup flow
 *        work after the popup has closed.
 * @returns the picked element's payload, or null if the user pressed Esc.
 */
export async function runPicker(config) {
  const externalCss = await fetchExternalCss(config.tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: config.tabId },
    func: elementInspectorRunner,
    args: [{ deliver: config.deliver || 'return', externalCss }]
  });
  return result;
}
