"""Normalize the Spanish edition: retired terms to the current ones, a no-break space before %, and a narrow
no-break space as the thousands separator. Safe to re-run; run it after every edit of es/paper.md, because some
editors turn U+00A0 into a plain space. Usage: python harmonize_es.py <paper.md>"""
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
path = sys.argv[1]
text = open(path, encoding="utf-8").read()

literal = [
    ("ventana de ingreso", "ventana de conexión"),
    ("Ventana de ingreso", "Ventana de conexión"),
    ("ingreso 45 s", "conexión 45 s"),
    ("no se ganan jugando", "no se obtienen jugando"),
    ("nadie gana puntos todavía", "nadie recibe puntos todavía"),
    ("franja de carga", "franja de ocupación"),
    ("Franjas de carga", "Franjas de ocupación"),
]
for old, new in literal:
    n = text.count(old)
    text = text.replace(old, new)
    print(f"{n:3d}  {old!r} -> {new!r}")

# Prose only (outside $...$ math and `code`): no-break space before %, narrow no-break space as thousands separator.
out, pos = [], 0
for m in re.finditer(r"\$\$[\s\S]*?\$\$|\$[^$\n]*\$|`[^`\n]*`", text):
    out.append(("prose", text[pos:m.start()]))
    out.append(("keep", m.group()))
    pos = m.end()
out.append(("prose", text[pos:]))
pct = sep = 0
for i, (kind, chunk) in enumerate(out):
    if kind != "prose":
        continue
    chunk, a = re.subn(r"(\d) %", "\\1\u00a0%", chunk)
    chunk, b = re.subn(r"(?<![\w.])(\d{1,3}) (\d{3})(?![\w])", "\\1\u202f\\2", chunk)
    pct, sep = pct + a, sep + b
    out[i] = (kind, chunk)
text = "".join(c for _, c in out)
print(f"{pct:3d}  percent signs given a no-break space")
print(f"{sep:3d}  thousands separators made narrow no-break")
open(path, "w", encoding="utf-8", newline="\n").write(text)
