/**
 * Fetches stylesheets the page itself is not allowed to read.
 *
 * A cross-origin <link rel="stylesheet"> without CORS headers throws on
 * `sheet.cssRules`, but the extension's host permissions let the service worker
 * fetch the same URL and hand the text back to the popup.
 */

const MAX_BYTES = 8 * 1024 * 1024;

async function fetchStylesheet(href) {
  try {
    const response = await fetch(href, { credentials: 'omit', cache: 'force-cache' });
    if (!response.ok) {
      return { href, error: 'HTTP ' + response.status + ' ' + response.statusText };
    }
    const css = await response.text();
    if (css.length > MAX_BYTES) {
      return { href, error: 'stylesheet is larger than 8 MB, skipped' };
    }
    return { href, css };
  } catch (err) {
    return { href, error: err && err.message ? err.message : String(err) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'fetch-stylesheets') return false;

  Promise.all((message.hrefs || []).map(fetchStylesheet)).then((results) => {
    sendResponse({ results });
  });

  return true; // keep the message channel open for the async response
});
