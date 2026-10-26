#!/usr/bin/env python3
"""beat_grid.py — fit a beat grid to a BGM and classify drum hits (references/beat-sync.md).

    python3 beat_grid.py bgm.mp3 analysis/beat_data.json [--plot analysis/grid.png] [--clicks analysis/]

Needs librosa + scipy (install into the project's venv). Writes:
  bpm, t0 (first beat, s), T (beat period, s), beats[], winner + candidates (0.5x … 2x incl. 3:2 relations, with match/coverage/mean_abs_ms/drift),
  hits[{t, s, k}] (k = kick|snare|hihat, s = strength 0..1; band-based heuristic — confirm by ear), rms[] (10 Hz), sections[], strongest[] (top kick beats).
All times are float seconds; convert to frames only at the very end.
"""
import argparse, json, os, sys
import numpy as np

try:
    import librosa
    from scipy.signal import butter, sosfilt
except ImportError:
    sys.exit('✗ needs librosa and scipy:  python3 -m venv .venv && .venv/bin/pip install librosa scipy soundfile')


def band_env(y, sr, lo, hi):
    sos = butter(4, [lo, min(hi, sr / 2 - 100)], btype='band', fs=sr, output='sos')
    env = librosa.onset.onset_strength(y=sosfilt(sos, y), sr=sr, hop_length=256)
    return env, librosa.times_like(env, sr=sr, hop_length=256)


def peaks(env, times, k, thresh=0.25):
    if env.max() <= 0: return []
    e = env / env.max()
    idx = librosa.util.peak_pick(e, pre_max=3, post_max=3, pre_avg=8, post_avg=8, delta=0.07, wait=6)
    return [dict(t=round(float(times[i]), 4), s=round(float(e[i]), 3), k=k) for i in idx if e[i] >= thresh]


def fit_grid(beats):
    i = np.arange(len(beats)); A = np.vstack([i, np.ones_like(i)]).T
    (T, t0), *_ = np.linalg.lstsq(A, beats, rcond=None)
    return float(T), float(t0)


def fit_candidate(T, onsets, dur, tol=0.035):
    """phase by circular mean of onsets mod T, then least-squares refine (T, t0) on the matched onsets."""
    ph = np.angle(np.mean(np.exp(2j * np.pi * onsets / T))) / (2 * np.pi) * T % T
    t0 = ph
    for _ in range(3):
        n = np.round((onsets - t0) / T); r = onsets - (t0 + n * T); m = np.abs(r) < tol
        if m.sum() < 4: break
        A = np.vstack([n[m], np.ones(m.sum())]).T; (T, t0), *_ = np.linalg.lstsq(A, onsets[m], rcond=None)
    t0 = t0 % T   # first grid point at or after 0
    return float(T), float(t0)


def score(T, t0, onsets, dur, tol=0.035):
    """match: share of grid beats with an onset; coverage: share of onsets on the grid; F1 of both picks the grid."""
    grid = t0 + np.arange(int((dur - t0) / T) + 1) * T
    if len(onsets): grid = grid[(grid >= onsets.min() - tol) & (grid <= onsets.max() + tol)]   # only where the drums play
    if len(onsets) == 0 or len(grid) == 0: return dict(match=0, coverage=0, f1=0, mean_abs_ms=999, drift_ms=999)
    d = np.array([onsets[np.argmin(np.abs(onsets - g))] - g for g in grid]); hit = np.abs(d) < tol
    cov = np.mean([np.min(np.abs(grid - o)) < tol for o in onsets])
    slope = np.polyfit(grid[hit], d[hit], 1)[0] if hit.sum() > 3 else 0.0
    m = float(hit.mean()); f1 = 2 * m * cov / (m + cov + 1e-9)
    return dict(match=round(m, 4), coverage=round(float(cov), 4), f1=round(f1, 4),
                mean_abs_ms=round(float(np.abs(d[hit]).mean() * 1000), 2) if hit.any() else 999, drift_ms=round(float(abs(slope) * dur * 1000), 2))


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('audio'); ap.add_argument('out')
    ap.add_argument('--clicks', help='folder: write click tracks over the song for each candidate grid')
    a = ap.parse_args()
    y, sr = librosa.load(a.audio, sr=None, mono=True); dur = len(y) / sr
    _, perc = librosa.effects.hpss(y)
    _, beats = librosa.beat.beat_track(y=perc, sr=sr, tightness=400, units='time')
    if len(beats) < 8: sys.exit('✗ too few beats detected — is this a rhythmic track?')
    T, t0 = fit_grid(beats)
    res = beats - (t0 + np.arange(len(beats)) * T)

    kick_env, times = band_env(perc, sr, 40, 160)
    snare_body, _ = band_env(perc, sr, 150, 500); snare_crack, _ = band_env(perc, sr, 1000, 3000)
    snare_env = np.sqrt(np.maximum(snare_body, 0) * np.maximum(snare_crack, 0))
    hat_env, _ = band_env(perc, sr, 6000, 14000)
    hits = peaks(kick_env, times, 'kick') + peaks(snare_env, times, 'snare', 0.45) + peaks(hat_env, times, 'hihat', 0.3)
    hits.sort(key=lambda h: h['t'])
    kicks = np.array([h['t'] for h in hits if h['k'] == 'kick'])
    onsets = kicks if len(kicks) > 8 else librosa.onset.onset_detect(y=perc, sr=sr, units='time')

    onsets = np.asarray(onsets, dtype=float)
    # beat trackers often lock to 2x, 0.5x or a 3:2 relation — test them all and let the drums decide
    cands = {}
    for name, mul in [('0.5x', 0.5), ('0.67x', 2 / 3), ('0.75x', 0.75), ('1x', 1.0), ('1.33x', 4 / 3), ('1.5x', 1.5), ('2x', 2.0)]:
        Tm, t0m = fit_candidate(T / mul, onsets, dur)
        sc = score(Tm, t0m, onsets, dur); sc.update(bpm=round(60 / Tm, 3), t0=round(t0m, 4), T=round(Tm, 6))
        cands[name] = sc
    in_range = lambda c: 1 if 70 <= c['bpm'] <= 180 else 0
    winner = max(cands, key=lambda k: (round(cands[k]['f1'], 2), in_range(cands[k]), -cands[k]['mean_abs_ms']))
    W = cands[winner]

    # first-beat validity: an onset within 35 ms of t0
    first_ok = bool(len(onsets) and np.min(np.abs(np.asarray(onsets) - W['t0'])) < 0.035)

    rms = librosa.feature.rms(y=y, hop_length=sr // 10)[0]; rms = (rms / (rms.max() + 1e-9)).round(3)
    # crude sections: smooth RMS, split where it crosses its median with hysteresis, snap to bars of 4 beats
    sm = np.convolve(rms, np.ones(20) / 20, mode='same'); med = float(np.median(sm)); sections = []; state = None
    for i, v in enumerate(sm):
        s = 'high' if v > med * 1.1 else 'low' if v < med * 0.9 else state
        if s != state and s is not None:
            t = i / 10; bar = round((t - W['t0']) / W['T'] / 4) * 4
            if not sections or bar > sections[-1]['beat']: sections.append(dict(beat=int(bar), t=round(W['t0'] + bar * W['T'], 3), energy=s))
            state = s
    # strongest kick beats (candidates for the ≤3 full-frame hits; R4)
    kb = []
    for n in range(int((dur - W['t0']) / W['T'])):
        t = W['t0'] + n * W['T']; kb.append((float(kick_env[np.argmin(np.abs(times - t))]), n, t))
    kb.sort(reverse=True)
    strongest = [dict(beat=n, t=round(t, 4), s=round(e / (kb[0][0] + 1e-9), 3)) for e, n, t in kb[:8]]

    data = dict(source=os.path.basename(a.audio), duration=round(dur, 3), bpm=W['bpm'], t0=W['t0'], T=W['T'], winner=winner,
                fit_residual_ms=round(float(np.abs(res).max() * 1000), 1), first_beat_on_attack=first_ok, candidates=cands,
                beats=[round(W['t0'] + i * W['T'], 4) for i in range(int((dur - W['t0']) / W['T']) + 1)],
                hits=hits, rms=rms.tolist(), sections=sections, strongest=strongest)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(data, open(a.out, 'w'), indent=1)

    ok = W['match'] >= 0.98 and W['mean_abs_ms'] < 10 and W['drift_ms'] < 5 and first_ok
    print(f"BPM {W['bpm']}  t0 {W['t0']}s  winner {winner}  match {W['match']:.1%}  coverage {W['coverage']:.1%}  mean {W['mean_abs_ms']} ms  drift {W['drift_ms']} ms  "
          f"first beat on attack: {first_ok}  fit residual ±{data['fit_residual_ms']} ms")
    for k, c in cands.items(): print(f"   {k:5s} bpm {c['bpm']:8.3f}  f1 {c['f1']:.3f}  match {c['match']:.1%}  coverage {c['coverage']:.1%}  mean {c['mean_abs_ms']} ms  drift {c['drift_ms']} ms")
    print('✓ grid accepted' if ok else '✗ grid NOT accepted — check tempo changes (fit per section), separate the drums (Demucs), or listen to the click tracks')
    print(f"strongest kick beats: {[s['beat'] for s in strongest[:4]]}  sections: {[(s['beat'], s['energy']) for s in sections[:8]]}")

    if a.clicks:
        import soundfile as sf
        os.makedirs(a.clicks, exist_ok=True)
        for k, c in cands.items():
            click = librosa.clicks(times=np.arange(c['t0'], dur, c['T']), sr=sr, length=len(y))
            sf.write(os.path.join(a.clicks, f'click_{k}.wav'), np.stack([y * 0.6, click * 0.5], 1), sr)
    sys.exit(0 if ok else 3)


if __name__ == '__main__':
    main()
