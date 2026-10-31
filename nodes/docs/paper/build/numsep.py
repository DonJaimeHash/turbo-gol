"""List prose numbers of five or more digits written without a thin space (U+202F).

Usage: python numsep.py <paper.md>
"""
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
lines = open(sys.argv[1], encoding="utf-8").read().split("\n")
in_math = False
hits = 0
for n, line in enumerate(lines, 1):
    if line.strip().startswith("$$"):
        in_math = not in_math if line.strip() == "$$" or not line.strip().endswith("$$") or line.strip() == "$$" else in_math
        continue
    if in_math:
        continue
    prose = re.sub(r"\$[^$]*\$", " ", line)
    prose = re.sub(r"`[^`]*`", " ", prose)
    for m in re.finditer(r"(?<![\w.#/-])\d{5,}(?!\w)|(?<![\w.])\d{1,3} \d{3}(?!\w)", prose):
        hits += 1
        print(n, repr(m.group()), "::", prose[max(0, m.start() - 40): m.end() + 10])
print("hits:", hits)
