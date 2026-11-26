#!/usr/bin/env python3
"""Synthesize an original, lyric-free acceptance track with contrasting rhythm."""

from pathlib import Path
import numpy as np
import wave as wav

SR = 44100
DURATION = 26.4
rng = np.random.default_rng(20261125)
audio = np.zeros((int(SR * DURATION), 2), dtype=np.float64)


def add_tone(start, duration, midi, gain=0.18, pan=0.0, kind="pluck"):
    count = min(int(duration * SR), len(audio) - int(start * SR))
    if count <= 0:
        return
    t = np.arange(count) / SR
    frequency = 440 * 2 ** ((midi - 69) / 12)
    if kind == "pluck":
        wave = np.sin(2 * np.pi * frequency * t) + 0.36 * np.sin(2 * np.pi * frequency * 2.01 * t) + 0.14 * np.sin(2 * np.pi * frequency * 3.98 * t)
        envelope = (1 - np.exp(-t * 90)) * np.exp(-t * 4.8 / max(duration, 0.15))
    else:
        wave = np.sin(2 * np.pi * frequency * t) + 0.25 * np.sin(2 * np.pi * frequency * 0.5 * t)
        envelope = np.minimum(1, t * 5) * np.minimum(1, (duration - t) * 3)
    signal = gain * wave * envelope
    index = int(start * SR)
    audio[index:index + count, 0] += signal * (1 - pan) * 0.72
    audio[index:index + count, 1] += signal * (1 + pan) * 0.72


def add_drum(start, strength=0.2, hat=False):
    length = 0.08 if hat else 0.28
    count = min(int(length * SR), len(audio) - int(start * SR))
    if count <= 0:
        return
    t = np.arange(count) / SR
    if hat:
        signal = rng.normal(0, 1, count) * np.exp(-t * 65) * strength
    else:
        phase = 2 * np.pi * (52 * t + 65 * (1 - np.exp(-t * 24)) / 24)
        signal = np.sin(phase) * np.exp(-t * 18) * strength
    index = int(start * SR)
    audio[index:index + count, 0] += signal
    audio[index:index + count, 1] += signal


# 128 BPM, syncopated phrases, a fast run, a sustained note and a full stop.
beat = 60 / 128
melody = [62, 65, 69, 67, 65, 62, 60, 57, 60, 62, 65, 69, 72, 69, 67, 65]
time = 0.45
index = 0
while time < 8.1:
    gap = beat * (0.5 if index % 4 in (1, 2) else 1.0)
    add_tone(time, gap * 0.9, melody[index % len(melody)], pan=0.35 * np.sin(index))
    if index % 2 == 0:
        add_drum(time, 0.22)
    add_drum(time + beat / 2, 0.045, hat=True)
    time += gap
    index += 1

for root, start in [(50, 0.0), (53, 3.75), (55, 7.5), (48, 15.0), (50, 20.25)]:
    for interval in (0, 7, 12):
        add_tone(start, 3.4, root + interval, gain=0.055, pan=(interval - 6) / 8, kind="pad")

for j in range(16):
    start = 8.25 + j * 0.115
    add_tone(start, 0.16, 69 + [0, 2, 4, 7, 9, 7, 4, 2][j % 8], gain=0.15, pan=-0.5 + j / 16)
    if j % 4 == 0:
        add_drum(start, 0.18)

add_tone(10.35, 2.9, 74, gain=0.2, kind="pad")
add_tone(10.35, 2.9, 62, gain=0.09, kind="pad")
for j in range(10):
    start = 14.1 + j * beat * 0.75
    add_tone(start, beat * 0.55, [57, 60, 64, 67, 65, 64, 60, 62, 65, 69][j], gain=0.18)
    add_drum(start, 0.2 if j % 2 == 0 else 0.1)
for j in range(7):
    start = 20.25 + j * 0.62
    add_tone(start, 0.52, [62, 67, 70, 74, 72, 67, 62][j], gain=0.17)
    add_drum(start, 0.2)
add_tone(24.85, 1.4, 62, gain=0.18, kind="pad")
add_drum(24.85, 0.24)

fade = int(0.08 * SR)
audio[:fade] *= np.linspace(0, 1, fade)[:, None]
audio[-fade:] *= np.linspace(1, 0, fade)[:, None]
peak = np.max(np.abs(audio))
audio = np.tanh(audio * 0.9) / max(1.0, peak)
output = Path(__file__).resolve().parents[1] / "test-assets" / "夜航-原创测试曲.wav"
output.parent.mkdir(parents=True, exist_ok=True)
with wav.open(str(output), "wb") as stream:
    stream.setnchannels(2)
    stream.setsampwidth(2)
    stream.setframerate(SR)
    stream.writeframes((audio * 32767).astype("<i2").tobytes())
print(output)
