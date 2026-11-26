"""Verify that weak subdivisions produce no keys, even with a sharp onset."""
from pathlib import Path
import sys

import numpy as np

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'analysis'))
from phrase_accents import performance_masks


def selected(amplitudes, gain, period):
    sr = 22050
    times = .35 + np.arange(len(amplitudes)) * period
    signal = np.zeros(round((times[-1] + .8) * sr))
    local = np.arange(round(.18 * sr)) / sr
    for i, (time, amplitude) in enumerate(zip(times, amplitudes)):
        frequency = [392, 440, 523.25, 466.16][i % 4]
        tone = sum(np.sin(2*np.pi*h*frequency*local) * np.exp(-(10+h)*local)/h for h in (1, 2, 3, 4))
        start = round(sr * time)
        signal[start:start+len(tone)] += gain*amplitude*(1-np.exp(-380*local))*tone
    hits = [{'t': t} for t in times]
    release, weak = performance_masks(hits, signal, sr)
    return np.flatnonzero(~(release | weak)).tolist()


for gain in (.08, .7):
    assert selected([1,.18,1,.2,.2,1,.65,1,.2,1,.5,1], gain, .24) == [0,2,5,6,7,9,10,11]
    assert selected([1,.14,.14,.14]*5, gain, .24) == [0,4,8,12,16]
    assert selected([.9]*4 + [.2]*8, gain, .24) == list(range(12))

print('Isolated weak notes, repeated weak subdivisions, quieter phrase passed.')
