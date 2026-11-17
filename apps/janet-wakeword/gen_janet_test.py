"""Held-out Janet-voice test speech: sentences built from templates that share no sentence with training."""
import os, sys, random
RT = os.environ["CHATTERBOX_RUNTIME"]
sys.path.insert(0, os.path.join(RT, "work", "runtime-source"))
import numpy as np, soundfile as sf, scipy.signal as sig, torch
from common import PRIV
from chatterbox.tts_turbo import ChatterboxTurboTTS, Conditionals
random.seed(2026); torch.manual_seed(2026)
subj = ["the hallway light", "your desk lamp", "the bedroom fan", "the coffee maker", "the printer", "the backup job", "your calendar", "the dryer"]
verb = ["is on", "finished", "is off", "needs attention", "is paused", "just started", "looks fine", "is running late"]
tail = ["", " Want me to change that?", " I'll keep an eye on it.", " Nothing else is pending.", " That's all for now."]
named = ["I'm Janet, and I'm here whenever you need me.", "Janet speaking. I've updated the shopping list.", "This is Janet: the weather turns rainy at four.",
         "Jane called while you were out.", "The planet Mars rises around nine tonight.", "Grab a jacket, it's windy.", "The channel you asked about posted twice.",
         "Hey, I found three restaurants nearby.", "Hey! Your timer is done.", "Hey there, the movie starts in ten minutes.", "Janice and Jenny both replied.",
         "Janet's notes are saved in the shared folder.", "Hey, just a reminder about the meeting.", "Did you get it? The file should be in your inbox."]
lines = [f"{random.choice(subj).capitalize()} {random.choice(verb)}.{random.choice(tail)}" for _ in range(50)] + named
tts = ChatterboxTurboTTS.from_local(os.path.join(RT, "work", "chatterbox-turbo-model"), device="cuda")
tts.conds = Conditionals.load(os.path.join(RT, "outputs", "voice", "voice-conditionals.pt")).to("cuda")
out = PRIV / "synth_test" / "janet"; out.mkdir(parents=True, exist_ok=True)
for i, t in enumerate(lines):
    p = out / f"{i:04d}.wav"
    if p.exists(): continue
    w = tts.generate(t, temperature=0.75).squeeze().cpu().numpy()
    sf.write(p, sig.resample_poly(w, 16000, tts.sr).astype("float32"), 16000)
print("JANET-TEST-DONE", len(lines))
