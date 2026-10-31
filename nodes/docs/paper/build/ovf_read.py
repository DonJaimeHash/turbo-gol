"""Print the overflow report that overflow.mjs printed into check.pdf."""
import sys, re, pypdf
sys.stdout.reconfigure(encoding='utf-8')
t = "\n".join(p.extract_text() for p in pypdf.PdfReader(sys.argv[1]).pages[:5])
m = re.search(r"OVF-BEGIN([\s\S]*?)OVF-END", t)
print(m.group(1).strip() if m else "no result")
