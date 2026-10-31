"""Report how full each page is and what it starts with. Usage: python pagefill.py <pdf> [first] [last]"""
import sys
import pypdfium2 as pdfium

sys.stdout.reconfigure(encoding="utf-8")
pdf = pdfium.PdfDocument(sys.argv[1])
first = int(sys.argv[2]) if len(sys.argv) > 2 else 1
last = int(sys.argv[3]) if len(sys.argv) > 3 else len(pdf)
for i in range(first - 1, min(last, len(pdf))):
    page = pdf[i]
    img = page.render(scale=0.5).to_pil().convert("L")
    w, h = img.size
    # Body area between the running header and the page number (22 mm top, 20 mm bottom margins on 297 mm).
    top, bottom = int(h * 24 / 297), int(h * 276 / 297)
    px = img.load()
    lowest = top
    for y in range(top, bottom):
        if any(px[x, y] < 200 for x in range(int(w * 0.07), int(w * 0.93), 2)):
            lowest = y
    fill = (lowest - top) / (bottom - top)
    text = page.get_textpage().get_text_range().strip().split("\n")
    head = next((l for l in text[1:] if l.strip()), "")[:70]
    print(f"p{i + 1:02d} fill={fill:4.0%}  {head}")
