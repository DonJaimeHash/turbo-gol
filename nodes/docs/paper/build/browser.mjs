// Finds a Chromium-based browser and prints a local HTML page to PDF with it.
// PAPER_BROWSER overrides the search with the path of any Chromium-based browser executable.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const candidates = [
  process.env.PAPER_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function findBrowser() {
  const found = candidates.find((c) => c && fs.existsSync(c));
  if (!found) throw new Error('no Chromium-based browser found; set PAPER_BROWSER to its executable');
  return found;
}

// The browser can hand the job to a running instance and exit before the PDF exists, so wait until the file stops growing.
function waitForFile(f, ms = 90000) {
  const sleep = (t) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, t);
  let last = -1;
  for (let t = 0; t < ms; t += 500) {
    const size = fs.existsSync(f) ? fs.statSync(f).size : -1;
    if (size > 0 && size === last) return;
    last = size; sleep(500);
  }
  throw new Error(`no PDF after ${ms} ms: ${f}`);
}

export function printToPdf(htmlPath, pdfPath, profileDir) {
  const out = path.resolve(pdfPath);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(out, { force: true });
  execFileSync(findBrowser(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-pdf-header-footer',
    `--user-data-dir=${profileDir}`, '--virtual-time-budget=15000', '--run-all-compositor-stages-before-draw',
    `--print-to-pdf=${out}`, pathToFileURL(htmlPath).href,
  ], { stdio: 'ignore', timeout: 120000 });
  waitForFile(out);
  return out;
}
