import numpy as np
import pytest

from common import janet_events, split_of, windows, frame_end_time


def words(text, gap=0.1, dur=0.3):
    out, t = [], 0.0
    for w in text.split():
        out.append({"w": " " + w, "s": t, "e": t + dur})
        t += dur + gap
    return out


@pytest.mark.parametrize(
    "text, kinds",
    [
        ("hey janet turn on the fan", ["hey_janet"]),
        ("Hey, Janet, what time is it", ["hey_janet"]),
        ("Janet, can you check", ["janet"]),
        ("okay Janet play some music", ["janet"]),  # only 'hey' makes the wake phrase
        ("thank you Janet", ["janet"]),
        ("okay Jenna turn it off", ["fuzzy"]),  # a name Whisper may have misheard: unlabelled
        ("change the channel please", []),
        ("Janet's timer went off", ["janet"]),
    ],
)
def test_janet_events_label_the_wake_phrase_only(text, kinds):
    assert [k for k, _, _ in janet_events(words(text))] == kinds


def test_hey_too_far_before_janet_is_not_the_wake_phrase():
    w = [{"w": " hey", "s": 0.0, "e": 0.3}, {"w": " Janet", "s": 1.5, "e": 1.8}]
    assert [k for k, _, _ in janet_events(w)] == ["janet"]


def test_hey_janet_span_starts_at_hey():
    (kind, s, e), = janet_events(words("so hey janet"))
    assert kind == "hey_janet" and s == pytest.approx(0.4) and e == pytest.approx(1.1)


def test_windows_are_sixteen_consecutive_frames():
    f = np.arange(20 * 96, dtype=np.float32).reshape(20, 96)
    w = windows(f)
    assert w.shape == (5, 16, 96)
    assert np.array_equal(w[3], f[3:19])
    assert windows(f[:10]).shape == (0, 16, 96)


def test_frame_times_advance_80ms():
    assert frame_end_time(1) - frame_end_time(0) == pytest.approx(0.08)


def test_split_is_stable_and_roughly_quartered():
    names = [f"note-{i}.ogg" for i in range(4000)]
    s = [split_of(n) for n in names]
    assert s == [split_of(n) for n in names]
    assert 0.22 < s.count("test") / len(s) < 0.28 and 0.10 < s.count("val") / len(s) < 0.15
