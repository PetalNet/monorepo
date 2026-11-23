"""Export the chosen voice-match model (private biometric data): WeSpeaker ResNet-293 embedding (6 s max) ->
L2 normalise -> logistic backend trained on the owner's TRAIN notes vs cohort + train-ref clones.
Thresholds are fitted on the TEST trials of sv_eval and stated as such; use them as a starting point only."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))  # shared common.py
import json, os, numpy as np
from sklearn.linear_model import LogisticRegression
from common import PRIV
OWNER = os.environ["JANET_WW_OWNER"]
rows = json.loads((PRIV / "sv_rows.json").read_text()); X = np.load(PRIV / "sv_embeddings.npz")["wespeaker_full"]
X = X / np.linalg.norm(X, axis=1, keepdims=True); spk = np.array([r["spk"] for r in rows]); split = np.array([r["split"] for r in rows])
libri = sorted({s for s in spk if s.startswith("libri_")})[:20]
pos = (spk == OWNER) & (split == "train")
neg = np.isin(spk, libri) | ((split == "train") & (spk != OWNER) & ~np.char.startswith(spk, "clone") & ~np.char.startswith(spk, "libri")) | (spk == "clone_owner_trainref")
lr = LogisticRegression(C=1.0, max_iter=2000, class_weight="balanced").fit(X[pos | neg], pos[pos | neg].astype(int))
res = json.loads((PRIV / "sv_results.json").read_text())["wespeaker_full/logreg_clone_aware"]
d = PRIV / "voicematch"; d.mkdir(exist_ok=True)
np.savez(d / f"{OWNER}_wespeaker_r293_logreg.npz", coef=lr.coef_[0], intercept=lr.intercept_, enroll_centroid=X[pos].mean(0))
(d / "MODEL.json").write_text(json.dumps({"encoder": "WeSpeaker voxceleb_resnet293_LM.onnx (fbank80, 25/10 ms, CMN, no dither)",
    "input": "16 kHz mono, up to 6 s; 2 s works but EER roughly doubles", "score": "coef . normalise(embedding) + intercept",
    "trained_on": f"{int(pos.sum())} owner train segments vs {int(neg.sum())} cohort/clone segments", "test_metrics": res,
    "use": "trust-tier signal only; never approval for money (SPEC). Clones from 10 s of public audio pass it."}, indent=1))
print("exported", d)
