#!/usr/bin/env node
// capture.mjs — turn a running product into promo material: full-page 2x textures, element cut-outs, layout.json.
//
//   node capture.mjs capture.json
//
// capture.json:
// {
//   "base": "http://localhost:3000",            // the product, running locally WITH fictional demo data already seeded
//   "out": "assets/live",                       // textures + cut-outs go here
//   "layout": "assets/live/layout.json",
//   "viewport": { "width": 1920, "height": 1080, "deviceScaleFactor": 2 },
//   "settleMs": 600,
//   "hideSelectors": [".cookie-banner", "[data-intercom]"],   // removed before every capture
//   "pages": [
//     { "name": "home", "path": "/", "waitMs": 0,
//       "boxes":   [ { "key": "sections", "selector": "main h2", "all": true } ],          // coordinates only
//       "cutouts": [ { "name": "card", "selector": "article", "all": true, "max": 12 },     // PNG + coordinates
//                    { "name": "search", "selector": "input[type=search]", "parent": true, "transparent": true, "scale": 4 } ],
//       "emptyPlate": "article",                // also capture the page with these hidden → home-empty.png (fly-in targets)
//       "click": "button[role=tab]:nth-of-type(2)", "afterMs": 800 }                         // optional: then home-after.png
//   ]
// }
//
// RED LINE: seed believable FICTIONAL data first. Never capture real customer, personal, internal or secret data.
// Re-run any time; pass page names after the config to capture only those: node capture.mjs capture.json home
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const cfgPath = process.argv[2];
if (!cfgPath) { console.error('usage: node capture.mjs capture.json [pageName ...]'); process.exit(2); }
const only = new Set(process.argv.slice(3));
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const ROOT = path.dirname(path.resolve(cfgPath));
const OUT = path.resolve(ROOT, cfg.out || 'assets/live');
const LAYOUT = path.resolve(ROOT, cfg.layout || path.join(cfg.out || 'assets/live', 'layout.json'));
const VP = { width: 1920, height: 1080, deviceScaleFactor: 2, ...(cfg.viewport || {}) };

async function loadPuppeteer() {
  const bases = [ROOT, process.cwd()];
  try { bases.push(path.join(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), '_')); } catch {}
  for (const b of bases) for (const n of ['puppeteer-core', 'puppeteer']) {
    try { const m = await import(pathToFileURL(createRequire(path.join(b, 'x.js')).resolve(n)).href); return m.default || m; } catch {}
  }
  console.error('✗ npm i puppeteer-core in the project folder'); process.exit(1);
}
const puppeteer = await loadPuppeteer();
function findChrome() {
  const fixed = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'];
  for (const p of fixed) if (fs.existsSync(p)) return p;
  for (const d of [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(process.env.HOME || '', '.cache/ms-playwright'), '/opt/pw-browsers'].filter(Boolean)) {
    if (!fs.existsSync(d)) continue;
    for (const sub of fs.readdirSync(d).filter((x) => /^chromium-\d+/.test(x)).sort().reverse())
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) { const p = path.join(d, sub, rel); if (fs.existsSync(p)) return p; }
  }
}
const chrome = process.env.CHROME_PATH || cfg.chrome || findChrome();
if (!chrome) { console.error('✗ set CHROME_PATH'); process.exit(1); }

fs.mkdirSync(OUT, { recursive: true });
const layout = fs.existsSync(LAYOUT) ? JSON.parse(fs.readFileSync(LAYOUT, 'utf8')) : {};
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])] });
const page = await browser.newPage();
await page.setViewport(VP);

async function settle(ms) {
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.evaluate((sel) => { for (const s of sel) document.querySelectorAll(s).forEach((e) => e.remove()); }, cfg.hideSelectors || []);
  // freeze motion so captures are stable: stop CSS animations/transitions and caret blink
  await page.addStyleTag({ content: '*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}' });
  await new Promise((r) => setTimeout(r, ms));
}
const boxOf = (sel, all, max, parent) => page.evaluate((sel, all, max, parent) => {
  const els = [...document.querySelectorAll(sel)].slice(0, all ? (max || 999) : 1).map((e) => (parent ? e.parentElement : e));
  return els.map((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; });
}, sel, all, max, parent);

for (const pg of cfg.pages) {
  if (only.size && !only.has(pg.name)) continue;
  const url = new URL(pg.path || '/', cfg.base).href;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  await settle((cfg.settleMs ?? 600) + (pg.waitMs || 0));
  const pageH = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
  const entry = { url: pg.path || '/', width: VP.width, pageH, scale: VP.deviceScaleFactor, boxes: {}, cutouts: {} };
  await page.screenshot({ path: path.join(OUT, `${pg.name}.png`), fullPage: true });
  for (const b of pg.boxes || []) { const r = await boxOf(b.selector, b.all, b.max, b.parent); entry.boxes[b.key] = b.all ? r : r[0] || null; }
  for (const c of pg.cutouts || []) {
    const handles = (await page.$$(c.selector)).slice(0, c.all ? (c.max || 999) : 1);
    const boxes = await boxOf(c.selector, c.all, c.max, c.parent);
    for (let i = 0; i < handles.length; i++) {
      let h = handles[i]; if (c.parent) h = await h.evaluateHandle((e) => e.parentElement);
      const name = c.all ? `${c.name}${i + 1}` : c.name;
      const file = path.join(OUT, `${pg.name}-${name}.png`);
      // transparent: clear the backgrounds of the element's ancestors so only the element itself is opaque
      if (c.transparent) await h.evaluate((e) => { for (let a = e.parentElement; a; a = a.parentElement) { a.dataset.mfBg = a.style.background; a.style.background = 'transparent'; } });
      if (c.scale && c.scale !== VP.deviceScaleFactor) {   // hero elements: re-capture at higher density (aesthetic-rules Q2)
        await page.setViewport({ ...VP, deviceScaleFactor: c.scale }); await settle(200);
        await h.screenshot({ path: file, omitBackground: !!c.transparent });
        await page.setViewport(VP); await settle(200);
      } else await h.screenshot({ path: file, omitBackground: !!c.transparent });
      if (c.transparent) await h.evaluate((e) => { for (let a = e.parentElement; a; a = a.parentElement) { a.style.background = a.dataset.mfBg || ''; delete a.dataset.mfBg; } });
      entry.cutouts[name] = { file: path.relative(path.dirname(LAYOUT), file), ...boxes[i], scale: c.scale || VP.deviceScaleFactor };
    }
  }
  if (pg.emptyPlate) {
    await page.evaluate((s) => document.querySelectorAll(s).forEach((e) => (e.style.visibility = 'hidden')), pg.emptyPlate);
    await page.screenshot({ path: path.join(OUT, `${pg.name}-empty.png`), fullPage: true });
    await page.evaluate((s) => document.querySelectorAll(s).forEach((e) => (e.style.visibility = '')), pg.emptyPlate);
  }
  if (pg.click) {
    const el = await page.$(pg.click);
    if (el) { await el.click(); await settle(pg.afterMs || 800); await page.screenshot({ path: path.join(OUT, `${pg.name}-after.png`), fullPage: true }); }
    else console.log(`  ! ${pg.name}: click target not found: ${pg.click}`);
  }
  layout[pg.name] = entry;
  console.log(`✓ ${pg.name}: page ${VP.width}×${pageH} @${VP.deviceScaleFactor}x, ${Object.keys(entry.boxes).length} box sets, ${Object.keys(entry.cutouts).length} cut-outs`);
}
fs.mkdirSync(path.dirname(LAYOUT), { recursive: true });
fs.writeFileSync(LAYOUT, JSON.stringify(layout, null, 1));
console.log(`✓ ${path.relative(process.cwd(), LAYOUT)}`);
await browser.close();
