"""Split a paper into six parts at fixed section headings, or join them back.

split: python splitparts.py split <paper.md> <out dir>
join:  python splitparts.py join <parts dir> <paper.md>
Parts: 1 = title..section 3, 2 = sections 4-5, 3 = section 6, 4 = sections 7-9, 5 = sections 10-15, 6 = appendices.
"""
import os
import re
import sys

STARTS = [r"## 4\. ", r"## 6\. ", r"## 7\. ", r"## 10\. ", r"## (Appendix|Apéndice) A\. "]

mode, src, dst = sys.argv[1:4]
if mode == "split":
    lines = open(src, encoding="utf-8").read().split("\n")
    cuts = [0] + [next(i for i, l in enumerate(lines) if re.match(p, l)) for p in STARTS] + [len(lines)]
    os.makedirs(dst, exist_ok=True)
    for n in range(6):
        chunk = lines[cuts[n]:cuts[n + 1]]
        open(os.path.join(dst, f"part{n + 1}.md"), "w", encoding="utf-8", newline="\n").write("\n".join(chunk))
        print(f"part{n + 1}: lines {cuts[n] + 1}-{cuts[n + 1]}")
else:
    parts = [open(os.path.join(src, f"part{n}.md"), encoding="utf-8").read().rstrip("\n") for n in range(1, 7)]
    open(dst, "w", encoding="utf-8", newline="\n").write("\n\n".join(parts) + "\n")
    print("joined", dst)
