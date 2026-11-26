#!/usr/bin/env python3
"""Turn one mixed audio file into deterministic collision times and a render plan."""

import argparse
import json
import math
import re
import subprocess
import tempfile
import wave
from pathlib import Path

import aubio
import numpy as np

if __package__:
    from .phrase_accents import band_flux, repeated_accents, performance_masks, spectral_magnitude
else:
    from phrase_accents import band_flux, repeated_accents, performance_masks, spectral_magnitude


EXPORT_SETTINGS = json.loads((Path(__file__).resolve().parents[1] / "export-settings.json").read_text())


def parse_lrc(text, duration):
    lines = []
    for raw in text.replace("\\n", "\n").splitlines():
        stamps = re.findall(r"\[(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)\]", raw)
        lyric = re.sub(r"\[[^\]]+\]", "", raw).strip()
        if not lyric:
            continue
        for minutes, seconds in stamps:
            start = int(minutes) * 60 + float(seconds)
            if start < duration:
                lines.append({"start": start, "text": lyric})
    lines.sort(key=lambda line: line["start"])
    for index, line in enumerate(lines):
        line["start"] = round(line["start"], 3)
        line["end"] = round(lines[index + 1]["start"] if index + 1 < len(lines) else min(duration, line["start"] + 5), 3)
    return lines


def embedded_lyrics(tags, duration):
    for key, value in tags.items():
        if key.lower() in {"lyrics", "lyric", "unsyncedlyrics", "syncedlyrics", "©lyr"} and value:
            parsed = parse_lrc(str(value), duration)
            if parsed:
                return parsed, "音频内嵌时间歌词"
    return [], "无可靠歌词来源"


def decode_audio(args, wav_path):
    subprocess.run([
        args.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(args.audio),
        "-vn", "-ac", "2", "-ar", "22050", "-c:a", "pcm_s16le", str(wav_path),
    ], check=True)
    with wave.open(str(wav_path), "rb") as wav:
        sr = wav.getframerate()
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    return samples.reshape(-1, 2), sr


def pitch_near(track, time, sr, hop, fallback):
    center = int(round(time * sr / hop))
    values = [track[frame] for frame in range(center, center + 9)
              if frame in track and 35 <= track[frame] <= 95]
    return float(np.median(values)) if values else fallback


def read_tags(args):
    result = subprocess.run([
        args.ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(args.audio),
        "-map_metadata", "0", "-f", "ffmetadata", "-",
    ], capture_output=True, text=True)
    tags = {}
    parts = []
    for line in result.stdout.splitlines():
        # FFmetadata represents a metadata newline with a backslash and an
        # actual line break. A literal trailing backslash is escaped in pairs.
        trailing = len(line) - len(line.rstrip("\\"))
        if trailing % 2:
            parts.append(line[:-1])
            continue
        entry = "\n".join([*parts, line])
        parts.clear()
        if "=" in entry and not entry.startswith(("#", ";")):
            key, value = entry.split("=", 1)
            tags[key] = re.sub(r"\\([\\=;#])", r"\1", value)
    return tags


def container_duration(args, fallback):
    result = subprocess.run([args.ffmpeg, "-hide_banner", "-i", str(args.audio)], capture_output=True, text=True)
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr)
    if not match:
        return fallback
    return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3))


def musical_attacks(samples, sr):
    """Return time and strength pairs for callers that only need note timings."""
    return measure_attacks(samples, sr)[0]


def measure_attacks(samples, sr):
    """Locate rising notes at frame centres; measure prominence against the surrounding phrase."""
    hop, size = 128, 1024
    channels = samples[:, None] if samples.ndim == 1 else samples
    padded = np.pad(channels, ((size // 2, size // 2), (0, 0)))
    frames = np.lib.stride_tricks.sliding_window_view(padded, size, axis=0)[::hop]
    window = np.hanning(size)
    freqs = np.fft.rfftfreq(size, 1 / sr)
    edges = np.geomspace(55, 9000, 37)
    bands = np.unique(np.searchsorted(freqs, edges))
    centres = (freqs[bands[:-1]] * freqs[bands[1:]]) ** 0.5
    levels = np.empty((len(frames), len(centres)), dtype=np.float32)
    edges = np.searchsorted(freqs, [55, 190, 450, 1030, 2320, 4300])
    flux = np.empty((len(frames), len(edges)-1), dtype=np.float32)
    history = np.zeros((4, edges[-1]+1))
    level_scale = max(float(np.percentile(np.abs(samples[::8]), 97)), 1e-5)
    for start in range(0, len(frames), 512):
        batch = frames[start:start + 512]
        spectrum = spectral_magnitude(batch, window) / (size / 4)
        flux[start:start+len(batch)], history = band_flux(spectrum, history, level_scale, edges)
        powers = np.add.reduceat(spectrum[:, :bands[-1]] ** 2, bands[:-1], axis=1)
        levels[start:start + len(batch)] = np.sqrt(powers)
    # Compression makes quieter phrases visible without lifting the noise floor.
    scale = max(float(np.percentile(levels.max(axis=1), 95)), 1e-5)
    levels = np.log1p(levels * (12 / scale))
    rise = np.zeros_like(levels)
    rise[2:] = np.maximum(0, levels[2:] - levels[:-2])
    body = rise[:, centres < 2700].max(axis=1)
    treble = rise[:, centres >= 2700].max(axis=1)
    score = body + 0.18 * treble
    score = np.convolve(np.pad(score, 1), [0.2, 0.6, 0.2], mode="valid")
    local_peaks = np.flatnonzero((score[1:-1] > score[:-2]) & (score[1:-1] >= score[2:])) + 1
    peaks = []
    span = round(0.55 * sr / hop)
    for i in local_peaks:
        nearby = score[max(0, i - span):min(len(score), i + span + 1)]
        floor = np.median(nearby)
        high = np.percentile(nearby, 96)
        if score[i] < max(0.012, 1.50 * floor, floor + 0.36 * (high - floor)):
            continue
        # A hi-hat over sustained instruments should not replace the melody.
        # Keep high-frequency attacks when percussion actually leads the phrase.
        body_peak = body[max(0, i - span):min(len(body), i + span + 1)].max()
        if body[i] < body_peak * 0.13 and treble[i] > body[i] * 1.5 and body_peak > 0.15:
            continue
        before = levels[max(0, i - 5):i].mean(axis=0)
        after = levels[i + 1:i + 6].mean(axis=0)
        change = after - before
        lasting_rise = max(change[centres < 2700].max(), 0.25 * change.max())
        if lasting_rise < score[i] * 0.69 and body_peak > 0.1:
            continue
        if lasting_rise <= 0.01:
            continue
        peaks.append((i, float((score[i] + lasting_rise) / 2)))
    # Take the strongest event within one perceptual attack, including echoes.
    accepted = np.zeros(len(score), dtype=bool)
    masked = np.zeros(len(score), dtype=bool)
    gap = int(0.092 * sr / hop)
    for i, _ in sorted(peaks, key=lambda peak: peak[1], reverse=True):
        if not masked[i]:
            accepted[i] = True
            masked[max(0, i - gap):i + gap + 1] = True
    attacks = [[max(0.001, (i - 1) * hop / sr), strength] for i, strength in peaks if accepted[i]]
    return repeated_accents(attacks, flux, score, samples, sr, hop)


# The layout builds a rolling guide only for gaps greater than this duration.
GUIDE_GAP = 0.78


def select_guide_exit_accents(hits, strengths, samples, sr):
    """Only end a long gap at an audible phrase accent; let quiet pickups pass."""
    if not hits:
        return [], []
    times = np.array([hit["t"] for hit in hits])
    if not np.any(np.diff(times) > GUIDE_GAP):
        return hits, []
    def level(start, end):
        start = max(0, round(start * sr))
        end = min(len(samples), max(0, round(end * sr)))
        window = samples[start:end]
        power = np.mean(window * window, dtype=np.float64) if len(window) else 0.0
        return 10 * np.log10(max(1e-12, power))

    before = np.array([level(t - .065, t - .012) for t in times])
    after = np.array([level(t + .012, t + .082) for t in times])
    strengths = np.asarray(strengths)
    accepted = [hits[0]]
    skipped = []
    for i, hit in enumerate(hits[1:], 1):
        t = hit["t"]
        if t - accepted[-1]["t"] > GUIDE_GAP:
            near = slice(*np.searchsorted(times, [t - 2.25, t + 2.25]))
            phrase = slice(*np.searchsorted(times, [t - 7., t + 7.]))
            reference = max(np.percentile(after[near], 80), np.percentile(after[phrase], 75) - 8.)
            # Let an intentionally quieter new phrase establish its own level
            # when there are several following notes and this attack leads them.
            following = after[i + 1:near.stop]
            if len(following) >= 3 and after[i] >= np.percentile(following, 85) - 2.:
                reference = min(reference, np.percentile(following, 85))
            relative = after[i] - reference
            onset_ratio = strengths[i] / max(1e-8, np.percentile(strengths[near], 80))
            lift = after[i] - before[i]
            if relative < -4. or onset_ratio < .50 or (lift < 1.5 and onset_ratio < .80):
                skipped.append(t)
                continue
        accepted.append(hit)
    return accepted, skipped


def analyze(args):
    with tempfile.TemporaryDirectory(prefix="marbles-analysis-") as temp_dir:
        samples, sr = decode_audio(args, Path(temp_dir) / "decoded.wav")
    duration = container_duration(args, len(samples) / sr)
    tags = read_tags(args)
    lyrics, lyric_source = embedded_lyrics(tags, duration)

    if not np.any(np.abs(samples) > 1e-5):
        raise RuntimeError("音轨为静音，无法分析旋律起音")

    hop = 256
    window = 2048
    pitch = aubio.pitch("yin", window, hop, sr)
    pitch.set_unit("midi")
    pitch.set_tolerance(0.75)
    tempo = aubio.tempo("default", window, hop, sr)
    pitch_track = {}
    beat_times = []
    pitch_input = samples.mean(axis=1)
    if np.mean(pitch_input[::8]**2) < .1 * np.mean(samples[::8]**2):
        # Aubio takes a single waveform. Use the stronger channel for a side-heavy mix.
        pitch_input = samples[:, np.argmax(np.mean(samples[::8]**2, axis=0))]
    for frame, start in enumerate(range(0, len(samples), hop)):
        block = np.ascontiguousarray(pitch_input[start:start + hop])
        if len(block) < hop:
            block = np.pad(block, (0, hop - len(block)))
        detected_pitch = float(pitch(block)[0])
        if math.isfinite(detected_pitch) and pitch.get_confidence() > 0.55:
            pitch_track[frame] = detected_pitch
        if tempo(block):
            beat_times.append(float(tempo.get_last() / sr))
    bpm = float(tempo.get_bpm())
    while bpm > 150:
        bpm /= 2
    while bpm and bpm < 60:
        bpm *= 2

    timing_source = "按左右声道的起音能量和乐句内的相对强弱筛选"
    detected, expression = measure_attacks(samples, sr)
    selected = [(time, strength) for time, strength in detected if time < duration]

    strengths = np.array([item[1] for item in selected])
    low, high = np.percentile(strengths, [10, 95]) if len(strengths) > 2 else (0.0, 1.0)
    hits = []
    previous_pitch = 60.0
    for time, strength in selected:
        current_pitch = pitch_near(pitch_track, time, sr, hop, previous_pitch)
        previous_pitch = current_pitch
        velocity = float(np.clip(0.25 + 0.75 * (strength - low) / max(high - low, 1e-6), 0.2, 1.0))
        is_beat = bool(beat_times and min(abs(beat - time) for beat in beat_times) < 0.065)
        hits.append({"t": round(time, 5), "pitch": round(current_pitch, 3), "velocity": round(velocity, 3), "beat": is_beat})

        if time in expression:
            hits[-1]["accentStrength"] = expression[time]
    release, weak = performance_masks(hits, samples, sr)
    excluded = release | weak
    skipped_weak = [hit["t"] for hit, skip in zip(hits, weak) if skip]
    skipped_release = [hit['t'] for hit, skip in zip(hits, release) if skip]
    hits = [hit for hit, skip in zip(hits, excluded) if not skip]
    strengths = strengths[~excluded]
    hits, skipped_exits = select_guide_exit_accents(hits, strengths, samples, sr)
    rail_count = sum(1 for a, b in zip(hits, hits[1:]) if b["t"] - a["t"] > GUIDE_GAP)
    if hits and duration - hits[-1]["t"] > 0.18:
        rail_count += 1
    plan = {
        "version": 1,
        "title": args.title or Path(args.audio).stem,
        "duration": round(duration, 6),
        "width": 1080,
        "height": 1920,
        "fps": EXPORT_SETTINGS["fps"],
        "audioDelayFrames": EXPORT_SETTINGS["audioDelayFrames"],
        "sampleRate": sr,
        "bpm": round(bpm, 3),
        "hits": hits,
        "lyrics": lyrics,
        "analysis": {
            "onsetMethod": timing_source,
            "lyricsSource": lyric_source,
            "railCount": rail_count,
            "skippedWeakGuideExits": skipped_exits,
            "skippedReleasePickups": skipped_release,
            "skippedWeakAttacks": skipped_weak,
            "maxCollisionQuantizationMs": round(500 / EXPORT_SETTINGS["fps"], 3),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"duration": duration, "hits": len(hits), "bpm": bpm, "lyrics": len(lyrics), "rails": rail_count, "timingSource": timing_source}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--title")
    args = parser.parse_args()
    analyze(args)


if __name__ == "__main__":
    main()
