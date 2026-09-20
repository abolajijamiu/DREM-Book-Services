/**
 * Node-side tests for the libraries that do not need a browser:
 * the ZIP writer, the pretty-printers and the source-map extractor.
 *
 *   npm run test:unit
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ZipWriter, sanitizeZipPath } from '../src/lib/zip.js';
import { formatJs, formatCss, formatHtml, formatJson } from '../src/lib/format.js';
import { extractOriginalSources, findSourceMappingUrl, normalizeSourcePath } from '../src/lib/sourcemap.js';
import { kindOf, zipPathForUrl } from '../src/lib/bundle.js';
import { absolutizeCssUrls } from '../src/lib/picker.js';
import { parseRobots, rulesFor, isAllowedPath, loadRobots } from '../src/lib/robots.js';
import { pagePathFor } from '../src/lib/site.js';
import { normalizePageUrl, cssUrlReferences } from '../src/lib/html-scan.js';
import { relativePath, rewriteHtml, rewriteCss } from '../src/lib/rewrite.js';

globalThis.atob ||= (b64) => Buffer.from(b64, 'base64').toString('binary');

let failed = 0;
const check = (name, ok) => {
  if (!ok) failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name);
};

/* ------------------------------------------------------------------ zip */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsc-zip-'));
const zip = new ZipWriter();
const compressible = 'body { color: red; }\n'.repeat(500);
const binary = new Uint8Array(256).map((_, i) => i);
await zip.add('capture/styles.css', compressible);
await zip.add('capture/files/img.bin', binary);
await zip.add('capture/README.md', '# héllo — unicode ✓');
await zip.add('capture/README.md', 'same path again');
await zip.add('../../etc/passwd', 'traversal attempt');
const zipPath = path.join(tmp, 'out.zip');
fs.writeFileSync(zipPath, Buffer.from(await (await zip.finish()).arrayBuffer()));

check('zip passes unzip -t', execSync(`unzip -t ${zipPath}`).toString().includes('No errors detected'));
execSync(`unzip -q ${zipPath} -d ${tmp}/unpacked`);
check('zip roundtrips text', fs.readFileSync(`${tmp}/unpacked/capture/styles.css`, 'utf8') === compressible);
check('zip roundtrips unicode', fs.readFileSync(`${tmp}/unpacked/capture/README.md`, 'utf8') === '# héllo — unicode ✓');
check('zip roundtrips binary', Buffer.compare(fs.readFileSync(`${tmp}/unpacked/capture/files/img.bin`), Buffer.from(binary)) === 0);
check('zip renames duplicate paths', fs.existsSync(`${tmp}/unpacked/capture/README-2.md`));
check('zip strips ../ traversal', fs.existsSync(`${tmp}/unpacked/etc/passwd`));
check('zip deflates', fs.statSync(zipPath).size < compressible.length / 2);
check('zip sanitizes illegal characters', sanitizeZipPath('a\u0000b/c*d?.txt') === 'a_b/c_d_.txt');

/* --------------------------------------------------------------- format */

const jsSamples = [
  `!function(e,t){"use strict";var n=e.x/2,r=/ab+c/gi.test(t);function q(a,b){if(a>b){return a/b}else{return[1,2,3].map(function(x){return x*2})}}e.z={a:1,b:"he}llo;",c:q(n,3)},t&&t(e)}(window,window.cb);`,
  'const s=`tpl ${a?b:c} /not-a-regex/`;for(let i=0;i<10;i++){s.split("/").join(";")}class A extends B{constructor(){super();this.x=()=>{return 1}}}',
  'try{JSON.parse(x)}catch(e){console.log(/\\/{2}/.test("//"),1/2/3)}//trailing\nvar y=1;'
];

jsSamples.forEach((source, index) => {
  const formatted = formatJs(source);
  const file = path.join(tmp, `fmt${index}.js`);
  fs.writeFileSync(file, formatted);
  let parses = true;
  try {
    execSync(`node --check ${file}`, { stdio: 'pipe' });
  } catch (err) {
    parses = false;
    console.log(formatted);
  }
  check(`formatted js sample ${index + 1} still parses`, parses);
  check(`formatted js sample ${index + 1} is multi-line`, formatted.split('\n').length > 4);
  check(
    `formatted js sample ${index + 1} keeps every non-space character`,
    formatted.replace(/\s/g, '').length >= source.replace(/\s/g, '').length
  );
});

const css = formatCss('.a{color:red;background:url("a;b{}c")}@media (min-width:10px){.b,.c{margin:0 auto}}');
check('css nests inside @media', css.includes('  .b, .c {'));
check('css leaves url() strings alone', css.includes('url("a;b{}c")'));
check('css spaces declarations', css.includes('color: red;'));

const html = formatHtml('<!doctype html><html><head><style>.a{color:red}</style></head><body><div class="x"><p>hi</p><br><img src="a.png"></div><pre>  keep\n   me  </pre><script>var a=1;var b=2</script></body></html>');
const lineOf = (needle) => html.split('\n').find((line) => line.includes(needle)) || '';
check('html keeps doctype at top level', html.split('\n')[1].startsWith('<html'));
check('html indents children', /\n\s+<p>/.test(html));
check('html inlines short text nodes', html.includes('<p>hi</p>'));
check('html does not nest after void elements', lineOf('<br>').match(/^\s*/)[0] === lineOf('<img').match(/^\s*/)[0]);
check('html formats embedded css', html.includes('color: red'));
check('html keeps <pre> verbatim', html.includes('  keep'));

check('json pretty-prints', formatJson('{"a":[1,2]}').includes('\n  "a": ['));
check('json passes invalid input through', formatJson('{oops') === '{oops');

/* ------------------------------------------------------------ sourcemap */

const map = {
  version: 3,
  sources: ['webpack://my-app/./src/components/Button.tsx', 'webpack:///node_modules/x/y.js'],
  sourcesContent: ['export const Button = () => <button/>;', null]
};
const served = { 'https://site.test/static/app.js.map': JSON.stringify(map) };
const fetchText = async (url) => served[url] || null;

check('finds js sourceMappingURL', findSourceMappingUrl('var a=1;\n//# sourceMappingURL=app.js.map') === 'app.js.map');
check('finds css sourceMappingURL', findSourceMappingUrl('.a{}\n/*# sourceMappingURL=a.css.map */') === 'a.css.map');
check('ignores files without a map', findSourceMappingUrl('var a=1;') === null);
check('normalizes webpack paths', normalizeSourcePath('webpack://my-app/./src/App.vue?vue&type=script', 0) === 'my-app/src/App.vue');
check('normalizes ~ to node_modules', normalizeSourcePath('~lib/a.js', 0) === 'node_modules/lib/a.js');

const extracted = await extractOriginalSources(fetchText, 'https://site.test/static/app.js', 'x\n//# sourceMappingURL=app.js.map');
check('resolves the map relative to the bundle', extracted.mapUrl === 'https://site.test/static/app.js.map');
check('recovers original tsx', extracted.files.some((file) => file.path === 'my-app/src/components/Button.tsx'));
check('reports sources with no embedded content', extracted.missing.length === 1);

const inlineMap = 'a\n//# sourceMappingURL=data:application/json;base64,' +
  Buffer.from(JSON.stringify({ version: 3, sources: ['/a/b.ts'], sourcesContent: ['const a: number = 1;'] })).toString('base64');
check('handles inline data: maps', (await extractOriginalSources(fetchText, 'https://site.test/app.js', inlineMap)).files[0].content.includes('number'));

served['https://site.test/i.js.map'] = JSON.stringify({
  version: 3,
  sections: [{ map: { version: 3, sources: ['s/one.js'], sourcesContent: ['1'] } }, { map: { version: 3, sources: ['s/two.js'], sourcesContent: ['2'] } }]
});
check('handles index maps', (await extractOriginalSources(fetchText, 'https://site.test/i.js', 'x\n//# sourceMappingURL=i.js.map')).files.length === 2);
check('reports unparseable maps', (await extractOriginalSources(async () => 'nope', 'https://site.test/b.js', 'x\n//# sourceMappingURL=b.js.map')).error.includes('valid JSON'));

/* ----------------------------------------------------------- bundle bits */

check('kindOf uses the content type first', kindOf('https://x.test/a', 'application/javascript; charset=utf-8') === 'script');
check('kindOf falls back to the extension', kindOf('https://x.test/a/b.woff2', '') === 'font');
check('kindOf knows php output is a document', kindOf('https://x.test/index.php', '') === 'document');
check('kindOf classifies Next.js RSC payloads as data', kindOf('https://x.test/page?_rsc=abc', 'text/x-component') === 'data');
check('kindOf classifies ld+json as data', kindOf('https://x.test/thing', 'application/ld+json') === 'data');
check('kindOf classifies text/plain as data', kindOf('https://x.test/robots', 'text/plain; charset=utf-8') === 'data');
check('kindOf still separates html from other text', kindOf('https://x.test/p', 'text/html') === 'document');
check('zip path mirrors the url', zipPathForUrl('https://x.test/assets/app.js') === 'files/x.test/assets/app.js');
check('zip path names directory urls', zipPathForUrl('https://x.test/blog/') === 'files/x.test/blog/index.html');
check('zip path keeps queries distinct', zipPathForUrl('https://x.test/a.js?v=1') !== zipPathForUrl('https://x.test/a.js?v=2'));

/* ---------------------------------------------------- picker helpers */

const base = 'https://cdn.test/css/site.css';
check('url() goes absolute against the stylesheet', absolutizeCssUrls('a{background:url(../img/x.png)}', base).includes('https://cdn.test/img/x.png'));
check('quoted url() is rewritten too', absolutizeCssUrls(".a{background:url('f/y.svg')}", base).includes("url('https://cdn.test/css/f/y.svg')"));
check('absolute url() is left alone', absolutizeCssUrls('a{background:url(https://other.test/a.png)}', base).includes('https://other.test/a.png'));
check('data: url() is left alone', absolutizeCssUrls('a{background:url(data:image/png;base64,AAA)}', base).includes('url(data:image/png;base64,AAA)'));
check('protocol-relative url() is left alone', absolutizeCssUrls('a{background:url(//x.test/a.png)}', base).includes('url(//x.test/a.png)'));
check('no base leaves css untouched', absolutizeCssUrls('a{background:url(x.png)}', '') === 'a{background:url(x.png)}');

/* -------------------------------------------------------------- robots */

const robotsTxt = [
  '# a comment',
  'User-agent: *',
  'Disallow: /private/',
  'Disallow: /tmp',
  'Allow: /private/public-bit',
  'Disallow: /*.pdf$',
  'Crawl-delay: 5',
  '',
  'User-agent: BadBot',
  'Disallow: /',
  '',
  'Sitemap: https://x.test/sitemap.xml'
].join('\n');

const parsedRobots = parseRobots(robotsTxt);
const robotRules = rulesFor(parsedRobots, 'WebSourceCopier');
check('robots groups parse', parsedRobots.groups.length === 2);
check('robots sitemap captured', parsedRobots.sitemaps[0] === 'https://x.test/sitemap.xml');
check('our agent falls into the * group', robotRules.length === 4);
check('robots allows an ordinary path', isAllowedPath(robotRules, '/about'));
check('robots blocks a disallowed folder', !isAllowedPath(robotRules, '/private/secret'));
check('robots prefix match blocks /tmpfoo', !isAllowedPath(robotRules, '/tmpfoo'));
check('robots longest match wins, Allow beating parent Disallow', isAllowedPath(robotRules, '/private/public-bit'));
check('robots wildcard with $ anchors the extension', !isAllowedPath(robotRules, '/files/report.pdf'));
check('robots $ anchor does not catch a trailing query', isAllowedPath(robotRules, '/files/report.pdf?x=1'));
check('a named agent group overrides the wildcard', !isAllowedPath(rulesFor(parsedRobots, 'BadBot'), '/anything'));
check('empty Disallow allows everything', isAllowedPath(rulesFor(parseRobots('User-agent: *\nDisallow:'), 'x'), '/a'));
check('rules before any user-agent line are ignored', rulesFor(parseRobots('Disallow: /\nUser-agent: *\nAllow: /'), 'x').length === 1);
check('missing robots.txt allows everything', (await loadRobots('https://x.test', async () => null)).allowed('https://x.test/private/x'));
check('unreadable robots.txt allows everything', (await loadRobots('https://x.test', async () => { throw new Error('offline'); })).allowed('https://x.test/a'));
const liveRobots = await loadRobots('https://x.test', async () => 'User-agent: *\nDisallow: /private/');
check('loaded robots blocks by url', !liveRobots.allowed('https://x.test/private/a') && liveRobots.allowed('https://x.test/ok'));

/* --------------------------------------------------------- site helpers */

check('page path mirrors the url', pagePathFor('https://x.test/docs/en/overview') === 'pages/docs/en/overview.html');
check('page path names the home page', pagePathFor('https://x.test/') === 'pages/index.html');
check('page path names a directory url', pagePathFor('https://x.test/blog/') === 'pages/blog/index.html');
check('page path keeps an .html suffix once', pagePathFor('https://x.test/a.html') === 'pages/a.html');
check('page path separates query strings', pagePathFor('https://x.test/p?a=1') !== pagePathFor('https://x.test/p?a=2'));
check('normalizePageUrl drops fragments', normalizePageUrl('/a#top', 'https://x.test/') === 'https://x.test/a');
check('normalizePageUrl rejects mailto', normalizePageUrl('mailto:a@b.c', 'https://x.test/') === null);
check('normalizePageUrl rejects javascript:', normalizePageUrl('javascript:void(0)', 'https://x.test/') === null);
check('css url() references resolve against the sheet', cssUrlReferences('a{background:url(../i/x.png)}', 'https://x.test/css/s.css')[0] === 'https://x.test/i/x.png');
check('css url() skips data URIs', cssUrlReferences('a{background:url(data:image/png;base64,AA)}', 'https://x.test/s.css').length === 0);
check('css @import is followed', cssUrlReferences('@import "more.css";', 'https://x.test/css/s.css')[0] === 'https://x.test/css/more.css');

/* ------------------------------------------------------ offline rewriting */

check('relative path within a folder', relativePath('pages/a.html', 'pages/b.html') === 'b.html');
check('relative path up and across', relativePath('pages/index.html', 'files/x/app.css') === '../files/x/app.css');
check('relative path from a deep page', relativePath('pages/docs/en/overview.html', 'files/x/a.js') === '../../../files/x/a.js');
check('relative path from the archive root', relativePath('rendered-page.html', 'files/x/a.js') === 'files/x/a.js');

const archive = {
  'https://s.test/style.css': 'files/s.test/style.css',
  'https://s.test/img/logo.png': 'files/s.test/img/logo.png',
  'https://s.test/img/logo@2x.png': 'files/s.test/img/logo@2x.png',
  'https://s.test/about': 'pages/about.html'
};
const lookup = (url) => archive[url] || null;
const pageHtml = [
  '<!doctype html><html><head><base href="https://s.test/">',
  '<link rel="stylesheet" href="/style.css">',
  '<style>.a{background:url(/img/logo.png)}</style></head><body>',
  '<img src="/img/logo.png" srcset="/img/logo.png 1x, /img/logo@2x.png 2x" alt="">',
  '<a href="/about">About</a><a href="/about#team">Team</a><a href="/missing">Missing</a>',
  '<a href="https://other.test/x">External</a><a href="mailto:a@b.c">Mail</a>',
  '<div style="background:url(/img/logo.png)"></div></body></html>'
].join('\n');
const rewritten = rewriteHtml(pageHtml, { pageUrl: 'https://s.test/', fromPath: 'pages/index.html', lookup });

check('rewrite repoints a stylesheet', rewritten.includes('href="../files/s.test/style.css"'));
check('rewrite repoints an image', rewritten.includes('src="../files/s.test/img/logo.png"'));
check('rewrite repoints every srcset candidate', rewritten.includes('srcset="../files/s.test/img/logo.png 1x, ../files/s.test/img/logo@2x.png 2x"'));
check('rewrite links captured pages to their files', rewritten.includes('href="about.html"'));
check('rewrite keeps a fragment on a page link', rewritten.includes('href="about.html#team"'));
check('rewrite leaves uncaptured pages absolute', rewritten.includes('href="/missing"'));
check('rewrite leaves external links alone', rewritten.includes('href="https://other.test/x"'));
check('rewrite leaves mailto: alone', rewritten.includes('href="mailto:a@b.c"'));
check('rewrite neutralises <base href>', rewritten.includes('data-original-href="https://s.test/"') && !/<base[^>]*\shref=/i.test(rewritten));
check('rewrite handles url() in a <style> block', rewritten.includes('url(../files/s.test/img/logo.png)'));
check('rewrite handles url() in a style attribute', rewritten.includes('style="background:url(../files/s.test/img/logo.png)"'));

const sheet = rewriteCss(
  '@import "other.css";\n.a{background:url("img/logo.png")}\n.b{background:url(/missing.png)}\n.c{background:url(data:image/png;base64,AA)}',
  { baseUrl: 'https://s.test/style.css', fromPath: 'files/s.test/style.css', lookup }
);
check('css rewrite resolves against the stylesheet', sheet.includes('url("img/logo.png")'));
check('css rewrite leaves uncaptured urls alone', sheet.includes('url(/missing.png)'));
check('css rewrite leaves data URIs alone', sheet.includes('url(data:image/png;base64,AA)'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} failing` : '\nall unit checks passed');
process.exit(failed ? 1 : 0);
