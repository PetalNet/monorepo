"""Adapt the 'hey Janet' openWakeWord head to its owner. Default: warm start from the deployed model's weights,
small constant learning rate, positives ~10% of each batch, heavy negative weight, so the deployed model's
quietness carries over and only the owner's voice and near-misses move it.
Checkpoints are compared at a fixed threshold on VAL only (test data is never loaded here)."""
import argparse, hashlib, json, time, numpy as np, torch
from common import ROOT, DATA, booth_split, booth_folds
ap = argparse.ArgumentParser()
ap.add_argument("run"); ap.add_argument("--fold", type=int, default=-1, help="-1: hold out October's booth split; 0-3: CV fold")
ap.add_argument("--init", default=str(ROOT / "baseline" / "baseline_weights.npz"), help="npz to start from; 'none' = from scratch")
ap.add_argument("--steps", type=int, default=6000); ap.add_argument("--lr", type=float, default=5e-5)
ap.add_argument("--negw", type=float, default=10.0); ap.add_argument("--freeze-layer1", action="store_true")
ap.add_argument("--acavw", type=float, default=50.0, help="weight on general-audio negatives (default: --negw)")
ap.add_argument("--mine", type=int, default=5000, help="hardest general-audio windows to oversample (0 = off)")
ap.add_argument("--distill", type=float, default=1.0, help="weight of matching the starting model's scores on general audio")
ap.add_argument("--fa-bar", type=float, default=0.3, help="max false accepts per hour on val natural audio at the chosen threshold")
a = ap.parse_args()
RUN = ROOT / "runs" / a.run; RUN.mkdir(parents=True, exist_ok=True)
torch.manual_seed(7); rng = np.random.default_rng(7); dev = "cuda"; FE = ROOT / "feats"
held = {n for n, s in booth_split().items() if s == "test"} if a.fold < 0 else {n for n, f in booth_folds().items() if f == a.fold}
def ld(n):
    p = FE / f"{n}.npy"; return np.load(p) if p.exists() else np.zeros((0, 16, 96), np.float16)
# Of the remaining booth takes, 3 positives and 2 negatives (by hash) are val, so selection hears the owner's real voice.
rest = sorted((p for p in (FE / "booth").glob("*.npy") if p.stem + ".wav" not in held), key=lambda p: hashlib.sha256(p.stem.encode()).hexdigest())
bval = [p for p in rest if p.stem.startswith("pos")][:3] + [p for p in rest if p.stem.startswith("neg")][:2]
btr = [p for p in rest if p not in bval]
cat = lambda ps: np.concatenate([np.load(p) for p in ps]) if ps else np.zeros((0, 16, 96), np.float16)
acav = np.load(DATA / "acav_slice.npy", mmap_mode="r"); A_VAL = 300000
train = {  # name: (array, label, per-batch count) -- positives ~10% of the batch
    "pos_real": (np.concatenate([cat([p for p in btr if p.stem.startswith("pos")]), ld("train_pos_notes")]), 1, 48),
    "pos_clone": (ld("train_pos_clone"), 1, 24), "pos_piper": (ld("train_pos_piper"), 1, 32),
    "neg_real": (cat([p for p in btr if p.stem.startswith("neg")]), 0, 24), "neg_notes": (ld("train_neg_notes"), 0, 160),
    "neg_janet": (ld("train_neg_janet"), 0, 96), "neg_clone": (ld("train_neg_clone"), 0, 64), "neg_piper": (ld("train_neg_piper"), 0, 64),
    "acav": (acav[:-A_VAL], 0, 512)}
train = {k: v for k, v in train.items() if len(v[0])}
print("held", sorted(held), "booth val", [p.stem for p in bval], {k: len(v[0]) for k, v in train.items()}, flush=True)
gpu = {k: torch.from_numpy(np.asarray(v[0], np.float16)).to(dev) for k, v in train.items()}
hard = None  # indices of the general-audio windows the current head scores highest (hard-negative mining)
val_pos = {"real": np.concatenate([cat([p for p in bval if p.stem.startswith("pos")]), ld("val_pos_notes")]), "clone": ld("val_pos_clone"), "piper": ld("val_pos_piper")}
from common import windows
oww = np.load(DATA / "validation_set_features.npy", mmap_mode="r")
oww_val = windows(np.asarray(oww[:len(oww) // 2], np.float32)).astype(np.float16)  # first half = val; second half is test-only
val_nat_parts = {"notes": ld("val_neg_notes"), "janet": ld("val_neg_janet"), "acav": np.asarray(acav[-A_VAL:]), "oww_first_half": oww_val}
val_nat = np.concatenate(list(val_nat_parts.values()))
val_near = np.concatenate([ld("val_neg_clone"), ld("val_neg_piper"), cat([p for p in bval if p.stem.startswith("neg")])])
HOURS = len(val_nat) * 0.08 / 3600

class Net(torch.nn.Module):  # parameter names match the deployed ONNX/TFLite head
    def __init__(s, h=32):
        super().__init__(); s.layer1 = torch.nn.Linear(1536, h); s.layernorm1 = torch.nn.LayerNorm(h)
        b = torch.nn.Module(); b.fcn_layer = torch.nn.Linear(h, h); b.layer_norm = torch.nn.LayerNorm(h)
        s.blocks = torch.nn.ModuleList([b]); s.last_layer = torch.nn.Linear(h, 1)
    def forward(s, x):
        x = torch.relu(s.layernorm1(s.layer1(x.flatten(1))))
        for b in s.blocks: x = torch.relu(b.layer_norm(b.fcn_layer(x)))
        return torch.sigmoid(s.last_layer(x)).squeeze(-1)
net = Net().to(dev)
if a.init != "none":
    W = np.load(a.init); net.load_state_dict({k: torch.from_numpy(W[k]) for k in W.files if not k.startswith("probe")})
params = [p for n, p in net.named_parameters() if not (a.freeze_layer1 and n.startswith("layer1."))]
opt = torch.optim.Adam(params, lr=a.lr)

@torch.no_grad()
def score(x):
    net.eval(); out = [net(torch.from_numpy(np.asarray(x[i:i + 8192], np.float32)).to(dev)).cpu().numpy() for i in range(0, len(x), 8192)]
    net.train(); return np.concatenate(out) if out else np.zeros(0)
GRID = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97]
def events_per_hour(s, hours):  # threshold crossings with 2 s refractory, like the test metric
    n, cool = 0, 0
    for v in s:
        if cool > 0: cool -= 1
        elif v: n += 1; cool = 25
    return n / hours
def evaluate():
    """Lowest threshold on the grid whose val false accepts/hour (events) stay under --fa-bar, and recall there."""
    nat = {k: score(v) for k, v in val_nat_parts.items()}; pos = {k: score(v) for k, v in val_pos.items() if len(v)}; near = score(val_near)
    for t in GRID:
        fa = sum(events_per_hour(nat[k] >= t, 1.0) for k in nat) / HOURS
        if fa <= a.fa_bar: break
    r = {"thr": t, "fa_per_hour_natural": fa, **{f"recall_{k}": float((v >= t).mean()) for k, v in pos.items()}, "near_miss_accept": float((near >= t).mean())}
    r["false_events"] = {k: int(events_per_hour(v >= t, 1.0)) for k, v in nat.items()}
    return r
start = evaluate(); print("init", json.dumps(start), flush=True)
bar = a.fa_bar
import copy; teacher = copy.deepcopy(net).eval()
best, log, t0 = None, [], time.time()
for step in range(a.steps):
    xs, ys, ws = [], [], []
    for k, (arr, lab, n) in train.items():
        if k == "acav" and hard is not None:
            idx = torch.cat([torch.randint(0, len(arr), (n // 2,), device=dev), hard[torch.randint(0, len(hard), (n - n // 2,), device=dev)]])
        else:
            idx = torch.randint(0, len(arr), (n,), device=dev)
        x = gpu[k][idx].float(); wneg = (a.acavw or a.negw) if k == "acav" else a.negw
        xs.append(x); ys.append(torch.full((n,), float(lab), device=dev)); ws.append(torch.full((n,), 1.0 if lab else wneg, device=dev))
    x, y, w = torch.cat(xs), torch.cat(ys), torch.cat(ws)
    loss = (torch.nn.functional.binary_cross_entropy(net(x).clamp(1e-6, 1 - 1e-6), y, reduction="none") * w).mean()
    if a.distill:  # stay close to the starting model's opinion on general audio (logit space)
        g = xs[list(train).index("acav")]; lg = lambda m: torch.logit(m(g).clamp(1e-6, 1 - 1e-6))
        with torch.no_grad(): tl = lg(teacher)
        loss = loss + a.distill * ((lg(net) - tl) ** 2).mean()
    opt.zero_grad(); loss.backward(); opt.step()
    if a.mine and step % 500 == 0:
        with torch.no_grad():
            net.eval(); sc_all = torch.cat([net(gpu["acav"][i:i + 16384].float()) for i in range(0, len(gpu["acav"]), 16384)]); net.train()
        hard = torch.topk(sc_all, a.mine).indices
    if (step + 1) % 500 == 0:
        r = evaluate(); ok = r["fa_per_hour_natural"] <= bar
        sc = np.mean([v for k, v in r.items() if k.startswith("recall")]) + r.get("recall_real", 0) - r["near_miss_accept"]
        log.append({"step": step + 1, "loss": float(loss.detach()), **r, "within_fa_bar": ok, "score": float(sc)})
        print(json.dumps(log[-1]), f"{time.time()-t0:.0f}s", flush=True)
        if ok and (best is None or sc > best[0]): best = (sc, step + 1, {k: v.detach().cpu().clone() for k, v in net.state_dict().items()})
if best is None:
    print("NO-CHECKPOINT within the FA bar; saving the last step for diagnosis only", flush=True)
    best = (None, a.steps, {k: v.detach().cpu().clone() for k, v in net.state_dict().items()}); RUN = RUN.with_name(RUN.name + "_REJECTED"); RUN.mkdir(exist_ok=True)
net.load_state_dict(best[2]); net.cpu().eval()
probe = np.random.default_rng(0).standard_normal((32, 16, 96)).astype(np.float32)
with torch.no_grad(): py = net(torch.from_numpy(probe)).numpy()
np.savez(RUN / "weights.npz", probe_x=probe, probe_y=py, **{k: v.numpy() for k, v in best[2].items()})
json.dump({"args": vars(a), "best_step": best[1], "fa_bar": bar, "val_hours": HOURS, "init_eval": start, "log": log}, open(RUN / "train.json", "w"), indent=1)
print("TRAIN-DONE best step", best[1], flush=True)
