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
<div style="color: teal">inline attribute</div>
<iframe src="/frame.html"></iframe>
<script src="/app.js"></script>
<script>window.__inline = function(){return 1};</script>
<script>fetch('/api/items.json').then(r=>r.json()).then(d=>{window.__items=d});</script>
</body></html>`;

export function startFixture(mainPort = 8094, otherPort = 8095) {
  const files = {
    '/': ['text/html', PAGE(otherPort)],
    '/frame.html': ['text/html', '<style>.iframe-rule{color:navy}</style><p class="iframe-rule">f</p>'],
    '/site.css': ['text/css', [
      '.external-used{border:1px solid black}',
      '.external-unused{border:9px dotted red}',
      '@media (min-width:1px){.hero-media{outline:1px solid red}.never-there{outline:9px solid red}}',
      '@supports (display:grid){@media (min-width:1px){.hero-nested{color:navy}}}'
    ].join('\n')],
    '/app.js': ['application/javascript', 'var app=1;function go(a,b){if(a>b){return a/b}return[1,2].map(function(x){return x*2})}\n//# sourceMappingURL=app.js.map'],
    '/app.js.map': ['application/json', SOURCE_MAP],
    '/api/items.json': ['application/json', '{"items":[{"id":1,"name":"from the API"}]}'],
    '/logo.png': ['image/png', ICON],
    '/favicon.ico': ['image/png', ICON]
  };

  const main = http.createServer((req, res) => {
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
      main.close();
      other.close();
    }
  };
}
