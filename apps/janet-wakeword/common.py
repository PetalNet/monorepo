"""Shared paths, splits, audio IO and openWakeWord feature extraction for the hey-janet retrain."""
import hashlib, json, os, pathlib, re
import numpy as np, soundfile as sf, scipy.signal as sig

ROOT = pathlib.Path(os.environ.get("JANET_WW_ROOT", "janet-ww-data")).resolve()
PRIV = ROOT / "private"            # personal audio: keep on the training machine, never commit it
DATA = ROOT / "data"
SR = 16000
HOP = 1280                         # one openWakeWord embedding frame = 80 ms
WIN = 16                           # classifier input = 16 frames = 1.28 s

def speakers():
    """Speaker names are the subdirectories of private/voicenotes (one folder of voice notes per person)."""
    return sorted(p.name for p in (PRIV / "voicenotes").iterdir() if p.is_dir())

def load(path, sr=SR):
    x, r = sf.read(str(path), dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    return sig.resample_poly(x, sr, r).astype("float32") if r != sr else x

def to_pcm(x):
    return (np.clip(x, -1, 1) * 32767).astype(np.int16)

def split_of(name):
    """Whole-recording split, fixed before any augmentation: 25% test, ~12% val, rest train."""
    h = int(hashlib.sha256(name.encode()).hexdigest()[:8], 16) % 8
    return "test" if h < 2 else "val" if h == 2 else "train"

# Booth clips: keep October's frozen holdout so old/new numbers are comparable on identical files.
def booth_split():
    s = json.loads((ROOT / "baseline" / "split.json").read_text())
    return {n: "test" for n in s["holdout"]} | {n: "train" for n in s["train"]}

def booth_folds(k=4):
    """Cross-validation folds over every usable booth clip (pos and neg stratified). Fold -1 = October split."""
    names = sorted(p.name for p in (PRIV / "booth").glob("*.wav") if not p.name.startswith("pos_17"))
    out = {}
    for kind in ("pos", "neg"):
        g = sorted((n for n in names if n.startswith(kind)), key=lambda n: hashlib.sha256(n.encode()).hexdigest())
        for i, n in enumerate(g): out[n] = i % k
    return out

HEY = {"hey", "hay", "heh", "hei"}
JANET = re.compile(r"^janet[.,!?']*s?$")
FUZZY = re.compile(r"^(jan|jane|janie|janice|jeanette|janette|jenna|jenny|jennet|genet|janetta|gianni|jared|jen|jenn|jeanine|janine|janell|janelle|jana|janus|jeannette|jennette)[.,!?']*$")

def norm(w):
    return re.sub(r"[^a-z']", "", w.lower())

def janet_events(words):
    """Classify every Janet-like word in a word-timestamped transcript.
    Returns [(kind, start, end)] with kind in {'hey_janet', 'janet', 'fuzzy'}."""
    out = []
    for i, w in enumerate(words):
        t = w["w"].strip().lower()
        if JANET.match(norm(t)) or norm(t) in ("janet", "janets"):
            prev = words[i - 1] if i else None
            hey = prev is not None and norm(prev["w"]) in HEY and (w["s"] - prev["e"]) < 0.6
            out.append(("hey_janet" if hey else "janet", prev["s"] if hey else w["s"], w["e"]))
        elif FUZZY.match(norm(t)):
            out.append(("fuzzy", w["s"], w["e"]))
    return out

class Featurizer:
    """openWakeWord's frozen melspectrogram + speech-embedding front end (same ONNX files the runtime uses)."""
    def __init__(self, device="cpu"):
        from openwakeword.utils import AudioFeatures
        m = DATA / "oww_models"
        self.f = AudioFeatures(melspec_model_path=str(m / "melspectrogram.onnx"),
                               embedding_model_path=str(m / "embedding_model.onnx"),
                               inference_framework="onnx", device=device, ncpu=8)
    def frames(self, x):
        """Embedding frames (n, 96) for a float waveform; frame k covers audio ending at ~ (k*8+76)*10 ms."""
        if len(x) < SR:  # shorter than one embedding window: pad with silence instead of failing
            x = np.pad(x, (0, SR - len(x)))
        return self.f._get_embeddings(to_pcm(x)).astype(np.float32)

def windows(frames):
    """All 16-frame classifier inputs from a frame sequence -> (n, 16, 96); index i ends at frame i+15."""
    if len(frames) < WIN:
        return np.zeros((0, WIN, 96), np.float32)
    idx = np.arange(WIN)[None, :] + np.arange(len(frames) - WIN + 1)[:, None]
    return frames[idx]

def frame_end_time(i):
    """Seconds at which embedding frame i ends (76 mel frames of 10 ms, hop 8)."""
    return (i * 8 + 76) * 0.01 + 0.015
