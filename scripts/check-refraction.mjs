// Verify visible refraction and foreground occlusion through the production glass pass.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = process.env.MARBLES_URL || 'http://127.0.0.1:7100';
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--enable-gpu', '--use-angle=metal'],
});
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 360 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.route('**/__glass_test.html', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<style>*{margin:0}canvas{display:block}</style><canvas></canvas>',
    }),
  );
  await page.goto(base + '/__glass_test.html');
  const result = await page.evaluate(async () => {
    const deps = '/node_modules/three/';
    const THREE = await import(deps + 'build/three.module.js');
    const { EffectComposer } = await import(deps + 'examples/jsm/postprocessing/EffectComposer.js');
    const { RenderPass } = await import(deps + 'examples/jsm/postprocessing/RenderPass.js');
    const { OutputPass } = await import(deps + 'examples/jsm/postprocessing/OutputPass.js');
    const { RoomEnvironment } = await import(deps + 'examples/jsm/environments/RoomEnvironment.js');
    const { GlassBallPass } = await import('/src/glass-ball.js');
    const rend = new THREE.WebGLRenderer({
      canvas: document.querySelector('canvas'),
      preserveDrawingBuffer: true,
    });
    rend.setSize(360, 360);
    const cam = new THREE.PerspectiveCamera(31, 1, 0.05, 16);
    cam.position.z = 2.6;
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    const sc = new THREE.Scene();
    sc.background = new THREE.Color(0x50474d);
    function plane(w, h, x, y, z, color) {
      let o = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color }));
      o.position.set(x, y, z);
      sc.add(o);
      return o;
    }
    plane(6, 6, 0, 0, -0.65, 0x50474d);
    const stripe = plane(0.082, 2, 0.14, 0, -0.649, 0xf4413c);
    plane(0.27, 0.065, 0, -0.11, 0.5, 0x1251e5);
    const comp = new EffectComposer(rend);
    comp.addPass(new RenderPass(sc, cam));
    const glass = new GlassBallPass(comp),
      pm = new THREE.PMREMGenerator(rend),
      env = pm.fromScene(new RoomEnvironment(), 0.04);
    glass.setEnvironment(env);
    glass.setView(cam, new THREE.Vector3(), -0.65);
    comp.addPass(glass);
    comp.addPass(new OutputPass());
    const paint = (enabled, color) => {
      glass.enabled = enabled;
      stripe.material.color.set(color);
      comp.render();
    };

    const copy = document.createElement('canvas');
    copy.width = copy.height = 360;
    const ctx = copy.getContext('2d', { willReadFrequently: true });
    function pixels(enabled, color) {
      paint(enabled, color);
      ctx.drawImage(rend.domElement, 0, 0);
      return ctx.getImageData(0, 0, 360, 360).data;
    }
    const base = pixels(false, 0xf4413c),
      red = pixels(true, 0xf4413c),
      green = pixels(true, 0x39de68);
    let bent = 0,
      front = 0,
      preserved = 0;
    for (let y = 0; y < 360; y++) {
      for (let x = 0; x < 360; x++) {
        if ((x - 179.5) ** 2 + (y - 179.5) ** 2 >= 67 ** 2) continue;
        const i = (y * 360 + x) * 4;
        const diff = (a, b) => Math.max(...[0, 1, 2].map((k) => Math.abs(a[i + k] - b[i + k])));
        if (base[i] - base[i + 1] <= 72 && diff(red, green) > 25) bent++;
        if (base[i + 2] > 160 && base[i] < 50) {
          front++;
          if (diff(red, base) < 3) preserved++;
        }
      }
    }
    return { bent, front, preserved };
  });
  assert.deepEqual(errors, []);
  assert(
    result.bent > 60,
    'Changing a coloured stripe should bend its image beyond the direct line of sight.',
  );
  assert(
    result.front > 100 && result.preserved >= result.front * 0.95,
    'An opaque foreground object must still occlude the ball.',
  );
  console.log(result);
} finally {
  await browser.close();
}
