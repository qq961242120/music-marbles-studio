"""Check repeated piano attacks and a deliberately empty beat."""
from pathlib import Path
import sys

import numpy as np

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "analysis"))
from analyze import measure_attacks

sr = 22050
# A different tempo, key, level and sustain for each take. The empty beat is a
# real absence in the waveform, even though both sides establish the pulse.
for period, root_pitch, gain in [(.205, 48, .55), (.32, 56, .06)]:
    times = .4 + np.arange(15) * period
    y = np.zeros(round((times[-1] + 1) * sr), dtype=np.float32)
    local = np.arange(int(.75 * sr)) / sr
    expected = np.delete(times, 8)
    for i, t in enumerate(times):
        if i == 8:
            continue
        for offset in [0, 4, 7]:
            note = root_pitch + offset + (i % 3) * 2
            f = 440 * 2**((note - 69) / 12)
            z = sum(np.sin(2*np.pi*f*h*local)*np.exp(-(4+h)*local)/h
                    for h in [1, 2, 3, 4, 6])
            start = round(t * sr)
            y[start:start+len(local)] += gain*.2*(1-np.exp(-500*local))*z
    attacks, expression = measure_attacks(y, sr)
    found = np.array([t for t, _ in attacks])
    for t in expected:
        assert np.count_nonzero(abs(found-t) < .035) == 1, (period, t, found)
    assert np.min(abs(found-times[8])) > period*.4, ('empty beat', times[8])
    assert np.all(found < times[-1]+.09), 'extra impact in the decaying tail'
    assert sum(value >= .6 for value in expression.values()) >= 4

print('Repeated chords, a silent beat, soft take and decay passed.')
