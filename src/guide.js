import * as THREE from 'three';
import { guideDimensions } from './route-clearance.js';

export function makeGuide(curve, kind, unit = 1, belowDeck = false) {
  const group = new THREE.Group();
  const clear = kind === 'glass' || kind === 'exit',
    brass = kind === 'brass';
  const enamel = new THREE.MeshStandardMaterial({
    color: brass ? 0x937341 : kind === 'exit' ? 0xa9a3ab : clear ? 0xc590aa : 0x18151b,
    emissive: brass ? 0x593613 : clear ? 0x685a6d : 0x151217,
    emissiveIntensity: clear ? 0.48 : 0.23,
    roughness: brass ? 0.44 : 0.24,
    metalness: clear ? 0.16 : 0.52,
  });
  const { radius, half } = guideDimensions(kind, unit);
  const center = curve.getPoints(36);
  const edges = [-1, 1].map((side) =>
    center.map((p, i) => {
      const v = center[Math.min(center.length - 1, i + 1)]
        .clone()
        .sub(center[Math.max(0, i - 1)])
        .normalize();
      return p.clone().add(new THREE.Vector3(-v.y * side * half, v.x * side * half, side * 0.1 * unit));
    }),
  );
  for (const points of edges) {
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 42, radius, 7, false),
      enamel,
    );
    tube.castShadow = true;
    group.add(tube);
  }
  if (kind !== 'rail') {
    const xyz = [],
      indices = [];
    for (let j = 0; j < center.length; j++) {
      for (const row of edges) xyz.push(...row[j].toArray());
      const k = j * 2;
      if (j) indices.push(k - 2, k - 1, k, k - 1, k + 1, k);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(xyz, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const deck = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        color: brass ? 0xc39957 : kind === 'exit' ? 0xb2a6ae : 0xd3a8bd,
        emissive: brass ? 0x785128 : 0x715b74,
        emissiveIntensity: brass ? 0.33 : 0.39,
        transparent: clear,
        opacity: kind === 'exit' ? 0.18 : clear ? 0.32 : 1,
        depthWrite: !clear,
        side: THREE.DoubleSide,
        metalness: brass ? 0.53 : 0.2,
        roughness: 0.26,
      }),
    );
    group.add(deck);
  }
  if (kind !== 'exit') {
    for (const u of [0.12, 0.49, 0.88]) {
      const p = curve.getPoint(u);
      const end = p
        .clone()
        .add(
          new THREE.Vector3(
            0.07 * unit,
            (belowDeck ? -0.1 : 0.32) * unit,
            (belowDeck ? -0.63 : -0.48) * unit,
          ),
        );
      const line = new THREE.LineCurve3(p, end);
      group.add(new THREE.Mesh(new THREE.TubeGeometry(line, 1, 0.014 * unit, 6, false), enamel));
      const disk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.046 * unit, 0.055 * unit, 0.045 * unit, 10),
        enamel,
      );
      disk.rotation.x = Math.PI / 2;
      disk.position.copy(end);
      group.add(disk);
    }
  }
  return group;
}
