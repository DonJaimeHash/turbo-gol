"""Tile rendered pages into contact sheets. Usage: python sheet.py <png dir> <out dir> [per sheet] [cols]"""
import sys, os, glob
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
per = int(sys.argv[3]) if len(sys.argv) > 3 else 6
cols = int(sys.argv[4]) if len(sys.argv) > 4 else 3
files = sorted(glob.glob(os.path.join(src, 'p*.png')))
os.makedirs(out, exist_ok=True)
for s in range(0, len(files), per):
    imgs = [Image.open(f) for f in files[s:s + per]]
    w, h = imgs[0].size
    rows = (len(imgs) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * w + (cols - 1) * 8, rows * h + (rows - 1) * 8), (120, 120, 120))
    for i, im in enumerate(imgs):
        sheet.paste(im, ((i % cols) * (w + 8), (i // cols) * (h + 8)))
    sheet.save(os.path.join(out, f"s{s // per + 1:02d}.png"))
print(len(files), 'pages')
