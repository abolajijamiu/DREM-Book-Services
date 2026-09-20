import { cssCopierRunner } from '../lib/css-collector.js';
import { captureSite } from '../lib/bundle.js';
import { formatHtml } from '../lib/format.js';

const el = (id) => document.getElementById(id);
const ui = {
  page: el('page'),
  usedOnly: el('usedOnly'),
  includeInline: el('includeInline'),
  status: el('status'),
  stats: el('stats'),
  statRules: el('statRules'),
  statSheets: el('statSheets'),
  statSize: el('statSize'),
  copyCss: el('copyCss'),
  copyHtml: el('copyHtml'),
  pickElement: el('pickElement'),
  exportZip: el('exportZip'),
  optPretty: el('optPretty'),
  optSourceMaps: el('optSourceMaps'),
  optAssets: el('optAssets'),
  progress: el('progress'),
  progressBar: el('progressBar'),
  previewWrap: el('previewWrap'),
  preview: el('preview')
};

let currentCss = '';
let currentTab = null;
let runToken = 0;

function setStatus(text, isError) {
  ui.status.textContent = text;
  ui.status.classList.toggle('error', Boolean(isError));
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function flash(button, text) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = text;
  setTimeout(() => {
    button.textContent = button.dataset.label;
  }, 1400);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function inject(request, allFrames, func) {
  return chrome.scripting.executeScript({
    target: { tabId: currentTab.id, allFrames: Boolean(allFrames) },
    func: func || cssCopierRunner,
    args: request === undefined ? [] : [request]
  });
}

function indent(text) {
  return text
    .split('\n')
    .map((line) => (line ? '  ' + line : line))
    .join('\n');
}

function serializeCss(frames, notes, options) {
  const seen = new Set();
  const sections = [];
  let blockCount = 0;

  frames.forEach((frame) => {
    const fromIframe = frame.frameUrl && frame.frameUrl !== currentTab.url;
    frame.blocks.forEach((block) => {
      const key = block.label + '\u0000' + block.media + '\u0000' + block.css;
      if (seen.has(key)) return;
      seen.add(key);
      blockCount++;
      let body = block.css;
      if (block.media) body = '@media ' + block.media + ' {\n' + indent(body) + '\n}';
      const heading = fromIframe ? block.label + '   (iframe: ' + frame.frameUrl + ')' : block.label;
      sections.push('/* ' + '='.repeat(66) + '\n   ' + heading + '\n   ' + '='.repeat(66) + ' */\n\n' + body);
    });
  });

  const kept = frames.reduce((sum, frame) => sum + frame.keptRules, 0);
  const dropped = frames.reduce((sum, frame) => sum + frame.droppedRules, 0);
  const header = [
    '/*',
    ' * CSS collected from: ' + currentTab.url,
    ' * Page title:         ' + (currentTab.title || ''),
    ' * Collected:          ' + new Date().toISOString(),
    ' * Mode:               ' + (options.usedOnly ? 'rules used on this page only' : 'every rule'),
    ' * Rules:              ' + kept + (dropped ? ' kept, ' + dropped + ' unused rules dropped' : ''),
    ' * Sources:            ' + blockCount
  ]
    .concat(notes.map((note) => ' * Note:               ' + note))
    .concat([' */', '', ''])
    .join('\n');

  return { css: sections.length ? header + sections.join('\n\n\n') + '\n' : '', rules: kept, sources: blockCount };
}

function fetchBlocked(hrefs) {
  return new Promise((resolve) => {
    if (!hrefs.length) return resolve([]);
    chrome.runtime.sendMessage({ type: 'fetch-stylesheets', hrefs }, (response) => {
      if (chrome.runtime.lastError || !response) return resolve([]);
      resolve(response.results || []);
    });
  });
}

async function collectCss() {
  const token = ++runToken;
  const options = {
    usedOnly: ui.usedOnly.checked,
    includeInlineAttributes: ui.includeInline.checked
  };

  currentCss = '';
  ui.copyCss.disabled = true;
  ui.stats.hidden = true;
  ui.previewWrap.hidden = true;
  setStatus('Collecting stylesheets…');

  let results;
  try {
    results = await inject({ mode: 'collect', options }, true);
  } catch (err) {
    setStatus('Cannot read this page. Browser pages, the extension store and PDF viewers are off limits.', true);
    return;
  }
  if (token !== runToken) return;

  const frames = results.map((entry) => entry.result).filter(Boolean);
  if (!frames.length) {
    setStatus('No stylesheets found on this page.', true);
    return;
  }

  const notes = [];
  const blocked = Array.from(new Set(frames.flatMap((frame) => frame.blockedHrefs)));
  if (blocked.length) {
    setStatus('Fetching ' + blocked.length + ' cross-origin stylesheet(s)…');
    const fetched = await fetchBlocked(blocked);
    if (token !== runToken) return;
    const usable = fetched.filter((entry) => entry.css);
    fetched
      .filter((entry) => entry.error)
      .forEach((entry) => notes.push('could not fetch ' + entry.href + ' (' + entry.error + ')'));

    if (usable.length) {
      try {
        const extra = await inject({ mode: 'filter-external', options, entries: usable }, false);
        if (token !== runToken) return;
        extra.map((entry) => entry.result).filter(Boolean).forEach((frame) => frames.push(frame));
      } catch (err) {
        usable.forEach((entry) => {
          frames.push({
            frameUrl: currentTab.url,
            blocks: [{ label: entry.href, css: entry.css.trim(), media: '' }],
            blockedHrefs: [],
            keptRules: 0,
            droppedRules: 0
          });
        });
      }
    }
  }

  const output = serializeCss(frames, notes, options);
  if (!output.css) {
    setStatus(options.usedOnly ? 'No matching rules are used on this page.' : 'No CSS found on this page.', true);
    return;
  }

  currentCss = output.css;
  ui.statRules.textContent = output.rules.toLocaleString();
  ui.statSheets.textContent = output.sources.toLocaleString();
  ui.statSize.textContent = formatBytes(new Blob([currentCss]).size);
  ui.stats.hidden = false;
  ui.preview.textContent = currentCss.slice(0, 4000);
  ui.previewWrap.hidden = false;
  ui.copyCss.disabled = false;
  setStatus(notes.length ? notes.length + ' stylesheet(s) could not be read — see the header comment.' : 'Ready.');
}

/* ---------------------------------------------------------------- actions */

ui.copyCss.addEventListener('click', async () => {
  flash(ui.copyCss, (await copyToClipboard(currentCss)) ? 'Copied ✓' : 'Copy failed');
});

ui.copyHtml.addEventListener('click', async () => {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      func: () => '<!doctype html>\n' + document.documentElement.outerHTML
    });
    const html = formatHtml(result);
    flash(ui.copyHtml, (await copyToClipboard(html)) ? 'Copied ✓' : 'Copy failed');
    setStatus('Copied the rendered DOM (' + formatBytes(new Blob([html]).size) + ').');
  } catch (err) {
    setStatus('Could not read this page: ' + err.message, true);
  }
});

ui.pickElement.addEventListener('click', () => {
  // The service worker runs the picker: it outlives this popup, which closes as
  // soon as the user clicks the page.
  chrome.runtime.sendMessage({ type: 'start-picker', tabId: currentTab.id }, () => {
    if (chrome.runtime.lastError) {
      setStatus('Could not start the picker: ' + chrome.runtime.lastError.message, true);
      return;
    }
    window.close();
  });
});

ui.exportZip.addEventListener('click', async () => {
  ui.exportZip.disabled = true;
  ui.progress.hidden = false;
  ui.progressBar.style.width = '2%';

  try {
    const { blob, stats, filename, resourceCount } = await captureSite({
      tabId: currentTab.id,
      options: {
        prettyPrint: ui.optPretty.checked,
        sourceMaps: ui.optSourceMaps.checked,
        includeAssets: ui.optAssets.checked,
        usedCssOnly: ui.usedOnly.checked,
        includeInlineAttributes: ui.includeInline.checked
      },
      onProgress: ({ message, done, total }) => {
        setStatus(message);
        ui.progressBar.style.width = Math.max(2, Math.round((done / Math.max(1, total)) * 100)) + '%';
      }
    });

    saveBlob(blob, filename);
    const recovered = stats.sourceFiles ? ', ' + stats.sourceFiles + ' original sources recovered' : '';
    const failed = stats.failures.length ? ', ' + stats.failures.length + ' failed (listed in README.md)' : '';
    setStatus(
      'Saved ' + filename + ' — ' + stats.files + ' files from ' + resourceCount + ' resources' + recovered + failed + '.'
    );
  } catch (err) {
    setStatus('Export failed: ' + err.message, true);
  } finally {
    ui.progressBar.style.width = '100%';
    ui.exportZip.disabled = false;
    setTimeout(() => {
      ui.progress.hidden = true;
      ui.progressBar.style.width = '0';
    }, 1200);
  }
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((other) => other.classList.toggle('is-active', other === tab));
    document.querySelectorAll('.pane').forEach((pane) => {
      pane.classList.toggle('is-active', pane.id === 'pane-' + tab.dataset.pane);
    });
  });
});

ui.usedOnly.addEventListener('change', collectCss);
ui.includeInline.addEventListener('change', collectCss);

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  if (!tab || !tab.url || !/^https?:|^file:/.test(tab.url)) {
    ui.page.textContent = tab && tab.url ? tab.url : '';
    setStatus('Open a normal web page to copy its source.', true);
    ['copyCss', 'copyHtml', 'pickElement', 'exportZip'].forEach((key) => {
      ui[key].disabled = true;
    });
    return;
  }
  ui.page.textContent = tab.url;
  collectCss();
})();
