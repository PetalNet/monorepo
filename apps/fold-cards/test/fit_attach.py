"""Fit and check the recall gate's second stage on judged (prompt, attachment) pairs.

  python3 -I test/fit_attach.py --fixture recall_attach.json [--fit]

The fixture rows carry stage one's p1, the BM25 rank, the message's term count, a weight and a judged label (helpful).
Rows the old gate attached have weight 1; the rest are a sample of the near misses and carry the inverse sampling rate,
so weighted precision and recall estimate what the new gate would do over every candidate stage one lets through.
Stage two applies to the sources in memindex.STAGE_TWO (memory notes). It did nothing for cards: at every threshold
their precision stayed at stage one's, so cards keep stage one's threshold.

Without --fit it scores the shipped RESCORE and THRESHOLDS on the fixture and FAILs unless the precision of what attaches
beats the old gate by PRECISION_GAIN and at least KEEP_HELPFUL of the helpful pairs the old gate attached survive.
That check is in-sample: the shipped weights were fitted on every row, and the threshold, FLOOR and the feature set were
chosen on this same week. With --fit it refits the weights on 60% of the prompts and measures the other 40%, repeats
that over SPLITS random splits (one split moves precision by 0.1), and prints the weights fitted on every row. Only the
weights are held out there; a fresh week of judgements is the real test.
"""
import argparse, json, math, os, random, statistics, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'bin'))
import memindex

PRECISION_GAIN, KEEP_HELPFUL, SPLITS = 0.08, 0.6, 200
NAMES = ['logit', 'lexr', 'terms']


def load(path):
    rows = json.load(open(path))['rows']
    for r in rows:
        r['f'] = memindex.stage_two_features(dict(p1=r['p1'], lex_rank=r['lex_rank']), r['nterms'])
    return rows


def fit(rows, l2=3.0):
    """Weighted logistic regression by Newton steps; returns {bias, **weights}."""
    k = len(NAMES) + 1
    w = [0.0] * k
    for _ in range(60):
        g, H = [0.0] * k, [[0.0] * k for _ in range(k)]
        for r in rows:
            x = [1.0] + [r['f'][n] for n in NAMES]
            p = 1 / (1 + math.exp(-max(-30, min(30, sum(a * b for a, b in zip(w, x))))))
            for i in range(k):
                g[i] += r['weight'] * (r['helpful'] - p) * x[i]
                for j in range(k):
                    H[i][j] += r['weight'] * p * (1 - p) * x[i] * x[j]
        for i in range(1, k):
            H[i][i] += l2
            g[i] -= l2 * w[i]
        A = [H[i] + [g[i]] for i in range(k)]
        for i in range(k):
            piv = max(range(i, k), key=lambda r: abs(A[r][i]))
            A[i], A[piv] = A[piv], A[i]
            for r in range(k):
                if r != i:
                    m = A[r][i] / A[i][i]
                    A[r] = [a - m * b for a, b in zip(A[r], A[i])]
        d = [A[i][k] / A[i][i] for i in range(k)]
        w = [a + b for a, b in zip(w, d)]
        if max(map(abs, d)) < 1e-7:
            break
    return dict(zip(['bias', *NAMES], w))


def scorer(weights):
    return lambda r: 1 / (1 + math.exp(-(weights['bias'] + sum(weights[n] * r['f'][n] for n in NAMES))))


def attaches(r, score):
    t = memindex.THRESHOLDS[r['source']]
    return score(r) >= t if r['source'] in memindex.STAGE_TWO and r['p1'] >= memindex.FLOOR else r['source'] not in memindex.STAGE_TWO and r['p1'] >= t


def kept_by(rows, score):
    return [r for r in rows if attaches(r, score)]


def staged(rows):
    return [r for r in rows if r['source'] in memindex.STAGE_TWO and r['p1'] >= memindex.FLOOR]


def measure(rows, kept):
    """(precision, recall, helpful old-gate pairs kept, attachments relative to the old gate) over rows, weighted."""
    ks = {id(r) for r in kept}
    n, tp, pos = (sum(r['weight'] for r in rows if cond(r)) for cond in (lambda r: id(r) in ks, lambda r: id(r) in ks and r['helpful'], lambda r: r['helpful']))
    old = [r for r in rows if r['old_gate']]
    good = [r for r in old if r['helpful']]
    return tp / max(n, 1), tp / max(pos, 1), sum(id(r) in ks for r in good) / max(len(good), 1), len(ks) / max(len(old), 1)


def held_out(rows, splits=SPLITS):
    """Mean and spread of the shipped thresholds' held-out numbers over random 60/40 splits by prompt, weights refitted on
    each train part, for all sources and each one; the old gate first."""
    groups = sorted({r['group'] for r in rows})
    out = {}
    for seed in range(splits):
        random.Random(seed).shuffle(groups)
        train_groups = set(groups[:int(0.6 * len(groups))])
        test = [r for r in rows if r['group'] not in train_groups]
        s = scorer(fit(staged([r for r in rows if r['group'] in train_groups])))
        for src in (None, *sorted({r['source'] for r in rows})):
            part = [r for r in test if src is None or r['source'] == src]
            out.setdefault((src or 'all', 'old gate'), []).append(measure(part, [r for r in part if r['old_gate']]))
            out.setdefault((src or 'all', 'new gate'), []).append(measure(part, kept_by(part, s)))
    for (src, name), v in out.items():
        m = [statistics.mean(x[i] for x in v) for i in range(4)]
        print(f'{src:7s} {name:8s} precision {m[0]:.3f} (sd {statistics.pstdev(x[0] for x in v):.3f})  recall {m[1]:.3f}  helpful old-gate pairs kept {m[2]:.2f}  attachments x{m[3]:.2f}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fixture', required=True)
    ap.add_argument('--fit', action='store_true')
    a = ap.parse_args()
    rows = load(a.fixture)
    old = [r for r in rows if r['old_gate']]
    old_p = sum(r['helpful'] for r in old) / len(old)
    print(f'{len(rows)} pairs, {len({r["group"] for r in rows})} prompts; the old gate attached {len(old)} at precision {old_p:.3f}')
    if a.fit:
        held_out(rows)
        print('weights fitted on every row', {k: round(v, 3) for k, v in fit(staged(rows)).items()})
        return 0
    s = scorer(dict(bias=memindex.RESCORE['bias'], **{n: memindex.RESCORE[n] for n in NAMES}))
    for src in sorted({r['source'] for r in rows}):
        part = [r for r in rows if r['source'] == src]
        print(f'shipped {src:7s} precision {measure(part, kept_by(part, s))[0]:.3f}, old gate {sum(r["helpful"] for r in part if r["old_gate"]) / sum(r["old_gate"] for r in part):.3f}')
    prec, _, keep, volume = measure(rows, kept_by(rows, s))
    print(f'shipped all     precision {prec:.3f}, helpful old-gate pairs kept {keep:.2f}, attachments x{volume:.2f}')
    ok = prec >= old_p + PRECISION_GAIN and keep >= KEEP_HELPFUL
    print('OK' if ok else f'FAIL: need precision >= {old_p + PRECISION_GAIN:.3f} and helpful kept >= {KEEP_HELPFUL}')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
