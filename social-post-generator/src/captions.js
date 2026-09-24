// Turns a post's copy into a caption tailored to each platform's length
// limit and hashtag conventions.
import { PLATFORMS } from './formats.js';
import { plain } from './template.js';

// How many hashtags each platform's audience expects.
const HASHTAG_COUNT = {
  instagram: 12, facebook: 3, x: 2, linkedin: 4, threads: 1, pinterest: 6, tiktok: 5, whatsapp: 0,
};

// Platforms whose captions should use the short copy when one is given.
const PREFERS_SHORT = new Set(['x', 'threads', 'tiktok', 'whatsapp', 'pinterest']);

export const charCount = (s) => [...s].length;

export function hashtagsFor(post, brand) {
  const seen = new Set();
  return [...(post.hashtags || []), ...(brand.defaultHashtags || [])]
    .map((t) => (t.startsWith('#') ? t : `#${t}`))
    .filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
}

function contactLine(brand) {
  return [brand.website, brand.email, brand.handle].filter(Boolean).join(' · ');
}

function truncate(text, limit) {
  const chars = [...text];
  if (chars.length <= limit) return text;
  return chars.slice(0, limit - 1).join('').replace(/\s+\S*$/, '') + '…';
}

export function captionFor(post, brand, platform) {
  const spec = PLATFORMS[platform];
  const warnings = [];
  const override = post.captions?.[platform];
  const base = override ?? (PREFERS_SHORT.has(platform) && post.short ? post.short : post.caption) ?? '';
  const contact = contactLine(brand);
  const tags = hashtagsFor(post, brand).slice(0, Math.min(HASHTAG_COUNT[platform] ?? 5, spec.hashtagLimit ?? Infinity));

  let parts = [base];
  if (contact && !override && platform !== 'x') parts.push(contact);
  let text = parts.join('\n\n');

  // Add as many hashtags as still fit under the limit.
  const fitting = [];
  for (const tag of tags) {
    const next = `${text}\n\n${[...fitting, tag].join(' ')}`;
    if (charCount(next) > spec.captionLimit) break;
    fitting.push(tag);
  }
  if (fitting.length) text += `\n\n${fitting.join(' ')}`;

  if (charCount(text) > spec.captionLimit) {
    warnings.push(`${spec.label} caption is ${charCount(text)} chars (limit ${spec.captionLimit}); ` +
      `it was cut short. Add a "short" or "captions.${platform}" field to control it.`);
    text = truncate(text, spec.captionLimit);
  }

  const result = { text, warnings };
  if (platform === 'pinterest') {
    result.title = truncate(plain(post.title || post.quote || brand.name), 100);
  }
  return result;
}
