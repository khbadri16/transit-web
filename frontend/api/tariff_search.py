"""
Lightweight lexical search over the structured Algerian tariff dataset.

Loads tariff_dataset.json (built by Web/tariff-tools/build_tariff_dataset.py)
once per process and answers `top_candidates(query, k)` in ~1ms without any
external dependency. Scoring is BM25-flavoured TF-IDF over accent-stripped
French tokens from designation + context, with a small boost for matches in
the designation itself.
"""

import json
import math
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

_DATASET_PATHS = [
    Path(__file__).resolve().parent / "tariff_dataset.json",
    Path(__file__).resolve().parent.parent.parent / "tariff-tools" / "tariff_dataset_v2.json",
]

_WORD_RE = re.compile(r"[a-z0-9]{2,}")

_STOP = {
    "de", "des", "du", "la", "le", "les", "et", "ou", "en", "un", "une", "d",
    "l", "a", "au", "aux", "pour", "par", "sur", "dans", "avec", "sans",
    "autres", "autre", "meme", "que", "non", "type", "types", "leurs", "leur",
}


def _norm(text):
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.lower()
    # Repair DGD-site mojibake where '?' replaced an accent or apostrophe:
    #   "d?une"/"l?annexe" (elision)  -> "d une"
    #   "c?ramique"/"rev?tement" (é/ê) -> "ceramique"/"revetement"
    text = re.sub(r"\b([dl])\?(?=[a-z])", r"\1 ", text)
    text = re.sub(r"(?<=[a-z])\?(?=[a-z])", "e", text)
    return text


def _tokens(text):
    return [t for t in _WORD_RE.findall(_norm(text)) if t not in _STOP]


class TariffIndex:
    def __init__(self, path=None):
        p = Path(path) if path else next((p for p in _DATASET_PATHS if p.exists()), None)
        if p is None:
            raise FileNotFoundError("tariff_dataset.json not found")
        data = json.loads(p.read_text(encoding="utf-8"))
        self.meta = data.get("meta", {})
        self.entries = data["entries"]
        self.df = Counter()
        self.postings = defaultdict(list)          # token -> [(idx, weight)]
        for i, e in enumerate(self.entries):
            desig_toks = _tokens(e.get("designation", ""))
            ctx_toks = _tokens(e.get("context", ""))
            weights = Counter()
            for t in desig_toks:
                weights[t] += 2.0                  # own designation
            for t in ctx_toks:
                weights[t] += 1.8                  # hierarchy context carries the
                                                   # discriminating family words
            for t, w in weights.items():
                self.postings[t].append((i, w))
                self.df[t] += 1
        self.n = len(self.entries)

    def top_candidates(self, query, k=15):
        q = _tokens(query)
        if not q:
            return []
        scores = defaultdict(float)
        for t in q:
            # exact token, plus cumulative prefix fallback across lengths
            # (helps singular/plural and stems: pneus -> pneumatiques)
            # exact match PLUS prefix siblings — singular/plural/stem variants
            # ("moteur" must also reach "moteurs"), glued mojibake included
            found = set()
            for plen in (6, 5, 4, 3):
                if plen == 3 and len(t) != 3:
                    continue                       # 3-char prefix only for 3-char words
                if len(t) >= plen and len(found) < 2:
                    found.update(
                        k for k in self.postings if k.startswith(t[:plen]))
            found.discard(t)
            keys = ([t] if t in self.postings else []) \
                + sorted(found, key=lambda k: -self.df[k])[:10]
            for key in keys:
                idf = math.log(1 + self.n / (1 + self.df[key]))
                partial = 1.0 if key == t else 0.6
                for i, w in self.postings[key]:
                    scores[i] += idf * w * partial
        ranked_all = sorted(scores.items(), key=lambda x: -x[1])
        # diversity: cap results per 4-digit position so one family cannot
        # flood the whole candidate list
        per_family, cap = defaultdict(int), max(3, k // 3)
        ranked, overflow = [], []
        for i, s in ranked_all:
            fam = self.entries[i]["code"][:4]
            if per_family[fam] < cap:
                per_family[fam] += 1
                ranked.append((i, s))
            else:
                overflow.append((i, s))
            if len(ranked) >= k:
                break
        for pair in overflow:                      # fill remainder if short
            if len(ranked) >= k:
                break
            ranked.append(pair)
        out = []
        for i, s in ranked:
            e = self.entries[i]
            out.append({
                "code": e["code"],
                "code_dotted": e.get("code_dotted", ""),
                "designation": e.get("designation", ""),
                "context": e.get("context", "")[:160],
                "dd": e.get("dd", ""), "tva": e.get("tva", ""),
                "score": round(s, 2),
            })
        return out


_index = None


def get_index():
    global _index
    if _index is None:
        _index = TariffIndex()
    return _index


if __name__ == "__main__":
    import sys
    idx = get_index()
    print(f"index: {idx.n} entries | meta: {idx.meta.get('built_at')}")
    query = " ".join(sys.argv[1:]) or "climatiseur split system"
    for c in idx.top_candidates(query, 8):
        print(f"{c['score']:7.2f}  {c['code_dotted']:15s} {c['designation'][:70]}")
