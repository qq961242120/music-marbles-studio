#!/usr/bin/env python3
"""Measure constant audio delay between a source and its rendered MP4."""

import argparse
import subprocess
import numpy as np


def decode(ffmpeg, path, sr):
    raw = subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(path),
        "-map", "0:a:0", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-",
    ], check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype="<f4")


def envelope(samples, sr, window_ms=5):
    width = max(1, int(sr * window_ms / 1000))
    usable = len(samples) // width * width
    frames = samples[:usable].reshape(-1, width)
    return np.sqrt(np.mean(frames * frames, axis=1) + 1e-12).astype(np.float64)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("rendered")
    parser.add_argument("--ffmpeg", required=True)
    args = parser.parse_args()
    sr = 22050
    source = envelope(decode(args.ffmpeg, args.source, sr), sr)
    rendered = envelope(decode(args.ffmpeg, args.rendered, sr), sr)
    rate = 200
    max_lag = rate
    source = (source - source.mean()) / max(source.std(), 1e-9)
    rendered = (rendered - rendered.mean()) / max(rendered.std(), 1e-9)
    scores = []
    for lag in range(-max_lag, max_lag + 1):
        if lag >= 0:
            a, b = source[:min(len(source), len(rendered) - lag)], rendered[lag:lag + len(source)]
        else:
            a, b = source[-lag:-lag + len(rendered)], rendered[:min(len(rendered), len(source) + lag)]
        count = min(len(a), len(b))
        scores.append((float(np.dot(a[:count], b[:count]) / max(count, 1)), lag))
    score, lag = max(scores)
    print({"renderedAudioDelayMs": lag * 1000 / rate, "correlation": round(score, 6)})


if __name__ == "__main__":
    main()
