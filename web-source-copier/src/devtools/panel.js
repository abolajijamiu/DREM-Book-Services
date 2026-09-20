import { captureSite, kindOf } from '../lib/bundle.js';
import { formatByKind, formatHtml } from '../lib/format.js';
import { extractOriginalSources, findSourceMappingUrl } from '../lib/sourcemap.js';
import { runPicker } from '../lib/picker.js';
import { cssCopierRunner } from '../lib/css-collector.js';

const tabId = chrome.devtools.inspectedWindow.tabId;
const el = (id) => document.getElementById(id);

const ui = {
  list: el('list'),
  empty: el('empty'),
  search: el('search'),
  kind: el('kind'),
  status: el('status'),
  statusbar: document.querySelector('.statusbar'),
  viewerTitle: el('viewerTitle'),
  viewerMeta: el('viewerMeta'),
  viewerBody: el('viewerBody'),
  copyFile: el('copyFile'),
  saveFile: el('saveFile'),
  unmap: el('unmap'),
  progress: el('progress'),
  progressBar: el('progressBar'),
  optPretty: el('optPretty'),
  optSourceMaps: el('optSourceMaps'),
  optAssets: el('optAssets')
};

/** url -> { url, kind, mimeType, size, status, method, entry } */
const captured = new Map();
let selected = null;
let selectedText = null;

function setStatus(text, isError) {
  ui.status.textContent = text;
  ui.statusbar.classList.toggle('error', Boolean(isError));
}

function formatBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function nameOf(url) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return (last || parsed.hostname) + (parsed.search ? parsed.search.slice(0, 24) : '');
  } catch (err) {
    return url.slice(0, 60);
  }
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Response body straight from the DevTools recording — no refetch. */
function bodyOf(record) {
  return new Promise((resolve) => {
    if (!record || !record.entry || typeof record.entry.getContent !== 'function') return resolve(null);
    try {
      record.entry.getContent((content, encoding) => {
        if (content === undefined || content === null) return resolve(null);
        resolve(
          encoding === 'base64'
            ? { bytes: base64ToBytes(content), contentType: record.mimeType, text: null }
            : { bytes: new TextEncoder().encode(content), contentType: record.mimeType, text: content }
        );
      });
    } catch (err) {
      resolve(null);
    }
  });
}

function addEntry(entry) {
  const url = entry.request && entry.request.url;
  if (!url || !/^https?:|^file:/.test(url)) return;
  const mimeType = (entry.response && entry.response.content && entry.response.content.mimeType) || '';
  captured.set(url, {
    url,
    kind: kindOf(url, mimeType),
    mimeType: mimeType.split(';')[0],
    size: (entry.response && (entry.response.content.size || entry.response.bodySize)) || 0,
    status: (entry.response && entry.response.status) || 0,
    method: (entry.request && entry.request.method) || 'GET',
    entry
  });
  renderList();
}

let renderQueued = false;
function renderList() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    drawList();
  });
}

function drawList() {
  const needle = ui.search.value.trim().toLowerCase();
  const kindFilter = ui.kind.value;
  const rows = Array.from(captured.values()).filter((record) => {
    if (kindFilter && record.kind !== kindFilter) return false;
    if (needle && !record.url.toLowerCase().includes(needle)) return false;
    return true;
  });

  ui.list.querySelectorAll('.row').forEach((row) => row.remove());
  ui.empty.hidden = rows.length > 0;
  if (!rows.length) {
    if (captured.size) ui.empty.textContent = 'No resource matches this filter.';
    return;
  }

  const fragment = document.createDocumentFragment();
  rows.forEach((record) => {
    const row = document.createElement('div');
    row.className = 'row' + (selected && selected.url === record.url ? ' is-active' : '');
    row.title = record.url;

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = record.kind;

    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = nameOf(record.url);

    const meta = document.createElement('span');
    meta.className = 'row-meta';
    meta.textContent = (record.status && record.status !== 200 ? record.status + ' · ' : '') + formatBytes(record.size);

    row.append(tag, name, meta);
    row.addEventListener('click', () => select(record));
    fragment.appendChild(row);
  });
  ui.list.appendChild(fragment);
  setStatus(captured.size + ' resources captured · showing ' + rows.length);
}

const TEXT_KINDS = new Set(['script', 'style', 'document', 'data']);

async function select(record) {
  selected = record;
  selectedText = null;
  drawList();
  ui.viewerTitle.textContent = nameOf(record.url);
  ui.viewerMeta.textContent = record.method + ' ' + (record.status || '') + ' · ' + (record.mimeType || record.kind) + ' · ' + formatBytes(record.size) + ' · ' + record.url;
  ui.viewerBody.textContent = 'Loading…';
  ui.unmap.hidden = true;
  ui.copyFile.disabled = true;
  ui.saveFile.disabled = true;

  const body = await bodyOf(record);
  if (!body) {
    ui.viewerBody.textContent =
      'The recorded body is no longer available.\n\nReload the page with this panel open to capture it, or use "Export capture (.zip)", which refetches by URL.';
    return;
  }

  ui.saveFile.disabled = false;
  if (!TEXT_KINDS.has(record.kind)) {
    ui.viewerBody.textContent = '(binary ' + record.kind + ', ' + formatBytes(body.bytes.length) + ')\n\nUse Save to write it to disk, or include it in a ZIP export.';
    return;
  }

  const text = body.text !== null && body.text !== undefined ? body.text : new TextDecoder().decode(body.bytes);
  const formatKind =
    record.kind === 'script' ? 'js' :
    record.kind === 'style' ? 'css' :
    record.kind === 'document' ? 'html' :
    /json|manifest|map$/i.test(record.mimeType + record.url) ? 'json' : null;

  selectedText = ui.optPretty.checked && formatKind ? formatByKind(formatKind, text) : text;
  ui.viewerBody.textContent = selectedText.slice(0, 500000);
  ui.copyFile.disabled = false;

  if (findSourceMappingUrl(text) && (record.kind === 'script' || record.kind === 'style')) {
    ui.unmap.hidden = false;
    ui.unmap.onclick = () => recoverSources(record, text);
  }
}

async function fetchText(url) {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.text();
}

async function recoverSources(record, text) {
  setStatus('Reading the source map…');
  try {
    const result = await extractOriginalSources(fetchText, record.url, text);
    if (!result || !result.files.length) {
      setStatus(result && result.error ? result.error : 'That map carries no embedded sources.', true);
      return;
    }

    ui.viewerTitle.textContent = result.files.length + ' original sources from ' + nameOf(record.url);
    ui.viewerMeta.textContent = result.mapUrl;
    ui.viewerBody.textContent = '';

    const list = document.createElement('ul');
    list.className = 'source-list';
    result.files.forEach((file) => {
      const item = document.createElement('li');
      item.textContent = file.path + '  (' + formatBytes(file.content.length) + ')';
      item.addEventListener('click', () => {
        selectedText = file.content;
        ui.viewerTitle.textContent = file.path;
        ui.viewerMeta.textContent = 'recovered from ' + result.mapUrl;
        ui.viewerBody.textContent = file.content.slice(0, 500000);
        ui.copyFile.disabled = false;
        ui.saveFile.disabled = false;
        selected = { url: file.path, kind: 'script', mimeType: 'text/plain' };
      });
      list.appendChild(item);
    });
    ui.viewerBody.appendChild(list);
    setStatus(result.files.length + ' original sources recovered' + (result.missing.length ? ' (' + result.missing.length + ' had no embedded content)' : ''));
  } catch (err) {
    setStatus('Source map failed: ' + err.message, true);
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

async function copyText(text) {
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

/* ---------------------------------------------------------------- actions */

ui.copyFile.addEventListener('click', async () => {
  if (selectedText === null) return;
  setStatus((await copyText(selectedText)) ? 'Copied to clipboard.' : 'Clipboard refused the write.', selectedText === null);
});

ui.saveFile.addEventListener('click', async () => {
  if (!selected) return;
  if (selectedText !== null) {
    saveBlob(new Blob([selectedText], { type: 'text/plain' }), nameOf(selected.url) || 'file.txt');
    return;
  }
  const body = await bodyOf(selected);
  if (!body) return setStatus('That body is no longer available.', true);
  saveBlob(new Blob([body.bytes], { type: selected.mimeType || 'application/octet-stream' }), nameOf(selected.url));
});

el('exportZip').addEventListener('click', async () => {
  const button = el('exportZip');
  button.disabled = true;
  ui.progress.hidden = false;

  try {
    const { blob, stats, filename, resourceCount } = await captureSite({
      tabId,
      options: {
        prettyPrint: ui.optPretty.checked,
        sourceMaps: ui.optSourceMaps.checked,
        includeAssets: ui.optAssets.checked
      },
      // Recorded bodies first: this is how XHR/API responses make it in.
      getBody: async (url) => {
        const record = captured.get(url);
        return record ? await bodyOf(record) : null;
      },
      onProgress: ({ message, done, total }) => {
        setStatus(message);
        ui.progressBar.style.width = Math.max(2, Math.round((done / Math.max(1, total)) * 100)) + '%';
      }
    });

    saveBlob(blob, filename);
    setStatus(
      'Saved ' + filename + ' — ' + stats.files + ' files from ' + resourceCount + ' resources' +
        (stats.sourceFiles ? ', ' + stats.sourceFiles + ' original sources recovered' : '') +
        (stats.failures.length ? ', ' + stats.failures.length + ' failed (see README.md)' : '') + '.'
    );
  } catch (err) {
    setStatus('Export failed: ' + err.message, true);
  } finally {
    button.disabled = false;
    ui.progressBar.style.width = '100%';
    setTimeout(() => {
      ui.progress.hidden = true;
      ui.progressBar.style.width = '0';
    }, 1200);
  }
});

el('pickElement').addEventListener('click', async () => {
  setStatus('Click an element in the page (Esc cancels)…');
  try {
    const result = await runPicker({ tabId, deliver: 'return' });
    if (!result) return setStatus('Picker cancelled.');
    selected = { url: result.selector, kind: 'style', mimeType: 'text/plain' };
    selectedText = result.text;
    ui.viewerTitle.textContent = result.selector;
    ui.viewerMeta.textContent = 'element HTML + matching CSS';
    ui.viewerBody.textContent = result.text;
    ui.unmap.hidden = true;
    ui.copyFile.disabled = false;
    ui.saveFile.disabled = false;
    setStatus('Picked ' + result.selector);
  } catch (err) {
    setStatus('Picker failed: ' + err.message, true);
  }
});

el('collectCss').addEventListener('click', async () => {
  setStatus('Collecting stylesheets…');
  try {
    const frames = (
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: cssCopierRunner,
        args: [{ mode: 'collect', options: { usedOnly: false, includeInlineAttributes: false } }]
      })
    )
      .map((entry) => entry.result)
      .filter(Boolean);

    const css = frames
      .flatMap((frame) => frame.blocks.map((block) => '/* ===== ' + block.label + ' ===== */\n\n' + block.css))
      .join('\n\n\n');
    selected = { url: 'collected.css', kind: 'style', mimeType: 'text/css' };
    selectedText = css;
    ui.viewerTitle.textContent = 'collected.css';
    ui.viewerMeta.textContent = frames.reduce((sum, frame) => sum + frame.keptRules, 0) + ' rules from ' + frames.length + ' frame(s)';
    ui.viewerBody.textContent = css.slice(0, 500000);
    ui.unmap.hidden = true;
    ui.copyFile.disabled = false;
    ui.saveFile.disabled = false;
    setStatus('CSS collected.');
  } catch (err) {
    setStatus('Could not collect CSS: ' + err.message, true);
  }
});

el('copyHtml').addEventListener('click', async () => {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => '<!doctype html>\n' + document.documentElement.outerHTML
    });
    const html = ui.optPretty.checked ? formatHtml(result) : result;
    selected = { url: 'rendered-page.html', kind: 'document', mimeType: 'text/html' };
    selectedText = html;
    ui.viewerTitle.textContent = 'rendered-page.html';
    ui.viewerMeta.textContent = 'the DOM as the browser built it';
    ui.viewerBody.textContent = html.slice(0, 500000);
    ui.unmap.hidden = true;
    ui.copyFile.disabled = false;
    ui.saveFile.disabled = false;
    setStatus('Rendered DOM loaded into the viewer.');
  } catch (err) {
    setStatus('Could not read the page: ' + err.message, true);
  }
});

el('reload').addEventListener('click', () => {
  captured.clear();
  drawList();
  chrome.devtools.inspectedWindow.reload({});
  setStatus('Reloading — every request from the first byte will be captured.');
});

el('clear').addEventListener('click', () => {
  captured.clear();
  selected = null;
  selectedText = null;
  ui.viewerTitle.textContent = 'Select a resource';
  ui.viewerMeta.textContent = '';
  ui.viewerBody.textContent = '';
  ui.copyFile.disabled = true;
  ui.saveFile.disabled = true;
  drawList();
  setStatus('Cleared.');
});

ui.search.addEventListener('input', renderList);
ui.kind.addEventListener('change', renderList);

chrome.devtools.network.onRequestFinished.addListener(addEntry);
chrome.devtools.network.getHAR((har) => {
  (har.entries || []).forEach(addEntry);
  drawList();
});
