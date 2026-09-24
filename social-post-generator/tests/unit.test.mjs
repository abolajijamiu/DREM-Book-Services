import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { captionFor, hashtagsFor, charCount } from '../src/captions.js';
import { renderHtml, escapeHtml, carouselLength } from '../src/template.js';
import { PLATFORMS, layoutFor } from '../src/formats.js';

const brand = JSON.parse(readFileSync(new URL('../brand.json', import.meta.url)));
const posts = JSON.parse(readFileSync(new URL('../content/posts.json', import.meta.url)));
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

test('every caption fits its platform limit', () => {
  for (const post of posts) for (const platform of Object.keys(PLATFORMS)) {
    const { text } = captionFor(post, brand, platform);
    assert.ok(charCount(text) <= PLATFORMS[platform].captionLimit, `${post.id} on ${platform}`);
  }
});

test('long captions are cut with a warning', () => {
  const post = { id: 'long', caption: 'word '.repeat(200) };
  const { text, warnings } = captionFor(post, brand, 'x');
  assert.ok(charCount(text) <= 280);
  assert.ok(text.endsWith('…'));
  assert.equal(warnings.length, 1);
});

test('platform override replaces the caption', () => {
  const post = { id: 'o', caption: 'long one', captions: { x: 'Just for X' } };
  assert.match(captionFor(post, brand, 'x').text, /^Just for X/);
});

test('hashtags are deduplicated case-insensitively and get a #', () => {
  const tags = hashtagsFor({ hashtags: ['amwriting', '#Books'] }, { defaultHashtags: ['#AmWriting'] });
  assert.deepEqual(tags, ['#amwriting', '#Books']);
});

test('pinterest gets a title of at most 100 chars', () => {
  const { title } = captionFor({ id: 'p', title: 'x'.repeat(150), caption: 'c' }, brand, 'pinterest');
  assert.ok(charCount(title) <= 100);
});

test('layout family follows aspect ratio', () => {
  assert.equal(layoutFor({ w: 1200, h: 630 }), 'wide');
  assert.equal(layoutFor({ w: 1080, h: 1080 }), 'square');
  assert.equal(layoutFor({ w: 1080, h: 1350 }), 'tall');
  assert.equal(layoutFor({ w: 1080, h: 1920 }), 'story');
});

test('user text is escaped in the HTML', () => {
  const html = renderHtml({ post: { id: 'x', type: 'quote', quote: '<script>bad()</script>', author: 'A & B' },
    brand, format: { w: 1080, h: 1080 } });
  assert.ok(!html.includes('<script>bad()'));
  assert.ok(html.includes('A &amp; B'));
  assert.equal(escapeHtml(`"'`), '&quot;&#39;');
});

test('every sample post renders for every size', () => {
  for (const post of posts) for (const spec of Object.values(PLATFORMS)) for (const format of Object.values(spec.formats)) {
    const slides = post.type === 'carousel' ? carouselLength(post) : 1;
    for (let slide = 0; slide < slides; slide++) {
      assert.match(renderHtml({ post, brand, format, slide }), /<\/html>$/);
    }
  }
});

test('unknown post types are rejected', () => {
  assert.throws(() => renderHtml({ post: { id: 'z', type: 'nope' }, brand, format: { w: 100, h: 100 } }), /unknown type/);
});

console.log(`\n${passed} tests passed`);
