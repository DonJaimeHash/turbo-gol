"""Structural counts of a paper. Usage: python counts.py <paper.md>"""
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
t = open(sys.argv[1], encoding="utf-8").read()
lines = t.split("\n")
dd = [l for l in lines if l.strip().startswith("$$")]
print("h2", sum(l.startswith("## ") for l in lines), "h3", sum(l.startswith("### ") for l in lines))
print("display equations", len(dd) // 2, "tagged", len(re.findall(r"\\tag\{", t)))
print("tables", len(re.findall(r"^\*(?:Table|Tabla) ", t, re.M)), "figures", t.count("<figure>"))
print("table body rows", sum(1 for l in lines if l.startswith("|") and not l.startswith("|---")) - len(re.findall(r"^\*(?:Table|Tabla) ", t, re.M)))
print("list items", sum(1 for l in lines if re.match(r"^(- |\d+\. )", l)))
print("inline math", len(re.findall(r"(?<!\$)\$(?!\$)[^$\n]+?\$", t)))
