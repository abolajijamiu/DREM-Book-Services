/**
 * The page picker behind "Capture site".
 *
 * Mounted by both the popup and the DevTools panel. It lists the pages this
 * site offers, marks the ones robots.txt puts off limits, and hands the chosen
 * ones to the site capture pipeline.
 */

import { discoverPages, expandDiscovery, captureSelectedPages, SITE_DEFAULTS } from '../lib/site.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function shortLabel(url, origin) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    return path === '/' ? '/ (home)' : path;
  } catch (err) {
    return url;
  }
}

/**
 * @param {object} config
 * @param {HTMLElement} config.container  where to render
 * @param {number} config.tabId
 * @param {function} config.setStatus     (text, isError) => void
 * @param {function} config.saveBlob      (blob, filename) => void
 * @param {function} [config.getOptions]  () => capture options from the host UI
 * @param {function} [config.getBody]     recorded-body lookup (DevTools panel)
 * @param {function} [config.onProgress]  ({done,total}) => void
 */
export function mountSitePicker(config) {
  const { container } = config;
  const state = {
    origin: '',
    current: '',
    robots: null,
    pages: [],
    selected: new Set(),
    limit: SITE_DEFAULTS.maxPages,
    renderPages: false,
    rewriteLinks: true,
    busy: false,
    controller: null
  };

  container.innerHTML = '';

  const summary = el('p', 'hint', 'Reading this page’s links…');
  const controls = el('div', 'picker-controls');
  const list = el('div', 'picker-list');
  const footer = el('div', 'picker-footer');
  container.append(summary, controls, list, footer);

  /* ------------------------------------------------------------ controls */

  const limitWrap = el('label', 'picker-limit');
  limitWrap.append(el('span', null, 'Max pages'));
  const limitInput = document.createElement('input');
  limitInput.type = 'number';
  limitInput.min = '1';
  limitInput.max = '500';
  limitInput.value = String(state.limit);
  limitWrap.appendChild(limitInput);

  const fillButton = el('button', null, 'Select first 25');
  const clearButton = el('button', null, 'Select none');
  const moreButton = el('button', null, 'Find more pages');
  controls.append(limitWrap, fillButton, clearButton, moreButton);

  const renderWrap = el('label', 'check picker-render');
  const renderInput = document.createElement('input');
  renderInput.type = 'checkbox';
  renderWrap.append(renderInput, el('span', null, 'Run each page’s JavaScript (slower; needed for app-rendered sites)'));

  const rewriteWrap = el('label', 'check picker-rewrite');
  const rewriteInput = document.createElement('input');
  rewriteInput.type = 'checkbox';
  rewriteInput.checked = true;
  rewriteWrap.append(rewriteInput, el('span', null, 'Rewrite links so the archive browses offline'));

  const captureButton = el('button', 'primary wide', 'Capture 0 pages (.zip)');
  footer.append(renderWrap, rewriteWrap, captureButton);

  /* ------------------------------------------------------------- render */

  function allowedPages() {
    return state.pages.filter((page) => page.allowed);
  }

  function updateCounts() {
    if (state.controller) {
      captureButton.textContent = 'Stop';
      captureButton.classList.remove('primary');
      captureButton.disabled = false;
      return;
    }
    captureButton.classList.add('primary');
    const blocked = state.pages.length - allowedPages().length;
    summary.textContent =
      state.pages.length +
      ' page(s) found on ' +
      state.origin +
      (blocked ? ' · ' + blocked + ' blocked by robots.txt' : '') +
      (state.robots && state.robots.status !== 'loaded' ? ' · no robots.txt published' : '');
    captureButton.textContent = 'Capture ' + state.selected.size + ' page' + (state.selected.size === 1 ? '' : 's') + ' (.zip)';
    captureButton.disabled = state.busy || state.selected.size === 0;
    fillButton.textContent = 'Select first ' + state.limit;
  }

  function renderList() {
    list.innerHTML = '';
    const fragment = document.createDocumentFragment();

    state.pages.forEach((page) => {
      const row = el('label', 'picker-row' + (page.allowed ? '' : ' is-blocked'));
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state.selected.has(page.url);
      box.disabled = !page.allowed || state.busy;
      box.addEventListener('change', () => {
        if (box.checked) {
          if (state.selected.size >= state.limit) {
            box.checked = false;
            config.setStatus('Raise "Max pages" above ' + state.limit + ' to select more.', true);
            return;
          }
          state.selected.add(page.url);
        } else {
          state.selected.delete(page.url);
        }
        updateCounts();
      });

      const text = el('span', 'picker-text');
      text.append(el('strong', null, shortLabel(page.url, state.origin)));
      if (page.current) text.append(el('em', 'picker-tag', 'this page'));
      if (!page.allowed) text.append(el('em', 'picker-tag', 'robots.txt'));
      if (page.title && page.title !== page.url) text.append(el('small', null, page.title));

      row.append(box, text);
      row.title = page.url;
      fragment.appendChild(row);
    });

    list.appendChild(fragment);
    updateCounts();
  }

  function selectFirst(count) {
    state.selected.clear();
    allowedPages()
      .slice(0, count)
      .forEach((page) => state.selected.add(page.url));
    renderList();
  }

  /* ------------------------------------------------------------ actions */

  limitInput.addEventListener('change', () => {
    const value = Math.max(1, Math.min(500, Number(limitInput.value) || SITE_DEFAULTS.maxPages));
    limitInput.value = String(value);
    state.limit = value;
    updateCounts();
  });

  fillButton.addEventListener('click', () => selectFirst(state.limit));
  clearButton.addEventListener('click', () => {
    state.selected.clear();
    renderList();
  });

  renderInput.addEventListener('change', () => {
    state.renderPages = renderInput.checked;
  });

  rewriteInput.addEventListener('change', () => {
    state.rewriteLinks = rewriteInput.checked;
  });

  moreButton.addEventListener('click', async () => {
    if (state.busy) return;
    state.busy = true;
    moreButton.disabled = true;
    config.setStatus('Looking for more pages…');
    try {
      const seeds = state.selected.size ? Array.from(state.selected) : allowedPages().map((page) => page.url);
      const { pages, errors } = await expandDiscovery({
        urls: seeds,
        known: state.pages.map((page) => page.url),
        origin: state.origin,
        robots: state.robots,
        fetchText: config.fetchText,
        onProgress: ({ message }) => config.setStatus(message)
      });
      state.pages = state.pages.concat(pages);
      renderList();
      config.setStatus(
        pages.length
          ? 'Found ' + pages.length + ' more page(s).' + (errors.length ? ' ' + errors.length + ' could not be read.' : '')
          : 'No new pages found from the current selection.'
      );
    } catch (err) {
      config.setStatus('Could not look for more pages: ' + err.message, true);
    } finally {
      state.busy = false;
      moreButton.disabled = false;
      updateCounts();
    }
  });

  captureButton.addEventListener('click', async () => {
    if (state.controller) {
      // Running: this click is Stop. The archive keeps what it already has.
      state.controller.abort();
      config.setStatus('Stopping — saving the pages captured so far…');
      return;
    }
    if (state.busy || !state.selected.size) return;
    state.busy = true;
    state.controller = new AbortController();
    updateCounts();

    // Capture in the order they were discovered, the current page first.
    const urls = state.pages.map((page) => page.url).filter((url) => state.selected.has(url));

    try {
      const result = await captureSelectedPages({
        tabId: config.tabId,
        primaryUrl: state.current,
        origin: state.origin,
        urls,
        robots: state.robots,
        getBody: config.getBody,
        signal: state.controller.signal,
        options: Object.assign({}, config.getOptions ? config.getOptions() : {}, {
          maxPages: state.limit,
          renderPages: state.renderPages,
          rewriteLinks: state.rewriteLinks
        }),
        onProgress: (progress) => {
          config.setStatus(progress.message);
          if (config.onProgress) config.onProgress(progress);
        }
      });

      config.saveBlob(result.blob, result.filename);
      const captured = result.pages.filter((page) => page.status === 'captured').length;
      const failed = result.pages.length - captured;
      config.setStatus(
        (result.stats.stopped ? 'Stopped. Saved ' : 'Saved ') +
          result.filename + ' — ' + captured + ' page(s), ' + result.stats.files + ' files' +
          (result.stats.sourceFiles ? ', ' + result.stats.sourceFiles + ' original sources' : '') +
          (failed ? ', ' + failed + ' page(s) skipped or failed (see README.md)' : '') + '.'
      );
    } catch (err) {
      config.setStatus('Site capture failed: ' + err.message, true);
    } finally {
      state.busy = false;
      state.controller = null;
      updateCounts();
    }
  });

  /* ----------------------------------------------------------- discover */

  (async () => {
    try {
      const discovered = await discoverPages({ tabId: config.tabId, fetchText: config.fetchText });
      state.origin = discovered.origin;
      state.current = discovered.current;
      state.robots = discovered.robots;
      state.pages = discovered.pages;
      selectFirst(state.limit);
      config.setStatus(
        discovered.robots.status === 'loaded'
          ? 'robots.txt read — pages it disallows cannot be selected.'
          : 'This site publishes no robots.txt.'
      );
    } catch (err) {
      summary.textContent = 'Could not read this page: ' + err.message;
      config.setStatus('Could not read this page: ' + err.message, true);
    }
  })();

  return state;
}
