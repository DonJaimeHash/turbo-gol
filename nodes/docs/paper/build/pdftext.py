"""Dump all text of a PDF to a UTF-8 file. Usage: python pdftext.py <pdf> <out txt>"""
import sys, pypdf
open(sys.argv[2], 'w', encoding='utf-8').write("\n".join(p.extract_text() for p in pypdf.PdfReader(sys.argv[1]).pages))
