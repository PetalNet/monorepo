"""Speaker embeddings for every segment with two pretrained encoders:
WeSpeaker ResNet-293-LM (ONNX, VoxCeleb2-trained, ~0.5% EER on Vox1-O) and SpeechBrain ECAPA-TDNN (~0.8%).
Each segment is embedded whole (<=6 s) and as a 2 s crop (about what a 'hey Janet, ...' turn gives)."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))  # shared common.py
import json, sys, numpy as np, torch, torchaudio, onnxruntime as ort, soundfile as sf
from common import ROOT, PRIV, load
SV = ROOT / "sv_data"; rows = json.loads((PRIV / "sv_segments.json").read_text())
# public impostors: LibriSpeech test-clean, up to 30 utterances per speaker, cropped to 6 s
lib = sorted((SV / "LibriSpeech" / "test-clean").glob("*/*/*.flac"))
by = {}
for p in lib: by.setdefault(p.parts[-3], []).append(p)
for spk, ps in sorted(by.items()):
    for p in ps[:30]: rows.append({"spk": "libri_" + spk, "split": "libri", "file": str(p), "sec": None})
for kind in ("clone_owner", "clone_owner_trainref", "clone_control"):  # written by sv_clones.py when present
    for p in sorted((PRIV / "sv_clones" / kind).glob("*.wav")): rows.append({"spk": kind, "split": "clone", "file": str(p), "sec": None})
print(len(rows), "segments", flush=True)

sess = ort.InferenceSession(str(SV / "resnet293_LM.onnx"), providers=["CPUExecutionProvider"])
iname = sess.get_inputs()[0].name
def wespeaker(x):
    f = torchaudio.compliance.kaldi.fbank(torch.from_numpy(x)[None] * 32768, num_mel_bins=80, frame_length=25, frame_shift=10,
                                          dither=0.0, sample_frequency=16000, window_type="hamming", use_energy=False)
    f = f - f.mean(0, keepdim=True)
    return sess.run(None, {iname: f[None].numpy()})[0][0]
from speechbrain.inference.speaker import EncoderClassifier
ecapa = EncoderClassifier.from_hparams(source=str(SV / "ecapa"), savedir=str(SV / "ecapa"), run_opts={"device": "cuda"})
def ecapa_emb(x):
    with torch.no_grad(): return ecapa.encode_batch(torch.from_numpy(x)[None].cuda()).squeeze().cpu().numpy()
out = {k: [] for k in ("wespeaker_full", "wespeaker_2s", "ecapa_full", "ecapa_2s")}
for i, r in enumerate(rows):
    x = load(r["file"])[:6 * 16000].astype(np.float32)
    mid = max(0, len(x) // 2 - 16000); c = x[mid:mid + 32000]
    out["wespeaker_full"].append(wespeaker(x)); out["wespeaker_2s"].append(wespeaker(c))
    out["ecapa_full"].append(ecapa_emb(x)); out["ecapa_2s"].append(ecapa_emb(c))
    if i % 200 == 0: print(i, flush=True)
np.savez(PRIV / "sv_embeddings.npz", **{k: np.stack(v) for k, v in out.items()})
(PRIV / "sv_rows.json").write_text(json.dumps(rows)); print("EMBED-DONE")
