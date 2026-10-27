"""Cross-reference and numbering check for the English edition.

Usage: python xref.py <paper.md>
"""
import re
import sys
from collections import Counter

sys.stdout.reconfigure(encoding="utf-8")
src = open(sys.argv[1], encoding="utf-8").read()
lines = src.split("\n")

# Sections
secs = set()
for l in lines:
    m = re.match(r"^##+ (\d+(?:\.\d+)?)[. ]", l)
    if m:
        secs.add(m.group(1).rstrip("."))
apps = set(re.findall(r"^## Appendix ([A-E])\.", src, re.M))
print("sections:", len(secs), "appendices:", sorted(apps))

# Tags in order
tags = [int(t) for t in re.findall(r"\\tag\{(\d+)\}", src)]
print("tags:", tags == list(range(1, 41)), len(tags), tags if tags != list(range(1, 41)) else "")
tag_line = {}
for i, l in enumerate(lines, 1):
    for t in re.findall(r"\\tag\{(\d+)\}", l):
        tag_line[int(t)] = i

# Tables and figures
tabs = re.findall(r"^\*Table ([A-Z]?\.?\d+)\.", src, re.M)
print("tables:", tabs)
figs = re.findall(r"<figcaption>Figure (\d+)\.", src)
print("figures:", figs)
srcs = re.findall(r'<img src="([^"]+)"', src)
print("figure files:", srcs)

problems = []
# Section references
for i, l in enumerate(lines, 1):
    for m in re.finditer(r"\bSections? ((?:\d+(?:\.\d+)?)(?:(?:–|, | and | through | to |, and )\d+(?:\.\d+)?)*)", l):
        for n in re.findall(r"\d+(?:\.\d+)?", m.group(1)):
            if n not in secs:
                problems.append(f"L{i}: Section {n} missing ({m.group(0)})")
    for m in re.finditer(r"\bEquations? \((\d+)\)((?:,? (?:and )?\((\d+)\))*)", l):
        for n in re.findall(r"\((\d+)\)", m.group(0)):
            if int(n) not in tag_line:
                problems.append(f"L{i}: Equation {n} missing")
            elif tag_line[int(n)] > i and "below" not in l[m.end():m.end() + 10]:
                problems.append(f"L{i}: forward ref to Equation ({n}) at L{tag_line[int(n)]} :: {l[max(0, m.start()-30):m.end()+15]}")
    for m in re.finditer(r"\bEqs?\.", l):
        problems.append(f"L{i}: abbreviation Eq. used")
    for m in re.finditer(r"\bTables? ([A-Z]?\.?\d+)", l):
        if m.group(1) not in tabs:
            problems.append(f"L{i}: Table {m.group(1)} missing")
    for m in re.finditer(r"\bFigures? (\d+)", l):
        if m.group(1) not in figs:
            problems.append(f"L{i}: Figure {m.group(1)} missing")
    for m in re.finditer(r"\bAppendix ([A-Z])\b", l):
        if m.group(1) not in apps:
            problems.append(f"L{i}: Appendix {m.group(1)} missing")
    for m in re.finditer(r"\b(section|table|figure|equation|appendix|lemma|proposition) \(?\d", l):
        problems.append(f"L{i}: lowercase label: {m.group(0)}")
for p in problems:
    print(p)

# Which tables / figures / equations are referenced in the text
refs_t = Counter(re.findall(r"\bTables? (\d+)", src))
refs_f = Counter(re.findall(r"\bFigures? (\d+)", src))
refs_e = Counter(re.findall(r"\bEquations? \((\d+)\)", src) + re.findall(r"\band \((\d+)\)", src))
print("tables referenced:", sorted(refs_t, key=int))
print("figures referenced:", sorted(refs_f, key=int))
print("equations referenced:", sorted(refs_e, key=int))
