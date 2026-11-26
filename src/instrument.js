import * as THREE from 'three';

const STOCK_WIDTH = 0.42;
const STOCK_LENGTH = 2.25;
const STOCK_THICKNESS = 0.078;
const REAR_GAP = 0.108;
const UP = new THREE.Vector3(0, 1, 0);

function bladeBlank(frontBore = -0.26) {
  const x = STOCK_WIDTH / 2,
    z = STOCK_LENGTH / 2,
    r = 0.038,
    bevel = 0.009;
  const outline = new THREE.Shape();
  outline.moveTo(-x + r, -z);
  outline.lineTo(x - r, -z);
  outline.quadraticCurveTo(x, -z, x, -z + r);
  outline.lineTo(x, z - r);
  outline.quadraticCurveTo(x, z, x - r, z);
  outline.lineTo(-x + r, z);
  outline.quadraticCurveTo(-x, z, -x, z - r);
  outline.lineTo(-x, -z + r);
  outline.quadraticCurveTo(-x, -z, -x + r, -z);
  for (const longitudinal of [frontBore, 0.26]) {
    const bore = new THREE.Path();
    bore.absarc(0, longitudinal * STOCK_LENGTH, 0.032, 0, Math.PI * 2, true);
    outline.holes.push(bore);
  }
  const depth = STOCK_THICKNESS - 2 * bevel;
  const geo = new THREE.ExtrudeGeometry(outline, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 6,
  });
  geo.translate(0, 0, -depth / 2);
  geo.rotateX(Math.PI / 2);
  return geo;
}

// Slice the neck crosswise so the curved flexure is represented on the caps,
// bevels and edges. A single shared morph target also drives depth and shadows.
function flexibleBlank(blank) {
  const pos = blank.attributes.position,
    nor = blank.attributes.normal;
  const positions = [],
    normals = [],
    offsets = [],
    normalOffsets = [];
  const root = 0.025,
    span = 0.14;
  const cuts = Array.from({ length: 10 }, (_, i) => (root + (span * i) / 9 - 0.5) * STOCK_LENGTH);
  function clip(poly, z, above) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i],
        b = poly[(i + 1) % poly.length];
      const da = (a.p.z - z) * (above ? 1 : -1),
        db = (b.p.z - z) * (above ? 1 : -1);
      if (da >= 0) out.push(a);
      if (da * db < 0) {
        const f = da / (da - db);
        out.push({ p: a.p.clone().lerp(b.p, f), n: a.n.clone().lerp(b.n, f).normalize() });
      }
    }
    return out;
  }
  function emit({ p, n }) {
    const u = THREE.MathUtils.clamp((p.z / STOCK_LENGTH + 0.5 - root) / span, 0, 1);
    const shape = u * u * (3 - 2 * u),
      slope = (6 * u * (1 - u)) / (span * STOCK_LENGTH);
    positions.push(p.x, p.y, p.z);
    normals.push(n.x, n.y, n.z);
    offsets.push(0, -STOCK_THICKNESS * shape, 0);
    normalOffsets.push(0, 0, n.y * STOCK_THICKNESS * slope);
  }
  for (let i = 0; i < pos.count; i += 3) {
    let polygon = [i, i + 1, i + 2].map((j) => ({
      p: new THREE.Vector3().fromBufferAttribute(pos, j),
      n: new THREE.Vector3().fromBufferAttribute(nor, j),
    }));
    const faces = [];
    for (const z of cuts) {
      if (!polygon.some((a) => a.p.z < z) || !polygon.some((a) => a.p.z > z)) continue;
      faces.push(clip(polygon, z, false));
      polygon = clip(polygon, z, true);
    }
    faces.push(polygon);
    for (const face of faces)
      for (let j = 1; j < face.length - 1; j++) [face[0], face[j], face[j + 1]].forEach(emit);
  }
  const g = new THREE.BufferGeometry();
  const attr = (values) => new THREE.Float32BufferAttribute(values, 3);
  g.setAttribute('position', attr(positions));
  g.setAttribute('normal', attr(normals));
  g.morphTargetsRelative = true;
  g.morphAttributes.position = [attr(offsets)];
  g.morphAttributes.normal = [attr(normalOffsets)];
  return g;
}

export function instrumentParts() {
  const parts = {
    blade: bladeBlank(),
    rod: new THREE.CylinderGeometry(1, 1, 1, 12),
    sleeve: new THREE.MeshStandardMaterial({ color: 0x423c39, metalness: 0.68, roughness: 0.31 }),
    brass: new THREE.MeshStandardMaterial({ color: 0x75614e, metalness: 0.79, roughness: 0.38 }),
    seat: new THREE.MeshStandardMaterial({ color: 0x373238, metalness: 0.63, roughness: 0.38 }),
  };
  // Keep both drillings clear of the ball's working strip at wall depth z=0.
  const drilled = bladeBlank(-0.15);
  parts.flexibleBlade = flexibleBlank(drilled);
  drilled.dispose();
  for (const resource of Object.values(parts)) resource.userData.instrumentShared = true;
  return parts;
}

function keyFinish(top, bottom) {
  const tone = (rgb) => new THREE.Color().setRGB(...rgb.map((n) => n / 255), THREE.SRGBColorSpace);
  const controls = {
    nearTint: { value: tone(top) },
    farTint: { value: tone(bottom) },
    power: { value: 1 },
    hit: { value: 0 },
  };
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.42,
    metalness: 0.14,
    clearcoat: 0.13,
    clearcoatRoughness: 0.27,
    envMapIntensity: 0.34,
    specularIntensity: 0.58,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, controls);
    shader.vertexShader =
      'varying float keyAlong; varying vec3 keyNormal;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        keyAlong=clamp(position.z/2.25+.5,0.,1.); keyNormal=normal;`,
      );
    shader.fragmentShader =
      'uniform vec3 nearTint,farTint; uniform float power,hit; varying float keyAlong; varying vec3 keyNormal;\n' +
      shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
        vec3 kn=normalize(keyNormal);
        float upper=smoothstep(.35,.86,kn.y), underside=smoothstep(.35,.86,-kn.y);
        vec3 enamel=mix(nearTint,farTint,keyAlong);
        enamel=max(vec3(.005),mix(vec3(dot(enamel,vec3(.2126,.7152,.0722))),enamel,1.61));
        vec3 graphite=mix(vec3(.007,.0058,.007),vec3(.018,.014,.018),.4+.4*keyAlong);
        diffuseColor.rgb=mix(graphite*(.45+.43*upper+.24*underside),enamel*(.11+.38*upper+.13*underside),power);`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
        totalEmissiveRadiance += enamel*(power*(.013+.23*upper+.069*underside)+hit*.32);`,
        );
  };
  return { material, controls };
}

export const pastelPairs = [
  [
    [242, 190, 158],
    [227, 147, 207],
  ],
  [
    [177, 220, 189],
    [157, 172, 232],
  ],
  [
    [240, 215, 151],
    [230, 165, 182],
  ],
  [
    [206, 182, 235],
    [157, 206, 225],
  ],
  [
    [163, 224, 205],
    [202, 170, 231],
  ],
];

// Project an elongated patch onto the wall: a soft wash plus a tapered image
// of the illuminated face. Both ends of the key contribute their actual colours.
const wallPatchGeometry = new THREE.PlaneGeometry(1, 1);
function wallLight(top, bottom) {
  const makeTint = (rgb) => new THREE.Color().setRGB(...rgb.map((v) => v / 255), THREE.SRGBColorSpace);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      nearTint: { value: makeTint(top) },
      farTint: { value: makeTint(bottom) },
      power: { value: 0 },
      strike: { value: 0 },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexShader: `varying vec2 patchUv;
      void main() {patchUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `varying vec2 patchUv; uniform vec3 nearTint,farTint; uniform float power,strike;
      void main() {
        float v=patchUv.y;
        float x=abs(patchUv.x-.5+.035*(v-.4));
        float penumbra=mix(.10,.20,v);
        float halfWidth=mix(.13,.045,v);
        float side=1.-smoothstep(halfWidth,halfWidth+penumbra,x);
        float along=smoothstep(.09,.30,v)*(1.-smoothstep(.41,.93,v));
        float core=side*along;
        float wash=exp(-17.*x*x-7.*(v-.49)*(v-.49))*
                   smoothstep(.0,.22,v)*(1.-smoothstep(.64,1.,v));
        vec3 tint=mix(nearTint,farTint,smoothstep(.23,.79,v)*.66);
        float mean=dot(tint,vec3(.2126,.7152,.0722));
        tint=max(vec3(0.),mix(vec3(mean),tint,1.25));
        gl_FragColor=vec4(tint, power*(.29*core+.17*wash)*(1.+.28*strike));
      }`,
  });
  const mesh = new THREE.Mesh(wallPatchGeometry, material);
  mesh.userData.sharedGeometry = true;
  return mesh;
}

function rod(parent, parts, a, b, radius, material) {
  const delta = new THREE.Vector3().subVectors(b, a);
  const mesh = new THREE.Mesh(parts.rod, material);
  mesh.position.copy(a).addScaledVector(delta, 0.5);
  mesh.scale.set(radius, delta.length(), radius);
  mesh.quaternion.setFromUnitVectors(UP, delta.normalize());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
}

/** The rear mount is on the XY wall. Local blade Z runs OUT from the wall. */
export function addInstrument(parent, parts, haloTexture, top, bottom, model) {
  const { width, length, leanX, leanY, roll } = model;
  const thickness = THREE.MathUtils.clamp(0.18 * width, 0.056, 0.085);
  const axis = new THREE.Vector3(leanX, leanY, 1).normalize();
  const wide = new THREE.Vector3(Math.cos(roll), Math.sin(roll), 0);
  wide.addScaledVector(axis, -wide.dot(axis)).normalize();
  const face = new THREE.Vector3().crossVectors(axis, wide);
  const basis = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(wide, face, axis));
  const assembly = new THREE.Group(),
    hinge = new THREE.Group(),
    pivot = new THREE.Group();
  assembly.add(hinge);
  hinge.quaternion.copy(basis);
  hinge.add(pivot);
  pivot.position.z = REAR_GAP;
  parent.add(assembly);

  const { material, controls } = keyFinish(top, bottom);
  assembly.name = 'wall-socket';
  const plank = new THREE.Mesh(model.flexible ? parts.flexibleBlade : parts.blade, material);
  plank.name = 'cantilever-key';
  plank.scale.set(width / STOCK_WIDTH, thickness / STOCK_THICKNESS, length / STOCK_LENGTH);
  plank.position.z = length / 2;
  plank.castShadow = true;
  plank.receiveShadow = true;
  pivot.add(plank);
  const local = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(basis);
  // Two saddles meet the underside. The inboard end and the diagonal tie are bolted
  // to wall pads. None of this hardware inherits the long dimension of the blade.
  const supports = model.flexible ? [0.002, 0.022] : [0.24, 0.76];
  const saddles = supports.map((u) => local(0, -thickness / 2, REAR_GAP + length * u));
  const rail = saddles.map((v) => v.clone().addScaledVector(face, -0.095));
  const footA = local(0, -thickness / 2 - 0.095, 0);
  footA.z = 0.042;
  const footB = local(0, -thickness / 2 - 0.2, 0);
  footB.z = 0.042;
  for (const foot of [footA, footB]) {
    const back = foot.clone();
    back.z = 0;
    rod(assembly, parts, back, foot, 0.045, parts.seat);
    const end = foot.clone();
    end.z += 0.014;
    rod(assembly, parts, foot, end, 0.027, parts.brass);
  }
  rod(assembly, parts, footA, rail[1], 0.018, parts.sleeve);
  rod(assembly, parts, footB, rail[1], 0.012, parts.brass);
  for (let i = 0; i < saddles.length; i++) {
    rod(assembly, parts, rail[i], saddles[i], 0.023, parts.brass);
    const collar = saddles[i].clone().addScaledVector(face, -0.022);
    rod(assembly, parts, collar, saddles[i], 0.042, parts.seat);
  }

  const glow = wallLight(top, bottom);
  const shade = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: haloTexture,
      color: 0x161319,
      transparent: true,
      depthWrite: false,
      opacity: 0.45,
    }),
  );
  parent.add(glow, shade);
  return {
    assembly,
    pivot,
    plank,
    controls,
    glow,
    shade,
    axis,
    wide,
    face,
    width,
    length,
    thickness,
    middle: REAR_GAP + length / 2,
  };
}

export function showInstrument(item, visible) {
  item.assembly.visible = item.glow.visible = item.shade.visible = visible;
}

/** width/height are the projected footprint used by the light on the wall, not mesh dimensions. */
export function illuminate(item, level, hit, halo, x, y, width, height, angle, wallDepth) {
  item.controls.power.value = level;
  item.controls.hit.value = hit;
  let dy = Math.cos(angle),
    dx = -Math.sin(angle);
  if (dy < 0) {
    dx = -dx;
    dy = -dy;
  }
  const { glow, shade } = item;
  glow.position.set(x + dx * height * 0.78, y + dy * height * 0.78, wallDepth);
  glow.scale.set(width * 2.66, height * 1.22, 1);
  glow.rotation.z = Math.atan2(-dx, dy);
  glow.material.uniforms.power.value = halo;
  glow.material.uniforms.strike.value = hit;
  shade.position.set(x - width * 0.43, y + height * 0.6, wallDepth - 0.02);
  shade.scale.set(width * 2.4, height * 1.45, 1);
  shade.material.rotation = angle - 0.12;
  shade.material.opacity = 0.19 + 0.12 * (1 - level);
}
