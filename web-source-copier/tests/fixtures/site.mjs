/**
 * A small two-origin test site: one origin serves the page and its assets, the
 * other serves a stylesheet *without* CORS headers, which is the case the page
 * itself cannot read.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ICON = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'icons', 'icon16.png'));

const SOURCE_MAP = JSON.stringify({
  version: 3,
  file: 'app.js',
  sources: ['webpack://demo/./src/App.tsx', 'webpack://demo/./src/styles/theme.scss'],
  sourcesContent: [
    'export const App = (): JSX.Element => <div className="hero">hi</div>;\n',
    '$brand: #5b4ce0;\n.hero { color: $brand; }\n'
  ],
  mappings: ''
});

const PAGE = (otherPort) => `<!doctype html>
<html><head>
<meta charset="utf-8"><title>Fixture site</title>
<link rel="stylesheet" href="/site.css">
<link rel="stylesheet" href="http://127.0.0.1:${otherPort}/remote.css">
<style>.inline-used{color:rebeccapurple}.inline-unused{color:red}#hero{padding:24px}</style>
</head><body>
<div class="hero external-used remote-used hero-media hero-nested" id="hero"><p class="lead">Fixture</p></div>
<img src="/logo.png" width="16" height="16" alt="">
<img data-src="/never-answers" alt="">
<div style="color: teal">inline attribute</div>
<iframe src="/frame.html"></iframe>
<nav>
  <a href="/about">About</a>
  <a href="/contact?ref=nav">Contact</a>
  <a href="/blog/">Blog index</a>
  <a href="/private/secret">Secret (robots-disallowed)</a>
  <a href="/spa">App-rendered page</a>
  <a href="/about#same-page-anchor">About again (fragment)</a>
  <a href="https://example.com/external">External site</a>
  <a href="mailto:someone@example.com">Mail</a>
</nav>
<script src="/app.js"></script>
<script>window.__inline = function(){return 1};</script>
<script>fetch('/api/items.json').then(r=>r.json()).then(d=>{window.__items=d});</script>
</body></html>`;

const PAGE_ABOUT = `<!doctype html><html><head><title>About us</title>
<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/page.css"></head>
<body><h1 class="about-only">ABOUT-PAGE-MARKER</h1><img src="/logo.png" alt=""><a href="/team">Team</a></body></html>`;

const PAGE_CONTACT = `<!doctype html><html><head><title>Contact</title>
<link rel="stylesheet" href="/site.css"></head><body><h1>CONTACT-PAGE-MARKER</h1></body></html>`;

const PAGE_BLOG = `<!doctype html><html><head><title>Blog</title></head><body>
<h1>BLOG-INDEX-MARKER</h1><a href="/blog/post-1">Post 1</a></body></html>`;

// Content that only exists once JavaScript has run.
const PAGE_SPA = `<!doctype html><html><head><title>App page</title></head><body>
<div id="root">loading…</div>
<script>document.getElementById('root').textContent = 'RENDERED-BY-JAVASCRIPT';</script>
</body></html>`;

export function startFixture(mainPort = 8094, otherPort = 8095) {
  const files = {
    '/': ['text/html', PAGE(otherPort)],
    '/frame.html': ['text/html', '<style>.iframe-rule{color:navy}</style><p class="iframe-rule">f</p>'],
    '/site.css': ['text/css', [
      '.external-used{border:1px solid black}',
      '.external-unused{border:9px dotted red}',
      '@media (min-width:1px){.hero-media{outline:1px solid red}.never-there{outline:9px solid red}}',
      '@supports (display:grid){@media (min-width:1px){.hero-nested{color:navy}}}',
      '@layer base{@supports (x:y){*,::before,::after,::backdrop{--tw-ring:initial}}}',
      '@media (min-width:1px){.hero-media::before{content:"x"}a:hover::after{color:red}}'
    ].join('\n')],
    '/app.js': ['application/javascript', 'var app=1;function go(a,b){if(a>b){return a/b}return[1,2].map(function(x){return x*2})}\n//# sourceMappingURL=app.js.map'],
    '/app.js.map': ['application/json', SOURCE_MAP],
    '/api/items.json': ['application/json', '{"items":[{"id":1,"name":"from the API"}]}'],
    '/logo.png': ['image/png', ICON],
    '/favicon.ico': ['image/png', ICON],
    '/robots.txt': ['text/plain', 'User-agent: *\nDisallow: /private/\n'],
    '/about': ['text/html', PAGE_ABOUT],
    '/contact': ['text/html', PAGE_CONTACT],
    '/blog/': ['text/html', PAGE_BLOG],
    '/blog/post-1': ['text/html', '<!doctype html><html><head><title>Post 1</title></head><body><h1>Post one</h1></body></html>'],
    '/private/secret': ['text/html', '<!doctype html><html><body>SECRET-CONTENT</body></html>'],
    '/spa': ['text/html', PAGE_SPA],
    '/page.css': ['text/css', '.about-only{color:seagreen;background:url(/logo.png)}']
  };

  const pending = [];
  const main = http.createServer((req, res) => {
    // A resource the exporter will try to fetch and never get an answer for.
    if (req.url.startsWith('/never-answers')) {
      pending.push(res);
      return;
    }
    const file = files[req.url.split('?')[0]];
    if (!file) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': file[0] });
    res.end(file[1]);
  }).listen(mainPort);

  // Deliberately no Access-Control-Allow-Origin.
  const other = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end('.remote-used{color:hotpink}\n.remote-unused{color:chartreuse}');
  }).listen(otherPort);

  return {
    url: `http://127.0.0.1:${mainPort}/`,
    close: () => {
      pending.forEach((res) => res.destroy());
      main.close();
      other.close();
    }
  };
}
