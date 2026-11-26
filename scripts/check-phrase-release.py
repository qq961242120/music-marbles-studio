"""Check musical releases and quiet re-entries independently of the onset grid."""
from pathlib import Path
import sys

import numpy as np

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'analysis'))
from phrase_accents import release_pickups

sr = 22050
for interval, pitch, gain in [(.21, 350, .6), (.29, 500, .08)]:
    stamps = .25 + np.arange(7) * interval
    y = np.zeros(round((stamps[-1]+.7)*sr))
    local = np.arange(round(2.1*sr))/sr
    def note(t, frequency, amp, decay):
        start = round(t*sr)
        x = local[:min(len(local),len(y)-start)]
        harmonics = sum(np.sin(2*np.pi*h*frequency*x)*np.exp(-decay*(1+.15*h)*x)/h
                        for h in [1,2,3,4])
        y[start:start+len(x)] += gain*amp*(1-np.exp(-600*x))*harmonics

    hits = [{'t':t} for t in stamps]
    note(stamps[0], pitch, 1, 1.65)
    for i in range(1,6):
        note(stamps[i], (.4+.03*(i%2))*pitch, .022, 7)
    note(stamps[6],1.12*pitch,.85,3)
    mask = release_pickups(hits,y,sr)
    assert mask.tolist()==[False,True,True,True,True,True,False], (interval,mask)
    # Same volume contrast, but a fresh quieter melody with clean attacks.
    y.fill(0)
    note(stamps[0],pitch,1,18)
    for i in range(1,6):
        note(stamps[i],(.7+i*.05)*pitch,.15,15)
    note(stamps[6],1.12*pitch,.85,3)
    assert not release_pickups(hits,y,sr).any()
    # A single residual ripple without a new strike must not make another key.
    y.fill(0)
    note(stamps[0],pitch,1,2.3)
    note(stamps[2],1.12*pitch,.85,5)
    assert release_pickups(hits[:3],y,sr).tolist()==[False,True,False]
    # A rapidly decaying new high note at the middle timestamp still counts.
    note(stamps[1],2.76*pitch,.24,30)
    assert not release_pickups(hits[:3],y,sr).any()

# Late ripples in a sustained low chord match the already ringing spectrum.
# A genuinely new, much softer note after the same decay must still be eligible.
ending_times = [.33, 3.72, 3.94, 4.08, 4.25, 4.51]
ending_hits = [{'t': t} for t in ending_times]
clock = np.arange(round(6.2 * sr)) / sr
for gain in (.72, .075):
    x = np.maximum(clock - ending_times[0], 0)
    chord = np.sin(2*np.pi*117*x) + .25*np.sin(2*np.pi*235*x)
    ring = gain*(1-np.exp(-700*x))*np.exp(-.9*x)*(1+.04*np.sin(2*np.pi*3*x))*chord
    ring[clock > 5.25] = 0
    assert release_pickups(ending_hits, ring, sr).tolist() == [False] + [True]*5
    u = np.maximum(clock - ending_times[-1], 0)
    soft_note = gain*.135*(1-np.exp(-700*u))*np.exp(-12*u)*np.sin(2*np.pi*930*u)
    assert release_pickups(ending_hits, ring+soft_note, sr).tolist() == [False] + [True]*4 + [False]

print('Fading accompaniment, long final decay, quiet melody and real re-attack verified.')
