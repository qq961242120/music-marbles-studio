// Check wall-space impacts and the rendered outward motion of their crests.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { rippleDuration } from '../src/wall-ripples.js';

const job = process.argv[2];
if (!job) throw Error('用法：node scripts/check-wall-ripples.mjs <歌曲任务 ID>');
const base = process.env.MARBLES_URL || 'http://127.0.0.1:7100';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--enable-gpu', '--use-angle=metal'],
});
try {
  for (const [width, height] of [
    [360, 640],
    [640, 360],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.addInitScript(() => {
      window.__THREE_DEVTOOLS__ = new EventTarget();
      window.__scenes = [];
      __THREE_DEVTOOLS__.addEventListener('observe', ({ detail }) => {
        if (detail.isScene) __scenes.push(detail);
      });
    });
    await page.route('**/api/jobs/*/plan', async (route) => {
      const plan = await (await route.fetch()).json();
      await route.fulfill({ json: { ...plan, width, height } });
    });
    await page.goto(base + '/render.html?job=' + encodeURIComponent(job), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__SCENE_READY__ || window.__SCENE_ERROR__, null, {
      timeout: 90000,
    });
    assert.equal(await page.evaluate(() => window.__SCENE_ERROR__ || null), null);
    const result = await page.evaluate((life) => {
      const scene = __scenes.find((s) => s.getObjectByName('wall-ripples'));
      const group = scene.getObjectByName('wall-ripples');
      const wall = scene.children.find((o) => o.isMesh && o.geometry.type === 'PlaneGeometry');
      const { hits, duration } = __PLAN__;
      const canvas = document.querySelector('#render-canvas');
      const { width, height } = canvas;
      let camera;
      scene.onBeforeRender = (_, __, cam) => {
        camera = cam;
      };
      const active = () => group.children.filter((wave) => wave.visible);
      let maxCenterError = 0,
        strikes = 0,
        maxWallGap = 0;
      const attributed = [];
      // Compare each wave at first contact to the same key used by the render page.
      for (const [i, hit] of hits.entries()) {
        const boards = __projectEventBoards(i, hit.t);
        if (!boards.length) continue;
        const wave = active().find((w) => w.material.uniforms.progress.value === 0);
        if (!wave) throw Error('Missing impact at ' + hit.t);
        const center = wave.position.clone().project(camera);
        const [x, y] = boards[0];
        maxCenterError = Math.max(
          maxCenterError,
          Math.hypot(((center.x - x) * width) / 2, ((center.y - y) * height) / 2),
        );
        maxWallGap = Math.max(maxWallGap, Math.abs(wave.position.z - wall.position.z));
        if (!wave.material.depthTest || wave.material.depthWrite) throw Error('Incorrect wall depth test');
        attributed.push(hit.t);
        strikes++;
      }
      const hitTime = attributed[0];
      function countAt(t) {
        __seek(t);
        return active().length;
      }
      const pre = countAt(hitTime - 0.005);
      const ending = countAt(duration);
      const tOverlap = attributed.find((t, i) => i && t - attributed[i - 1] < 0.4);
      const overlap = tOverlap === undefined ? 0 : countAt(tOverlap + 0.001);

      // On the actual wall, measure the luminous crest at two ages, sampling
      // rays in the wall plane so perspective and camera motion don't skew it.
      const copy = document.createElement('canvas');
      copy.width = width;
      copy.height = height;
      const ctx = copy.getContext('2d', { willReadFrequently: true });
      const pixels = () => {
        ctx.drawImage(canvas, 0, 0);
        return ctx.getImageData(0, 0, width, height).data;
      };
      function crest(age) {
        const t = hitTime + age;
        __seek(t);
        const wave = active().reduce((best, w) =>
          Math.abs(w.material.uniforms.progress.value - age / life) <
          Math.abs(best.material.uniforms.progress.value - age / life)
            ? w
            : best,
        );
        // Difference the same frame with and without this one wave.
        const draw = scene.onBeforeRender;
        scene.onBeforeRender = (...args) => {
          draw(...args);
          wave.visible = false;
        };
        __seek(t);
        const off = pixels();
        scene.onBeforeRender = draw;
        __seek(t);
        const on = pixels();
        let best = 0,
          peak = 0;
        for (let r = 0.04; r < 0.65; r += 0.01) {
          const differences = [];
          for (let k = 0; k < 40; k++) {
            const a = (k * 2 * Math.PI) / 40,
              p = wave.position.clone();
            p.x += r * wave.scale.x * 0.5 * Math.cos(a);
            p.y += r * wave.scale.y * 0.5 * Math.sin(a);
            p.project(camera);
            const x = Math.floor(((1 + p.x) * width) / 2),
              y = Math.floor(((1 - p.y) * height) / 2);
            if (x < 0 || x >= width || y < 0 || y >= height) continue;
            const ix = 4 * (y * width + x);
            differences.push(
              (on[ix] - off[ix] + (on[ix + 1] - off[ix + 1]) + (on[ix + 2] - off[ix + 2])) / 3,
            );
          }
          differences.sort((a, b) => a - b);
          const level = differences[Math.floor(differences.length * 0.6)] ?? 0;
          if (level > peak) {
            best = r;
            peak = level;
          }
        }
        return { radius: best, signal: peak };
      }
      const early = crest(0.13),
        late = crest(0.29);
      __seek(hitTime + 0.13);
      const repeat = pixels();
      __seek(duration);
      __seek(hitTime + 0.13);
      const again = pixels();
      const equal = again.every((value, i) => value === repeat[i]);
      return {
        width,
        height,
        strikes,
        maxCenterError,
        maxWallGap,
        pre,
        ending,
        quietEnd: duration - attributed.at(-1) > life,
        overlap,
        tOverlap,
        early,
        late,
        equal,
        halo: !!scene.getObjectByName('marble-halo'),
      };
    }, rippleDuration);
    console.log(result);
    assert.deepEqual(errors, []);
    assert(!result.halo && result.strikes > 0 && result.maxCenterError < 1 && result.maxWallGap < 0.01);
    assert(result.pre === 0 && (!result.quietEnd || result.ending === 0));
    assert(result.tOverlap === undefined || result.overlap >= 2);
    assert(
      result.early.signal > 1 && result.late.signal > 1 && result.late.radius - result.early.radius > 0.1,
    );
    assert(result.equal, 'Scrubbing changed a previously rendered ripple');
    await page.close();
  }
} finally {
  await browser.close();
}
