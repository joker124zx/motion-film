#!/usr/bin/env python3
"""sfx.py — procedural foley + event mixer for motion-film.

Reads the EVENTS exported by `render.mjs --events` (or any JSON list of events) and writes a 48 kHz stereo mix.

    python3 sfx.py out/events.json out/mix.wav [--duration 12] [--music bgm.wav --music-gain 0.34 --duck 0.5]
    python3 sfx.py --demo out/sfx_demo.wav          # one of every sound, for auditioning

Event fields: t (s, where the sound's *hit* lands), kind, gain (0..1+), pan (-1..1), dur, variant (int), pitch (semitones).
Kinds: whoosh swoosh riser impact thump pop click tick snap sparkle ding boing paper type scratch bed
       file  (needs src: a wav/mp3/m4a path, e.g. a TTS line or a licensed sample; duck: true lowers the music under it)

Every sound is a pure function of its parameters plus a seed derived from (kind, variant, t), so renders repeat exactly.
Hit-aligned: sounds with an attack (impact, pop, click…) are placed so their peak lands on t; risers and whooshes
END/peak on t (a whoosh peaks at t, a riser finishes at t).
Dependencies: numpy, scipy. ffmpeg on PATH for non-wav files.
"""
import argparse, json, math, os, subprocess, sys, tempfile, zlib
import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48000


def rng_for(*key):
    return np.random.default_rng(zlib.crc32(repr(key).encode()) & 0xFFFFFFFF)


def env_adsr(n, a, d, s, r, sr=SR):
    a, d, r = int(a * sr), int(d * sr), int(r * sr)
    sus = max(0, n - a - d - r)
    e = np.concatenate([np.linspace(0, 1, max(a, 1), endpoint=False), np.linspace(1, s, max(d, 1), endpoint=False),
                        np.full(sus, s), np.linspace(s, 0, max(r, 1))])
    return np.pad(e, (0, max(0, n - len(e))))[:n]


def exp_decay(n, tau, sr=SR):
    return np.exp(-np.arange(n) / (tau * sr))


def bandpass(x, lo, hi, order=2):
    lo, hi = max(lo, 20), min(hi, SR / 2 - 100)
    sos = signal.butter(order, [lo, hi], btype='band', fs=SR, output='sos')
    return signal.sosfilt(sos, x)


def lowpass(x, f, order=2):
    return signal.sosfilt(signal.butter(order, min(f, SR / 2 - 100), btype='low', fs=SR, output='sos'), x)


def highpass(x, f, order=2):
    return signal.sosfilt(signal.butter(order, max(f, 20), btype='high', fs=SR, output='sos'), x)


def sweep_filter_noise(noise, f0, f1, q=1.2, steps=64):
    """band-pass noise whose centre glides f0→f1 (block-wise, cross-faded)"""
    n = len(noise); out = np.zeros(n); blk = int(np.ceil(n / steps)); win = np.hanning(2 * blk)
    for i in range(steps):
        c = f0 * (f1 / f0) ** (i / max(1, steps - 1))
        a, b = max(0, i * blk - blk // 2), min(n, (i + 1) * blk + blk // 2)
        seg = bandpass(noise[a:b], c / q, c * q)
        w = np.hanning(b - a) if b - a > 1 else np.ones(b - a)
        out[a:b] += seg * w
    return out


def reverb(x, size=0.25, mix=0.18, seed=3):
    """cheap stereo-ish reverb tail: exponentially decaying filtered noise IR"""
    r = np.random.default_rng(seed); n = int(size * SR * 2.5)
    ir = r.standard_normal(n) * exp_decay(n, size); ir = lowpass(ir, 6000); ir[0] = 0
    wet = np.pad(signal.fftconvolve(x, ir), (0, 1))[: len(x) + n]; wet /= (np.max(np.abs(wet)) + 1e-9)
    dry = np.pad(x, (0, n)); return dry + mix * wet * np.max(np.abs(x))


def norm(x, peak=0.9):
    m = np.max(np.abs(x)) + 1e-12
    return x / m * peak


# ---------- the sounds: each returns (mono array, hit_offset_seconds) ----------
def s_whoosh(p, r):
    dur = p.get('dur', 0.6); n = int(dur * SR)
    x = sweep_filter_noise(r.standard_normal(n), 300, 2600 if p.get('variant', 0) % 2 == 0 else 1800, q=1.6)
    e = np.sin(np.linspace(0, np.pi, n)) ** 2.2
    return norm(x * e, 0.8), dur * 0.55


def s_swoosh(p, r):
    p = dict(p); p.setdefault('dur', 0.35); x, h = s_whoosh(p, r); return highpass(x, 600), h


def s_riser(p, r):
    dur = p.get('dur', 1.6); n = int(dur * SR); t = np.arange(n) / SR
    noise = sweep_filter_noise(r.standard_normal(n), 400, 7000, q=1.4) * np.linspace(0, 1, n) ** 2
    f = 110 * 2 ** (np.linspace(0, 2, n)); tone = np.sin(TAU * np.cumsum(f) / SR) * 0.25 * np.linspace(0, 1, n) ** 3
    x = noise + tone; x[-int(0.01 * SR):] *= np.linspace(1, 0, int(0.01 * SR))
    return norm(x, 0.8), dur


def s_impact(p, r):
    dur = p.get('dur', 1.4); n = int(dur * SR); t = np.arange(n) / SR
    f = 52 * 2 ** (p.get('pitch', 0) / 12) * (1 + 1.8 * np.exp(-t * 30))
    body = np.sin(TAU * np.cumsum(f) / SR) * exp_decay(n, 0.28)
    crack = highpass(r.standard_normal(n), 1500) * exp_decay(n, 0.018) * 0.7
    tail = lowpass(r.standard_normal(n), 900) * exp_decay(n, 0.35) * 0.18
    x = np.tanh(1.6 * (body + crack + tail))
    return norm(reverb(x, 0.4, 0.22), 0.95), 0.004


def s_thump(p, r):
    n = int(0.35 * SR); t = np.arange(n) / SR
    f = 70 * 2 ** (p.get('pitch', 0) / 12) * (1 + 1.2 * np.exp(-t * 40))
    x = np.sin(TAU * np.cumsum(f) / SR) * exp_decay(n, 0.08) + lowpass(r.standard_normal(n), 400) * exp_decay(n, 0.02) * 0.5
    return norm(x, 0.9), 0.003


def s_pop(p, r):
    n = int(0.12 * SR); t = np.arange(n) / SR
    base = (520, 640)[p.get('variant', 0) % 2] * 2 ** (p.get('pitch', 0) / 12)
    f = base * (1 + 1.5 * np.exp(-t * 90))
    x = np.sin(TAU * np.cumsum(f) / SR) * exp_decay(n, 0.025)
    x += highpass(r.standard_normal(n), 3000) * exp_decay(n, 0.003) * 0.3
    return norm(x, 0.85), 0.002


def s_click(p, r):
    n = int(0.05 * SR)
    x = bandpass(r.standard_normal(n), 1800, 6500) * exp_decay(n, 0.004)
    x += bandpass(r.standard_normal(n), 600, 1500) * exp_decay(n, 0.008) * 0.6 * (1 if p.get('variant', 0) % 2 else 0.6)
    return norm(x, 0.8), 0.001


def s_tick(p, r):
    n = int(0.03 * SR); t = np.arange(n) / SR
    x = np.sin(TAU * 3200 * 2 ** (p.get('pitch', 0) / 12) * t) * exp_decay(n, 0.004)
    return norm(x, 0.6), 0.0005


def s_snap(p, r):
    n = int(0.18 * SR)
    x = highpass(r.standard_normal(n), 2000) * exp_decay(n, 0.006) + bandpass(r.standard_normal(n), 300, 900) * exp_decay(n, 0.03) * 0.5
    return norm(reverb(x, 0.15, 0.1), 0.85), 0.001


def s_sparkle(p, r):
    dur = p.get('dur', 1.2); n = int(dur * SR); t = np.arange(n) / SR; x = np.zeros(n)
    notes = [2093, 2637, 3136, 3951, 4186]
    for i in range(7):
        st = 0 if i == 0 else int(r.uniform(0.02, 0.35) * SR); f = notes[r.integers(len(notes))] * 2 ** (p.get('pitch', 0) / 12)
        amp = 1.0 if i == 0 else r.uniform(0.25, 0.7)   # first note is the onset that lands on t
        m = n - st; tt = np.arange(m) / SR
        x[st:] += (np.sin(TAU * f * tt) + 0.3 * np.sin(TAU * f * 2.76 * tt)) * exp_decay(m, r.uniform(0.15, 0.45)) * amp
    x += highpass(r.standard_normal(n), 7000) * exp_decay(n, 0.25) * 0.08
    return norm(reverb(x, 0.6, 0.3), 0.6), 0.01


def s_ding(p, r):
    n = int(1.2 * SR); t = np.arange(n) / SR; f = 1318.5 * 2 ** (p.get('pitch', 0) / 12)
    x = sum(a * np.sin(TAU * f * k * t) * exp_decay(n, d) for k, a, d in [(1, 1, 0.5), (2.0, 0.35, 0.25), (3.01, 0.2, 0.12), (4.2, 0.1, 0.08)])
    return norm(x, 0.7), 0.002


def s_boing(p, r):
    n = int(0.5 * SR); t = np.arange(n) / SR
    f = 180 * 2 ** (p.get('pitch', 0) / 12) * (1 + 0.6 * np.sin(TAU * 11 * t) * np.exp(-t * 5)) * (1 + 0.8 * np.exp(-t * 12))
    x = np.sin(TAU * np.cumsum(f) / SR) * env_adsr(n, 0.004, 0.1, 0.6, 0.3)
    return norm(x, 0.8), 0.006


def s_paper(p, r):
    dur = p.get('dur', 0.4); n = int(dur * SR); x = np.zeros(n)
    for i in range(int(6 + dur * 30)):
        st = int(r.uniform(0, max(1e-3, dur - 0.03)) * SR); m = int(r.uniform(0.004, 0.03) * SR); m = min(m, n - st)
        x[st:st + m] += bandpass(r.standard_normal(m), 1500, 7000) * np.hanning(m) * r.uniform(0.3, 1)
    return norm(x * np.sin(np.linspace(0, np.pi, n)) ** 0.5, 0.6), None


def s_type(p, r):
    """one keystroke; variant changes the key"""
    n = int(0.08 * SR); v = p.get('variant', 0)
    x = bandpass(r.standard_normal(n), 2500 + 400 * (v % 3), 8000) * exp_decay(n, 0.003)
    x += bandpass(r.standard_normal(n), 250, 700) * exp_decay(n, 0.012) * 0.7
    st = int(0.025 * SR); x[st:] += bandpass(r.standard_normal(n - st), 1500, 5000) * exp_decay(n - st, 0.004) * 0.3
    return norm(x, 0.7), 0.001


def s_scratch(p, r):
    dur = p.get('dur', 0.45); n = int(dur * SR); t = np.arange(n) / SR
    rate = 1 + 0.9 * np.sin(TAU * t / dur * 2)
    x = sweep_filter_noise(r.standard_normal(n), 600, 3000, q=2.5) * (0.5 + 0.5 * np.abs(np.sin(TAU * t / dur * 2)))
    x *= rate
    return norm(x, 0.7), None


def s_bed(p, r):
    """room-tone / air bed; dur required"""
    dur = p.get('dur', 4.0); n = int(dur * SR)
    x = lowpass(r.standard_normal(n), 900) * 0.6 + bandpass(r.standard_normal(n), 2000, 6000) * 0.05
    fade = min(int(0.5 * SR), n // 3); e = np.ones(n); e[:fade] = np.linspace(0, 1, fade); e[-fade:] = np.linspace(1, 0, fade)
    return norm(x * e, 0.25), 0.0


TAU = 2 * math.pi
GEN = {k[2:]: v for k, v in globals().items() if k.startswith('s_')}


def load_audio(path):
    if path.lower().endswith('.wav'):
        sr, d = wavfile.read(path)
    else:
        fd, tmp = tempfile.mkstemp(suffix='.wav'); os.close(fd)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', path, '-ar', str(SR), '-ac', '2', tmp], check=True)
        sr, d = wavfile.read(tmp); os.unlink(tmp)
    kind = d.dtype
    d = d.astype(np.float64)
    if kind == np.int16: d /= 32768.0
    elif kind == np.int32: d /= 2147483648.0
    elif kind == np.uint8: d = (d - 128) / 128.0
    if d.ndim == 1: d = np.stack([d, d], 1)
    if sr != SR: d = signal.resample_poly(d, SR, sr, axis=0)
    return d[:, :2]


def place(buf, mono_or_st, at, gain=1.0, pan=0.0):
    x = mono_or_st
    if x.ndim == 1:
        l, rr = math.cos((pan + 1) * math.pi / 4), math.sin((pan + 1) * math.pi / 4)
        x = np.stack([x * l, x * rr], 1) * math.sqrt(2)
    i = int(round(at * SR))
    if i < 0: x, i = x[-i:], 0
    end = min(len(buf), i + len(x))
    if end > i: buf[i:end] += x[: end - i] * gain


def render_events(events, duration):
    buf = np.zeros((int(math.ceil(duration * SR)) + SR, 2)); duck_spans = []
    for k, e in enumerate(events):
        kind = e.get('kind') or e.get('type')
        if kind == 'file':
            src = e['src']; x = load_audio(src)
            if e.get('dur'): x = x[: int(e['dur'] * SR)]
            place(buf, x, e['t'], e.get('gain', 1.0))
            if e.get('duck'): duck_spans.append((e['t'], e['t'] + len(x) / SR))
            continue
        if kind not in GEN:
            print(f'  skip unknown kind {kind!r} at {e.get("t")}', file=sys.stderr); continue
        r = rng_for(kind, e.get('variant', 0), round(e['t'], 4), k)
        x, hit = GEN[kind](e, r)
        if hit is None:   # no designed attack: land the loudest moment (smoothed envelope) on t
            env = np.convolve(np.abs(x), np.ones(480) / 480, mode='same'); hit = float(np.argmax(env)) / SR
        place(buf, x, e['t'] - hit, e.get('gain', 0.5), e.get('pan', 0.0))
    return buf, duck_spans


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('events', nargs='?'); ap.add_argument('out', nargs='?')
    ap.add_argument('--duration', type=float); ap.add_argument('--music'); ap.add_argument('--music-gain', type=float, default=0.34)
    ap.add_argument('--duck', type=float, default=0.5, help='music gain multiplier under events with duck:true')
    ap.add_argument('--music-fade', type=float, default=1.0); ap.add_argument('--demo')
    a = ap.parse_args()
    if a.demo:
        kinds = [k for k in GEN if k != 'bed']; ev = [dict(t=0.6 + i * 1.1, kind=k, gain=0.7) for i, k in enumerate(kinds)]
        buf, _ = render_events(ev, len(kinds) * 1.1 + 2); write(a.demo, buf); print('kinds:', ', '.join(kinds)); return
    data = json.load(open(a.events))
    events = data['EVENTS'] if isinstance(data, dict) else data
    dur = a.duration or (data.get('FILM') or {}).get('duration') if isinstance(data, dict) else a.duration
    dur = dur or (max([e['t'] for e in events] + [0]) + 2)
    buf, duck = render_events(events, dur)
    if a.music:
        m = load_audio(a.music)[: len(buf)]
        g = np.full(len(m), a.music_gain)
        f = int(a.music_fade * SR); g[:f] *= np.linspace(0, 1, f); end = int(dur * SR)
        if end < len(g): g[end:] = 0
        g[max(0, end - 2 * f):end] *= np.linspace(1, 0, min(end, 2 * f))
        for t0, t1 in duck:
            i0, i1 = int(t0 * SR), int(t1 * SR); ramp = int(0.15 * SR)
            k = np.ones(len(g)); k[i0:i1] = a.duck
            k[max(0, i0 - ramp):i0] = np.linspace(1, a.duck, i0 - max(0, i0 - ramp))
            k[i1:i1 + ramp] = np.linspace(a.duck, 1, len(k[i1:i1 + ramp])); g *= k
        buf[: len(m)] += m * g[:, None]
    buf = buf[: int(dur * SR)]
    pre = 20 * np.log10(np.max(np.abs(buf)) + 1e-12)
    write(a.out, buf)
    note = '  (summed peak was above 0 dBFS: soft-limited — lower some gains if it sounds squashed)' if pre > -0.2 else ''
    print(f'✓ {a.out}  {dur:.2f}s, {len(events)} events, mix peak {min(pre, -0.18):.1f} dBFS{note}')


def write(path, buf):
    peak = np.max(np.abs(buf))
    if peak > 0.98: buf = np.tanh(buf / peak * 1.2) / math.tanh(1.2) * 0.98   # soft safety limit; master.sh does loudness
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    wavfile.write(path, SR, (buf * 32767).astype(np.int16))


if __name__ == '__main__':
    main()
