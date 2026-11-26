"""Exercise stereo decode, onset detection and accent selection through the export analyser."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import wave

import numpy as np

root = Path(__file__).resolve().parents[1]
sr = 22050
times = .35 + .30 * np.arange(10)
melody = [523.25, 698.46, 1567.98, 587.33, 698.46, 1567.98, 587.33, 932.33, 523.25, 698.46]
amplitudes = [.35, .35, .24, .26, .35, .24, .26, .035, .35, .35]
local = np.arange(int(.23 * sr)) / sr
signals = np.zeros((int(3.6 * sr), 2), dtype=np.float32)
for t, f, a in zip(times, melody, amplitudes):
    tone = np.sin(2*np.pi*f*local) + .22*np.sin(4*np.pi*f*local)
    note = a * tone * (1-np.exp(-700*local)) * np.exp(-13*local)
    i = round(t * sr)
    signals[i:i+len(note)] += note[:, None]

with tempfile.TemporaryDirectory() as tmp:
    wavpath, planpath = Path(tmp)/'stereo.wav', Path(tmp)/'plan.json'
    for mode in ['centred', 'opposed-high-note', 'opposed-track']:
        sound = signals.copy()
        if mode == 'opposed-high-note':
            i = round(times[5] * sr)
            sound[i:i+len(local), 1] *= -1
        elif mode == 'opposed-track':
            sound[:, 1] *= -1
        with wave.open(str(wavpath), 'wb') as stream:
            stream.setparams((2, 2, sr, 0, 'NONE', 'not compressed'))
            stream.writeframes(np.rint(sound * 32767).astype('<i2').tobytes())
        subprocess.run([sys.executable, root/'analysis/analyze.py', wavpath, planpath,
                        '--ffmpeg', root/'node_modules/ffmpeg-static/ffmpeg'], check=True, stdout=subprocess.DEVNULL)
        found = np.array([h['t'] for h in json.loads(planpath.read_text())['hits']])
        expected = np.delete(times, 7)  # real, much weaker pickup
        assert len(found) == len(expected) and np.max(abs(expected-found)) < .03, (mode, found)
        if mode == 'centred':
            centred = found
        else:
            assert np.allclose(found, centred, atol=.006, rtol=0), (mode, found, centred)

print('Centred and out-of-phase notes verified, weak pickup excluded.')
