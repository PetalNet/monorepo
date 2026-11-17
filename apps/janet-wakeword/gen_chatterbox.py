"""Speaker-matched synthetic clips with the local Chatterbox Turbo (no download).
Positives/near-misses cloned from TRAIN-split voice notes only; Janet's own voice for self-wake negatives."""
import os, sys, random, json
RT = os.environ["CHATTERBOX_RUNTIME"]  # the voice-runtime directory (see apps/chatterbox-wyoming)
sys.path.insert(0, os.path.join(RT, "work", "runtime-source"))
import numpy as np, soundfile as sf, torch, scipy.signal as sig
from common import PRIV, load, split_of, speakers
from chatterbox.tts_turbo import ChatterboxTurboTTS, Conditionals
OUT = PRIV / "synth"; REF = PRIV / "refs"
random.seed(1117); torch.manual_seed(1117)

POS = ["Hey Janet.", "Hey Janet!", "Hey, Janet.", "Hey Janet?", "hey janet", "Hey Janet...", "Heyy Janet.", "Hey, Janet!"]
NEAR = ["Hey Jane.", "Hey Janice.", "Hey Jenny.", "Janet.", "Janet, hold on.", "Hey jacket.", "Hey, can it?",
        "The planet.", "Hey Jeanette.", "Hey Jenna.", "Hey channel.", "Hey Jarvis.", "Hey dad.", "Hey, wait.",
        "Okay and it.", "Hey Jan.", "Say it again.", "Hey, did you get it?", "I was talking to Janet earlier.",
        "Hey Janelle.", "A janitor.", "Hey Garnet.", "Hey, granite.", "Hey Bennett.", "Hey Kenneth.",
        "Hey, get it.", "Hey, Daniel.", "They ate it.", "Hey, dinner.", "Ask Janet.", "Thanks Janet.", "Hey Jeff."]
JANET_SAYS = [
 "The kitchen lights are off and the door is locked.", "Your next class starts at two, and it's about a ten minute walk.",
 "I added that to your list. Anything else?", "The planet Venus is bright in the evening sky tonight.",
 "Jane and Jenny said they'd be over for dinner around seven.", "Hey, quick heads up: your package arrived.",
 "I'm Janet. I can help with lights, music, your calendar, and reminders.", "Okay, I set a timer for ten minutes.",
 "It's forty two degrees and cloudy. You might want a jacket.", "Hey there! What can I do for you?",
 "I didn't catch that. Could you say it again?", "Playing your focus playlist on the desk speaker.",
 "Janet here. The server backup finished without errors.", "Got it, I'll remind you when you get home.",
 "The channel is quiet right now, nothing new since this morning.", "Say the word and I'll start it.",
 "Here's the plan: dinner at six, then the study group at eight.", "Hey, did you get my last message?",
 "I checked the traffic. It's about twelve minutes to campus.", "That's done. The thermostat is set to sixty eight.",
 "Hmm, I'm not sure. Let me look that up for you.", "The side lamp is on; I'll leave it alone.",
 "Planet Earth is about ninety three million miles from the sun.", "Okay and it's on your calendar for Friday.",
 "Hey, it looks like the printer finished your job.", "I can tell you more if you want the details.",
 "Good morning! You have two meetings and a lab today.", "Sure, turning on the fan.", "Janet's on it.",
 "Hey, the laundry should be done.", "Not a girl, not a robot. Just Janet.", "Hello! Ask me anything.",
]

def pick_refs(spk, n):
    n = int(os.environ.get(f"JANET_WW_REFS_{spk.upper()}", n))
    """n random 8-12 s reference snippets from TRAIN-split notes of one speaker."""
    REF.mkdir(parents=True, exist_ok=True)
    files = [f for f in sorted((PRIV / "voicenotes" / spk).glob("*.ogg")) if split_of(f.name) == "train"]
    refs = []
    for k in range(n * 3):
        if len(refs) >= n: break
        f = random.choice(files); x = load(f)
        L = random.randint(8, 12) * 16000
        if len(x) < L + 16000: continue
        s = random.randint(0, len(x) - L); seg = x[s:s + L]
        if np.sqrt(np.mean(seg ** 2)) < 0.01: continue
        p = REF / f"{spk}_{k:03d}.wav"; sf.write(p, seg, 16000); refs.append(p)
    return refs

tts = ChatterboxTurboTTS.from_local(os.path.join(RT, "work", "chatterbox-turbo-model"), device="cuda")
janet = Conditionals.load(os.path.join(RT, "outputs", "voice", "voice-conditionals.pt")).to("cuda")
manifest = []
def emit(kind, idx, text, cond_note):
    d = OUT / kind; p = d / f"{idx:05d}.wav"
    if p.exists(): return  # resumable: clips already on disk are kept
    wav = tts.generate(text, temperature=random.uniform(0.6, 0.9)).squeeze().cpu().numpy()
    y = sig.resample_poly(wav, 16000, tts.sr).astype("float32")
    d.mkdir(parents=True, exist_ok=True); sf.write(p, y, 16000)
    manifest.append({"kind": kind, "file": str(p), "text": text, "ref": cond_note})

# The owner (JANET_WW_OWNER) gets the most cloned clips; everyone else a smaller share.
OWNER = os.environ["JANET_WW_OWNER"]
plan = [(OWNER, 50, 12, 16)] + [(s, 25, 8, 8) for s in speakers() if s != OWNER and len(list((PRIV / "voicenotes" / s).glob("*.ogg"))) >= 10]
for spk, nref, npos, nneg in plan:
    for r_i, ref in enumerate(pick_refs(spk, nref)):
        tts.prepare_conditionals(str(ref))
        for j in range(npos): emit(f"{spk}_pos", r_i * 100 + j, random.choice(POS), ref.name)
        for j in range(nneg): emit(f"{spk}_neg", r_i * 100 + j, random.choice(NEAR), ref.name)
        print("ref done", spk, r_i, flush=True)
tts.conds = janet
for rep in range(3):
    for i, t in enumerate(JANET_SAYS):
        emit("janet_neg", rep * 1000 + i, t, "janet-voice-conditionals")
print("janet done", flush=True)
# The manifest is rebuilt from disk so a resumed run lists every clip, not only this run's.
manifest = [{"kind": d.name, "file": str(f)} for d in sorted(OUT.iterdir()) if d.is_dir() for f in sorted(d.glob("*.wav"))]
(OUT / "manifest.json").write_text(json.dumps(manifest))
print("GEN-DONE", len(manifest))
