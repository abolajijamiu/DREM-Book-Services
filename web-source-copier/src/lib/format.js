/**
 * Pretty-printers for minified JS, CSS, HTML and JSON.
 *
 * These only ever *insert* whitespace — no token is added, removed or
 * reordered, and string/comment/regex contents are passed through untouched —
 * so a formatted bundle still behaves exactly like the original.
 */

const INDENT = '  ';

function indentOf(depth) {
  return INDENT.repeat(Math.max(0, depth));
}

/**
 * Splits JavaScript into code / string / comment / regex tokens so the
 * formatter never rewrites anything inside a literal.
 */
function tokenizeJs(source) {
  const tokens = [];
  let i = 0;
  let buffer = '';
  // Tracks the last meaningful character, to tell `a / b` from `/regex/`.
  let lastSignificant = '';

  const flush = () => {
    if (buffer) tokens.push({ type: 'code', value: buffer });
    buffer = '';
  };

  const regexAllowedAfter = (ch) => !/[\w$)\]]/.test(ch);

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      flush();
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      tokens.push({ type: 'line-comment', value: source.slice(i, stop) });
      i = stop;
      continue;
    }

    if (ch === '/' && next === '*') {
      flush();
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      tokens.push({ type: 'block-comment', value: source.slice(i, stop) });
      i = stop;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      flush();
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === ch) break;
        j++;
      }
      tokens.push({ type: 'string', value: source.slice(i, Math.min(j + 1, source.length)) });
      lastSignificant = ch;
      i = j + 1;
      continue;
    }

    if (ch === '/' && regexAllowedAfter(lastSignificant)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < source.length) {
        const c = source[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        let end = j + 1;
        while (end < source.length && /[a-z]/i.test(source[end])) end++; // flags
        flush();
        tokens.push({ type: 'regex', value: source.slice(i, end) });
        lastSignificant = '/';
        i = end;
        continue;
      }
    }

    buffer += ch;
    if (!/\s/.test(ch)) lastSignificant = ch;
    i++;
  }

  flush();
  return tokens;
}

/** `{` after `=`, `(`, `,`, `:` or `return` opens an object literal, not a block. */
function opensObjectLiteral(tail) {
  return /[=(,:?[&|!+\-*/%<>]\s*$/.test(tail) || /\b(return|typeof|of|in|do|else|=>)\s*$/.test(tail);
}

export function formatJs(source) {
  const tokens = tokenizeJs(source);
  const stack = []; // open delimiters, innermost last
  const lines = [];
  let line = '';
  let depth = 0;
  // The last few characters written, for the object-literal test. Keeping a
  // window rather than scanning the output is what keeps this linear.
  let recent = '';

  const remember = (text) => {
    recent = (recent + text).slice(-40);
  };
  const atLineStart = () => !line.trim();
  const newline = () => {
    lines.push(line.replace(/[ \t]+$/, ''));
    line = indentOf(depth);
  };
  const write = (text) => {
    if (!text) return;
    line += text;
    remember(text);
  };

  for (const token of tokens) {
    if (token.type !== 'code') {
      write(token.value);
      if (token.type === 'line-comment') newline();
      continue;
    }

    for (const ch of token.value) {
      if (/\s/.test(ch)) {
        // Collapse original whitespace; layout is decided below.
        if (!atLineStart() && !/\s$/.test(line)) write(' ');
        continue;
      }

      if (ch === '{' || ch === '[' || ch === '(') {
        stack.push(ch === '{' && !opensObjectLiteral(recent) ? 'block' : ch);
        write(ch);
        if (ch === '{' || ch === '[') {
          depth++;
          newline();
        }
        continue;
      }

      if (ch === '}' || ch === ']' || ch === ')') {
        const open = stack.pop();
        if (open === '{' || open === '[' || open === 'block') {
          depth--;
          if (!atLineStart()) newline();
          else line = indentOf(depth);
        }
        write(ch);
        continue;
      }

      const top = stack[stack.length - 1];

      if (ch === ';' && top !== '(') {
        write(ch);
        newline();
        continue;
      }

      if (ch === ',' && (top === '{' || top === '[')) {
        write(ch);
        newline();
        continue;
      }

      write(ch);
    }
  }

  lines.push(line);
  return tidyJs(lines.join('\n')).trim() + '\n';
}

/**
 * Cosmetic touch-ups applied only to code tokens, so nothing inside a string,
 * comment or regex is ever rewritten.
 */
function tidyJs(text) {
  const joined = tokenizeJs(text)
    .map((token) => {
      if (token.type !== 'code') return token.value;
      return token.value
        .replace(/\}\s*\n\s*(else|catch|finally|while)\b/g, '} $1')
        .replace(/\b(if|for|while|switch|catch|function)\(/g, '$1 (')
        .replace(/\)\{/g, ') {')
        .replace(/\belse\{/g, 'else {')
        .replace(/\}(else|catch|finally)\b/g, '} $1');
    })
    .join('');
  return collapseBlankLines(joined.split('\n')).join('\n');
}

/** Trailing whitespace off, and never two blank lines in a row. */
function collapseBlankLines(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line && (!out.length || !out[out.length - 1])) continue;
    out.push(line);
  }
  return out;
}

/**
 * Is the colon at `index` a declaration separator, or part of a selector?
 *
 * `color: red;` wants a space after the colon. `a::before {` and `a:hover {`
 * must be left exactly as they are — spacing them breaks the selector. Looking
 * ahead for the first `{`, `;` or `}` settles it: a `{` first means everything
 * up to here was a selector.
 */
function isDeclarationColon(source, index) {
  const limit = Math.min(source.length, index + 2000);
  for (let i = index + 1; i < limit; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      i++;
      while (i < limit && source[i] !== ch) i += source[i] === '\\' ? 2 : 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return false;
      i = end + 1;
      continue;
    }
    if (ch === '{') return false; // a selector led here
    if (ch === ';' || ch === '}') return true; // a declaration ended here
  }
  return false; // ambiguous: leaving the colon alone can never break the CSS
}

export function formatCss(source) {
  const lines = [];
  let line = '';
  let depth = 0;
  let parenDepth = 0;
  let i = 0;

  const newline = () => {
    lines.push(line.replace(/[ \t]+$/, ''));
    line = indentOf(depth);
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      line += source.slice(i, stop);
      newline();
      i = stop;
      continue;
    }

    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === '\\' ? 2 : 1;
      line += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (ch === '{') {
      line = line.replace(/\s+$/, '') + ' {';
      depth++;
      newline();
      i++;
      continue;
    }

    if (ch === '}') {
      depth--;
      if (line.trim()) newline();
      lines.push(indentOf(depth) + '}');
      line = indentOf(depth);
      i++;
      continue;
    }

    if (ch === ';') {
      line += ';';
      newline();
      i++;
      continue;
    }

    if (/\s/.test(ch)) {
      if (line && !/[\s(]$/.test(line)) line += ' ';
      i++;
      continue;
    }

    if (ch === ',' && parenDepth === 0) {
      line += ', ';
      i++;
      while (/\s/.test(source[i])) i++;
      continue;
    }

    if (ch === '(') parenDepth++;
    if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);

    if (ch === ':' && (parenDepth > 0 || (depth > 0 && isDeclarationColon(source, i)))) {
      line += ': ';
      i++;
      while (/\s/.test(source[i])) i++;
      continue;
    }

    line += ch;
    i++;
  }

  lines.push(line);
  return collapseBlankLines(lines).join('\n').trim() + '\n';
}

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr'
]);
const VERBATIM_ELEMENTS = new Set(['pre', 'textarea', 'script', 'style']);

export function formatHtml(source) {
  const lines = [];
  let depth = 0;
  let i = 0;

  const push = (text) => {
    const trimmed = text.trim();
    if (trimmed) lines.push(indentOf(depth) + trimmed);
  };

  while (i < source.length) {
    // Text node
    if (source[i] !== '<') {
      const next = source.indexOf('<', i);
      const stop = next === -1 ? source.length : next;
      push(source.slice(i, stop).replace(/\s+/g, ' '));
      i = stop;
      continue;
    }

    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i);
      const stop = end === -1 ? source.length : end + 3;
      push(source.slice(i, stop));
      i = stop;
      continue;
    }

    // <!doctype>, <?xml ...?> and friends sit outside the element tree.
    if (source.startsWith('<!', i) || source.startsWith('<?', i)) {
      const end = source.indexOf('>', i);
      const stop = end === -1 ? source.length : end + 1;
      push(source.slice(i, stop));
      i = stop;
      continue;
    }

    const end = source.indexOf('>', i);
    if (end === -1) {
      push(source.slice(i));
      break;
    }

    const tag = source.slice(i, end + 1);
    const nameMatch = tag.match(/^<\/?\s*([a-zA-Z][\w:-]*)/);
    const name = nameMatch ? nameMatch[1].toLowerCase() : '';
    const isClosing = tag.startsWith('</');
    const selfClosing = tag.endsWith('/>') || VOID_ELEMENTS.has(name);
    i = end + 1;

    if (isClosing) {
      depth = Math.max(0, depth - 1);
      push(tag);
      continue;
    }

    if (selfClosing) {
      push(tag);
      continue;
    }

    if (VERBATIM_ELEMENTS.has(name)) {
      const closeIndex = source.toLowerCase().indexOf('</' + name, i);
      const stop = closeIndex === -1 ? source.length : closeIndex;
      const body = source.slice(i, stop);
      push(tag);
      depth++;
      if (body.trim()) {
        if (name === 'pre' || name === 'textarea') {
          // Byte-exact: whitespace here is content.
          lines[lines.length - 1] += body;
        } else {
          const formatted = name === 'script' ? formatJs(body) : formatCss(body);
          formatted
            .split('\n')
            .filter((line) => line.trim())
            .forEach((line) => lines.push(indentOf(depth) + line));
        }
      }
      i = stop;
      continue;
    }

    // Short text-only elements stay on one line: <p>hi</p>
    const closeTag = '</' + name;
    const closeIndex = source.toLowerCase().indexOf(closeTag, i);
    if (closeIndex !== -1) {
      const inner = source.slice(i, closeIndex);
      const innerEnd = source.indexOf('>', closeIndex);
      if (!inner.includes('<') && inner.trim().length <= 60 && innerEnd !== -1) {
        push(tag + inner.replace(/\s+/g, ' ').trim() + source.slice(closeIndex, innerEnd + 1));
        i = innerEnd + 1;
        continue;
      }
    }

    push(tag);
    depth++;
  }

  return lines.join('\n').trim() + '\n';
}

export function formatJson(source) {
  try {
    return JSON.stringify(JSON.parse(source), null, 2) + '\n';
  } catch (err) {
    return source;
  }
}

/** Dispatches on a filename or content type; unknown types pass through. */
export function formatByKind(kind, source) {
  switch (kind) {
    case 'js':
      return formatJs(source);
    case 'css':
      return formatCss(source);
    case 'html':
      return formatHtml(source);
    case 'json':
      return formatJson(source);
    default:
      return source;
  }
}
