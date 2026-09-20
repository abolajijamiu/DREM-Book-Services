/**
 * Element picker: click anything on the page and get its HTML plus only the CSS
 * that applies to it.
 *
 * Injected with `chrome.scripting.executeScript`, so it must stay
 * self-contained. It returns a promise; `executeScript` waits for it.
 *
 * `deliver: 'clipboard'` copies from inside the page's own click handler, which
 * is what makes the popup flow work — the popup is already closed by then, but
 * the page still has the user gesture the Clipboard API requires.
 */
export function elementInspectorRunner(request) {
  const deliver = (request && request.deliver) || 'return';
  const ID = '__web_source_copier_picker__';

  // Stylesheets the page itself cannot read (cross-origin, no CORS headers).
  // The extension fetched them for us; re-parse them here so their rules can be
  // matched against the picked element like any other source.
  const externalSheets = [];
  ((request && request.externalCss) || []).forEach((entry) => {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(entry.css);
      externalSheets.push({ label: entry.href, rules: sheet.cssRules });
    } catch (err) {
      /* unparseable stylesheet: skipped */
    }
  });

  const previous = document.getElementById(ID);
  if (previous) previous.remove();

  const overlay = document.createElement('div');
  overlay.id = ID;
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647', 'pointer-events:none',
    'font:12px/1.4 system-ui,sans-serif'
  ].join(';');

  const box = document.createElement('div');
  box.style.cssText = [
    'position:fixed', 'border:1px solid #5b4ce0', 'background:rgba(91,76,224,0.14)',
    'border-radius:2px', 'transition:all .04s linear', 'pointer-events:none'
  ].join(';');

  const label = document.createElement('div');
  label.style.cssText = [
    'position:fixed', 'padding:3px 7px', 'background:#5b4ce0', 'color:#fff',
    'border-radius:4px', 'white-space:nowrap', 'pointer-events:none',
    'box-shadow:0 2px 8px rgba(0,0,0,.25)', 'max-width:90vw', 'overflow:hidden',
    'text-overflow:ellipsis'
  ].join(';');

  const hint = document.createElement('div');
  hint.textContent = 'Click an element to copy its HTML + CSS  ·  Esc to cancel';
  hint.style.cssText = [
    'position:fixed', 'left:50%', 'top:12px', 'transform:translateX(-50%)',
    'padding:6px 12px', 'background:#16161a', 'color:#fff', 'border-radius:999px',
    'pointer-events:none', 'box-shadow:0 4px 14px rgba(0,0,0,.3)'
  ].join(';');

  overlay.append(box, label, hint);
  document.documentElement.appendChild(overlay);

  function describe(el) {
    let out = el.tagName.toLowerCase();
    if (el.id) return out + '#' + el.id;
    if (el.classList.length) out += '.' + Array.from(el.classList).slice(0, 3).join('.');
    return out;
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      let part = node.tagName.toLowerCase();
      if (node.classList.length) {
        part += '.' + Array.from(node.classList).map((c) => CSS.escape(c)).join('.');
      }
      const parent = node.parentElement;
      if (parent) {
        const twins = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (twins.length > 1) part += ':nth-of-type(' + (twins.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  /** Every rule in the document that matches this element or a descendant. */
  function matchingCss(root) {
    const targets = [root].concat(Array.from(root.querySelectorAll('*')));
    const hits = [];

    const matchesAny = (selectorText) =>
      selectorText.split(',').some((part) => {
        const probe = part
          .replace(/::?(before|after|first-line|first-letter|placeholder|selection|marker|backdrop)(\([^()]*\))?/gi, '')
          .replace(/:(hover|active|focus|focus-visible|focus-within|visited|link|any-link|target)\b/gi, '')
          .trim();
        if (!probe) return false;
        try {
          return targets.some((el) => el.matches(probe));
        } catch (err) {
          return false;
        }
      });

    const walk = (rules, wrapper, source) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) {
          if (matchesAny(rule.selectorText)) hits.push({ wrapper, source, text: rule.cssText });
        } else if (typeof CSSGroupingRule !== 'undefined' && rule instanceof CSSGroupingRule) {
          const prelude = rule.cssText.slice(0, rule.cssText.indexOf('{') + 1).trim();
          walk(rule.cssRules, wrapper ? wrapper + '\n' + prelude : prelude, source);
        } else if (rule instanceof CSSFontFaceRule || (typeof CSSKeyframesRule !== 'undefined' && rule instanceof CSSKeyframesRule)) {
          hits.push({ wrapper: '', source, text: rule.cssText, atRule: true });
        }
      }
    };

    Array.from(document.styleSheets).forEach((sheet) => {
      try {
        walk(sheet.cssRules, '', '');
      } catch (err) {
        /* unreadable here; the same sheet arrives below via externalSheets */
      }
    });
    externalSheets.forEach((sheet) => walk(sheet.rules, '', sheet.label));

    const grouped = new Map();
    hits.forEach((hit) => {
      if (hit.atRule) return;
      const key = hit.source + '\u0000' + hit.wrapper;
      const list = grouped.get(key) || [];
      list.push(hit.text);
      grouped.set(key, list);
    });

    const chunks = [];
    grouped.forEach((list, key) => {
      const source = key.split('\u0000')[0];
      const wrapper = key.slice(source.length + 1);
      const banner = source ? '/* from ' + source + ' */\n' : '';
      const body = list.join('\n\n');
      if (!wrapper) {
        chunks.push(banner + body);
        return;
      }
      const opens = wrapper.split('\n');
      const indented = body.split('\n').map((line) => (line ? '  '.repeat(opens.length) + line : line)).join('\n');
      chunks.push(banner + opens.join(' {\n') + '\n' + indented + '\n' + opens.map(() => '}').join('\n'));
    });

    const fontFaces = hits.filter((hit) => hit.atRule).map((hit) => hit.text);
    return { css: chunks.join('\n\n'), atRules: Array.from(new Set(fontFaces)) };
  }

  /** Computed styles, minus everything that is just the browser default. */
  function nonDefaultComputedStyles(el) {
    let frame;
    try {
      frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:fixed;left:-9999px;top:0;width:0;height:0;border:0;opacity:0';
      document.body.appendChild(frame);
      const doc = frame.contentDocument;
      const probe = doc.createElement(el.tagName);
      doc.body.appendChild(probe);
      const defaults = frame.contentWindow.getComputedStyle(probe);
      const actual = getComputedStyle(el);
      const lines = [];
      for (let i = 0; i < actual.length; i++) {
        const prop = actual[i];
        const value = actual.getPropertyValue(prop);
        if (value && value !== defaults.getPropertyValue(prop)) lines.push('  ' + prop + ': ' + value + ';');
      }
      return lines.join('\n');
    } catch (err) {
      return '';
    } finally {
      if (frame) frame.remove();
    }
  }

  function toast(text) {
    const note = document.createElement('div');
    note.textContent = text;
    note.style.cssText = [
      'position:fixed', 'left:50%', 'top:16px', 'transform:translateX(-50%)',
      'z-index:2147483647', 'padding:10px 16px', 'background:#16161a', 'color:#fff',
      'border-radius:999px', 'font:13px/1.4 system-ui,sans-serif',
      'box-shadow:0 6px 20px rgba(0,0,0,.35)', 'transition:opacity .4s ease'
    ].join(';');
    document.documentElement.appendChild(note);
    setTimeout(() => {
      note.style.opacity = '0';
    }, 2200);
    setTimeout(() => note.remove(), 2800);
  }

  function buildOutput(el) {
    const selector = cssPath(el);
    const { css, atRules } = matchingCss(el);
    const computed = nonDefaultComputedStyles(el);
    const parts = [
      '/* ' + '='.repeat(60),
      '   Element: ' + selector,
      '   Page:    ' + location.href,
      '   ' + '='.repeat(60) + ' */',
      '',
      '<!-- HTML -->',
      el.outerHTML,
      '',
      '/* ---------- CSS rules that match this element or its children ---------- */',
      '',
      css || '/* none — this element carries no matching rules (inline styles only?) */'
    ];
    if (atRules.length) {
      parts.push('', '/* ---------- @font-face / @keyframes in scope ---------- */', '', atRules.join('\n\n'));
    }
    if (computed) {
      parts.push(
        '',
        '/* ---------- computed styles that differ from the browser default ---------- */',
        '',
        '/*',
        selector + ' {',
        computed,
        '}',
        '*/'
      );
    }
    return { selector, text: parts.join('\n') + '\n', html: el.outerHTML, css };
  }

  return new Promise((resolve) => {
    let current = null;

    const cleanup = () => {
      overlay.remove();
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
    };

    const onMove = (event) => {
      const el = event.target;
      if (!el || el.nodeType !== 1 || el === overlay || overlay.contains(el)) return;
      current = el;
      const rect = el.getBoundingClientRect();
      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';
      label.textContent = describe(el) + '   ' + Math.round(rect.width) + '×' + Math.round(rect.height);
      label.style.left = rect.left + 'px';
      label.style.top = (rect.top > 24 ? rect.top - 22 : rect.bottom + 4) + 'px';
    };

    const onClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const el = current || event.target;
      cleanup();
      const output = buildOutput(el);
      if (deliver === 'clipboard') {
        // Still inside the click gesture, so this is allowed.
        Promise.resolve(navigator.clipboard.writeText(output.text))
          .then(() => toast('Copied ' + output.selector.split(' > ').pop() + ' — HTML + CSS'))
          .catch(() => toast('Could not reach the clipboard'));
      }
      resolve(output);
    };

    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cleanup();
      resolve(null);
    };

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  });
}
