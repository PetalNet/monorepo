"""Word-timestamp transcripts for every voice note (GPU). Output: private/transcripts/<speaker>/<id>.json
Notes are cut at quiet points into <=25 s pieces so memory stays bounded on long notes."""
import json, pathlib, numpy as np, torch
from transformers import pipeline
from common import PRIV, load, speakers
asr = pipeline("automatic-speech-recognition", model="openai/whisper-large-v3-turbo", dtype=torch.float16, device="cuda")
def pieces(x, sr=16000, maxlen=25.0):
    e = np.sqrt(np.convolve(x ** 2, np.ones(400) / 400, "same"))
    s, out = 0, []
    while s < len(x):
        if len(x) - s <= maxlen * sr: out.append((s, len(x))); break
        lo, hi = s + int(15 * sr), s + int(maxlen * sr)
        cut = lo + int(np.argmin(e[lo:hi])); out.append((s, cut)); s = cut
    return out
for spk in speakers():
    out = PRIV / "transcripts" / spk; out.mkdir(parents=True, exist_ok=True)
    for f in sorted((PRIV / "voicenotes" / spk).glob("*.ogg")):
        dst = out / (f.stem + ".json")
        if dst.exists(): continue
        x = load(f); words, text = [], []
        for a, b in pieces(x):
            r = asr({"raw": x[a:b], "sampling_rate": 16000}, return_timestamps="word", generate_kwargs={"language": "en"})
            text.append(r["text"])
            for c in r["chunks"]:
                s0, e0 = c["timestamp"]; e0 = s0 if e0 is None else e0
                words.append({"w": c["text"], "s": a / 16000 + s0, "e": a / 16000 + e0})
        torch.cuda.empty_cache()
        dst.write_text(json.dumps({"file": f.name, "seconds": len(x) / 16000, "text": " ".join(text), "words": words}))
        print(spk, f.name, round(len(x) / 16000), "s", len(words), "words", flush=True)
print("TRANSCRIBE-DONE")
