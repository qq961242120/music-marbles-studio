"""Check automatic collisions against the authored melody, independent of the detector."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as tmp:
    plan = Path(tmp) / 'plan.json'
    subprocess.run([sys.executable, root / 'analysis/analyze.py', root / 'test-assets/夜航-原创测试曲.wav',
                    plan, '--ffmpeg', root / 'node_modules/ffmpeg-static/ffmpeg'], check=True)
    times = np.array([hit['t'] for hit in json.loads(plan.read_text())['hits']])

# Taken from the note scheduler in make-test-song.py. The softer hi-hats in
# between these notes are intentional distractors for the marble choreography.
melody = []
time = 0.45
while time < 8.1:
    melody.append(time)
    subdivision = 0.5 if (len(melody) - 1) % 4 in (1, 2) else 1
    time += 60 / 128 * subdivision

def check_phrase(expected, start, end):
    actual = times[(times >= start) & (times <= end)]
    if not len(actual):
        return 0, 0
    distances = np.abs(np.asarray(expected)[:, None] - actual)
    return len(actual), int(np.count_nonzero(distances.min(axis=1) <= 2 / 30))

total, matched = check_phrase(melody, 0.38, 8.08)
assert matched >= len(melody) - 1 and total - matched <= 2, (total, matched)
fast_total, fast_matched = check_phrase(8.25 + np.arange(16) * 0.115, 8.15, 10.02)
assert fast_matched >= 15 and fast_total - fast_matched <= 1, (fast_total, fast_matched)
assert not np.any((times > 10.7) & (times < 14)), 'Sustain or release produced a false hit'
print(f'Opening melody {matched}/{len(melody)}, extra hits {total - matched}; fast run {fast_matched}/16; sustain clear.')
