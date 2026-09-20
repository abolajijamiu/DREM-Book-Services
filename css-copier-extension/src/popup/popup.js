import { cssCopierRunner } from '../content/collector.js';

const el = {
  page: document.getElementById('page'),
  usedOnly: document.getElementById('usedOnly'),
  includeInline: document.getElementById('includeInline'),
  status: document.getElementById('status'),
  stats: document.getElementById('stats'),
  statRules: document.getElementById('statRules'),
  statSheets: document.getElementById('statSheets'),
  statSize: document.getElementById('statSize'),
  copy: document.getElementById('copy'),
  download: document.getElementById('download'),
  previewWrap: document.getElementById('previewWrap'),
  preview: document.getElementById('preview')
};

let currentCss = '';
let currentTab = null;
let runToken = 0;

function setStatus(text, isError) {
  el.status.textContent = text;
  el.status.classList.toggle('error', Boolean(isError));
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function inject(tab, request, allFrames) {
  return chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: Boolean(allFrames) },
    func: cssCopierRunner,
    args: [request]
  });
}

/** Turn the per-frame collector payloads into one stylesheet. */
function serialize(tab, frames, notes, options) {
  const seen = new Set();
  const sections = [];
  let blockCount = 0;

  frames.forEach((frame) => {
    const fromIframe = frame.frameUrl && frame.frameUrl !== tab.url;
    frame.blocks.forEach((block) => {
      const key = block.label + '\u0000' + block.media + '\u0000' + block.css;
      if (seen.has(key)) return;
      seen.add(key);
      blockCount++;

      let body = block.css;
      if (block.media) {
        body = '@media ' + block.media + ' {\n' + indent(body) + '\n}';
      }
      const heading = fromIframe ? block.label + '   (iframe: ' + frame.frameUrl + ')' : block.label;
      sections.push('/* ' + '='.repeat(66) + '\n   ' + heading + '\n   ' + '='.repeat(66) + ' */\n\n' + body);
    });
  });

  const kept = frames.reduce((sum, frame) => sum + frame.keptRules, 0);
  const dropped = frames.reduce((sum, frame) => sum + frame.droppedRules, 0);

  const header = [
    '/*',
    ' * CSS collected from: ' + tab.url,
    ' * Page title:         ' + (tab.title || ''),
    ' * Collected:          ' + new Date().toISOString(),
    ' * Mode:               ' + (options.usedOnly ? 'rules used on this page only' : 'every rule'),
    ' * Rules:              ' + kept + (dropped ? ' kept, ' + dropped + ' unused rules dropped' : ''),
    ' * Sources:            ' + blockCount
  ]
    .concat(notes.map((note) => ' * Note:               ' + note))
    .concat([' */', '', ''])
    .join('\n');

  return {
    css: sections.length ? header + sections.join('\n\n\n') + '\n' : '',
    rules: kept,
    sources: blockCount
  };
}

function indent(text) {
  return text
    .split('\n')
    .map((line) => (line ? '  ' + line : line))
    .join('\n');
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

async function collect() {
  const token = ++runToken;
  const options = {
    usedOnly: el.usedOnly.checked,
    includeInlineAttributes: el.includeInline.checked
  };

  currentCss = '';
  el.copy.disabled = true;
  el.download.disabled = true;
  el.stats.hidden = true;
  el.previewWrap.hidden = true;
  setStatus('Collecting stylesheets…');

  let results;
  try {
    results = await inject(currentTab, { mode: 'collect', options }, true);
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
        const extra = await inject(
          currentTab,
          { mode: 'filter-external', options, entries: usable },
          false
        );
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

  const output = serialize(currentTab, frames, notes, options);
  if (!output.css) {
    setStatus(options.usedOnly ? 'No matching rules are used on this page.' : 'No CSS found on this page.', true);
    return;
  }

  currentCss = output.css;
  el.statRules.textContent = output.rules.toLocaleString();
  el.statSheets.textContent = output.sources.toLocaleString();
  el.statSize.textContent = formatBytes(new Blob([currentCss]).size);
  el.stats.hidden = false;
  el.preview.textContent = currentCss.slice(0, 4000);
  el.previewWrap.hidden = false;
  el.copy.disabled = false;
  el.download.disabled = false;
  setStatus(notes.length ? notes.length + ' stylesheet(s) could not be read — see the header comment.' : 'Ready.');
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

function filenameFor(url) {
  let host = 'page';
  try {
    host = new URL(url).hostname.replace(/^www\./, '') || 'page';
  } catch (err) {
    /* keep the fallback */
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return host.replace(/[^a-z0-9.-]/gi, '-') + '-' + stamp + '.css';
}

el.copy.addEventListener('click', async () => {
  const ok = await copyToClipboard(currentCss);
  el.copy.textContent = ok ? 'Copied ✓' : 'Copy failed';
  setTimeout(() => {
    el.copy.textContent = 'Copy CSS';
  }, 1400);
});

el.download.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([currentCss], { type: 'text/css' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filenameFor(currentTab.url);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

el.usedOnly.addEventListener('change', collect);
el.includeInline.addEventListener('change', collect);

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  if (!tab || !tab.url || !/^https?:|^file:/.test(tab.url)) {
    el.page.textContent = tab && tab.url ? tab.url : '';
    setStatus('Open a normal web page to collect its CSS.', true);
    return;
  }
  el.page.textContent = tab.url;
  collect();
})();
