"""Render PDF pages to PNG for visual review. Usage: python render.py <pdf> <out dir> [first] [last] [scale]"""
import sys, os
import pypdfium2 as pdfium

pdf_path, out_dir = sys.argv[1], sys.argv[2]
pdf = pdfium.PdfDocument(pdf_path)
n = len(pdf)
first = int(sys.argv[3]) if len(sys.argv) > 3 else 1
last = min(int(sys.argv[4]) if len(sys.argv) > 4 else n, n)
scale = float(sys.argv[5]) if len(sys.argv) > 5 else 1.4
os.makedirs(out_dir, exist_ok=True)
for i in range(first - 1, last):
    img = pdf[i].render(scale=scale).to_pil()
    img.save(os.path.join(out_dir, f"p{i + 1:02d}.png"))
print(f"{n} pages; rendered {first}-{last}")
