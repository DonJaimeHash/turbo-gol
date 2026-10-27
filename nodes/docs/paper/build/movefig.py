"""Move each <figure> line to just before a given heading. Usage: python movefig.py <paper.md> <fig file>=<heading> ..."""
import sys

path = sys.argv[1]
lines = open(path, encoding="utf-8").read().split("\n")
for spec in sys.argv[2:]:
    fig, heading = spec.split("=", 1)
    i = next(k for k, l in enumerate(lines) if l.startswith("<figure") and f"fig/{fig}" in l)
    figline = lines.pop(i)
    if lines[i] == "" and lines[i - 1] == "":
        lines.pop(i)
    j = next(k for k, l in enumerate(lines) if l.strip().startswith(heading))
    lines[j:j] = [figline, ""]
    print(f"{fig}: line {i + 1} -> before line {j + 1} ({heading})")
open(path, "w", encoding="utf-8", newline="\n").write("\n".join(lines))
