// Builds the community-nodes paper: Markdown + KaTeX -> one HTML page -> PDF through a headless Chromium-based browser.
// Usage: node build.mjs <paper dir> <output pdf>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import { printToPdf } from './browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [paperDir, outPdf] = process.argv.slice(2);
if (!paperDir || !outPdf) throw new Error('usage: node build.mjs <paper dir> <output pdf>');

// Per-language strings; each paper directory overrides them with its build.json.
const defaults = {
  lang: 'en',
  title: 'Turbogol: A Community Network of Verifiable Match Servers',
  author: 'Turbogol Project',
  headerLeft: 'Turbogol · A community network of verifiable match servers',
  headerRight: 'Version 1.0 · October 2026',
  contents: 'Contents',
};
const cfgPath = path.join(paperDir, 'build.json');
const cfg = { ...defaults, ...(fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {}) };
const cssString = (s) => JSON.stringify(s);

const md = new MarkdownIt({ html: true, typographer: true, linkify: false })
  .use(texmath, { engine: katex, delimiters: 'dollars', katexOptions: { throwOnError: false, strict: false, output: 'html' } });

const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/<[^>]+>/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

let body = md.render(fs.readFileSync(path.join(paperDir, 'paper.md'), 'utf8'));

// Ids on h2/h3 and a table of contents from them.
const toc = [];
body = body.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_, lvl, inner) => {
  const id = slug(inner) || `s${toc.length}`;
  toc.push({ lvl: Number(lvl), id, text: inner.replace(/<[^>]+>/g, '') });
  return `<h${lvl} id="${id}">${inner}</h${lvl}>`;
});

// Cover = everything before the first h2 plus the abstract (the first h2 section).
const h2s = [...body.matchAll(/<h2 id="[^"]*">/g)].map((m) => m.index);
const head = body.slice(0, h2s[0]);
const abstract = body.slice(h2s[0], h2s[1]);
const rest = body.slice(h2s[1]);
const tocHtml = toc.filter((t) => !/^(resumen|abstract)$/i.test(t.text.trim()))
  .map((t) => `<li class="toc-l${t.lvl}"><a href="#${t.id}">${t.text}</a></li>`).join('\n');

// Appendices start on a new page.
const restPaged = rest.replace(/<h2 id="((?:apendice|appendix)[^"]*)">/, '<h2 id="$1" class="newpage">');

const katexCss = fs.readFileSync(path.join(here, 'node_modules/katex/dist/katex.min.css'), 'utf8')
  .replace(/url\(fonts\//g, `url(${pathToFileURL(path.join(here, 'node_modules/katex/dist/fonts')).href}/`);
const css = fs.readFileSync(path.join(here, 'paper.css'), 'utf8') + `
@page { @top-left { content: ${cssString(cfg.headerLeft)}; } @top-right { content: ${cssString(cfg.headerRight)}; } }
@page :first { @top-left { content: none; } @top-right { content: none; } }`;

const html = `<!doctype html><html lang="${cfg.lang}"><head><meta charset="utf-8">
<title>${cfg.title}</title>
<meta name="author" content="${cfg.author}">
<style>${katexCss}</style><style>${css}</style></head><body>
<section class="cover">
  <div class="brandbar"></div>
  ${head}
  <div class="abstract">${abstract}</div>
</section>
<nav class="toc"><h2 class="toc-title">${cfg.contents}</h2><ol>${tocHtml}</ol></nav>
<main>${restPaged}</main>
</body></html>`;

const htmlPath = path.join(paperDir, 'paper.html');
fs.writeFileSync(htmlPath, html);

const pdf = printToPdf(htmlPath, outPdf, path.join(here, '.browser-profile'));
console.log('pdf:', pdf, fs.statSync(pdf).size, 'bytes');
