// Renders paper.md once with KaTeX in strict 'warn' mode and throwOnError, reporting math errors,
// strict-mode warnings and typographer replacements (©, ®, ™, ±, –, —) in the output. Writes nothing.
import fs from 'node:fs';
import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import katex from 'katex';

const src = fs.readFileSync(process.argv[2], 'utf8');
const errors = [];
const warns = [];
const origWarn = console.warn;
console.warn = (...a) => warns.push(a.join(' '));
const engine = {
  renderToString(tex, opts) {
    try {
      return katex.renderToString(tex, { ...opts, throwOnError: true, strict: 'warn' });
    } catch (e) {
      errors.push(`${e.message} :: ${tex.slice(0, 120)}`);
      return '';
    }
  },
};
const md = new MarkdownIt({ html: true, typographer: true, linkify: false })
  .use(texmath, { engine, delimiters: 'dollars', katexOptions: { output: 'html' } });
const out = md.render(src);
console.warn = origWarn;
console.log('math errors:', errors.length);
for (const e of errors) console.log('  ' + e);
console.log('strict warnings:', warns.length);
for (const w of warns.slice(0, 30)) console.log('  ' + w.slice(0, 200));
const text = out.replace(/<span class="katex[\s\S]*?<\/span><\/span><\/span>/g, '');
for (const ch of ['©', '®', '™', '±', '–', '—', '…']) {
  const n = text.split(ch).length - 1;
  if (n) console.log(`char ${ch}: ${n}`);
}
const dollars = (out.match(/\$/g) || []).length;
console.log('stray $ in output:', dollars);
