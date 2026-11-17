"""Speaker verification of the owner: EER on held-out notes vs other speakers, and a voice-clone attack.
Enrollment and every trained backend use TRAIN-split notes only; trials use TEST-split notes, unseen
LibriSpeech speakers and clones made from TEST-split references."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))  # shared common.py
import json, collections, numpy as np
from common import PRIV
OWNER = os.environ["JANET_WW_OWNER"]
rows = json.loads((PRIV / "sv_rows.json").read_text()); E = np.load(PRIV / "sv_embeddings.npz")
spk = np.array([r["spk"] for r in rows]); split = np.array([r["split"] for r in rows])
libri = sorted({s for s in spk if s.startswith("libri_")}); lib_cohort, lib_test = set(libri[:20]), set(libri[20:])
def eer(tar, non):
    s = np.concatenate([tar, non]); y = np.concatenate([np.ones(len(tar)), np.zeros(len(non))]); o = np.argsort(-s); y = y[o]
    fr = 1 - np.cumsum(y) / len(tar); fa = np.cumsum(1 - y) / len(non); i = np.argmin(np.abs(fr - fa))
    return float((fr[i] + fa[i]) / 2 * 100), float(s[o][i])
def thr_at_far(non, far): return float(np.quantile(non, 1 - far))
out = {}
for emb in E.files:
    X = E[emb]; X = X / np.linalg.norm(X, axis=1, keepdims=True)
    m = lambda cond: X[cond]
    enroll = m((spk == OWNER) & (split == "train")); c = enroll.mean(0); c /= np.linalg.norm(c)
    cohort = m(np.isin(spk, list(lib_cohort)) | ((spk != OWNER) & (split == "train") & ~np.char.startswith(spk, "clone") & ~np.char.startswith(spk, "libri")))
    tar = m((spk == OWNER) & (split == "test"))
    non_sets = {"other_household_speakers": m((spk != OWNER) & (split == "test") & ~np.char.startswith(spk, "clone") & ~np.char.startswith(spk, "libri")),
                "librispeech_unseen": m(np.isin(spk, list(lib_test)))}
    non = np.concatenate(list(non_sets.values()))
    clones = m(spk == "clone_owner"); clones_tr = m(spk == "clone_owner_trainref"); ctrl = m(spk == "clone_control")
    # backends
    cos = lambda Y: Y @ c
    cs = cohort @ c; mu_e, sd_e = cs.mean(), cs.std()
    def asnorm(Y, k=200):  # adaptive symmetric normalisation against the cohort
        s = Y @ c; ct = Y @ cohort.T; top = np.sort(ct, 1)[:, -k:]
        te = np.sort(cs)[-k:]
        return 0.5 * ((s - te.mean()) / te.std() + (s - top.mean(1)) / top.std(1))
    from sklearn.linear_model import LogisticRegression
    lr = LogisticRegression(C=1.0, max_iter=2000, class_weight="balanced").fit(np.concatenate([enroll, cohort]), np.r_[np.ones(len(enroll)), np.zeros(len(cohort))])
    logit = lambda Y: lr.decision_function(Y)
    lr2 = LogisticRegression(C=1.0, max_iter=2000, class_weight="balanced").fit(np.concatenate([enroll, cohort, clones_tr]), np.r_[np.ones(len(enroll)), np.zeros(len(cohort) + len(clones_tr))])
    logit_ac = lambda Y: lr2.decision_function(Y)
    for bname, f in (("cosine", cos), ("asnorm", asnorm), ("logreg", logit), ("logreg_clone_aware", logit_ac)):
        st, sn = f(tar), f(non); e, t_eer = eer(st, sn); t1 = thr_at_far(sn, 0.01)
        r = {"EER_%": round(e, 2), "trials": f"{len(st)} target / {len(sn)} non-target",
             "EER_vs_household_%": round(eer(st, f(non_sets['other_household_speakers']))[0], 2),
             "EER_vs_librispeech_%": round(eer(st, f(non_sets['librispeech_unseen']))[0], 2),
             "FRR_at_FAR1%_%": round(float((st < t1).mean() * 100), 1)}
        if len(clones):
            sc = f(clones); r["clones_accepted_at_EER_thr_%"] = round(float((sc >= t_eer).mean() * 100), 1)
            r["clones_accepted_at_FAR1%_thr_%"] = round(float((sc >= t1).mean() * 100), 1); r["n_clones"] = len(sc)
            r["clone_vs_owner_EER_%"] = round(eer(st, sc)[0], 1)  # can the score tell real owner from clone at all?
        if len(ctrl): r["control_clones_accepted_as_owner_at_EER_%"] = round(float((f(ctrl) >= t_eer).mean() * 100), 1)
        out[f"{emb}/{bname}"] = r
(PRIV / "sv_results.json").write_text(json.dumps(out, indent=1)); print(json.dumps(out, indent=1))
