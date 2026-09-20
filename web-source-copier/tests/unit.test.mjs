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
check('zip path mirrors the url', zipPathForUrl('https://x.test/assets/app.js') === 'files/x.test/assets/app.js');
check('zip path names directory urls', zipPathForUrl('https://x.test/blog/') === 'files/x.test/blog/index.html');
check('zip path keeps queries distinct', zipPathForUrl('https://x.test/a.js?v=1') !== zipPathForUrl('https://x.test/a.js?v=2'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} failing` : '\nall unit checks passed');
process.exit(failed ? 1 : 0);
