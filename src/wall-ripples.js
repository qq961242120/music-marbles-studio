import * as THREE from 'three';

export const rippleDuration = 0.82;
export const rippleWallOffset = 0.006;

const vertexShader = `
  varying vec2 wallUv;
  void main() {
    wallUv = uv * 2.0 - 1.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const fragmentShader = `
  uniform float progress, strength;
  uniform vec3 tint;
  varying vec2 wallUv;

  // Each crest has a broader shaded trough just behind it.
  float band(float distance, float width) {
    float x = distance / width;
    return exp(-x*x);
  }

  void main() {
    float radius = length(wallUv);
    vec2 direction = wallUv / max(radius, .0001);
    float angle = atan(direction.y, direction.x + .00001);
    float ripple = radius * (1.0 + .016*sin(3.0*angle + .4) + .009*sin(5.0*angle - .3*progress));
    float front = .90 * progress * (1.28 - .28*progress);
    float d = ripple - front;
    float width = .014 + .010*progress + .45*fwidth(radius);
    float crest = band(d, width) + .48*band(d+.14, width*.91) + .18*band(d+.27, width*.86);
    float trough = band(d+.038, width*1.45) + .45*band(d+.18, width*1.3);
    float facing = .58 + .38*dot(direction, vec2(-.60,.80));
    facing += .10*sin(2.0*angle + 7.0*d);
    float highlight = .18 * facing * crest;
    float shade = .26 * trough;
    float fade = (1.0-smoothstep(.28, 1.0, progress)) * (.56+.44*strength);
    float alpha = (highlight + shade) * fade;
    if (alpha < .0008) discard;
    vec3 reflected = mix(tint, vec3(.82,.91,.96), .30);
    vec3 color = mix(vec3(.012,.009,.017), reflected, highlight / (highlight+shade));
    gl_FragColor = vec4(color, alpha);
  }`;

// Only the impacts still propagating need a mesh. Rebuild their state from
// song time, so scrubbing, preview and offline frame capture always agree.
export class WallRipples extends THREE.Group {
  constructor() {
    super();
    this.name = 'wall-ripples';
    this.patchGeometry = new THREE.PlaneGeometry(1, 1);
  }

  update(strikes, time, wallZ) {
    let slot = 0;
    const last = strikes.findLastIndex((strike) => strike.t <= time);
    for (let i = last; i >= 0 && time - strikes[i].t < rippleDuration; i--) {
      const strike = strikes[i];
      const wave = this.children[slot++] ?? this.createWave();
      const strength = THREE.MathUtils.clamp(strike.strength, 0, 1);
      const diameter = 2 * (1.22 + 0.42 * strength);
      wave.position.copy(strike.anchor);
      wave.position.z = wallZ + rippleWallOffset;
      wave.scale.set(diameter, diameter, 1);
      const { uniforms } = wave.material;
      uniforms.progress.value = (time - strike.t) / rippleDuration;
      uniforms.strength.value = strength;
      uniforms.tint.value.copy(strike.tint);
      wave.visible = true;
    }
    for (; slot < this.children.length; slot++) this.children[slot].visible = false;
  }

  createWave() {
    const material = new THREE.ShaderMaterial({
      uniforms: { progress: { value: 0 }, strength: { value: 0 }, tint: { value: new THREE.Color() } },
      transparent: true,
      depthWrite: false,
      vertexShader,
      fragmentShader,
    });
    const wave = new THREE.Mesh(this.patchGeometry, material);
    this.add(wave);
    return wave;
  }

  dispose() {
    this.patchGeometry.dispose();
    for (const wave of this.children) wave.material.dispose();
  }
}
