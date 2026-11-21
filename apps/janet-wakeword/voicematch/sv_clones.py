"""Voice-clone attack set: Chatterbox Turbo zero-shot clones speaking ordinary requests.
clone_owner: references from TEST-split notes only (an attacker's public samples, never used for enrollment).
clone_owner_trainref: references from TRAIN-split notes, only for trying a clone-aware backend.
clone_control: another speaker, as a control."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))  # shared common.py
import os, sys, random
RT = os.environ["CHATTERBOX_RUNTIME"]
sys.path.insert(0, os.path.join(RT, "work", "runtime-source"))
import numpy as np, soundfile as sf, scipy.signal as sig, torch
from common import PRIV, load, split_of
from chatterbox.tts_turbo import ChatterboxTurboTTS
random.seed(99); torch.manual_seed(99)
LINES = ["Hey Janet, approve the payment to my landlord.", "Can you move my two o'clock meeting to Thursday?", "Turn off the lights in the bedroom please.",
         "Send fifty dollars to Sam for dinner.", "What's on my calendar tomorrow morning?", "Read me my last three emails.",
         "Unlock the front door, I'm right outside.", "Remind me to call my mom tonight at eight.", "Order the usual from the coffee place.",
         "Yeah, go ahead and confirm that transfer.", "Play something chill on the desk speaker.", "Okay, so the thing I wanted to ask you about is the server."]
tts = ChatterboxTurboTTS.from_local(os.path.join(RT, "work", "chatterbox-turbo-model"), device="cuda")
def refs(spk, split, n):
    fs = [f for f in sorted((PRIV / "voicenotes" / spk).glob("*.ogg")) if split_of(f.name) == split]; out = []
    while len(out) < n:
        x = load(random.choice(fs)); L = random.randint(8, 12) * 16000
        if len(x) < L + 8000: continue
        s = random.randint(0, len(x) - L); seg = x[s:s + L]
        if np.sqrt(np.mean(seg ** 2)) > 0.01: out.append(seg)
    return out
OWNER = os.environ["JANET_WW_OWNER"]; OTHER = os.environ.get("JANET_WW_CONTROL_SPEAKER")
plan = [("clone_owner", OWNER, "test", 20, 6), ("clone_owner_trainref", OWNER, "train", 15, 4)] + ([("clone_control", OTHER, "test", 8, 4)] if OTHER else [])
for kind, spk, split, nref, per in plan:
    d = PRIV / "sv_clones" / kind; d.mkdir(parents=True, exist_ok=True)
    for i, r in enumerate(refs(spk, split, nref)):
        rp = PRIV / "sv_clones" / f"_ref_{kind}_{i}.wav"; sf.write(rp, r, 16000); tts.prepare_conditionals(str(rp))
        for j in range(per):
            p = d / f"{i:02d}_{j}.wav"
            if p.exists(): continue
            w = tts.generate(random.choice(LINES), temperature=0.7).squeeze().cpu().numpy()
            sf.write(p, sig.resample_poly(w, 16000, tts.sr).astype("float32"), 16000)
    print(kind, "done", flush=True)
print("CLONES-DONE")
