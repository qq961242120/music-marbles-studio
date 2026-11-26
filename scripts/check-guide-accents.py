"""An exit must wait for a phrase accent; onset detection alone cannot authorize a key."""
import sys
from pathlib import Path
import numpy as np

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "analysis"))
from analyze import select_guide_exit_accents

sr = 22050


def perform(notes, gain=1):
    times, amplitudes = np.transpose(notes)
    y = np.zeros(int(sr*(times[-1]+.4)), dtype=np.float32)
    local = np.arange(int(.17*sr))/sr
    for t, amp in notes:
        a = round(t*sr)
        y[a:a+len(local)] += gain*amp*(1-np.exp(-200*local))*np.exp(-9*local)*np.sin(2*np.pi*440*local)
    hits = [dict(t=float(t),beat=True) for t in times]
    # Equal spectral strengths deliberately make the quiet pickup look like a
    # clean, on-grid onset. Its low musical level must still suppress the plate.
    kept, skipped = select_guide_exit_accents(hits, np.ones(len(hits)), y, sr)
    return [h['t'] for h in kept], skipped


notes=[(.15,.6),(.45,.45),(.75,.6),(2.0,.17),(2.26,.18),(2.52,.64),(2.80,.2),(3.08,.48)]
for gain in (1.,.1):
    kept,skipped=perform(notes,gain)
    assert skipped==[2.,2.26],skipped
    assert kept==[.15,.45,.75,2.52,2.80,3.08],kept
# A quiet but clearly led new phrase and a definite immediate exit both survive.
assert perform([(.1,.7),(.4,.6),(1.55,.20),(1.80,.14),(2.05,.13),(2.30,.15)])[1]==[]
assert perform([(.1,.65),(.4,.6),(1.6,.61),(2.0,.45)])[1]==[]
# No substitute landing is synthesized if weak notes are all that remains.
assert perform([(.12,.6),(.40,.56),(1.55,.08),(1.8,.06)])[0]==[.12,.40]
print('Weak post-guide pickups skipped, softer new phrase preserved, and no synthetic terminal key.')
