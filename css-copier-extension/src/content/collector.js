/**
 * The page-side collector.
 *
 * This whole function is stringified by `chrome.scripting.executeScript({ func })`
 * and re-parsed inside the page, so it must stay self-contained: no imports, no
 * references to anything outside its own body.
 *
 * Two modes:
 *   - "collect"         walk the live document and return its CSS
 *   - "filter-external" parse stylesheet text we had to fetch from the
 *                       background worker (cross-origin sheets the page cannot
 *                       read) and filter it against this document
 */
export function cssCopierRunner(request) {
  const mode = request.mode;
  const opts = Object.assign(
    { usedOnly: false, includeInlineAttributes: false },
    request.options || {}
  );

  const PSEUDO_ELEMENT_RE =
    /::?(before|after|first-line|first-letter|placeholder|selection|backdrop|marker|cue|part|slotted|file-selector-button|-webkit-[a-z-]+|-moz-[a-z-]+|-ms-[a-z-]+)(\([^()]*\))?/gi;
  const STATE_PSEUDO_RE =
    /:(hover|active|focus|focus-visible|focus-within|visited|link|any-link|target|target-within|user-valid|user-invalid|autofill|placeholder-shown|default|future|past|current)\b/gi;

  const blockedHrefs = [];
  const blocks = [];
  let keptRules = 0;
  let droppedRules = 0;

  function indent(text) {
    return text
      .split('\n')
      .map((line) => (line ? '  ' + line : line))
      .join('\n');
  }

  /** Does at least one selector in `selectorText` still match something? */
  function isUsedSelector(selectorText, root) {
    if (!selectorText) return true;
    return selectorText.split(',').some((part) => {
      const probe = part
        .replace(PSEUDO_ELEMENT_RE, '')
        .replace(STATE_PSEUDO_RE, '')
        .trim();
      // A selector that was nothing but pseudo state (`:hover`) is kept.
      if (!probe || probe === '*') return true;
      try {
        return root.querySelector(probe) !== null;
      } catch (err) {
        // Nesting (`&`), `:has()` on old engines, vendor junk — keep it rather
        // than silently throw away CSS we failed to understand.
        return true;
      }
    });
  }

  /** Returns the rule's text, or null when `usedOnly` filtered it away. */
  function filterRule(rule, root) {
    if (rule instanceof CSSStyleRule) {
      if (!opts.usedOnly || isUsedSelector(rule.selectorText, root)) {
        keptRules++;
        return rule.cssText;
      }
      droppedRules++;
      return null;
    }

    // @media, @supports, @container, @layer {}, @scope — recurse so a media
    // query does not drag in rules for elements the page never renders.
    if (typeof CSSGroupingRule !== 'undefined' && rule instanceof CSSGroupingRule) {
      const inner = [];
      for (const child of rule.cssRules) {
        const text = filterRule(child, root);
        if (text) inner.push(text);
      }
      if (!inner.length) return null;
      const prelude = rule.cssText.slice(0, rule.cssText.indexOf('{') + 1);
      return prelude + '\n' + inner.map(indent).join('\n\n') + '\n}';
    }

    // @font-face, @keyframes, @property, @import, @page, @charset: always kept,
    // they have no selector to match against.
    keptRules++;
    return rule.cssText;
  }

  function rulesToText(rules, root) {
    const parts = [];
    for (const rule of rules) {
      const text = filterRule(rule, root);
      if (text) parts.push(text);
    }
    return parts.join('\n\n');
  }

  function pushBlock(label, css, media) {
    if (!css.trim()) return;
    blocks.push({ label, css, media: media && media !== 'all' ? media : '' });
  }

  function readSheet(sheet, label, root) {
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch (err) {
      rules = null; // cross-origin without CORS headers
    }
    if (!rules) {
      if (sheet.href) blockedHrefs.push(sheet.href);
      return;
    }
    pushBlock(label, rulesToText(rules, root), sheet.media && sheet.media.mediaText);
  }

  function describeSheet(sheet) {
    if (sheet.href) return sheet.href;
    const node = sheet.ownerNode;
    if (!node) return 'constructed stylesheet';
    if (node.id) return '<style id="' + node.id + '">';
    const styles = Array.from(document.querySelectorAll('style'));
    return '<style> block #' + (styles.indexOf(node) + 1);
  }

  function describeElement(el) {
    let out = el.tagName.toLowerCase();
    if (el.id) out += '#' + el.id;
    if (el.classList.length) out += '.' + Array.from(el.classList).join('.');
    return out;
  }

  function collectInlineAttributes() {
    const nodes = document.querySelectorAll('[style]');
    if (!nodes.length) return 0;
    const lines = [];
    nodes.forEach((el) => {
      const value = el.getAttribute('style').trim();
      if (value) lines.push('  ' + describeElement(el) + '  {  ' + value + '  }');
    });
    if (!lines.length) return 0;
    pushBlock(
      'inline style="" attributes (reference only)',
      '/*\n' + lines.join('\n') + '\n*/',
      ''
    );
    return nodes.length;
  }

  function collectShadowRoots() {
    let count = 0;
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    const roots = [];
    while (node) {
      if (node.shadowRoot) roots.push(node);
      node = walker.nextNode();
    }
    roots.forEach((host) => {
      const root = host.shadowRoot;
      const label = 'shadow DOM of ' + describeElement(host);
      const sheets = Array.from(root.styleSheets || []);
      const adopted = Array.from(root.adoptedStyleSheets || []);
      sheets.concat(adopted).forEach((sheet) => readSheet(sheet, label, root));
      count += sheets.length + adopted.length;
    });
    return count;
  }

  if (mode === 'filter-external') {
    // Re-parse fetched stylesheet text inside the page so the same
    // "is this rule actually used?" test can run against the live DOM.
    (request.entries || []).forEach((entry) => {
      if (!opts.usedOnly) {
        pushBlock(entry.href, entry.css.trim(), '');
        return;
      }
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(entry.css);
        pushBlock(entry.href, rulesToText(sheet.cssRules, document), '');
      } catch (err) {
        pushBlock(entry.href, entry.css.trim(), '');
      }
    });
    return { frameUrl: location.href, blocks, blockedHrefs, keptRules, droppedRules };
  }

  Array.from(document.styleSheets).forEach((sheet) => {
    readSheet(sheet, describeSheet(sheet), document);
  });
  Array.from(document.adoptedStyleSheets || []).forEach((sheet, index) => {
    readSheet(sheet, 'adopted stylesheet #' + (index + 1), document);
  });
  collectShadowRoots();

  const inlineCount = opts.includeInlineAttributes ? collectInlineAttributes() : 0;

  return {
    frameUrl: location.href,
    title: document.title,
    blocks,
    blockedHrefs,
    keptRules,
    droppedRules,
    inlineCount
  };
}
