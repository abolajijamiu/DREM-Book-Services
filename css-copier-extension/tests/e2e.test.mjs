/**
 * End-to-end check: loads the unpacked extension into Chromium, points the popup
 * at a test page served on two origins, and asserts what ends up on the clipboard
 * buffer for both collection modes.
 *
 *   npm install && npm test        (from the extension folder)
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';

const EXT = path.resolve(import.meta.dirname, '..');
// Set CHROME_PATH to use a specific binary; otherwise Playwright's Chromium is used.
const CHROME = process.env.CHROME_PATH || undefined;

const pageHtml = `<!doctype html><html><head>
<link rel="stylesheet" href="/site.css">
<link rel="stylesheet" href="http://127.0.0.1:8095/remote.css">
<style>.inline-used{color:rebeccapurple}.inline-unused{color:red}</style>
</head><body>
<div class="inline-used external-used remote-used">hello</div>
<iframe src="/frame.html"></iframe>
</body></html>`;

const files = {
  '/': ['text/html', pageHtml],
  '/frame.html': ['text/html', '<style>.iframe-rule{color:navy}</style><p class="iframe-rule">f</p>'],
  '/site.css': ['text/css', '.external-used{border:1px solid black}\n.external-unused{border:9px dotted red}'],
};
const main = http.createServer((req, res) => {
  const f = files[req.url.split('?')[0]];
  if (!f) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f[0] });
  res.end(f[1]);
}).listen(8094);
// no CORS headers -> unreadable by the page, fetched by the service worker
const other = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/css' });
  res.end('.remote-used{color:hotpink}\n.remote-unused{color:chartreuse}');
}).listen(8095);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'css-copier-e2e-'));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;

const target = await ctx.newPage();
await target.goto('http://127.0.0.1:8094/');
await target.waitForTimeout(300);

// Find the target tab's id from an extension page.
const probe = await ctx.newPage();
await probe.goto(`chrome-extension://${extId}/src/popup/popup.html`);
const tab = await probe.evaluate(() =>
  new Promise((r) => chrome.tabs.query({ url: 'http://127.0.0.1:8094/*' }, (t) => r(t[0])))
);
await probe.close();

// The real popup targets the active tab; in a test tab that would be itself, so
// pin chrome.tabs.query to the page under test.
const popup = await ctx.newPage();
const errors = [];
popup.on('pageerror', (e) => errors.push(String(e)));
popup.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await popup.addInitScript((t) => {
  const patch = () => {
    if (typeof chrome === 'undefined' || !chrome.tabs) return false;
    chrome.tabs.query = (q, cb) => (cb ? cb([t]) : Promise.resolve([t]));
    return true;
  };
  if (!patch()) document.addEventListener('readystatechange', patch, true);
}, tab);
await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);

await popup.waitForFunction(() => !document.getElementById('copy').disabled, null, { timeout: 15000 });
const css = await popup.evaluate(() => document.getElementById('preview').textContent);
const status = await popup.textContent('#status');
const stats = {
  rules: await popup.textContent('#statRules'),
  sources: await popup.textContent('#statSheets'),
  size: await popup.textContent('#statSize'),
};

const checks = [
  ['header names the page', css.includes('http://127.0.0.1:8094/')],
  ['inline <style> collected', css.includes('.inline-used')],
  ['same-origin stylesheet collected', css.includes('.external-used')],
  ['cross-origin stylesheet collected via worker', css.includes('.remote-used')],
  ['iframe CSS collected', css.includes('.iframe-rule')],
  ['unused rules present in full mode', css.includes('.external-unused')],
  ['no popup errors', errors.length === 0],
];

await popup.setViewportSize({ width: 330, height: 360 });
await popup.screenshot({ path: path.join(import.meta.dirname, 'popup-all-css.png') });

// Now the "used only" mode.
await popup.click('#usedOnly');
await popup.waitForTimeout(1200);
await popup.waitForFunction(() => !document.getElementById('copy').disabled, null, { timeout: 15000 });
const usedCss = await popup.evaluate(() => document.getElementById('preview').textContent);
checks.push(['used-only keeps used rules', usedCss.includes('.external-used') && usedCss.includes('.remote-used')]);
checks.push(['used-only drops unused rules', !usedCss.includes('.external-unused') && !usedCss.includes('.remote-unused')]);
checks.push(['used-only still no errors', errors.length === 0]);
await popup.screenshot({ path: path.join(import.meta.dirname, 'popup-used-only.png') });

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name);
}
console.log('\nstatus:', status, '| stats:', stats);
if (errors.length) console.log('errors:', errors);
console.log('\n--- first 900 chars of collected CSS ---\n' + css.slice(0, 900));

await ctx.close();
main.close();
other.close();
process.exit(failed ? 1 : 0);
