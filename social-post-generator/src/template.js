// Builds the HTML for one post image in the DREM Book brand (see
// brand/drem-book-brand-kit.html). The same markup serves every size: sizes
// are expressed in --u (1% of the shorter side) and the layout class
// (wide / square / tall / story) rearranges the blocks.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutFor } from './formats.js';
import { ICONS } from './icons.js';

const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/fonts');
const FONT_FILES = [
  ['Open Sans', 400, 'normal', 'OpenSans-Regular.woff2'],
  ['Open Sans', 600, 'normal', 'OpenSans-SemiBold.woff2'],
  ['Open Sans', 700, 'normal', 'OpenSans-Bold.woff2'],
  ['Open Sans', 800, 'normal', 'OpenSans-ExtraBold.woff2'],
  ['Zilla Slab', 500, 'normal', 'ZillaSlab-Medium.woff2'],
  ['Zilla Slab', 400, 'italic', 'ZillaSlab-Italic.woff2'],
];

let fontCss;
function fontFaces() {
  fontCss ??= FONT_FILES.map(([family, weight, style, file]) => {
    const data = readFileSync(path.join(FONT_DIR, file)).toString('base64');
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

// *word* in a title or quote becomes the Zilla Slab italic accent.
export const rich = (s) => escapeHtml(s).replace(/\*([^*]+)\*/g, '<em>$1</em>');
export const plain = (s = '') => String(s).replace(/\*([^*]+)\*/g, '$1');

// Background themes, all taken from the brand kit's palette and pairings.
const THEMES = {
  paper: (c) => ({
    bg: c.paper, fg: c.midnight, soft: c.graphite, eyebrow: c.emberDeep, em: c.ember,
    iconBg: c.moonlight, iconStroke: c.midnight, hl: c.moonlight,
    rings: [c.ember, c.amber, c.dusk], logo: { spine: c.midnight, r: [c.ember, c.amber, c.dusk], w1: c.midnight, w2: c.ember },
  }),
  midnight: (c) => ({
    bg: c.midnight, fg: c.white, soft: 'rgba(255,255,255,.8)', eyebrow: c.moonlight, em: c.moonlight,
    iconBg: c.moonlight, iconStroke: c.midnight, hl: 'transparent', qem: c.moonlight,
    rings: [c.ember, c.amber, c.moonlight], logo: { spine: c.white, r: [c.ember, c.amber, c.moonlight], w1: c.white, w2: c.moonlight },
  }),
  moonlight: (c) => ({
    bg: c.moonlight, fg: c.midnight, soft: c.graphite, eyebrow: c.emberDeep, em: c.emberDeep,
    iconBg: c.white, iconStroke: c.midnight, hl: c.white,
    rings: [c.ember, c.amber, c.dusk], logo: { spine: c.midnight, r: [c.ember, c.amber, c.dusk], w1: c.midnight, w2: c.ember },
  }),
};
const THEME_ALIASES = { dark: 'midnight', light: 'paper', accent: 'moonlight' };
export const themeNames = () => [...Object.keys(THEMES), ...Object.keys(THEME_ALIASES)];

// The DREM Book mark: a book spine and three fanned pages forming a D.
// Geometry from the brand kit, in a 100-unit box (bounding box x 12..67, y 14..86).
const SPINE = 'M16 14H28V86H16A4 4 0 0 1 12 82V18A4 4 0 0 1 16 14Z';
const ring = (cx, cy, ro, ri) => `M${cx} ${cy - ro}A${ro} ${ro} 0 0 1 ${cx} ${cy + ro}L${cx} ${cy + ri}A${ri} ${ri} 0 0 0 ${cx} ${cy - ri}Z`;
const disc = (cx, cy, r) => `M${cx} ${cy - r}A${r} ${r} 0 0 1 ${cx} ${cy + r}Z`;
const pages = ([a, b, d]) => `<path d="${ring(31, 50, 36, 28)}" fill="${a}"/><path d="${ring(31, 50, 25, 17)}" fill="${b}"/><path d="${disc(31, 50, 14)}" fill="${d}"/>`;

function markSvg(logo) {
  return `<svg class="mark" viewBox="12 14 55 72" aria-hidden="true"><path d="${SPINE}" fill="${logo.spine}"/>${pages(logo.r)}</svg>`;
}

// The fanned pages alone, rising from the bottom-right corner like a sun.
function cornerRings(t) {
  return `<svg class="rings" viewBox="31 14 36 36" aria-hidden="true">${pages(t.rings)}</svg>`;
}

function iconSvg(id, t, cls = 'icon') {
  const ic = ICONS[id];
  if (!ic) throw new Error(`Unknown icon "${id}". Try: ${Object.keys(ICONS).join(', ')}`);
  return `<svg class="${cls}" viewBox="0 0 48 48" fill="none" stroke="${t.iconStroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<g fill="#F0A030" stroke="none">${ic.a}</g>${ic.s}</svg>`;
}

function lockup(brand, t, baseDir) {
  if (brand.logo) {
    const file = path.resolve(baseDir, brand.logo);
    if (existsSync(file)) {
      const ext = path.extname(file).slice(1).toLowerCase();
      const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      return `<img class="logo-img" src="data:${mime};base64,${readFileSync(file).toString('base64')}" alt="">`;
    }
  }
  const [w1, w2] = [brand.word1 ?? brand.name, brand.word2 ?? ''];
  return `<div class="lockup">${markSvg(t.logo)}<span class="w1" style="color:${t.logo.w1}">${escapeHtml(w1)}</span>` +
    `<span class="w2" style="color:${t.logo.w2}">${escapeHtml(w2)}</span></div>`;
}

function footer(brand, t, baseDir) {
  const contact = brand.handle || brand.website || brand.email;
  return `<footer class="foot">${lockup(brand, t, baseDir)}${contact ? `<span class="contact">${escapeHtml(contact)}</span>` : ''}</footer>`;
}

const cta = (post, brand) => `<div class="cta">${escapeHtml(post.cta || brand.cta)}</div>`;

function body(post, brand, t, slide) {
  const e = escapeHtml;
  switch (post.type) {
    case 'service':
      return `<div class="split">
          <div class="lead">${post.icon ? `<div class="icon-circle">${iconSvg(post.icon, t)}</div>` : ''}
            <div class="eyebrow">${e(post.eyebrow)}</div><h1>${rich(post.title)}</h1>
            ${post.subtitle ? `<p class="sub">${e(post.subtitle)}</p>` : ''}</div>
          <div class="side"><ul class="points">${(post.points || []).map((p) =>
            `<li>${iconSvg('check', t, 'tick')}<span>${e(p)}</span></li>`).join('')}</ul>${cta(post, brand)}</div>
        </div>`;
    case 'tip':
      return `<div class="split">
          <div class="lead"><div class="eyebrow">${e(post.eyebrow || 'Tip')}</div><h1 class="h-tip">${rich(post.title)}</h1></div>
          <div class="side"><ol class="steps">${(post.points || []).map((p, i) =>
            `<li><span class="num">${i + 1}</span><span>${e(p)}</span></li>`).join('')}</ol></div>
        </div>`;
    case 'quote':
      return `<div class="quote-wrap"><svg class="qmark" viewBox="0 0 64 46" aria-hidden="true"><path id="q" d="M26 3C12 8 3 18 3 31a11 11 0 1 0 11-11c-1.500 0-2.500.2-3.500.5C12.500 14 17 10 26 7.500z"/><use href="#q" x="33"/></svg>
        <blockquote>${rich(post.quote)}</blockquote>
        <div class="cite">${e(post.author)}${post.source ? `<em>${e(post.source)}</em>` : ''}</div></div>`;
    case 'announcement':
      return `<div class="announce"><div class="eyebrow">${e(post.eyebrow || 'News')}</div><h1 class="h-big">${rich(post.title)}</h1>
          ${post.body ? `<p class="sub">${e(post.body)}</p>` : ''}${cta(post, brand)}</div>`;
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
    return `${counter}<div class="announce">${post.eyebrow ? `<div class="eyebrow">${e(post.eyebrow)}</div>` : ''}
      <h1 class="h-big">${rich(post.title)}</h1>
      ${post.subtitle ? `<p class="sub">${e(post.subtitle)}</p>` : ''}
      <div class="swipe">Swipe <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 24h30M28 14l10 10-10 10"/></svg></div></div>${dots}`;
  }
  const step = post.slides[i - 1];
  if (step) {
    return `${counter}<div class="step"><div class="big-num">${i}</div>
      <div><h1 class="h-step">${rich(step.title)}</h1><p class="sub">${e(step.body)}</p></div></div>${dots}`;
  }
  return `${counter}<div class="announce"><h1 class="h-big">${rich(post.outro.title)}</h1>
    <p class="sub">${e(post.outro.body)}</p>${cta(post, brand)}</div>${dots}`;
}

export function renderHtml({ post, brand, format, slide = 0, baseDir = '.' }) {
  const c = brand.colors;
  const themeName = THEME_ALIASES[post.theme] || post.theme || 'paper';
  if (!THEMES[themeName]) throw new Error(`Post "${post.id}": unknown theme "${post.theme}". Try: ${themeNames().join(', ')}`);
  const t = THEMES[themeName](c);
  const u = Math.min(format.w, format.h) / 100;
  const layout = layoutFor(format);
  const safe = format.safe || 0;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFaces()}
*{box-sizing:border-box;margin:0;padding:0}
:root{--u:${u}px;--s:1;--bg:${t.bg};--fg:${t.fg};--soft:${t.soft};--eyebrow:${t.eyebrow};--em:${t.em};--hl:${t.hl};--qem:${t.qem || 'inherit'};
  --icon-bg:${t.iconBg};--ember:${c.ember};--moonlight:${c.moonlight};--white:${c.white}}
html,body{width:${format.w}px;height:${format.h}px;overflow:hidden;background:var(--bg);color:var(--fg);
  font-family:'Open Sans','Liberation Sans',sans-serif;-webkit-font-smoothing:antialiased}
.frame{position:relative;width:100%;height:100%;display:flex;flex-direction:column;
  padding:calc(${safe}px + var(--u)*9) calc(var(--u)*9) calc(${safe}px + var(--u)*7.5)}
.rings{position:absolute;right:0;bottom:0;width:calc(var(--u)*26);height:calc(var(--u)*26)}
.content{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;overflow:hidden;
  padding-bottom:calc(var(--u)*5)}
.fit{font-size:calc(var(--u)*var(--s))}
h1{font-weight:800;font-size:8.8em;line-height:1.08;letter-spacing:-.02em;text-wrap:balance}
h1 em,blockquote em{font-family:'Zilla Slab',serif;font-style:italic;font-weight:400;letter-spacing:0;color:var(--em)}
h1 em{font-size:1.1em;line-height:.9}
.h-tip{font-size:7.2em}.h-big{font-size:10.4em}.h-step{font-size:9em}
.eyebrow{font-size:2.9em;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--eyebrow);margin-bottom:1.3em}
.sub{font-size:3.7em;line-height:1.55;color:var(--soft);margin-top:.9em;max-width:28ch;text-wrap:pretty}
.split{display:flex;flex-direction:column;gap:4.5em}
.icon-circle{width:15em;height:15em;border-radius:50%;background:var(--icon-bg);display:grid;place-items:center;margin-bottom:3.2em}
.icon-circle .icon{width:8.8em;height:8.8em}
.points{list-style:none;display:flex;flex-direction:column;gap:1.1em}
.points li{font-size:3.8em;font-weight:600;line-height:1.3;display:flex;align-items:center;gap:.6em}
.tick{flex:none;width:1.35em;height:1.35em}
.steps{list-style:none;display:flex;flex-direction:column;gap:2.2em}
.steps li{display:flex;gap:.9em;align-items:center;font-size:4em;line-height:1.4}
.num{flex:none;display:grid;place-items:center;width:1.9em;height:1.9em;border-radius:50%;background:var(--ember);
  border:.14em solid var(--moonlight);color:var(--white);font-weight:800;font-size:1em}
.cta{align-self:flex-start;margin-top:2.4em;font-size:3.2em;font-weight:600;line-height:1.1;padding:.8em 1.7em;border-radius:99em;
  background:var(--ember);color:var(--white);border:.18em solid var(--moonlight)}
.side{display:flex;flex-direction:column}
.side .cta{margin-top:1.8em}
.quote-wrap{display:flex;flex-direction:column}
.qmark{width:13em;height:auto;fill:var(--ember);margin-bottom:3em}
blockquote{font-family:'Zilla Slab',serif;font-style:italic;font-weight:400;font-size:8em;line-height:1.2;text-wrap:balance}
blockquote em{background:linear-gradient(transparent 62%,var(--hl) 62%);color:var(--qem)}
.cite{margin-top:1.8em;font-size:3.5em;font-weight:600;color:var(--soft)}
.cite em{display:block;font-family:'Zilla Slab',serif;font-weight:400;margin-top:.15em}
.announce{display:flex;flex-direction:column}
.counter{position:absolute;top:0;right:0;font-size:2.8em;font-weight:700;letter-spacing:.08em;color:var(--soft)}
.swipe{display:flex;align-items:center;gap:.35em;margin-top:2.4em;font-size:3.6em;font-weight:700;color:var(--em)}
.swipe svg{width:1.1em;height:1.1em}
.step{display:flex;flex-direction:column;gap:4em}
.big-num{display:grid;place-items:center;width:2em;height:2em;border-radius:50%;background:var(--ember);border:.1em solid var(--moonlight);
  color:var(--white);font-size:11em;font-weight:800;line-height:1}
.dots{position:absolute;top:.4em;left:0;display:flex;gap:1.1em}
.dots span{width:1.5em;height:1.5em;border-radius:50%;border:.28em solid var(--ember)}
.dots span.on{background:var(--ember)}
.carousel .fit>.step,.carousel .fit>.announce{padding-top:6em}
.foot{position:relative;display:flex;align-items:center;gap:calc(var(--u)*3);font-size:calc(var(--u)*3)}
.lockup{display:flex;align-items:center;white-space:nowrap}
.lockup .mark{height:2.7em;width:auto;margin-right:.55em}
.lockup .w1{font-weight:800;font-size:1.5em;letter-spacing:.05em}
.lockup .w2{font-weight:400;font-size:1.5em;margin-left:.3em}
.logo-img{height:2.7em;width:auto}
.contact{padding-left:calc(var(--u)*3);border-left:max(1px,calc(var(--u)*.2)) solid currentColor;color:var(--soft);font-weight:600}
/* Wide: title left, details right */
.wide .frame{padding-left:calc(var(--u)*10);padding-right:calc(var(--u)*10)}
.wide .split{flex-direction:row;align-items:center;gap:8em}
.wide .lead{flex:1.2}.wide .side{flex:1}
.wide h1{font-size:9.6em}.wide .h-tip{font-size:8em}.wide .h-big{font-size:12em}
.wide .sub{max-width:34ch}
.wide .step{flex-direction:row;align-items:center;gap:6em}
.wide .icon-circle{display:none}
.wide .rings{width:calc(var(--u)*34);height:calc(var(--u)*34)}
/* Story / tall: more air, larger type */
.story h1{font-size:11em}.story .h-tip{font-size:9.4em}.story .h-big{font-size:13em}.story .h-step{font-size:12em}
.story blockquote{font-size:10em}.story .sub,.story .points li{font-size:4.4em}.story .steps li{font-size:4.8em}
.story .big-num{font-size:14em}.story .split{gap:7em}.story .rings{width:calc(var(--u)*40);height:calc(var(--u)*40)}
.tall h1{font-size:9.6em}.tall .h-big{font-size:11.5em}.tall blockquote{font-size:8.8em}
</style></head><body class="${layout} ${post.type}">
<div class="frame">
  ${cornerRings(t)}
  <main class="content"><div class="fit" id="fit">${body(post, brand, t, slide)}</div></main>
  ${footer(brand, t, baseDir)}
</div>
<script>
// Shrink the type until the content fits its box, so long copy never overflows.
(async () => {
  await document.fonts.ready;
  const box = document.querySelector('.content');
  const fit = document.getElementById('fit');
  const root = document.documentElement;
  const room = () => box.clientHeight - parseFloat(getComputedStyle(box).paddingBottom);
  let s = 1;
  const over = () => fit.scrollHeight > room() + 1 || fit.scrollWidth > box.clientWidth + 1;
  while (over() && s > 0.45) { s -= 0.025; root.style.setProperty('--s', s); }
  document.body.dataset.scale = s.toFixed(3);
  document.body.dataset.ready = '1';
})();
</script></body></html>`;
}
