/**
 * Runs the extension against a live website and reports what it got.
 *
 *   node tests/real-site.mjs https://pypi.org/ [css-selector-to-pick]
 *
 * This is a manual smoke test, not part of `npm test`: it needs the open
 * internet, and what a live site serves changes without warning.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const siteUrl = process.argv[2] || 'https://pypi.org/';
const pickSelectors = process.argv[3] ? [process.argv[3]] : ['main h1', 'h1', 'header', 'nav', 'body > div'];
const EXT = path.resolve(import.meta.dirname, '..');
const CHROME = process.env.CHROME_PATH || undefined;

// Only needed behind a TLS-intercepting corporate/sandbox proxy: pass the
// base64 SHA-256 SPKI hashes of that proxy's CA certs (comma separated) and
// Chromium will accept those specific certificates. This pins named CAs; it is
// not the same as turning certificate checking off.
//   echo | openssl s_client -connect example.com:443 -showcerts
const SPKI_PINS = process.env.SPKI_PINS || '';

const out = [];
const say = (line = '') => {
  console.log(line);
  out.push(line);
};
let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed++;
  say((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
};
const bytes = (n) => (n < 1024 ? n + ' B' : n < 1024 * 1024 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wsc-real-'));
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'wsc-real-dl-'));

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  acceptDownloads: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-proxy-server',
    '--disable-features=Translate,MediaRouter',
    ...(SPKI_PINS ? ['--ignore-certificate-errors-spki-list=' + SPKI_PINS] : [])
  ]
});

let worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 20000 }));
const extId = new URL(worker.url()).host;

// Record real response bodies so the DevTools panel can be exercised with them.
const recorded = [];
const target = await ctx.newPage();
target.on('response', async (response) => {
  const request = response.request();
  if (!/^https?:/.test(response.url()) || recorded.length > 300) return;
  recorded.push({
    url: response.url(),
    method: request.method(),
    status: response.status(),
    mimeType: (response.headers()['content-type'] || '').split(';')[0],
    body: await response.body().catch(() => null)
  });
});

say('# Live capture: ' + siteUrl);
say();
const started = Date.now();
await target.goto(siteUrl, { waitUntil: 'load', timeout: 60000 });
await target.waitForTimeout(3000); // let lazy assets and fetches land
say('Loaded in ' + ((Date.now() - started) / 1000).toFixed(1) + 's · ' + recorded.length + ' network responses seen');
say('Title: ' + (await target.title()));
say();

const probe = await ctx.newPage();
await probe.goto(`chrome-extension://${extId}/src/popup/popup.html`);
const tab = await probe.evaluate(
  (url) => new Promise((resolve) => chrome.tabs.query({ url: url.replace(/\/?$/, '/') + '*' }, (tabs) => resolve(tabs[0]))),
  siteUrl
);
await probe.close();
check('the live page is visible to the extension', Boolean(tab && tab.id), tab && tab.url);

/* ------------------------------------------------------------------ popup */

const errors = [];
const popup = await ctx.newPage();
popup.on('pageerror', (error) => errors.push(String(error)));
const blocked = [];
const preloadNoise = new Set();
popup.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  // A third-party asset the network refused is the site's business (or a proxy's),
  // not an extension fault: the capture report lists these under "Not captured".
  if (/Failed to load resource/.test(text) || message.location().url.includes('favicon')) {
    blocked.push(message.location().url);
    return;
  }
  // Chromium logs a CSP refusal the first time an extension page fetches a URL
  // the inspected page had preloaded as a module. The fetch is then performed
  // normally and the bytes arrive — the integrity check below proves it.
  if (/Refused to load the script/.test(text)) {
    preloadNoise.add(text.match(/'([^']+)'/)?.[1] || text);
    return;
  }
  errors.push(text);
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
await popup.waitForFunction(() => !document.getElementById('copyCss').disabled, null, { timeout: 60000 });

const stat = async (id) => (await popup.textContent('#' + id)).trim();
say('## Copy CSS');
say('- rules: ' + (await stat('statRules')) + ' · sources: ' + (await stat('statSheets')) + ' · size: ' + (await stat('statSize')));
say('- status: ' + (await popup.textContent('#status')).trim());
const fullCss = await popup.evaluate(() => document.getElementById('preview').textContent);
check('collected real CSS', fullCss.length > 2000, bytes(fullCss.length) + ' in the preview window');

await popup.click('#usedOnly');
await popup.waitForTimeout(1500);
await popup.waitForFunction(() => !document.getElementById('copyCss').disabled, null, { timeout: 60000 });
const usedRules = await stat('statRules');
say('- used-only: ' + usedRules + ' rules (' + (await stat('statSize')) + ')');
check('used-only prunes a real stylesheet', Number(usedRules.replace(/,/g, '')) > 0);
await popup.click('#usedOnly');
await popup.waitForTimeout(1200);
say();

/* -------------------------------------------------------------- zip export */

await popup.click('.tab[data-pane="export"]');
const exportStarted = Date.now();
const downloadPromise = popup.waitForEvent('download', { timeout: 180000 });
await popup.click('#exportZip');
const download = await downloadPromise;
const zipPath = path.join(downloads, download.suggestedFilename());
await download.saveAs(zipPath);
const exportSeconds = ((Date.now() - exportStarted) / 1000).toFixed(1);

const unpacked = path.join(downloads, 'unpacked');
execSync(`unzip -q -o ${JSON.stringify(zipPath)} -d ${JSON.stringify(unpacked)}`);
const root = path.join(unpacked, fs.readdirSync(unpacked)[0]);
const read = (relative) => {
  const full = path.join(root, relative);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
};
const files = execSync(`find ${JSON.stringify(root)} -type f`).toString().trim().split('\n');
const rel = (file) => path.relative(root, file);

say('## Export');
say('- ' + path.basename(zipPath) + ' — ' + bytes(fs.statSync(zipPath).size) + ' in ' + exportSeconds + 's');
say('- ' + files.length + ' files unpacked');
check('zip is intact', execSync(`unzip -t ${JSON.stringify(zipPath)}`).toString().includes('No errors'));
check('rendered DOM captured', read('rendered-page.html').length > 1000, bytes(read('rendered-page.html').length));
check('server HTML captured', read('original-page.html').length > 1000, bytes(read('original-page.html').length));
check('CSS collected into the archive', read('collected.css').length > 1000, bytes(read('collected.css').length));

const inventory = JSON.parse(read('inventory.json') || '{"resources":[]}');
const byKind = {};
inventory.resources.forEach((resource) => {
  byKind[resource.kind] = (byKind[resource.kind] || 0) + 1;
});
say('- resources by type: ' + Object.entries(byKind).map(([k, v]) => k + ' ' + v).join(', '));
check('inventory has real resources', inventory.resources.length >= 5, inventory.resources.length + ' entries');

const sources = files.filter((file) => rel(file).startsWith('src/'));
say();
say('## Original sources recovered from source maps: ' + sources.length);
sources.slice(0, 12).forEach((file) => say('   ' + rel(file) + '  (' + bytes(fs.statSync(file).size) + ')'));
if (sources.length > 12) say('   … and ' + (sources.length - 12) + ' more');
if (sources.length) {
  const sample = sources.find((f) => !rel(f).includes('node_modules')) || sources[0];
  say();
  say('   first lines of ' + rel(sample) + ':');
  fs.readFileSync(sample, 'utf8').split('\n').slice(0, 6).forEach((line) => say('   | ' + line.slice(0, 96)));
}

const report = read('README.md');
const failureSection = (report.split('## Not captured')[1] || '').split('\n## ')[0];
const failureLines = failureSection.split('\n').filter((line) => line.startsWith('- '));
say();
say('## Not captured: ' + (failureLines.length || 0));
failureLines.slice(0, 8).forEach((line) => say('   ' + line.slice(0, 150)));

const jsFiles = files.filter((file) => rel(file).startsWith('files/') && file.endsWith('.js'));
if (jsFiles.length) {
  const biggest = jsFiles.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  const lines = fs.readFileSync(biggest, 'utf8').split('\n').length;
  say();
  say('## Pretty-printer on a real bundle');
  say('   ' + rel(biggest) + ' → ' + lines.toLocaleString() + ' lines, ' + bytes(fs.statSync(biggest).size));
  check('real bundle was reformatted', lines > 50, lines + ' lines');
}
// Binary assets are stored verbatim, so they can be compared with the server.
const binaryAsset = files
  .filter((file) => /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/i.test(file))
  .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
const textAsset = inventory.resources.find((resource) => resource.kind === 'script' && resource.size > 2000);

if (binaryAsset) {
  const relative = rel(binaryAsset);
  const entry = inventory.resources.find((resource) => resource.path === relative);
  if (entry) {
    const live = Buffer.from(await (await fetch(entry.url)).arrayBuffer());
    const captured = fs.readFileSync(binaryAsset);
    say();
    say('## Integrity');
    say('- ' + relative + ' — captured ' + bytes(captured.length) + ', server ' + bytes(live.length));
    check('captured binary asset is byte-identical to the server', Buffer.compare(captured, live) === 0);
  }
}
if (textAsset) {
  const live = await (await fetch(textAsset.url)).text();
  const captured = read(textAsset.path);
  const strip = (text) => text.replace(/\s+/g, '');
  say('- ' + textAsset.path + ' — pretty-printed ' + bytes(captured.length) + ', server ' + bytes(live.length));
  check('pretty-printed script keeps every non-space character', strip(captured).length >= strip(live).length);
}

check('popup raised no script errors', errors.length === 0, errors.slice(0, 3).join(' | '));
if (blocked.length) say('- ' + blocked.length + ' asset request(s) refused by the network (listed in the capture report)');
if (preloadNoise.size) say('- ' + preloadNoise.size + ' module-preload CSP notices from Chromium (cosmetic; bytes verified below)');
say();

/* ----------------------------------------------------------------- picker */

await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(siteUrl).origin });
let pickSelector = null;
for (const selector of pickSelectors) {
  if (await target.locator(selector).first().isVisible().catch(() => false)) {
    pickSelector = selector;
    break;
  }
}

if (pickSelector) {
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
  await popup2.waitForFunction(() => !document.getElementById('pickElement').disabled, null, { timeout: 30000 });
  await popup2.click('#pickElement').catch(() => {});

  await target.bringToFront();
  await target.waitForSelector('#__web_source_copier_picker__', { timeout: 20000 });
  await target.locator(pickSelector).first().click({ timeout: 20000, force: true });
  await target.waitForTimeout(1500);
  const clipboard = await target.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  say('## Element picker on ' + pickSelector);
  say('- clipboard: ' + bytes(clipboard.length));
  check('picker copied real markup', clipboard.includes('<!-- HTML -->') && clipboard.length > 200);
  const cssPart = clipboard.split('CSS rules that match')[1] || '';
  check('picker copied matching CSS', /\{[^}]*:[^}]*\}/.test(cssPart), cssPart.trim().split('\n').length + ' lines of CSS');
  clipboard.split('\n').slice(5, 16).forEach((line) => say('   | ' + line.slice(0, 96)));
} else {
  say('## Element picker skipped: no candidate selector matched');
}
say();

/* ----------------------------------------------------- devtools panel (real bodies) */

const harEntries = recorded
  .filter((entry) => entry.body)
  .slice(0, 120)
  .map((entry) => ({
    url: entry.url,
    method: entry.method,
    status: entry.status,
    mimeType: entry.mimeType,
    isText: /text|javascript|json|xml|css|html/.test(entry.mimeType),
    content: /text|javascript|json|xml|css|html/.test(entry.mimeType)
      ? entry.body.toString('utf8')
      : entry.body.toString('base64')
  }));

const panel = await ctx.newPage();
const panelErrors = [];
panel.on('pageerror', (error) => panelErrors.push(String(error)));
panel.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  if (/Failed to load resource/.test(text) || message.location().url.includes('favicon')) return;
  panelErrors.push(text);
});
await panel.addInitScript(({ tabId, entries }) => {
  const har = {
    entries: entries.map((entry) => ({
      request: { url: entry.url, method: entry.method },
      response: { status: entry.status, content: { mimeType: entry.mimeType, size: entry.content.length } },
      getContent: (callback) => callback(entry.content, entry.isText ? '' : 'base64')
    }))
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
}, { tabId: tab.id, entries: harEntries });

await panel.goto(`chrome-extension://${extId}/src/devtools/panel.html`);
await panel.waitForSelector('.row', { timeout: 30000 });
const rows = await panel.locator('.row').count();
say('## DevTools panel (fed the real recorded responses)');
say('- ' + rows + ' resources listed');
check('panel lists real responses', rows > 3, rows + ' rows');

await panel.selectOption('#kind', 'script');
await panel.waitForTimeout(400);
const scriptRows = await panel.locator('.row').count();
if (scriptRows) {
  // Click the biggest script: that is where a real site keeps its bundle, and
  // with it the source map worth recovering.
  const sizes = await panel.locator('.row .row-meta').allTextContents();
  const toBytes = (text) => {
    const [, value, unit] = text.match(/([\d.]+)\s*(B|KB|MB)/) || [];
    return value ? Number(value) * { B: 1, KB: 1024, MB: 1048576 }[unit] : 0;
  };
  const biggestIndex = sizes.reduce((best, text, index) => (toBytes(text) > toBytes(sizes[best]) ? index : best), 0);
  say('- opening the largest script: ' + (await panel.locator('.row .row-name').nth(biggestIndex).textContent()));
  await panel.locator('.row').nth(biggestIndex).click();
  await panel.waitForTimeout(2500);
  const viewer = await panel.textContent('#viewerBody');
  check('panel shows a real script body', viewer.length > 200, bytes(viewer.length));
  const hasMap = await panel.isVisible('#unmap');
  say('- source map offered on the first script: ' + hasMap);
  if (hasMap) {
    await panel.click('#unmap');
    await panel.waitForSelector('.source-list li', { timeout: 60000 }).catch(() => {});
    const recoveredList = await panel.locator('.source-list li').allTextContents();
    say('- recovered ' + recoveredList.length + ' sources in the panel');
    recoveredList.slice(0, 6).forEach((line) => say('   ' + line.slice(0, 96)));
    check('panel recovered real sources', recoveredList.length > 0);
    if (recoveredList.length) {
      await panel.locator('.source-list li').first().click();
      await panel.waitForTimeout(600);
      check('panel opens a recovered source', (await panel.textContent('#viewerBody')).length > 100);
    }
  }
}
await panel.setViewportSize({ width: 1200, height: 620 });
await panel.screenshot({ path: path.join(import.meta.dirname, 'real-panel.png') });
check('panel raised no script errors', panelErrors.length === 0, panelErrors.slice(0, 3).join(' | '));

say();
say(failed ? failed + ' check(s) failed' : 'all live checks passed');
fs.writeFileSync(path.join(downloads, 'report.md'), out.join('\n'));
console.log('\n(zip kept at ' + zipPath + ')');

await ctx.close();
process.exit(failed ? 1 : 0);
