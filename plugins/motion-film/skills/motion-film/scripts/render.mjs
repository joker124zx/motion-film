#!/usr/bin/env node
// motion-film renderer: a web page that can draw any time t → stills, review sheets, frames, MP4.
//
// Page contract (see references/tech.md):
//   window.FILM = { width, height, fps, duration }   optional defaults
//   window.renderAt = async (t) => {...}              draw frame at time t (seconds), deterministic
//   window.READY = true                               set once fonts/images/shaders are loaded
//   window.EVENTS = [{t, kind, ...}]  window.CUES = [{t0,t1,text}]  window.TEXTS = t => [{id,text}]   optional
//
// Usage:
//   node render.mjs <project-dir|page.html> [options]
//     (no mode)                    full render → <dir>/out/video.mp4
//     --stills 0.5,2,4.25          PNG stills → out/stills/
//     --sheet 0:12:0.5 | 1,2,3     contact sheet (range a:b:step or list) → out/qa/sheet.jpg
//     --strip 2.1:2.6              every frame of a moment as a sheet → out/qa/strip.jpg
//     --crop x,y,w,h               crop each sheet/strip/still cell (frame px)
//     --cols 6 --cellw 320         sheet layout
//     --events out/events.json     export FILM/EVENTS/CUES (+ .srt next to it) without rendering
//     --readcheck                  check on-screen text hold times via window.TEXTS
//   options: --out file.mp4 --fps 30 --w 1920 --h 1080 --duration 10 --from 0 --to 10
//            --workers 2 --mb 4 --shutter 0.5 --scale 1 --crf 16 --preset veryfast --audio mix.wav
//            --frames out/frames (keep JPEG frames; resumable)  --query k=v&k2=v2
//            --chrome /path/to/chrome  --soft-gl  --page other.html  --png (lossless intermediate frames)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------- args ----------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) {
      const key = k.slice(2), next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) a[key] = true; else { a[key] = next; i++; }
    } else a._.push(k);
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
if (!args._[0]) { console.error('usage: node render.mjs <project-dir|page.html> [options]  (see header)'); process.exit(2); }

let target = path.resolve(args._[0]);
let ROOT, PAGE;
if (fs.statSync(target).isDirectory()) { ROOT = target; PAGE = args.page || 'index.html'; }
else { ROOT = path.dirname(target); PAGE = path.basename(target); }
const OUT = path.join(ROOT, 'out');

// ---------- dependencies ----------
async function loadPuppeteer() {
  const bases = [ROOT, process.cwd(), HERE];
  try { bases.push(path.join(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), '_')); } catch {}
  for (const b of bases) {
    const req = createRequire(path.join(b, 'noop.js'));
    for (const name of ['puppeteer-core', 'puppeteer']) {
      try { const p = req.resolve(name); const m = await import(pathToFileURL(p).href); return m.default || m; } catch {}
    }
  }
  console.error('✗ puppeteer-core not found. In the project folder run: npm i puppeteer-core');
  process.exit(1);
}

function findChrome() {
  const c = args.chrome || process.env.CHROME_PATH;
  if (c) return c;
  const fixed = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of fixed) if (fs.existsSync(p)) return p;
  // Playwright-installed Chromium
  const pwDirs = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), '.cache/ms-playwright'),
    path.join(os.homedir(), 'Library/Caches/ms-playwright'), '/opt/pw-browsers', '/ms-playwright'].filter(Boolean);
  for (const d of pwDirs) {
    if (!fs.existsSync(d)) continue;
    for (const sub of fs.readdirSync(d).filter((s) => /^chromium-\d+/.test(s)).sort().reverse()) {
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const p = path.join(d, sub, rel); if (fs.existsSync(p)) return p;
      }
    }
  }
  console.error('✗ Chrome/Chromium not found. Pass --chrome <path> or set CHROME_PATH.');
  process.exit(1);
}

// ---------- static server (project root; /lib/* maps to this scripts folder) ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.mp4': 'video/mp4', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.hdr': 'application/octet-stream' };
function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://x');
        let rel = decodeURIComponent(u.pathname);
        if (rel === '/favicon.ico') { res.writeHead(204); return res.end(); }
        let base = ROOT;
        if (rel.startsWith('/lib/')) { base = HERE; rel = rel.slice(4); }
        let p = path.join(base, rel);
        if (!p.startsWith(base)) { res.writeHead(403); return res.end(); }
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
        if (!fs.existsSync(p)) { res.writeHead(404); return res.end('404 ' + u.pathname); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        fs.createReadStream(p).pipe(res);
      } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ---------- browser ----------
const puppeteer = await loadPuppeteer();
const CHROME = findChrome();
const launchArgs = ['--hide-scrollbars', '--mute-audio', '--disable-background-timer-throttling', '--no-first-run',
  '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--font-render-hinting=none',
  '--force-color-profile=srgb'];
if (process.platform === 'linux') launchArgs.push('--no-sandbox');
if (args['soft-gl']) launchArgs.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
else if (process.platform === 'darwin') launchArgs.push('--use-angle=metal');

const srv = await startServer();
const base = `http://127.0.0.1:${srv.address().port}/${PAGE}${args.query ? '?' + args.query : ''}`;
// one browser per worker: a background tab may never deliver a screenshot in headless Chrome
const launch = () => puppeteer.launch({ executablePath: CHROME, headless: true, args: launchArgs, protocolTimeout: 600000 });
const browser = await launch();
const extraBrowsers = [];

let pageErrors = 0;
async function openPage(w, h, tag = '', own = false) {
  let b = browser; if (own) { b = await launch(); extraBrowsers.push(b); }
  const page = await b.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: +(args.scale || 1) });
  page.on('console', (m) => { if (m.type() === 'error' || process.env.VERBOSE) console.log(`${tag}[page ${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => { pageErrors++; console.log(`${tag}[page error] ${e.message}`); });
  page.on('requestfailed', (r) => console.log(`${tag}[request failed] ${r.url()} ${r.failure()?.errorText}`));
  await page.goto(base, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction('window.READY === true || window.__ready === true', { timeout: 300000, polling: 100 });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  return page;
}

// read FILM defaults from a probe page
const probe = await openPage(+(args.w || 1920), +(args.h || 1080), '[probe]');
const FILM = await probe.evaluate(() => window.FILM || window.DEMO || {});
const W = +(args.w || FILM.width || 1920), H = +(args.h || FILM.height || 1080);
const FPS = +(args.fps || FILM.fps || 30), DUR = +(args.duration || FILM.duration || 10);
if (W !== 1920 || H !== 1080) await probe.setViewport({ width: W, height: H, deviceScaleFactor: +(args.scale || 1) });
const MB = Math.max(1, +(args.mb || 1)), SHUTTER = +(args.shutter ?? 0.5);
const SCALE = +(args.scale || 1);
const TOTAL = Math.round(DUR * FPS);

async function seek(page, t) {
  await page.evaluate(async (t) => {
    for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = t * 1000; } catch {} }
    if (typeof window.renderAt === 'function') await window.renderAt(t);
    else if (typeof window.render === 'function') await window.render(t);
  }, t);
}
const fmt = args.png ? 'png' : 'jpeg';
async function capture(page, clip) {
  const o = { type: fmt, clip: clip || { x: 0, y: 0, width: W, height: H }, optimizeForSpeed: true };
  if (fmt === 'jpeg') o.quality = 95;
  return page.screenshot(o);
}

// helper tab: builds labelled review sheets after all cells are captured
let helper;
async function getHelper() {
  if (helper) return helper;
  helper = await browser.newPage();
  await helper.setContent('<html><body style="margin:0;background:#111"></body></html>');
  return helper;
}
// motion blur: average sub-frame samples inside the rendering page (an OffscreenCanvas; the DOM is untouched)
async function average(page, bufs) {
  const b64 = await page.evaluate(async (list, mime) => {
    const bms = await Promise.all(list.map((s) => fetch(`data:${mime};base64,${s}`).then((r) => r.blob()).then(createImageBitmap)));
    const { width: w, height: hh } = bms[0];
    const c = new OffscreenCanvas(w, hh), x = c.getContext('2d', { willReadFrequently: true });
    const acc = new Float32Array(w * hh * 4);
    for (const bm of bms) { x.clearRect(0, 0, w, hh); x.drawImage(bm, 0, 0); const d = x.getImageData(0, 0, w, hh).data; for (let i = 0; i < d.length; i++) acc[i] += d[i]; }
    const out = x.createImageData(w, hh); const n = bms.length;
    for (let i = 0; i < acc.length; i++) out.data[i] = Math.round(acc[i] / n);
    x.putImageData(out, 0, 0);
    const blob = await c.convertToBlob({ type: mime, quality: 0.95 });
    const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, bufs.map((b) => Buffer.from(b).toString('base64')), `image/${fmt}`);
  return Buffer.from(b64, 'base64');
}

async function frameAt(page, f) {
  const t = f / FPS;
  if (MB === 1) { await seek(page, t); return capture(page); }
  const samples = [];
  for (let k = 0; k < MB; k++) { await seek(page, t + ((k + 0.5) / MB - 0.5) * SHUTTER / FPS); samples.push(await capture(page)); }
  return average(page, samples);
}

function ffmpeg(a) {
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { stdio: ['pipe', 'inherit', 'inherit'] });
  return { p, done: new Promise((res, rej) => p.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c))))) };
}
const encodeArgs = (outFile) => ['-c:v', 'libx264', '-preset', args.preset || 'veryfast', '-crf', String(args.crf || 16),
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', ...(SCALE !== 1 ? ['-vf', `scale=${W}:${H}:flags=lanczos`] : []), outFile];

// "1,2.5" | "0:10:0.5" | mixed "0:2:0.5,4,6:7:0.25"
const parseTimes = (s) => String(s).split(',').flatMap((p) => {
  if (!p.includes(':')) return [Number(p)];
  const [a, b, st = 0.5] = p.split(':').map(Number); const r = [];
  for (let i = 0; a + i * st <= b + 1e-9; i++) r.push(+(a + i * st).toFixed(4));
  return r;
});
const crop = args.crop ? (() => { const [x, y, w, h] = String(args.crop).split(',').map(Number); return { x, y, width: w, height: h }; })() : null;

async function sheet(times, file, title) {
  const cols = +(args.cols || Math.min(6, times.length));
  const cells = [];
  for (const t of times) {
    await seek(probe, t);
    cells.push({ t, b64: Buffer.from(await capture(probe, crop)).toString('base64') });
  }
  const cw = +(args.cellw || 320), aspect = crop ? crop.height / crop.width : H / W, ch = Math.round(cw * aspect);
  const rows = Math.ceil(cells.length / cols);
  const h = await getHelper();
  const sw = cols * (cw + 6) + 6, sh = rows * (ch + 26) + 34;
  await h.setViewport({ width: sw, height: sh });
  await h.setContent(`<html><body style="margin:0;background:#151515;font:12px/1.2 ui-monospace,monospace;color:#ddd">
    <div style="padding:8px 8px 0">${title}</div>
    <div style="display:grid;grid-template-columns:repeat(${cols},${cw}px);gap:6px;padding:6px">
    ${cells.map((c) => `<div><img style="width:${cw}px;height:${ch}px;display:block;object-fit:cover" src="data:image/${fmt};base64,${c.b64}"><div style="padding:3px 0">${c.t.toFixed(2)}s · f${Math.round(c.t * FPS)}</div></div>`).join('')}
    </div></body></html>`, { waitUntil: 'load' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await h.screenshot({ path: file, type: 'jpeg', quality: 88, fullPage: true });
  console.log(`✓ ${path.relative(process.cwd(), file)}  (${cells.length} frames)`);
}

const toSrt = (cues) => cues.map((c, i) => {
  const ts = (s) => { const ms = Math.round(s * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60, r = ms % 1000; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(r).padStart(3, '0')}`; };
  return `${i + 1}\n${ts(c.t0)} --> ${ts(c.t1)}\n${c.text}\n`;
}).join('\n');

// ---------- modes ----------
try {
  if (args.events) {
    const data = await probe.evaluate(() => ({ FILM: window.FILM || null, EVENTS: window.EVENTS || [], CUES: window.CUES || [] }));
    data.FILM = { ...(data.FILM || {}), width: W, height: H, fps: FPS, duration: DUR };
    const f = path.resolve(ROOT, args.events === true ? 'out/events.json' : args.events);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(data, null, 1));
    console.log(`✓ ${path.relative(process.cwd(), f)}  (${data.EVENTS.length} events, ${data.CUES.length} cues)`);
    if (data.CUES.length) { const s = f.replace(/\.json$/, '.srt'); fs.writeFileSync(s, toSrt(data.CUES)); console.log(`✓ ${path.relative(process.cwd(), s)}`); }
  } else if (args.readcheck) {
    const seen = await probe.evaluate((FPS, TOTAL) => {
      const m = {};
      if (typeof window.TEXTS !== 'function') return null;
      for (let f = 0; f <= TOTAL; f++) for (const x of window.TEXTS(f / FPS) || []) {
        const k = x.id ?? x.text; (m[k] ||= { text: x.text, spans: [] });
        const s = m[k].spans, last = s[s.length - 1];
        if (last && last[1] === f - 1) last[1] = f; else s.push([f, f]);
      }
      return m;
    }, FPS, TOTAL);
    if (!seen) { console.log('window.TEXTS(t) is not defined; nothing to check'); }
    else {
      let bad = 0;
      for (const [id, v] of Object.entries(seen)) {
        const cjk = (v.text.match(/[\u3000-\u9fff\uff00-\uffef]/g) || []).length;
        const other = v.text.replace(/[\u3000-\u9fff\uff00-\uffef\s]/g, '').length;
        const need = Math.max(1.8, cjk / 4.5 + other / 15 + 1.5);
        for (const [a, b] of v.spans) {
          const got = (b - a + 1) / FPS;
          if (got + 1e-6 < need) { bad++; console.log(`✗ "${v.text}" (${id})  ${(a / FPS).toFixed(2)}–${(b / FPS).toFixed(2)}s  on screen ${got.toFixed(2)}s, needs ${need.toFixed(2)}s`); }
        }
      }
      console.log(bad ? `${bad} text span(s) too short to read` : '✓ every text stays long enough to read');
      process.exitCode = bad ? 1 : 0;
    }
  } else if (args.stills) {
    const dir = path.join(OUT, 'stills'); fs.mkdirSync(dir, { recursive: true });
    for (const t of parseTimes(args.stills)) {
      await seek(probe, t);
      const file = path.join(dir, `t${t.toFixed(2)}.png`);
      await probe.screenshot({ path: file, type: 'png', clip: crop || { x: 0, y: 0, width: W, height: H } });
      console.log(`✓ ${path.relative(process.cwd(), file)}`);
    }
  } else if (args.sheet) {
    await sheet(parseTimes(args.sheet === true ? `0:${DUR}:${Math.max(0.5, DUR / 24)}` : args.sheet), path.resolve(ROOT, args.out || 'out/qa/sheet.jpg'), `sheet ${args.sheet}`);
  } else if (args.strip) {
    const [a, b] = String(args.strip).split(':').map(Number); const ts = [];
    for (let f = Math.round(a * FPS); f <= Math.round(b * FPS); f++) ts.push(f / FPS);
    await sheet(ts, path.resolve(ROOT, args.out || 'out/qa/strip.jpg'), `strip ${a}–${b}s (every frame @${FPS}fps)`);
  } else {
    // full render
    const f0 = Math.round(+(args.from || 0) * FPS), f1 = Math.min(TOTAL, Math.round(+(args.to ?? DUR) * FPS)) - 1;
    const outFile = path.resolve(ROOT, args.out || 'out/video.mp4'); fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const WORKERS = Math.max(1, +(args.workers || 1));
    const framesDir = args.frames ? path.resolve(ROOT, args.frames === true ? 'out/frames' : args.frames) : (WORKERS > 1 ? path.join(OUT, 'frames') : null);
    console.log(`render ${PAGE}: ${W}x${H}@${FPS}fps frames ${f0}–${f1} (${(f1 - f0 + 1)}), mb=${MB}, workers=${WORKERS}${framesDir ? ', frames→' + path.relative(ROOT, framesDir) : ''}`);
    const t0 = Date.now();
    if (!framesDir) {
      const enc = ffmpeg(['-f', 'image2pipe', '-framerate', String(FPS), '-i', '-', ...(args.audio ? ['-i', path.resolve(args.audio), '-c:a', 'aac', '-b:a', '256k', '-shortest'] : []), ...encodeArgs(outFile)]);
      for (let f = f0; f <= f1; f++) {
        const buf = await frameAt(probe, f);
        if (!enc.p.stdin.write(buf)) await new Promise((r) => enc.p.stdin.once('drain', r));
        if ((f - f0) % FPS === 0) process.stdout.write(`\r  ${f - f0 + 1}/${f1 - f0 + 1}  ${((Date.now() - t0) / (f - f0 + 1)).toFixed(0)} ms/frame `);
      }
      enc.p.stdin.end(); await enc.done;
    } else {
      fs.mkdirSync(framesDir, { recursive: true });
      const ext = fmt === 'png' ? 'png' : 'jpg';
      const todo = []; for (let f = f0; f <= f1; f++) if (!fs.existsSync(path.join(framesDir, `${String(f).padStart(6, '0')}.${ext}`))) todo.push(f);
      let done = 0;
      const pages = [probe]; for (let i = 1; i < WORKERS; i++) pages.push(await openPage(W, H, `[w${i}]`, true));
      await Promise.all(pages.map(async (pg, wi) => {
        for (let i = wi; i < todo.length; i += WORKERS) {
          const f = todo[i];
          fs.writeFileSync(path.join(framesDir, `${String(f).padStart(6, '0')}.${ext}`), await frameAt(pg, f));
          if (++done % FPS === 0) process.stdout.write(`\r  ${done}/${todo.length}  ${((Date.now() - t0) / done).toFixed(0)} ms/frame (wall) `);
        }
      }));
      const enc = ffmpeg(['-framerate', String(FPS), '-start_number', String(f0), '-i', path.join(framesDir, `%06d.${ext}`),
        ...(args.audio ? ['-i', path.resolve(args.audio), '-c:a', 'aac', '-b:a', '256k', '-shortest'] : []), '-frames:v', String(f1 - f0 + 1), ...encodeArgs(outFile)]);
      enc.p.stdin.end(); await enc.done;
    }
    console.log(`\n✓ ${path.relative(process.cwd(), outFile)}  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  if (pageErrors) { console.log(`✗ ${pageErrors} page error(s) — fix them before trusting the output`); process.exitCode = 1; }
} finally {
  for (const b of extraBrowsers) await b.close().catch(() => {});
  await browser.close(); srv.close();
}
