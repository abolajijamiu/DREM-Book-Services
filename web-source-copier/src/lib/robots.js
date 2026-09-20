/**
 * robots.txt parsing, following RFC 9309.
 *
 * Site capture asks this before every page it fetches. A site that has not
 * published a robots.txt, or whose robots.txt cannot be read, is treated as
 * "allowed" — the same thing a browser does.
 */

export const USER_AGENT = 'WebSourceCopier';

/** Splits a robots.txt into its user-agent groups. */
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let expectingAgent = false;

  String(text || '')
    .split(/\r?\n/)
    .forEach((rawLine) => {
      const line = rawLine.replace(/#.*$/, '').trim();
      if (!line) return;
      const separator = line.indexOf(':');
      if (separator === -1) return;
      const field = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();

      if (field === 'user-agent') {
        if (!current || !expectingAgent) {
          current = { agents: [], rules: [] };
          groups.push(current);
          expectingAgent = true;
        }
        current.agents.push(value.toLowerCase());
        return;
      }

      if (field === 'sitemap') {
        sitemaps.push(value);
        return;
      }

      if (field === 'allow' || field === 'disallow') {
        if (!current) return; // a rule before any user-agent line is ignored
        expectingAgent = false;
        current.rules.push({ allow: field === 'allow', pattern: value });
      }
    });

  return { groups, sitemaps };
}

/** The rules that apply to us: an exact user-agent match beats the `*` group. */
export function rulesFor(parsed, userAgent = USER_AGENT) {
  const wanted = userAgent.toLowerCase();
  const specific = parsed.groups.filter((group) =>
    group.agents.some((agent) => agent !== '*' && wanted.includes(agent))
  );
  const wildcard = parsed.groups.filter((group) => group.agents.includes('*'));
  const chosen = specific.length ? specific : wildcard;
  return chosen.flatMap((group) => group.rules);
}

function patternToRegExp(pattern) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + escaped + (anchored ? '$' : ''));
}

/**
 * Longest matching pattern wins; on a tie, Allow beats Disallow.
 * An empty `Disallow:` means "nothing is disallowed".
 */
export function isAllowedPath(rules, pathAndQuery) {
  let best = null;
  for (const rule of rules) {
    if (!rule.pattern) {
      // "Disallow:" with no value allows everything; "Allow:" with no value is a no-op.
      if (!rule.allow) continue;
      continue;
    }
    let matches = false;
    try {
      matches = patternToRegExp(rule.pattern).test(pathAndQuery);
    } catch (err) {
      matches = false;
    }
    if (!matches) continue;
    const specificity = rule.pattern.replace(/\*/g, '').length;
    if (!best || specificity > best.specificity || (specificity === best.specificity && rule.allow)) {
      best = { allow: rule.allow, specificity };
    }
  }
  return best ? best.allow : true;
}

/**
 * @param fetchText async (url) => string  (throws or returns null when absent)
 * @returns { allowed(url), status, rules, sitemaps, url }
 */
export async function loadRobots(origin, fetchText, userAgent = USER_AGENT) {
  const url = new URL('/robots.txt', origin).href;
  let text = null;
  let status = 'missing';

  try {
    text = await fetchText(url);
    status = text === null || text === undefined ? 'missing' : 'loaded';
  } catch (err) {
    status = 'unreadable';
  }

  const parsed = text ? parseRobots(text) : { groups: [], sitemaps: [] };
  const rules = text ? rulesFor(parsed, userAgent) : [];

  return {
    url,
    status,
    rules,
    sitemaps: parsed.sitemaps,
    /** @param {string} pageUrl absolute URL */
    allowed(pageUrl) {
      if (status !== 'loaded') return true;
      try {
        const parsedUrl = new URL(pageUrl);
        return isAllowedPath(rules, parsedUrl.pathname + parsedUrl.search);
      } catch (err) {
        return true;
      }
    }
  };
}
