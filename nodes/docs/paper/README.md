# Community paper (draft)

*Turbogol: A Community Network of Verifiable Match Servers* explains to the community how community nodes and verifiers work: the deterministic simulation they rest on, the mathematical model (verification sampling, detection, reputation, placement, server points), the architecture, and the roadmap.

**This is a working draft, not the public release.** Edit it here; the version to publish will be cut from these sources once it is final.

## Editions

| Folder | Edition |
|---|---|
| `en/` | English. **Canonical:** every change starts here. |
| `es/` | Spanish. A faithful translation of the English edition; update it after the English change, using [GLOSSARY.md](GLOSSARY.md). |

Each edition has its own `paper.md`, its own translated figures in `fig/` (same file names in both), and a `build.json` with the title, running headers, and table-of-contents label. Equation, table, figure, and section numbers are identical in both editions.

| Path | Contents |
|---|---|
| `GLOSSARY.md` | Binding term map (Spanish ↔ English), notation map, English style rules, and the Spanish edition's conventions |
| `build/` | Build script, stylesheet, and the check and layout tools listed below |
| `out/` | Built PDFs (not versioned) |

## Building the PDFs

You need Node.js 24, a Chromium-based browser (Edge or Chrome; set `PAPER_BROWSER` to its executable if it is not found), and, for the check tools, Python 3 with `build/requirements.txt`.

```bash
cd nodes/docs/paper/build
npm install
npm run build
```

`npm run build` writes both PDFs to `out/`; `npm run build:en` and `npm run build:es` build one edition. The build renders Markdown and KaTeX math to a single HTML page (`paper.html`, next to `paper.md`) and prints it with the headless browser. Page breaks were tuned with the Windows fonts the stylesheet names first (Cambria, Bahnschrift, Segoe UI, Consolas); with other fonts the pagination changes.

## Editing rules

- **Cover:** `#` title, then a bold subtitle paragraph, then the meta line (version · date · project). The first `##` section is the abstract and must be titled exactly `## Abstract` / `## Resumen` (it is left out of the table of contents). The first appendix heading must start with `## Appendix` / `## Apéndice` (it starts a new page).
- **Typography:** markdown-it's typographer is on, so never write `(c)`, `(r)`, `(tm)`, `+-`, or `--` in prose; type `±`, `–`, `—`, and `…` directly.
- **Math:** `$…$` inline and `$$…$$` display, rendered with KaTeX. Numbered equations use `\tag{n}`; keep the numbers identical in both editions.
- **Tables:** the caption is an italic paragraph right after the table (`*Table 7. …*` / `*Tabla 7. …*`).
- **Figures:** `<figure><img src="fig/…svg" alt="…"><figcaption>…</figcaption></figure>` on one line. A figure change must be made in both `en/fig/` and `es/fig/`.
- **Layout:** browser printing has no floating figures, so a tall figure can leave a half-empty page. Move the figure (`movefig.py`) and check with `pagefill.py` and the contact sheets. `<div class="keep">…</div>` keeps a lead-in sentence on the same page as the equation it introduces; `<div style="break-before: page"></div>` forces a page break.
- **Vocabulary:** the paper never uses the vocabulary of digital currencies, never presents server points as money, and never names the commercial game that inspired Turbogol, its publisher, or third-party vendors. [GLOSSARY.md](GLOSSARY.md) section A.14 lists the traps and the wording to use; `forbidden.py` scans for them.
- **Spanish:** run `harmonize_es.py` after every edit of `es/paper.md`. It restores the no-break spaces that some editors drop and rewrites retired terms.

## Checks and tools

Run from `build/`:

| Command | Purpose |
|---|---|
| `npm run check:math` | KaTeX errors, strict-mode warnings, typographer replacements, and stray `$` (the English edition has one legitimate one, in “US$”) |
| `npm run check:overflow` | Equations, tables, figures, and code blocks wider than the text column (build first) |
| `python forbidden.py ../en/paper.md ../es/paper.md ../en/fig/*.svg ../es/fig/*.svg` | Vocabulary scan; each hit needs a human look |
| `python numsep.py <paper.md>` | Numbers of five or more digits without a narrow no-break thousands separator |
| `python xref.py ../en/paper.md` | Cross-references and numbering of sections, tables, figures, and equations |
| `python counts.py <paper.md>` | Headings, equations, tables, figures, and rows; must match between editions |
| `python harmonize_es.py ../es/paper.md` | Normalizes the Spanish edition (see Editing rules) |
| `python pagefill.py <pdf>` | How full each page is, to find half-empty pages |
| `python render.py <pdf> <png dir>` and `python sheet.py <png dir> <sheet dir>` | Page images and contact sheets for visual review |
| `python pdftext.py <pdf> <txt>` | Text of the built PDF |
| `python movefig.py <paper.md> <fig file>=<heading>` | Moves a figure to just before the line that starts with `<heading>` |
| `python splitparts.py split <paper.md> <dir>` / `join <dir> <paper.md>` | Splits a paper into six parts at fixed section headings, and joins them back |

## State of this draft

Built from these sources: English 55 pages, Spanish 57; 40 numbered equations; Tables 1–17 plus A.1, B.1, and D.1; Figures 1–4. Math, overflow, number-separator, and vocabulary checks are clean.

Before publishing:

- Review three points the editorial review settled on its own: the condition in Section 5.6 (after a no-show, abandon penalties apply only if at least one player did send a WebRTC offer), the seven new rows of Table B.1, and the key-rotation wording in Table 15.
- Set the version and date on the cover (`paper.md`) and in the running header (`build.json`) of both editions.
