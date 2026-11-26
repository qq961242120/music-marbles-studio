"""Check a new melody note over a ringing predecessor across pitches and dynamics."""
from pathlib import Path
import sys

import numpy as np

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'analysis'))
from phrase_accents import performance_masks


def check_phrase(base_hz, direction, gain, middle):
    sr = 22050
    times = [.20, .48, .72, 1.02, 1.31, 1.59, 1.85, 2.12, 2.40]
    semitones = [7, 2, 5, 0, 2, 5, 7, 0, 4]
    dynamics = [.65, .58, .55, .37, .24, .60, .55, .60, .60]
    sound = np.zeros(round(3.6 * sr))
    local = np.arange(round(.95 * sr)) / sr
    for i, (t, step, amplitude) in enumerate(zip(times, semitones, dynamics)):
        frequency = base_hz * 2**(direction * step/12)
        envelope = (1-np.exp(-500*local)) * np.exp(-4*local)
        if i == 4:
            if middle == 'weak':
                amplitude = .065
            elif middle == 'brief':
                envelope *= np.exp(-70*local)
            elif middle == 'resonance':
                amplitude = 0
        tone = sum(a * np.sin(2*np.pi*h*frequency*local) for h,a in [(1,1), (2,.56), (3,.26)])
        start = round(t * sr)
        sound[start:start+len(tone)] += gain * amplitude * envelope * tone
    release, weak = performance_masks([{'t':t} for t in times], sound, sr)
    assert bool((release | weak)[4]) == (middle != 'lead'), (base_hz, direction, gain, middle)


for base_hz, direction, gain in [(293.665, 1, .6), (440., -1, .08)]:
    for middle in ['lead', 'weak', 'brief', 'resonance']:
        check_phrase(base_hz, direction, gain, middle)

print('Rising and falling held notes, softer accompaniment, brief blips and resonance passed.')
