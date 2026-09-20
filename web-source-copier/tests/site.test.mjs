/**
 * Site capture end-to-end: the real popup's "Site" tab, driven against the
 * multi-page fixture (which publishes a robots.txt disallowing /private/).
 *
 *   npm run test:site
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wsc-site-'));
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'wsc-site-dl-'));

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  acceptDownloads: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});

let worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
const extId = new URL(worker.url()).host;

const target = await ctx.newPage();
await target.goto(fixture.url);
await target.waitForTimeout(400);

const probe = await ctx.newPage();
await probe.goto(`chrome-extension://${extId}/src/popup/popup.html`);
const tab = await probe.evaluate(
  (url) => new Promise((resolve) => chrome.tabs.query({ url: url + '*' }, (tabs) => resolve(tabs[0]))),
  fixture.url
);
await probe.close();

const errors = [];
const popup = await ctx.newPage();
popup.on('pageerror', (error) => errors.push(String(error)));
popup.on('console', (message) => {
  if (message.type() === 'error' && !message.location().url.includes('favicon')) errors.push(message.text());
});
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

/* --------------------------------------------------------------- picker */

await popup.click('.tab[data-pane="site"]');
await popup.waitForSelector('.picker-row', { timeout: 20000 });

const rowText = await popup.locator('.picker-row').allTextContents();
check('lists the current page first', rowText[0].includes('/ (home)') && rowText[0].includes('this page'));
check('lists same-site links', rowText.some((t) => t.includes('/about')) && rowText.some((t) => t.includes('/blog/')));
check('keeps a link with a query string', rowText.some((t) => t.includes('/contact?ref=nav')));
check('drops external links and mailto:', !rowText.some((t) => t.includes('example.com') || t.includes('mailto')));
check('collapses a fragment-only duplicate', rowText.filter((t) => t.includes('/about')).length === 1, rowText.join(' | '));

const blockedRow = popup.locator('.picker-row.is-blocked');
check('marks the robots-disallowed page', (await blockedRow.count()) === 1 && (await blockedRow.first().textContent()).includes('/private/secret'));
check('robots-disallowed page cannot be selected', await blockedRow.locator('input').first().isDisabled());
check('status explains robots.txt was read', (await popup.textContent('#status')).includes('robots.txt'));

/* ------------------------------------------------------------ page limit */

await popup.fill('.picker-limit input', '2');
await popup.dispatchEvent('.picker-limit input', 'change');
await popup.click('.picker-controls button:nth-of-type(1)'); // Select first 2
check('limit governs the default selection', (await popup.textContent('#sitePicker button.primary')).includes('Capture 2 pages'));

const checkboxes = popup.locator('.picker-row:not(.is-blocked) input');
await checkboxes.nth(3).check().catch(() => {});
await popup.waitForTimeout(200);
check('refuses to select past the limit', (await popup.textContent('#status')).includes('Raise "Max pages"'));
check('selection stayed at the limit', (await popup.textContent('#sitePicker button.primary')).includes('Capture 2 pages'));

await popup.fill('.picker-limit input', '25');
await popup.dispatchEvent('.picker-limit input', 'change');
await checkboxes.nth(3).check();
await popup.waitForTimeout(200);
check('raising the limit allows more pages', (await popup.textContent('#sitePicker button.primary')).includes('Capture 3 pages'));

/* --------------------------------------------------------- find more pages */

const before = await popup.locator('.picker-row').count();
await popup.click('.picker-controls button:nth-of-type(3)'); // Find more pages
await popup.waitForFunction((count) => document.querySelectorAll('.picker-row').length > count, before, { timeout: 20000 });
const after = await popup.locator('.picker-row').allTextContents();
check('crawling one level deeper finds new pages', after.length > before, before + ' → ' + after.length);
check('the deeper crawl found a linked sub-page', after.some((t) => t.includes('/blog/post-1') || t.includes('/team')), after.join(' | '));

/* ----------------------------------------------------------- the capture */

await popup.click('.picker-controls button:nth-of-type(2)'); // Select none
await popup.locator('.picker-row:not(.is-blocked) input').nth(0).check(); // home (rendered)
for (const wanted of ['/about', '/contact?ref=nav', '/blog/']) {
  const row = popup.locator('.picker-row', { hasText: wanted }).first();
  await row.locator('input').check();
}
check('four pages selected', (await popup.textContent('#sitePicker button.primary')).includes('Capture 4 pages'));

const downloadPromise = popup.waitForEvent('download', { timeout: 120000 });
await popup.click('#sitePicker button.primary');
const download = await downloadPromise;
const zipPath = path.join(downloads, download.suggestedFilename());
await download.saveAs(zipPath);

const unpacked = path.join(downloads, 'unpacked');
execSync(`unzip -q -o ${JSON.stringify(zipPath)} -d ${JSON.stringify(unpacked)}`);
const root = path.join(unpacked, fs.readdirSync(unpacked)[0]);
const read = (relative) => {
  const full = path.join(root, relative);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
};
const listing = execSync(`find ${JSON.stringify(root)} -type f`).toString();

check('archive is intact', execSync(`unzip -t ${JSON.stringify(zipPath)}`).toString().includes('No errors'));
check('home page captured as rendered', read('pages/index.html').includes('class="hero'));
check('about page captured', read('pages/about.html').includes('ABOUT-PAGE-MARKER'));
check('contact page captured under a query-safe name', /CONTACT-PAGE-MARKER/.test(listing ? read(listing.split('\n').map((f) => path.relative(root, f)).find((f) => f.startsWith('pages/contact')) || '') : ''));
check('directory url became index.html', read('pages/blog/index.html').includes('BLOG-INDEX-MARKER'));
check('robots-disallowed page is absent', !listing.includes('secret') && !/SECRET-CONTENT/.test(read('pages/private/secret.html')));

const pagesJson = JSON.parse(read('pages/pages.json') || '[]');
check('pages.json records every page', pagesJson.length === 4 && pagesJson.every((page) => page.status === 'captured'), JSON.stringify(pagesJson.map((p) => [p.url, p.status])));
check('pages.json marks how each was captured', pagesJson[0].mode === 'rendered' && pagesJson.slice(1).every((page) => page.mode === 'served'));

const siteCssCopies = listing.split('\n').filter((line) => line.endsWith('files/127.0.0.1/site.css'));
check('a stylesheet shared by pages is stored once', siteCssCopies.length === 1, siteCssCopies.join(' | '));
check('a page-specific stylesheet is captured', listing.includes('files/127.0.0.1/page.css'));
check('assets referenced from fetched CSS are followed', listing.includes('files/127.0.0.1/logo.png'));
check('collected CSS of the starting page is included', read('collected.css').includes('.external-used'));

const report = read('README.md');
check('report is a site report', report.includes('# Site capture of'));
check('report states the robots.txt outcome', report.includes('robots.txt'));
check('report lists the pages', report.includes('/about') && report.includes('| Page | File | How | Result |'));
check('report keeps the server-side warning', report.includes('PHP'));

const inventory = JSON.parse(read('inventory.json') || '{}');
check('inventory carries the page list', Array.isArray(inventory.pages) && inventory.pages.length === 4);
check('every inventory path resolves', inventory.resources.every((entry) => fs.existsSync(path.join(root, entry.path))));

await popup.setViewportSize({ width: 330, height: 520 });
await popup.screenshot({ path: path.join(import.meta.dirname, 'popup-site.png') });

/* ------------------------------- served vs rendered on a JS-built page */

const captureOnly = async (wanted, rendered) => {
  await popup.click('.picker-controls button:nth-of-type(2)'); // Select none
  await popup.locator('.picker-row', { hasText: wanted }).first().locator('input').check();
  await popup.locator('#sitePicker .check input').setChecked(rendered);
  const pending = popup.waitForEvent('download', { timeout: 120000 });
  await popup.click('#sitePicker button.primary');
  const file = await pending;
  const at = path.join(downloads, (rendered ? 'rendered-' : 'served-') + file.suggestedFilename());
  await file.saveAs(at);
  const into = path.join(downloads, rendered ? 'rendered' : 'served');
  execSync(`unzip -q -o ${JSON.stringify(at)} -d ${JSON.stringify(into)}`);
  const base = path.join(into, fs.readdirSync(into)[0]);
  return fs.readFileSync(path.join(base, 'pages/spa.html'), 'utf8');
};

const servedSpa = await captureOnly('/spa', false);
// The marker also appears in the page's inline script source, so compare what
// the #root element actually holds, not the file as a whole.
const rootContent = (html) => (html.match(/id="root"[^>]*>([^<]*)</) || [])[1] || '';
check('served capture stores the DOM the server sent', rootContent(servedSpa).includes('loading'));
check('served capture leaves JS-built content unbuilt', !rootContent(servedSpa).includes('RENDERED-BY-JAVASCRIPT'));

const renderedSpa = await captureOnly('/spa', true);
check('rendered capture runs the page and keeps what JS built', rootContent(renderedSpa).includes('RENDERED-BY-JAVASCRIPT'), rootContent(renderedSpa));

const openTabs = ctx.pages().filter((page) => page.url().includes('/spa'));
check('the background tab it opened was closed again', openTabs.length === 0, openTabs.map((p) => p.url()).join(', '));

/* --------------------------------------------- the panel mounts it too */

const panel = await ctx.newPage();
const panelErrors = [];
panel.on('pageerror', (error) => panelErrors.push(String(error)));
await panel.addInitScript((activeTabId) => {
  const shim = {
    inspectedWindow: { tabId: activeTabId, reload: () => {} },
    network: { onRequestFinished: { addListener: () => {} }, onNavigated: { addListener: () => {} }, getHAR: (cb) => cb({ entries: [] }) },
    panels: { create: () => {} }
  };
  const patch = () => {
    if (typeof chrome === 'undefined') return false;
    chrome.devtools = shim;
    return true;
  };
  if (!patch()) document.addEventListener('readystatechange', patch, true);
}, tab.id);
await panel.goto(`chrome-extension://${extId}/src/devtools/panel.html`);
await panel.click('#captureSite');
await panel.waitForSelector('#sitePicker .picker-row', { timeout: 20000 });
check('panel shows the same picker', (await panel.locator('#sitePicker .picker-row').count()) > 3);
check('panel picker honours robots.txt too', (await panel.locator('#sitePicker .picker-row.is-blocked').count()) === 1);
check('panel raised no script errors', panelErrors.length === 0, panelErrors.slice(0, 2).join(' | '));

check('popup raised no script errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await ctx.close();
fixture.close();
fs.rmSync(downloads, { recursive: true, force: true });
console.log(failed ? `\n${failed} failing` : '\nall site-capture checks passed');
process.exit(failed ? 1 : 0);
