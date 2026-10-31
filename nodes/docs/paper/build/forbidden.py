"""Case-insensitive scan for vocabulary the paper avoids, including substrings.

Usage: python forbidden.py <file> [<file> ...]
Every hit needs a human look: a few are legitimate (a database transaction, infrastructure cost,
"a fork of the code", the sentence saying points are not money). GLOSSARY.md section A.14 lists the
usual traps and the wording to use instead.
"""
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
pats = [
    r"block ?chain", r"chain", r"crypto", r"token", r"ledger", r"wallet", r"mining", r"miner", r"\bmint",
    r"stak(e|ing)", r"slash", r"consensus", r"decentrali[sz]", r"trustless", r"smart contract", r"\bgas\b",
    r"merkle", r"\bnft", r"airdrop", r"validat", r"proof[ -]of[ -](work|stake)", r"bitcoin", r"ethereum",
    r"satoshi", r"white ?paper", r"sybil", r"\bcoins?\b", r"coin", r"on-chain", r"off-chain", r"oracle",
    r"yield", r"payout", r"tokenomic", r"settle", r"liquidat", r"nonce", r"hard fork", r"\bjwt\b",
    r"income", r"earn", r"reward", r"\bpa(y|id|ys|ying|yment)\b", r"\bbalance", r"\bprice", r"\bcosts?\b",
    r"transaction", r"\bfork", r"wager", r"\bbet\b",
    r"\binvest", r"\bprofit", r"\bfee\b", r"\bfees\b", r"cloudflare", r"\bsell", r"\bbuy", r"\bbought",
    r"\bsold\b", r"transfer", r"exchange", r"\btrad(e|ed|ing)\b", r"\bmoney",
]
for f in sys.argv[1:]:
    text = open(f, encoding="utf-8").read()
    for i, line in enumerate(text.split("\n"), 1):
        for p in pats:
            for m in re.finditer(p, line, re.I):
                s = max(0, m.start() - 50)
                print(f"{f.split('/')[-1]}:{i}: [{p}] …{line[s:m.end() + 40]}…")
