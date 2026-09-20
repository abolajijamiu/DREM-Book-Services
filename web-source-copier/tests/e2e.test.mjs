/**
 * End-to-end: loads the unpacked extension into Chromium and drives the real
 * popup and the real DevTools panel against a two-origin fixture site.
 *
 *   npm run test:e2e        (CHROME_PATH=/path/to/chrome to pick a binary)
 *
 * The popup normally targets the active tab, and the panel normally lives
 * inside DevTools; neither is reachable from Playwright directly, so the two
 * host APIs (`chrome.tabs.query`, `chrome.devtools`) are stubbed before the
 * page's own scripts run. Everything below those two seams is the shipped code.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startFixture } from './fixtures/site.mjs';

const EXT = path.resolve(import.meta.dirname, '..');
const CHROME = process.env.CHROME_PATH || undefined;

let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && detail ? '\n      ' + detail : ''));
};

const fixture = startFixture();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wsc-e2e-'));
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'wsc-dl-'));

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  acceptDownloads: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});

let [worker] = ctx.serviceWorkers();
if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(worker.url()).host;
check('extension loads with a service worker', Boolean(extId));

const target = await ctx.newPage();
await target.goto(fixture.url);
await target.waitForTimeout(500); // let the fixture's fetch() land

const probe = await ctx.newPage();
await probe.goto(`chrome-extension://${extId}/src/popup/popup.html`);
const tab = await probe.evaluate(
  (url) => new Promise((resolve) => chrome.tabs.query({ url: url + '*' }, (tabs) => resolve(tabs[0]))),
  fixture.url
);
await probe.close();
check('the fixture page is visible to the extension', Boolean(tab && tab.id));

/* ------------------------------------------------------------------ popup */

const errors = [];
const popup = await ctx.newPage();
popup.on('pageerror', (error) => errors.push('popup: ' + error));
popup.on('console', (message) => message.type() === 'error' && errors.push('popup: ' + message.text()));
await popup.addInitScript((activeTab) => {
  const patch = () => {
    if (typeof chrome === 'undefined' || !chrome.tabs) return false;
    chrome.tabs.query = (query, callback) => (callback ? callback([activeTab]) : Promise.resolve([activeTab]));
    return true;
  };
  if (!patch()) document.addEventListener('readystatechange', patch, true);
}, tab);
await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
await popup.waitForFunction(() => !document.getElementById('copyCss').disabled, null, { timeout: 20000 });

const allCss = await popup.evaluate(() => document.getElementById('preview').textContent);
check('popup collects inline <style>', allCss.includes('.inline-used'));
check('popup collects same-origin stylesheets', allCss.includes('.external-used'));
check('popup collects cross-origin stylesheets', allCss.includes('.remote-used'));
check('popup collects iframe CSS', allCss.includes('.iframe-rule'));

await popup.click('#usedOnly');
await popup.waitForTimeout(800);
await popup.waitForFunction(() => !document.getElementById('copyCss').disabled, null, { timeout: 20000 });
const usedCss = await popup.evaluate(() => document.getElementById('preview').textContent);
check('used-only keeps matching rules', usedCss.includes('.external-used') && usedCss.includes('.remote-used'));
check('used-only drops unmatched rules', !usedCss.includes('.external-unused') && !usedCss.includes('.remote-unused'));
await popup.click('#usedOnly');
await popup.waitForTimeout(600);

await popup.setViewportSize({ width: 330, height: 430 });
await popup.screenshot({ path: path.join(import.meta.dirname, 'popup-copy.png') });

/* ------------------------------------------------------- popup: zip export */

await popup.click('.tab[data-pane="export"]');
// Shorten the fetch guard so the deliberately hung fixture asset resolves fast.
await popup.evaluate(async () => {
  const { DEFAULT_OPTIONS } = await import('../lib/bundle.js');
  DEFAULT_OPTIONS.fetchTimeoutMs = 1500;
});
const downloadPromise = popup.waitForEvent('download', { timeout: 60000 });
await popup.click('#exportZip');
const download = await downloadPromise;
const zipPath = path.join(downloads, download.suggestedFilename());
await download.saveAs(zipPath);
check('export produces a .zip', fs.existsSync(zipPath) && fs.statSync(zipPath).size > 500);

const unpacked = path.join(downloads, 'unpacked');
execSync(`unzip -q -o ${JSON.stringify(zipPath)} -d ${JSON.stringify(unpacked)}`);
const root = path.join(unpacked, fs.readdirSync(unpacked)[0]);
const read = (relative) => {
  const full = path.join(root, relative);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
};
const listing = execSync(`find ${JSON.stringify(root)} -type f`).toString();

check('zip passes unzip -t', execSync(`unzip -t ${JSON.stringify(zipPath)}`).toString().includes('No errors'));
check('zip has the rendered DOM', read('rendered-page.html').includes('class="hero'));
check('zip has the server HTML', read('original-page.html').includes('<title>Fixture site</title>'));
check('zip has the collected CSS', read('collected.css').includes('.external-used'));
check('zip mirrors the site tree', listing.includes('files/127.0.0.1/site.css') && listing.includes('files/127.0.0.1/app.js'));
check('zip captures the cross-origin stylesheet', listing.includes('remote.css'), listing);
check('zip captures binary assets', fs.existsSync(path.join(root, 'files/127.0.0.1/logo.png')));
check('zip captures inline scripts', listing.includes('inline-scripts/'));
check('zip recovers original sources from the map', read('src/demo/src/App.tsx').includes('JSX.Element'));
check('zip recovers scss from the map', read('src/demo/src/styles/theme.scss').includes('$brand'));
check('zip pretty-prints the bundle', read('files/127.0.0.1/app.js').split('\n').length > 4);
check('report names what a browser cannot capture', read('README.md').includes('PHP'));
check('a hung asset is reported as a timeout, not a stall', /never-answers.*timed out/.test(read('README.md')), (read('README.md').split('## Not captured')[1] || '').slice(0, 300));
const inventory = JSON.parse(read('inventory.json') || '{}');
check('inventory lists resources with paths', Array.isArray(inventory.resources) && inventory.resources.some((r) => r.url.endsWith('/app.js')));
check(
  'every inventory path resolves inside the archive',
  inventory.resources.length > 0 && inventory.resources.every((entry) => fs.existsSync(path.join(root, entry.path))),
  inventory.resources.map((entry) => entry.path).join(', ')
);

/* --------------------------------------------------------- the Stop button */

// Give the deliberately hung fixture asset a long leash, so the capture is
// still running when Stop is pressed.
await popup.evaluate(async () => {
  const { DEFAULT_OPTIONS } = await import('../lib/bundle.js');
  DEFAULT_OPTIONS.fetchTimeoutMs = 60000;
});

const stopDownload = popup.waitForEvent('download', { timeout: 30000 });
await popup.click('#exportZip');
await popup.waitForFunction(() => document.getElementById('exportZip').textContent === 'Stop', null, { timeout: 10000 });
check('the export button becomes Stop while running', true);

await popup.waitForTimeout(700);
const stopStarted = Date.now();
await popup.click('#exportZip');
const stoppedFile = await stopDownload;
const stopSeconds = (Date.now() - stopStarted) / 1000;
check('stopping returns an archive promptly', stopSeconds < 10, stopSeconds.toFixed(1) + 's');

const stoppedPath = path.join(downloads, 'stopped-' + stoppedFile.suggestedFilename());
await stoppedFile.saveAs(stoppedPath);
const stoppedDir = path.join(downloads, 'stopped');
execSync(`unzip -q -o ${JSON.stringify(stoppedPath)} -d ${JSON.stringify(stoppedDir)}`);
const stoppedRoot = path.join(stoppedDir, fs.readdirSync(stoppedDir)[0]);
const stoppedReport = fs.readFileSync(path.join(stoppedRoot, 'README.md'), 'utf8');
check('a stopped capture still yields what it had', fs.existsSync(path.join(stoppedRoot, 'rendered-page.html')));
check('the report says it was stopped early', stoppedReport.includes('Stopped early'), stoppedReport.split('\n').slice(0, 4).join(' | '));
check('the button goes back to Export afterwards', (await popup.textContent('#exportZip')) === 'Export capture (.zip)');
check('the status line reports the stop', (await popup.textContent('#status')).includes('Stopped'), await popup.textContent('#status'));

/* ------------------------------------------- offline rewriting, single page */

check('rendered page points at archived assets', /(src|href)="files\/127\.0\.0\.1\//.test(read('rendered-page.html')), (read('rendered-page.html').match(/<link[^>]*>/g) || []).join(' '));
check('a cross-origin stylesheet is repointed too', read('rendered-page.html').includes('files/127.0.0.1/') && !/href="http:\/\/127\.0\.0\.1:8094\/site\.css"/.test(read('rendered-page.html')));

await popup.setViewportSize({ width: 330, height: 460 });
await popup.screenshot({ path: path.join(import.meta.dirname, 'popup-export.png') });
check('popup raised no console errors', errors.length === 0, errors.join('\n      '));

/* ------------------------------------------------------------ devtools panel */

const panelErrors = [];
const panel = await ctx.newPage();
panel.on('pageerror', (error) => panelErrors.push('panel: ' + error));
panel.on('console', (message) => message.type() === 'error' && panelErrors.push('panel: ' + message.text()));

// Stub the devtools host APIs with a recorded HAR. The API JSON body here is
// deliberately different from what the server returns, which proves the export
// uses recorded bodies rather than refetching.
await panel.addInitScript(
  ({ tabId, base }) => {
    const entry = (url, mimeType, content, encoding) => ({
      request: { url, method: 'GET' },
      response: { status: 200, content: { mimeType, size: content.length } },
      getContent: (callback) => callback(content, encoding)
    });
    const har = {
      entries: [
        entry(base + 'app.js', 'application/javascript', 'var app=1;function go(a,b){if(a>b){return a/b}return 0}\n//# sourceMappingURL=app.js.map', ''),
        entry(base + 'api/items.json', 'application/json', '{"items":[{"id":1,"name":"RECORDED-BY-DEVTOOLS"}]}', ''),
        entry(base + 'site.css', 'text/css', '.external-used{border:1px solid black}', ''),
        entry(base + 'logo.png', 'image/png', 'iVBORw0KGgo=', 'base64')
      ]
    };
    const shim = {
      inspectedWindow: { tabId, reload: () => {} },
      network: {
        onRequestFinished: { addListener: () => {} },
        onNavigated: { addListener: () => {} },
        getHAR: (callback) => callback(har)
      },
      panels: { create: () => {} }
    };
    const patch = () => {
      if (typeof chrome === 'undefined') return false;
      chrome.devtools = shim;
      return true;
    };
    if (!patch()) document.addEventListener('readystatechange', patch, true);
  },
  { tabId: tab.id, base: fixture.url }
);

await panel.goto(`chrome-extension://${extId}/src/devtools/panel.html`);
await panel.waitForSelector('.row', { timeout: 15000 });

const rowCount = await panel.locator('.row').count();
check('panel lists recorded requests', rowCount === 4, 'rows: ' + rowCount);

await panel.fill('#search', 'app.js');
await panel.waitForTimeout(300);
check('panel filters by url', (await panel.locator('.row').count()) === 1);
await panel.click('.row');
await panel.waitForFunction(() => document.getElementById('viewerBody').textContent.includes('function go'), null, { timeout: 10000 });
check('panel shows a recorded body', (await panel.textContent('#viewerBody')).includes('function go'));
check('panel pretty-prints the body', (await panel.textContent('#viewerBody')).split('\n').length > 3);
check('panel offers source recovery', await panel.isVisible('#unmap'));

await panel.click('#unmap');
await panel.waitForSelector('.source-list li', { timeout: 15000 });
const sources = await panel.locator('.source-list li').allTextContents();
check('panel recovers original sources', sources.some((line) => line.includes('App.tsx')), sources.join(' | '));
await panel.locator('.source-list li').first().click();
check('panel views a recovered source', (await panel.textContent('#viewerBody')).includes('JSX.Element'));

await panel.fill('#search', '');
await panel.click('#collectCss');
await panel.waitForFunction(() => document.getElementById('viewerBody').textContent.includes('.inline-used'), null, { timeout: 15000 });
check('panel collects page CSS', (await panel.textContent('#viewerBody')).includes('.inline-used'));

// Element picker, driven from the panel: the page is clicked for real.
const pickPromise = panel.click('#pickElement');
await target.bringToFront();
await target.waitForSelector('#__web_source_copier_picker__', { timeout: 15000 });
check('picker overlay appears on the page', await target.isVisible('#__web_source_copier_picker__'));
await target.click('#hero', { position: { x: 6, y: 6 } }); // the div's padding, not its child
await pickPromise;
await panel.waitForFunction(() => document.getElementById('viewerBody').textContent.includes('<!-- HTML -->'), null, { timeout: 15000 });
const picked = await panel.textContent('#viewerBody');
check('picker returns the element HTML', picked.includes('class="hero'));
check('picker returns only matching CSS', picked.includes('.external-used') && !picked.includes('.external-unused'));
check('picker includes cross-origin rules', picked.includes('.remote-used'), picked.slice(0, 600));
check('picker drops unmatched cross-origin rules', !picked.includes('.remote-unused'));
check('picker credits the cross-origin stylesheet', picked.includes('/* from http://127.0.0.1:8095/remote.css */'));
check('picker rebuilds @media wrappers', /@media \(min-width: ?1px\) \{/.test(picked) && picked.includes('.hero-media'));
check('picker nests @supports > @media', /@supports[^\n]*\{\n\s+@media[^\n]*\{/.test(picked), picked.slice(picked.indexOf('@supports'), picked.indexOf('@supports') + 160));
check('picker does not double the opening brace', !/\{\s*\{/.test(picked));
check('picker keeps at-rule groups balanced', (picked.match(/\{/g) || []).length === (picked.match(/\}/g) || []).length);
check('picker prunes unmatched rules inside @media', !picked.includes('.never-there'));
check('picker reports computed styles', picked.includes('computed styles'));
check('picker cleans up its overlay', !(await target.isVisible('#__web_source_copier_picker__')));

const panelDownloadPromise = panel.waitForEvent('download', { timeout: 60000 });
await panel.click('#exportZip');
const panelDownload = await panelDownloadPromise;
const panelZip = path.join(downloads, 'panel-' + panelDownload.suggestedFilename());
await panelDownload.saveAs(panelZip);
const panelUnpacked = path.join(downloads, 'panel-unpacked');
execSync(`unzip -q -o ${JSON.stringify(panelZip)} -d ${JSON.stringify(panelUnpacked)}`);
const panelRoot = path.join(panelUnpacked, fs.readdirSync(panelUnpacked)[0]);
const apiFile = path.join(panelRoot, 'files/127.0.0.1/api/items.json');
check('panel export includes API responses', fs.existsSync(apiFile));
check(
  'panel export prefers recorded bodies over refetching',
  fs.existsSync(apiFile) && fs.readFileSync(apiFile, 'utf8').includes('RECORDED-BY-DEVTOOLS')
);

await panel.setViewportSize({ width: 1100, height: 560 });
await panel.screenshot({ path: path.join(import.meta.dirname, 'panel.png') });
check('panel raised no console errors', panelErrors.length === 0, panelErrors.join('\n      '));

/* ------------------------------------------- popup picker via the worker */

await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:8094' });

const popup2 = await ctx.newPage();
await popup2.addInitScript((activeTab) => {
  const patch = () => {
    if (typeof chrome === 'undefined' || !chrome.tabs) return false;
    chrome.tabs.query = (query, callback) => (callback ? callback([activeTab]) : Promise.resolve([activeTab]));
    return true;
  };
  if (!patch()) document.addEventListener('readystatechange', patch, true);
}, tab);
await popup2.goto(`chrome-extension://${extId}/src/popup/popup.html`);
await popup2.waitForFunction(() => !document.getElementById('pickElement').disabled, null, { timeout: 20000 });
// The popup closes itself once the service worker has taken the picker over.
await popup2.click('#pickElement').catch(() => {});

await target.bringToFront();
await target.waitForSelector('#__web_source_copier_picker__', { timeout: 15000 });
check('popup hands the picker to the service worker', true);
await target.click('#hero', { position: { x: 6, y: 6 } });
await target.waitForFunction(
  () => Array.from(document.body.parentElement.children).some((node) => (node.textContent || '').startsWith('Copied ')),
  null,
  { timeout: 15000 }
);
check('page reports a successful copy', true);

const clipboard = await target.evaluate(() => navigator.clipboard.readText().catch(() => ''));
check('clipboard holds the element HTML', clipboard.includes('id="hero"'), clipboard.slice(0, 200));
check('clipboard holds its cross-origin CSS', clipboard.includes('.remote-used'), clipboard.slice(0, 400));

await ctx.close();
fixture.close();
fs.rmSync(downloads, { recursive: true, force: true });
console.log(failed ? `\n${failed} failing` : '\nall e2e checks passed');
process.exit(failed ? 1 : 0);
