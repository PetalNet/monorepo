"""Turn every audio source into labelled openWakeWord feature windows, split before augmentation.

Positives: windows whose last frame lands 0-0.32 s after the phrase ends.
Negatives: every other window of negative audio. Around a 'hey janet' or a fuzzy name (Jeanette, Janice...)
nothing is labelled, because the transcript can't be trusted there. Bare 'Janet' stays a hard negative."""
import json, random, sys, time, pathlib
import numpy as np, scipy.signal as sig
from common import ROOT, PRIV, DATA, SR, load, split_of, booth_split, janet_events, Featurizer, windows, frame_end_time, speakers
rng = np.random.default_rng(20261117); random.seed(20261117)
OUT = ROOT / "feats"; OUT.mkdir(exist_ok=True)
F = Featurizer()
T0 = time.time()
def log(*a): print(f"[{time.time()-T0:7.0f}s]", *a, flush=True)

RIRS = [load(p) for p in sorted((DATA / "rirs").glob("*.wav"))]
TR = {}  # transcripts
for spk in speakers():
    for p in (PRIV / "transcripts" / spk).glob("*.json"):
        TR[(spk, p.stem)] = json.loads(p.read_text())

def note_events(spk, stem):
    t = TR.get((spk, stem)); return janet_events(t["words"]) if t else None

# Background pool: train-split voice-note audio with every Janet-like region cut out, plus coloured noise.
BG = []
for spk in speakers():
    for f in sorted((PRIV / "voicenotes" / spk).glob("*.ogg")):
        if split_of(f.name) != "train": continue
        ev = note_events(spk, f.stem)
        if ev is None: continue
        x = load(f); keep = np.ones(len(x), bool)
        for _, s, e in ev: keep[max(0, int((s - 1) * SR)):int((e + 1) * SR)] = False
        BG.append(x[keep])
def colored(n):
    w = rng.standard_normal(n); k = rng.choice([0, 1, 2])  # white / pink / brown
    if k: w = sig.lfilter([1], [1, -0.98 if k == 1 else -0.999], w)
    return (w / (np.abs(w).max() + 1e-9)).astype(np.float32)
def background(n):
    if BG and rng.random() < 0.7:
        b = BG[rng.integers(len(BG))]
        if len(b) > n: s = rng.integers(len(b) - n); return b[s:s + n]
    return colored(n)

def augment(x, strength=1.0, speed=True):
    if speed and rng.random() < 0.5 * strength:
        f = rng.uniform(0.92, 1.08); x = sig.resample(x, int(len(x) / f)).astype(np.float32)
    if rng.random() < 0.6 * strength:
        h = RIRS[rng.integers(len(RIRS))]; y = sig.fftconvolve(x, h)[:len(x)]
        x = (y * (np.abs(x).max() / (np.abs(y).max() + 1e-9))).astype(np.float32)
    if rng.random() < 0.8 * strength:
        b = background(len(x)); snr = rng.uniform(3, 25)
        ps, pb = np.mean(x ** 2) + 1e-9, np.mean(b ** 2) + 1e-9
        x = x + b * np.sqrt(ps / pb / 10 ** (snr / 10))
    x = x * 10 ** (rng.uniform(-15, 6) / 20)
    return np.clip(x, -1, 1).astype(np.float32)

def speech_end(x):
    e = np.sqrt(np.convolve(x ** 2, np.ones(160) / 160, "same"))[::160]
    on = np.nonzero(e > max(e.max() * 0.1, 1e-4))[0]
    return (on[-1] + 1) * 0.01 if len(on) else len(x) / SR

def pos_windows(clip, t_end, aug):
    """Pad the phrase into context and keep windows that end 0-0.32 s after it."""
    if aug and rng.random() < 0.5:
        f = rng.uniform(0.92, 1.08); n = int(len(clip) / f)
        t_end *= n / len(clip); clip = sig.resample(clip, n).astype(np.float32)
    # A window spans 1.96 s of audio, so the phrase needs that much context before its end.
    lead, tail = int((max(0.0, 2.2 - t_end) + rng.uniform(0.0, 0.8)) * SR), int(0.6 * SR)
    x = np.concatenate([np.zeros(lead, np.float32), clip, np.zeros(tail, np.float32)])
    if aug: x = augment(x, speed=False)
    ph = int(rng.integers(0, 1280)); x = np.pad(x, (ph, 0))  # random frame phase
    t_end += (lead + ph) / SR
    w = windows(F.frames(x)); ends = np.array([frame_end_time(i + 15) for i in range(len(w))])
    sel = (ends >= t_end) & (ends <= t_end + 0.32)
    return w[sel]

def neg_windows(x, aug, exclude=(), stride=1):
    if len(x) < 3 * SR:  # short clip: give it the same leading context a positive gets
        x = np.concatenate([np.zeros(int(rng.uniform(1.6, 2.4) * SR), np.float32), x, np.zeros(int(0.5 * SR), np.float32)])
    if aug: x = augment(x, 0.8)
    w = windows(F.frames(x)); ends = np.array([frame_end_time(i + 15) for i in range(len(w))])
    keep = np.ones(len(w), bool)
    for s, e in exclude: keep &= ~((ends > s - 0.3) & (ends - 1.28 < e + 0.6))
    return w[keep][::stride]

STAGES = set(sys.argv[1:]) or {"booth", "notes", "chatterbox", "piper"}
store = {}
def add(name, w):
    if len(w): store.setdefault(name, []).append(w.astype(np.float16))
def flush():
    for k, v in store.items():
        a = np.concatenate(v); np.save(OUT / f"{k}.npy", a); log("saved", k, a.shape)

# 1. Booth clips: saved per clip so train.py can hold out the October split or any CV fold.
(OUT / "booth").mkdir(exist_ok=True)
for p in [] if "booth" not in STAGES else sorted((PRIV / "booth").glob("*.wav")):
    if p.name.startswith("pos_17"): continue  # near-silent, excluded as in October
    x = load(p); pos = p.name.startswith("pos")
    w = [pos_windows(x, speech_end(x), True) if pos else neg_windows(x, True) for k in range(60)]
    np.save(OUT / "booth" / (p.stem + ".npy"), np.concatenate(w).astype(np.float16))
log("booth done")

# 2. Voice notes: train/val notes become features; test notes are left as raw audio for evaluate.py
counts = {}
for spk in speakers() if "notes" in STAGES else ():
    for f in sorted((PRIV / "voicenotes" / spk).glob("*.ogg")):
        sp = split_of(f.name); ev = note_events(spk, f.stem)
        if ev is None or sp == "test": continue
        x = load(f); hj = [(s, e) for k, s, e in ev if k == "hey_janet"]
        fz = [(s, e) for k, s, e in ev if k == "fuzzy"]
        counts[f"{sp}_{spk}_hey_janet"] = counts.get(f"{sp}_{spk}_hey_janet", 0) + len(hj)
        for s, e in hj:
            seg = x[max(0, int((s - 0.3) * SR)):int((e + 0.1) * SR)]
            for k in range(60 if sp == "train" else 4):
                add(f"{sp}_pos_notes", pos_windows(seg, (e - max(0, s - 0.3)), sp == "train"))
        add(f"{sp}_neg_notes", neg_windows(x, False, hj + fz))
        if sp == "train":
            for k in range(2): add("train_neg_notes", neg_windows(x, True, hj + fz, stride=2))
    log("notes done", spk, counts)

# 3. Synthetic: Chatterbox (speaker-matched) and Piper (multi-speaker)
man = json.loads((PRIV / "synth" / "manifest.json").read_text()) if "chatterbox" in STAGES else []
for m in man:
    x = load(m["file"]); kind = m["kind"]
    sp = "val" if int(pathlib.Path(m["file"]).stem) % 10 == 0 else "train"
    if kind == "janet_neg":  # sentence index >= 24 is held out entirely for test
        if int(pathlib.Path(m["file"]).stem) % 1000 >= 24: continue
        for k in range(3): add(f"{sp}_neg_janet", neg_windows(x, True))
    elif kind.endswith("_pos"):
        for k in range(3): add(f"{sp}_pos_clone", pos_windows(x, speech_end(x), True))
    else:
        for k in range(3): add(f"{sp}_neg_clone", neg_windows(x, True))
log("chatterbox done")
pos_files = sorted((ROOT / "synth_piper" / "pos").rglob("*.wav")) if "piper" in STAGES else []
neg_files = sorted((ROOT / "synth_piper" / "neg").rglob("*.wav")) if "piper" in STAGES else []
for i, p in enumerate(pos_files):
    x = load(p); sp = "val" if i % 10 == 0 else "train"
    add(f"{sp}_pos_piper", pos_windows(x, speech_end(x), True))
for i, p in enumerate(neg_files):
    x = load(p); sp = "val" if i % 10 == 0 else "train"
    add(f"{sp}_neg_piper", neg_windows(x, True, stride=2))
log("piper done")
flush()
if counts:
    (OUT / "counts.json").write_text(json.dumps(counts, indent=1))
log("BUILD-DONE", counts)
