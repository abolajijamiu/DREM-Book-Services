// Builds the HTML for one post image. The same markup serves every size:
// sizes are expressed in --u (1% of the shorter side) and the layout class
// (wide / square / tall / story) rearranges the blocks.
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { layoutFor } from './formats.js';

const require = createRequire(import.meta.url);

const FONT_FILES = [
  ['Fraunces', 400, 'normal', '@fontsource/fraunces/files/fraunces-latin-400-normal.woff2'],
  ['Fraunces', 400, 'italic', '@fontsource/fraunces/files/fraunces-latin-400-italic.woff2'],
  ['Fraunces', 600, 'normal', '@fontsource/fraunces/files/fraunces-latin-600-normal.woff2'],
  ['Fraunces', 600, 'italic', '@fontsource/fraunces/files/fraunces-latin-600-italic.woff2'],
  ['Inter', 400, 'normal', '@fontsource/inter/files/inter-latin-400-normal.woff2'],
  ['Inter', 600, 'normal', '@fontsource/inter/files/inter-latin-600-normal.woff2'],
];

let fontCss;
function fontFaces() {
  fontCss ??= FONT_FILES.map(([family, weight, style, file]) => {
    const data = readFileSync(require.resolve(file)).toString('base64');
    return `@font-face{font-family:'${family}';font-weight:${weight};font-style:${style};` +
      `src:url(data:font/woff2;base64,${data}) format('woff2');}`;
  }).join('\n');
  return fontCss;
}

export function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const THEMES = {
  dark: (c) => ({ bg: c.ink, fg: c.paper, soft: 'rgba(247,241,230,.72)', mark: c.gold, line: c.gold }),
  light: (c) => ({ bg: c.paper, fg: c.ink, soft: 'rgba(29,43,58,.72)', mark: c.accent, line: c.accent }),
  accent: (c) => ({ bg: c.accentDeep, fg: c.paper, soft: 'rgba(247,241,230,.8)', mark: c.gold, line: c.gold }),
};

function logoMark(brand, baseDir) {
  if (brand.logo) {
    const file = path.resolve(baseDir, brand.logo);
    if (existsSync(file)) {
      const ext = path.extname(file).slice(1).toLowerCase();
      const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      return `<img class="logo-img" src="data:${mime};base64,${readFileSync(file).toString('base64')}" alt="">`;
    }
  }
  // Default mark: an open book.
  return `<svg class="logo-svg" viewBox="0 0 48 36" aria-hidden="true">
    <path d="M24 8C18 3 9 3 3 5v26c6-2 15-2 21 3 6-5 15-5 21-3V5c-6-2-15-2-21 3z"
      fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/>
    <path d="M24 8v26" stroke="currentColor" stroke-width="2.6"/></svg>`;
}

function footer(brand, baseDir) {
  const contact = brand.handle || brand.website || brand.email || brand.tagline;
  return `<footer class="foot">
    <div class="brand"><span class="mark">${logoMark(brand, baseDir)}</span>
      <span class="brand-name">${escapeHtml(brand.name)}</span></div>
    <div class="contact">${escapeHtml(contact)}</div>
  </footer>`;
}

const pad2 = (n) => String(n).padStart(2, '0');

function body(post, brand, slide) {
  const e = escapeHtml;
  switch (post.type) {
    case 'service':
      return `<div class="eyebrow">${e(post.eyebrow)}</div>
        <div class="split">
          <div class="lead"><h1>${e(post.title)}</h1>
            ${post.subtitle ? `<p class="sub">${e(post.subtitle)}</p>` : ''}</div>
          <div class="side"><ul class="points">${(post.points || []).map((p) => `<li>${e(p)}</li>`).join('')}</ul>
            <div class="cta">${e(post.cta || brand.cta)}</div></div>
        </div>`;
    case 'tip':
      return `<div class="eyebrow">${e(post.eyebrow || 'Tip')}</div>
        <div class="split">
          <div class="lead"><h1 class="h-tip">${e(post.title)}</h1></div>
          <div class="side"><ol class="steps">${(post.points || []).map((p, i) =>
            `<li><span class="num">${i + 1}</span><span>${e(p)}</span></li>`).join('')}</ol></div>
        </div>`;
    case 'quote':
      return `<div class="quote-wrap"><div class="qmark">“</div>
        <blockquote>${e(post.quote)}</blockquote>
        <div class="cite"><span class="rule"></span><span>${e(post.author)}${post.source ? `<em>, ${e(post.source)}</em>` : ''}</span></div></div>`;
    case 'announcement':
      return `<div class="stamp">${e(post.eyebrow || 'News')}</div>
        <div class="announce"><h1 class="h-big">${e(post.title)}</h1>
          ${post.body ? `<p class="sub">${e(post.body)}</p>` : ''}
          <div class="cta">${e(post.cta || brand.cta)}</div></div>`;
    case 'carousel':
      return carouselSlide(post, brand, slide);
    default:
      throw new Error(`Post "${post.id}": unknown type "${post.type}"`);
  }
}

// Slide 0 is the cover, then one slide per step, then the outro.
export function carouselLength(post) {
  return (post.slides?.length || 0) + 1 + (post.outro ? 1 : 0);
}

function carouselSlide(post, brand, i) {
  const e = escapeHtml;
  const total = carouselLength(post);
  const dots = `<div class="dots">${Array.from({ length: total }, (_, k) =>
    `<span class="${k === i ? 'on' : ''}"></span>`).join('')}</div>`;
  const counter = `<div class="counter">${i + 1} / ${total}</div>`;
  if (i === 0) {
    return `${counter}<div class="announce"><h1 class="h-big">${e(post.title)}</h1>
      ${post.subtitle ? `<p class="sub">${e(post.subtitle)}</p>` : ''}
      <div class="swipe">Swipe <span>→</span></div></div>${dots}`;
  }
  const step = post.slides[i - 1];
  if (step) {
    return `${counter}<div class="step"><div class="big-num">${pad2(i)}</div>
      <h1 class="h-step">${e(step.title)}</h1><p class="sub">${e(step.body)}</p></div>${dots}`;
  }
  return `${counter}<div class="announce"><h1 class="h-big">${e(post.outro.title)}</h1>
    <p class="sub">${e(post.outro.body)}</p><div class="cta">${e(post.cta || brand.cta)}</div></div>${dots}`;
}

export function renderHtml({ post, brand, format, slide = 0, baseDir = '.' }) {
  const c = brand.colors;
  const t = (THEMES[post.theme] || THEMES.light)(c);
  const u = Math.min(format.w, format.h) / 100;
  const layout = layoutFor(format);
  const safe = format.safe || 0;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFaces()}
*{box-sizing:border-box;margin:0;padding:0}
:root{--u:${u}px;--s:1;--bg:${t.bg};--fg:${t.fg};--soft:${t.soft};--mark:${t.mark};--line:${t.line};
  --ink:${c.ink};--paper:${c.paper};--accent:${c.accent};--gold:${c.gold}}
html,body{width:${format.w}px;height:${format.h}px;overflow:hidden;background:var(--bg);color:var(--fg);
  font-family:Inter,'Liberation Sans',sans-serif;-webkit-font-smoothing:antialiased}
.frame{position:relative;width:100%;height:100%;display:flex;flex-direction:column;
  padding:calc(${safe}px + var(--u)*9) calc(var(--u)*9) calc(${safe}px + var(--u)*8)}
.border{position:absolute;inset:calc(var(--u)*3.2);border:max(1px,calc(var(--u)*.22)) solid var(--line);opacity:.55;pointer-events:none}
.grain{position:absolute;inset:0;opacity:.07;pointer-events:none;
  background:radial-gradient(circle at 85% 12%,var(--mark),transparent 45%),radial-gradient(circle at 5% 100%,var(--mark),transparent 40%)}
.spines{position:absolute;right:calc(var(--u)*9);top:calc(${safe}px + var(--u)*6.6);display:flex;align-items:flex-end;gap:calc(var(--u)*.6)}
.spines i{display:block;width:calc(var(--u)*1.3);border-radius:calc(var(--u)*.2);background:var(--mark)}
.spines i:nth-child(1){height:calc(var(--u)*5)}.spines i:nth-child(2){height:calc(var(--u)*6.2);opacity:.7}
.spines i:nth-child(3){height:calc(var(--u)*4.4);opacity:.45}.spines i:nth-child(4){height:calc(var(--u)*5.6);transform:rotate(12deg);transform-origin:bottom left;opacity:.3}
.content{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;overflow:hidden}
.fit{font-size:calc(var(--u)*var(--s))}
h1,blockquote,.big-num,.num,.qmark{font-family:Fraunces,'Liberation Serif',serif;font-weight:600;letter-spacing:-.015em}
.eyebrow,.stamp,.counter{font-size:3em;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--mark)}
.eyebrow{display:flex;align-items:center;gap:1em;margin-bottom:1.4em}
.eyebrow::before{content:'';width:3em;height:max(2px,.25em);background:var(--mark)}
.stamp{display:inline-block;align-self:flex-start;border:max(2px,.3em) solid var(--mark);padding:.5em .9em;margin-bottom:1.4em}
h1{font-size:9.5em;line-height:1.02;text-wrap:balance}
.h-tip{font-size:7.6em}.h-big{font-size:11em}.h-step{font-size:10em}
.sub{font-size:3.9em;line-height:1.4;color:var(--soft);margin-top:.9em;max-width:26ch;text-wrap:pretty}
.split{display:flex;flex-direction:column;gap:5em}
.points{list-style:none;display:flex;flex-direction:column;gap:1.1em}
.points li{font-size:3.9em;line-height:1.3;display:flex;align-items:center;gap:.8em}
.points li::before{content:'';flex:none;width:.5em;height:.5em;background:var(--mark);transform:rotate(45deg)}
.steps{list-style:none;display:flex;flex-direction:column;gap:2.4em}
.steps li{display:flex;gap:1.1em;align-items:baseline;font-size:4.3em;line-height:1.32}
.num{flex:none;font-size:1.9em;line-height:.8;color:var(--mark);min-width:.8em}
.cta{align-self:flex-start;margin-top:2.6em;font-size:3.3em;font-weight:600;padding:.8em 1.3em;border-radius:99em;
  background:var(--mark);color:var(--bg)}
.side .cta{margin-top:1.8em}
.quote-wrap{display:flex;flex-direction:column}
.qmark{font-size:30em;line-height:.62;height:.4em;color:var(--mark)}
blockquote{font-size:8.2em;line-height:1.15;font-style:italic;font-weight:400;text-wrap:balance}
.cite{display:flex;align-items:center;gap:1em;margin-top:2.2em;font-size:3.6em;font-weight:600;color:var(--soft)}
.cite em{font-weight:400}
.cite .rule{flex:none;width:2.4em;height:max(2px,.12em);background:var(--mark)}
.announce{display:flex;flex-direction:column}
.counter{position:absolute;top:0;right:0;font-size:2.8em;color:var(--soft)}
.swipe{margin-top:2.6em;font-size:3.6em;font-weight:600;color:var(--mark)}
.big-num{font-size:24em;line-height:.85;color:var(--mark);opacity:.9}
.dots{position:absolute;bottom:0;left:0;display:flex;gap:1.2em}
.dots span{width:1.4em;height:1.4em;border-radius:50%;border:max(1px,.25em) solid var(--mark)}
.dots span.on{background:var(--mark)}
.step,.carousel .announce{padding-bottom:4em}
.foot{position:relative;display:flex;justify-content:space-between;align-items:center;gap:calc(var(--u)*3);
  padding-top:calc(var(--u)*3.5);font-size:calc(var(--u)*2.9)}
.brand{display:flex;align-items:center;gap:.7em;font-weight:600;letter-spacing:.02em;white-space:nowrap}
.mark{display:flex;color:var(--mark)}.logo-svg{width:2.2em;height:auto}.logo-img{height:2em;width:auto}
.contact{color:var(--soft);text-align:right}
.carousel .spines{display:none}
/* Wide: title left, details right */
.wide .split{flex-direction:row;align-items:center;gap:7em}
.wide .lead{flex:1.25}.wide .side{flex:1}
.wide h1{font-size:10em}.wide .h-tip{font-size:8.4em}.wide .h-big{font-size:12.5em}
.wide .sub{max-width:30ch}
.wide .step{display:grid;grid-template-columns:auto 1fr;column-gap:5em;align-items:center}
.wide .step .big-num{grid-row:span 2}
.wide .frame{padding-left:calc(var(--u)*10);padding-right:calc(var(--u)*10)}
.wide .spines{right:calc(var(--u)*10)}
/* Story / tall: more air, larger type */
.story h1{font-size:12em}.story .h-tip{font-size:10em}.story .h-big{font-size:14em}.story .h-step{font-size:13em}
.story blockquote{font-size:10.5em}.story .sub,.story .points li{font-size:4.6em}.story .steps li{font-size:5.2em}
.story .big-num{font-size:32em}.story .split{gap:8em}
.tall h1{font-size:10.5em}.tall .h-big{font-size:12.5em}.tall blockquote{font-size:9em}
</style></head><body class="${layout} ${post.type}">
<div class="frame">
  <div class="grain"></div><div class="border"></div>
  <div class="spines"><i></i><i></i><i></i><i></i></div>
  <main class="content"><div class="fit" id="fit">${body(post, brand, slide)}</div></main>
  ${footer(brand, baseDir)}
</div>
<script>
// Shrink the type until the content fits its box, so long copy never overflows.
(async () => {
  await document.fonts.ready;
  const box = document.querySelector('.content');
  const fit = document.getElementById('fit');
  const root = document.documentElement;
  let s = 1;
  const over = () => fit.scrollHeight > box.clientHeight + 1 || fit.scrollWidth > box.clientWidth + 1;
  while (over() && s > 0.45) { s -= 0.025; root.style.setProperty('--s', s); }
  document.body.dataset.scale = s.toFixed(3);
  document.body.dataset.ready = '1';
})();
</script></body></html>`;
}
