// Lists display equations, tables, figures and code blocks wider than the printed text column.
// Usage: node overflow.mjs <paper dir>   (run build.mjs first; it writes the paper.html this reads)
// Headless --dump-dom can print nothing, so the probe writes its findings into the page, which is printed and read back.
// PYTHON overrides the interpreter that runs ovf_read.py (it needs pypdf).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { printToPdf } from './browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2];
const probe = fs.readFileSync(path.join(here, 'ovf_probe.js'), 'utf8');
const html = fs.readFileSync(path.join(dir, 'paper.html'), 'utf8')
  .replace('<body>', () => `<body style="width:168mm;margin:0"><pre id="ovf" style="white-space:pre-wrap;font:8pt monospace"></pre><script>${probe}</script>`);
const page = path.join(dir, 'paper.check.html');
fs.writeFileSync(page, html);

const pdf = printToPdf(page, path.join(here, 'check.pdf'), path.join(here, '.browser-profile'));
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
console.log(execFileSync(python, [path.join(here, 'ovf_read.py'), pdf], { encoding: 'utf8' }));
fs.rmSync(pdf, { force: true });
