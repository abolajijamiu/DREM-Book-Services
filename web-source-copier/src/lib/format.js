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
  let out = '';
  let depth = 0;
  let atLineStart = true;

  const newline = () => {
    out = out.replace(/[ \t]+$/, '');
    out += '\n' + indentOf(depth);
    atLineStart = true;
  };
  const write = (text) => {
    if (!text) return;
    out += text;
    atLineStart = false;
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
        if (!atLineStart && !/[\s]$/.test(out)) write(' ');
        continue;
      }

      if (ch === '{' || ch === '[' || ch === '(') {
        stack.push(ch === '{' && !opensObjectLiteral(out) ? 'block' : ch);
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
          if (!atLineStart) newline();
          else out = out.replace(/[ \t]*$/, indentOf(depth));
        }
        write(ch);
        continue;
      }

      const inParens = stack[stack.length - 1] === '(';

      if (ch === ';' && !inParens) {
        write(ch);
        newline();
        continue;
      }

      if (ch === ',' && (stack[stack.length - 1] === '{' || stack[stack.length - 1] === '[')) {
        write(ch);
        newline();
        continue;
      }

      write(ch);
    }
  }

  return tidyJs(out).trim() + '\n';
}

/**
 * Cosmetic touch-ups applied only to code tokens, so nothing inside a string,
 * comment or regex is ever rewritten.
 */
function tidyJs(text) {
  return tokenizeJs(text)
    .map((token) => {
      if (token.type !== 'code') return token.value;
      return token.value
        .replace(/\}\s*\n\s*(else|catch|finally|while)\b/g, '} $1')
        .replace(/\b(if|for|while|switch|catch|function)\(/g, '$1 (')
        .replace(/\)\{/g, ') {')
        .replace(/\belse\{/g, 'else {')
        .replace(/\}(else|catch|finally)\b/g, '} $1');
    })
    .join('')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line, index, all) => line.trim() || (index > 0 && all[index - 1].trim()))
    .join('\n');
}

export function formatCss(source) {
  let out = '';
  let depth = 0;
  let parenDepth = 0;
  let i = 0;

  const newline = () => {
    out = out.replace(/[ \t]+$/, '');
    out += '\n' + indentOf(depth);
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop);
      newline();
      i = stop;
      continue;
    }

    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (ch === '{') {
      out = out.replace(/\s+$/, '') + ' {';
      depth++;
      newline();
      i++;
      continue;
    }

    if (ch === '}') {
      depth--;
      out = out.replace(/\s+$/, '');
      out += '\n' + indentOf(depth) + '}';
      newline();
      i++;
      continue;
    }

    if (ch === ';') {
      out += ';';
      newline();
      i++;
      continue;
    }

    if (/\s/.test(ch)) {
      if (!/[\s(]$/.test(out) && out) out += ' ';
      i++;
      continue;
    }

    if (ch === ',' && parenDepth === 0) {
      out += ', ';
      i++;
      while (/\s/.test(source[i])) i++;
      continue;
    }

    if (ch === '(') parenDepth++;
    if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);

    if (ch === ':' && (depth > 0 || parenDepth > 0)) {
      out += ': ';
      i++;
      while (/\s/.test(source[i])) i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line, index, all) => line.trim() || (index > 0 && all[index - 1].trim()))
    .join('\n')
    .trim() + '\n';
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
