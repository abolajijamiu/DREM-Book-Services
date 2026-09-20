/**
 * Two jobs the page cannot do for itself:
 *
 * 1. fetch stylesheets it is not allowed to read, and
 * 2. start the element picker on the popup's behalf — the popup closes the
 *    moment the user clicks the page, so the injection is owned here instead.
 *
 * A cross-origin <link rel="stylesheet"> without CORS headers throws on
 * `sheet.cssRules`, but the extension's host permissions let the service worker
 * fetch the same URL and hand the text back to the popup.
 */

import { runPicker } from '../lib/picker.js';

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
  if (!message) return false;

  if (message.type === 'fetch-stylesheets') {
    Promise.all((message.hrefs || []).map(fetchStylesheet)).then((results) => {
      sendResponse({ results });
    });
    return true; // keep the message channel open for the async response
  }

  if (message.type === 'start-picker') {
    // Fetch the page's unreadable stylesheets, then hand the picker over to the
    // page: it copies from inside its own click handler and shows its own
    // toast, so nothing here needs to wait for the result.
    runPicker({ tabId: message.tabId, deliver: 'clipboard' }).catch(() => {});
    sendResponse({ started: true });
    return false;
  }

  return false;
});
