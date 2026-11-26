"""Measure repeated attacks independently of the tempo grid and single-band flux."""
import numpy as np


def spectral_magnitude(frames, window, fft_size=None):
    """RMS amplitude per frequency bin; the last two axes are channel and sample."""
    if frames.shape[-2] == 1:
        return abs(np.fft.rfft(frames[..., 0, :] * window, n=fft_size, axis=-1))
    magnitudes = abs(np.fft.rfft(frames * window, n=fft_size, axis=-1))
    return np.sqrt(np.mean(magnitudes**2, axis=-2))


def band_flux(spectrum, history, scale, edges):
    """Reject beating and pitch drift by comparing each bin with its past neighbours."""
    compressed = np.log1p(36 * spectrum[:, :edges[-1] + 1] / scale)
    joined = np.concatenate((history, compressed))
    previous = joined[:-len(history)]
    floor = np.maximum(previous[:, 1:-1], np.maximum(previous[:, :-2], previous[:, 2:]))
    rise = np.maximum(0, compressed[:, 1:-1] - floor)
    features = [rise[:, lo-1:hi-1].sum(axis=1) / np.sqrt(hi-lo)
                for lo, hi in zip(edges, edges[1:])]
    return np.column_stack(features), joined[-len(history):].copy()


def repeated_accents(attacks, bands, single_flux, samples, sr, hop):
    if len(attacks) < 3:
        return attacks, {}
    step = hop / sr
    score = np.convolve(np.pad(bands.sum(axis=1), 1), [.2, .6, .2], mode='valid')
    maxima = np.flatnonzero((score[1:-1] > score[:-2]) & (score[1:-1] >= score[2:])) + 1
    peaks = []
    for i in maxima:
        if score[i] < .55 or score[i] < score[max(0, i-6):i+7].max():
            continue
        active = bands[i] > max(.09, .14 * bands[i].max())
        if active.sum() < 3 or not active[:3].any():
            continue
        baseline = score[max(0, i-45):i+46]
        if score[i] >= max(2.65 * np.median(baseline), .55 * np.percentile(baseline, 90)):
            peaks.append(i)
    frames = np.asarray(peaks, dtype=int)
    times = (frames - 1) * step
    if not len(times):
        return attacks, {}

    def near(values, t, tolerance):
        i = np.searchsorted(values, t - tolerance)
        return i < len(values) and values[i] <= t + tolerance

    def in_run(t):
        left = np.searchsorted(times, [t-.57, t-.105])
        for prev in times[left[0]:left[1]][::-1]:
            period = t - prev
            tolerance = max(.016, .13*period)
            if near(times, t+period, tolerance) and (
                near(times, t-2*period, tolerance*1.6) or near(times, t+2*period, tolerance*1.6)
            ):
                return True
        return False

    def power_db(start, end):
        block = samples[max(0, round(start*sr)):max(0, round(end*sr))]
        return 10*np.log10(np.mean(block*block, dtype=np.float64) + 1e-12) if len(block) else -120.

    original = np.array([t for t, _ in attacks])
    after = np.array([power_db(t+.012, t+.065) for t in original])
    song_level = np.percentile(after, 75)
    events = dict(attacks)
    expression = {}
    recovered = []
    # Decide from actual attacks, in descending order, so a decay ripple cannot
    # take the place of the louder attack when both compete for the same note.
    for index in np.argsort(score[frames])[::-1]:
        i, t = frames[index], times[index]
        if not in_run(t):
            continue
        ix = np.searchsorted(original, t)
        nearest = min(range(max(0, ix-1), min(len(original), ix+1)), key=lambda k: abs(original[k]-t))
        source = original[nearest]
        distance = abs(source-t)
        db = power_db(t+.012, t+.065)
        lift = power_db(t+.010, t+.052) - power_db(t-.060, t-.025)
        key = source
        if distance > .032:
            # Recover a missing stroke inside a measured sequence. Neighbouring
            # accepted notes must also support the spacing of the audio candidate.
            replace = distance <= .105
            left = ix-1-int(replace and nearest == ix-1)
            right = ix+int(replace and nearest == ix)
            if left < 0 or right >= len(original):
                continue
            before, following = t-original[left], original[right]-t
            if min(before,following)<.09 or max(before,following)>.57 or abs(before-following)>.18*max(before,following):
                continue
            if lift < .65 or any(abs(t-u) < .092 for u in recovered):
                continue
            if replace:
                j = round(source/step)+1
                if source not in events or score[max(0,j-4):j+5].max() > .35*score[i]:
                    continue
                del events[source]
                expression.pop(source, None)
            key = float(t)
            recovered.append(key)
            events[key] = float(single_flux[max(0,i-3):i+4].max())
        if key not in events:
            continue
        # A loud chord over a still-ringing predecessor can have little change
        # in overall level. Measure sounding level AND the renewed spectral attack.
        neighbourhood = slice(*np.searchsorted(original,[t-2.5,t+2.5]))
        reference = max(np.percentile(after[neighbourhood], 80), song_level-7.)
        prominence = score[i] / max(.12, np.median(score[max(0,i-36):i+37]))
        level = np.clip((db-reference+7.5)/8, 0, 1)
        clarity = np.clip((prominence-2.1)/5, 0, 1)
        expression[key] = round(float(level*(.70+.30*clarity)),3)
    return sorted(events.items()), expression


# A normal foreground attack can sit this far below the upper quarter of
# nearby attacks. Values are dB of newly excited sound, independent of gain.
ACCENT_WINDOW_SECONDS = 1.5
ACCENT_DROP_DB = 7.5


def _weak_attacks(hits, times, sounding, attack, melodic, release):
    weak = np.zeros(len(times), dtype=bool)
    def accent_reference(values):
        # A single accent every four notes can fall outside the upper quartile.
        # Limit the influence of very loud outliers on the local reference.
        upper = np.percentile(values, 75)
        strong = np.percentile(values, 90, method="higher")
        return max(upper, strong - 3.)

    for i, t in enumerate(times):
        if release[i]:
            continue
        lo, hi = np.searchsorted(times, [t-ACCENT_WINDOW_SECONDS, t+ACCENT_WINDOW_SECONDS])
        usable = ~release[lo:hi]
        reference = accent_reference(attack[lo:hi][usable])
        if reference - attack[i] <= ACCENT_DROP_DB:
            continue

        # Bass drums can set the broadband level. A note that carries much of
        # its new energy in the melodic register can lead that register itself.
        if melodic[i] >= attack[i] - 5:
            melodic_reference = accent_reference(melodic[lo:hi][usable])
            if melodic_reference - melodic[i] <= ACCENT_DROP_DB:
                continue

        # A verified chord re-attack may have to share energy with notes that
        # are still ringing. Use it only when the sounding chord is prominent.
        if (hits[i].get('accentStrength', 0) >= .50 and reference-attack[i] <= 11
                and np.percentile(sounding[lo:hi][usable], 75) - sounding[i] <= 5):
            continue

        # At a dynamic boundary, a quieter but freshly articulated phrase can
        # establish its own level on either side of this note.
        louder = usable & (attack[lo:hi] > attack[i] + ACCENT_DROP_DB)
        if louder[:i-lo].any() and louder[i-lo+1:].any():
            weak[i] = True
            continue
        quiet_phrase = False
        for start in range(max(lo, i-3), i+1):
            if start+4 > hi:
                continue
            group = slice(start, start+4)
            if (not release[group].any() and np.ptp(attack[group]) <= 3.5
                    and np.max(np.diff(times[group])) < .65
                    and np.min(attack[group] - sounding[group]) >= -9):
                quiet_phrase = True
                break
        weak[i] = not quiet_phrase
    return weak


def _retain_melody_changes(times, channels, sr, weak, release):
    """Recheck a rejected onset for a sustained pitch overtaking a ringing note."""
    anchors = np.flatnonzero(~(weak | release))
    if not anchors.size or not weak.any():
        return
    size = round(.075 * sr)
    fft_size = 1 << (2 * size - 1).bit_length()
    window = np.hanning(size)
    hz = np.fft.rfftfreq(fft_size, 1 / sr)
    register = (hz >= 165) & (hz <= 2100)

    def spectrum(t):
        start = max(0, round(t * sr) - size // 2)
        return spectral_magnitude(channels[start:start + size].T, window, fft_size)

    def leading_peak(s):
        peaks = register[1:-1] & (s[1:-1] > s[:-2]) & (s[1:-1] >= s[2:])
        bins = np.flatnonzero(peaks) + 1
        return hz[bins[np.argmax(s[bins])]] if bins.size else 0.

    def partial(s, f):
        width = max(9., f * .016)
        lo, hi = np.searchsorted(hz, [f-width, f+width])
        return s[lo:hi].max()

    # Only originally accepted notes can establish the foreground. A series of
    # weak accompaniment notes must not promote one another.
    for i in np.flatnonzero(weak):
        left = np.searchsorted(anchors, i)
        if left == 0:
            continue
        t, previous = times[i], times[anchors[left-1]]
        next_time = times[i+1] if i+1 < len(times) else len(channels)/sr
        if not .15 < t-previous < .85 or next_time-t < .135:
            continue
        lead = spectrum(previous + .040)
        onset = spectrum(t + .038)
        held = spectrum(min(t + .100, next_time - .045))
        old, new, later = map(leading_peak, (lead, onset, held))
        if min(old, new, later) == 0:
            continue
        if abs(12*np.log2(new/old)) < 1 or abs(12*np.log2(later/new)) > .75:
            continue

        before = spectrum(t - .050)
        old_before, old_onset, old_held = (partial(s, old) for s in (before, onset, held))
        new_before, new_onset, new_held = (partial(s, new) for s in (before, onset, held))
        incoming = min(new_onset, new_held)
        # The new note must reach foreground level while the old one still rings.
        if new_onset < .56 * partial(lead, old) or old_onset < .126 * new_onset:
            continue
        # Its fundamental and second harmonic grow; the pitch balance then
        # shifts by at least 5 dB in favour of the new, sustained note.
        harmonic = partial(held, 2 * new)
        if (incoming >= 1.41 * new_before
                and harmonic >= max(1.41 * partial(before, 2 * new), .14 * new_held)
                and new_held >= 1.41 * old_held
                and new_held * old_before >= 1.78 * old_held * new_before):
            weak[i] = False


def performance_masks(hits, samples, sr):
    """Classify ringing tails and non-accented onsets using the same spectra."""
    suppressed = np.zeros(len(hits), dtype=bool)
    if len(hits) < 2:
        return suppressed, suppressed.copy()

    # Compare the sound after each attack with the preceding resonance. A
    # renewed note can add energy in just one register while the mix decays.
    size = 2 * round(.026 * sr)
    window = np.hanning(size)
    channels = samples[:, None] if samples.ndim == 1 else samples
    padded = np.pad(channels, ((size, 2 * size), (0, 0)))
    freq = np.fft.rfftfreq(size, 1 / sr)
    audible = (freq >= 45) & (freq <= 8000)
    melodic_band = (freq[audible] >= 180) & (freq[audible] <= 2800)

    def spectrum(t):
        start = max(0, round(t * sr) + size // 2)
        return spectral_magnitude(padded[start:start + size].T, window)

    times = np.array([h['t'] for h in hits])
    sounding = np.empty(len(hits))
    fresh = np.empty(len(hits))
    attack_level = np.empty(len(hits))
    melodic_level = np.empty(len(hits))
    residual_only = np.zeros(len(hits), dtype=bool)
    ringing = np.zeros(len(hits), dtype=bool)
    for i, t in enumerate(times):
        recent = spectrum(t - .040)
        before = np.maximum(recent, spectrum(t - .069))
        # Allow a partial to drift by one bin without counting it as a new attack.
        before = np.maximum.reduce((np.roll(before, 1), before, np.roll(before, -1)))
        after = (spectrum(t + .028) + spectrum(t + .047)) * .5
        new = np.maximum(0, after[audible] - before[audible])
        sounding[i] = 10 * np.log10(np.sum(after[audible]**2) + 1e-14)
        fresh[i] = 10 * np.log10(np.dot(new, new) + 1e-14)

        attack = spectrum(t + .007)[audible]
        early = np.maximum(0, attack - before[audible])
        attack_level[i] = max(fresh[i], 10 * np.log10(np.dot(early, early) + 1e-14))

        mid_power = max(np.sum(new[melodic_band]**2), np.sum(early[melodic_band]**2))
        melodic_level[i] = 10 * np.log10(mid_power + 1e-14)

        present = after[audible]
        past = recent[audible]
        similarity = np.dot(present, past) / max(1e-14, np.linalg.norm(present) * np.linalg.norm(past))

        # Test both the hammer transient and the sustained note. A new partial
        # in a quiet register can be audible even if the overall level falls.
        if attack_level[i] < sounding[i] - 15 and similarity > .96:
            significant = present > .06 * present.max()
            emerging_partial = np.any(present[significant] > 2.5 * before[audible][significant])
            ringing[i] = not emerging_partial and np.dot(present, present) < 1.4 * np.dot(past, past)

        # A soft but distinct new note can be brief. Check its early transient
        # as well as the sustained spectrum before discarding a single ripple.
        if i and times[i] - times[i-1] < .35 and fresh[i] < sounding[i] - 27:
            residual_only[i] = (similarity > .94 and np.dot(early, early) < .006 * np.dot(attack, attack)
                                and sounding[i] < sounding[i-1] - 1.3 and fresh[i] < fresh[i-1] - 19
                                and hits[i].get('accentStrength', 0) < .45)

    for i, t in enumerate(times):
        if suppressed[i] or fresh[i] < sounding[i] - 10:
            continue
        j = i + 1
        while (j < len(hits) and times[j] - times[j-1] < .55 and times[j] - t < 2.5
               and sounding[j] < sounding[i] - 2.4 and fresh[j] < fresh[i] - 9
               and fresh[j] < sounding[j] - 5.5 and hits[j].get('accentStrength', 0) < .55):
            j += 1
        if j - i < 4:
            continue
        tail = sounding[i+1:j]
        bottom = int(np.argmin(tail))
        if (tail[0] - tail[bottom] < 5 or sounding[i] - tail[bottom] < 8
                or np.count_nonzero(np.diff(tail[:bottom+1]) < -.8) < 2):
            continue
        # A stable quieter phrase may also follow an accent. Only bridge to a
        # verified re-entry, or to the end of a decaying final phrase.
        if j < len(hits) and not (fresh[j] >= fresh[i] - 7 and sounding[j] >= sounding[i] - 5):
            continue
        suppressed[i+1:j] = True
    release = suppressed | residual_only
    # Keep a reference to the last distinct attack across a long decay. A
    # cluster of late ripples must not establish its own local accent level.
    anchors = np.flatnonzero(~(release | ringing))
    for anchor, stop in zip(anchors, np.append(anchors[1:], len(hits))):
        if stop <= anchor + 1:
            continue
        tail = slice(anchor + 1, stop)
        long_or_final = (stop == len(hits)) | (times[tail] - times[anchor] > 2.5)
        release[tail] |= (ringing[tail] & long_or_final
                          & (sounding[tail] < sounding[anchor] - 12)
                          & (attack_level[tail] < attack_level[anchor] - 18))
    weak = _weak_attacks(hits, times, sounding, attack_level, melodic_level, release)
    _retain_melody_changes(times, channels, sr, weak, release)
    return release, weak


def release_pickups(hits, samples, sr):
    """Return only the release classification for callers inspecting decay."""
    return performance_masks(hits, samples, sr)[0]
