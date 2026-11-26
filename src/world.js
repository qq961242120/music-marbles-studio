import * as THREE from 'three';
import { gravity as GRAVITY, gravityMetres, metresPerUnit } from './rebound.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GlassBallPass } from './glass-ball.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { addInstrument, illuminate, pastelPairs, instrumentParts, showInstrument } from './instrument.js';
import { makeGuide } from './guide.js';
import { WallRipples, rippleWallOffset } from './wall-ripples.js';
import { planClearRoute } from './clear-route.js';

const SPEED = 4.2;
const BALL_Y = 0.61;
const cameraWeights = [1, 3, 6, 8, 6, 3, 1];
const PALETTE = [0xd876b4, 0x9d83df, 0x62c6b1, 0xd5cd69, 0xe39268];
const clamp = THREE.MathUtils.clamp;

function seeded(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGlowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255,255,255,0.85)');
  gradient.addColorStop(0.22, 'rgba(255,255,255,0.32)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

function makeLyricSprite(text, tint, reflection = false) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = '500 64px "PingFang SC","Noto Sans CJK SC",sans-serif';
  ctx.font = font;
  const metrics = ctx.measureText(text);
  canvas.width = Math.ceil(metrics.width + 20);
  canvas.height = 86;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = tint;
  if (reflection) ctx.filter = 'blur(10px)';
  ctx.fillText(text, canvas.width / 2, 44);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, transparent: true, depthWrite: false, toneMapped: false,
  }));
  sprite.scale.set(canvas.width / 220,canvas.height / 220,1);
  return sprite;
}

function railPosition(segment, time) {
  if (time <= segment.start) return { position: segment.curve.getPoint(0), u: 0 };
  if (time >= segment.end) return { position: segment.curve.getPoint(1), u: 1 };
  const elapsed = time - segment.start;
  let low = 0;
  let high = segment.times.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (segment.times[middle] <= elapsed) low = middle;
    else high = middle - 1;
  }
  const next = Math.min(segment.times.length - 1, low + 1);
  const span = Math.max(1e-12, segment.times[next] - segment.times[low]);
  const mix = clamp((elapsed - segment.times[low]) / span, 0, 1);
  // The route planner samples getPoint() at uniform curve parameters, not equal arc lengths.
  const u = (low + mix) / (segment.times.length - 1);
  return { position: segment.curve.getPoint(u), u };
}

export function createWorld(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.94;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const sky = new THREE.Color(0x302c33);
  scene.background = sky;
  scene.fog = new THREE.FogExp2(sky, 0.012);
  const camera = new THREE.PerspectiveCamera(49, 9 / 16, 0.08, 220);
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const glassBall = new GlassBallPass(composer);
  composer.addPass(glassBall);
  const smoothEdges=new ShaderPass(FXAAShader);
  composer.addPass(smoothEdges);
  const bloom = new UnrealBloomPass(new THREE.Vector2(1080, 1920), 0.2, 0.46, 0.8);
  composer.addPass(bloom);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = new RoomEnvironment();
  const envTarget = pmrem.fromScene(environment, 0.04);
  glassBall.setEnvironment(envTarget);
  scene.environment = envTarget.texture;
  scene.environmentIntensity = 0.76;
  environment.dispose();
  pmrem.dispose();

  scene.add(new THREE.HemisphereLight(0xc8dce8, 0x171019, 0.86));
  const key = new THREE.DirectionalLight(0xffe9d6, 1.08);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -9;
  key.shadow.camera.right = 9;
  key.shadow.camera.top = 12;
  key.shadow.camera.bottom = -12;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 45;
  key.shadow.bias = -0.00018;
  key.shadow.normalBias = .014;
  key.shadow.radius = 3.2;
  key.shadow.intensity = .52;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8ce8dc, 1.1);
  rim.position.set(7, 4, -9);
  scene.add(rim);
  const pinkLight = new THREE.PointLight(0xf08bc7, 4, 12, 2);
  scene.add(pinkLight);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 500),
    new THREE.MeshStandardMaterial({ color: 0x302931, roughness: 0.72, metalness: 0.16, envMapIntensity: 0.34 }),
  );
  ground.position.z = -0.65;
  ground.receiveShadow = true;
  scene.add(ground);
  const grid = new THREE.GridHelper(160, 25, 0x161119, 0x161119);
  grid.rotation.x = Math.PI / 2;
  grid.position.z = -0.63;
  grid.material.transparent = true;
  grid.material.opacity = 0.78;
  scene.add(grid);

  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 48, 32),
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
  );
  ball.castShadow = true;
  scene.add(ball);

  const glowTexture = makeGlowTexture();
  const ripples = new WallRipples();
  scene.add(ripples);
  const hardware=instrumentParts();
  const world = new THREE.Group();
  scene.add(world);

  const rand = seeded(81427);
  const dustPositions = new Float32Array(900 * 3);
  for (let i = 0; i < 900; i += 1) {
    dustPositions[i * 3] = (rand() - 0.5) * 55;
    dustPositions[i * 3 + 1] = rand() * 14 + 0.3;
    dustPositions[i * 3 + 2] = -rand() * 12 + 2;
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
  const dust = new THREE.Points(dustGeometry, new THREE.PointsMaterial({ color: 0x8fb5bd, size: 0.035, transparent: true, opacity: 0.5, depthWrite: false }));
  scene.add(dust);

  let plan = null;
  let events = [];
  let segments = [];
  let planks = [];
  let rippleStrikes = [];
  let rails = [];
  let lyrics = [];
  let currentTime = 0;
  let ending = null;


  function clearWorld() {
    for (const child of [...world.children]) {
      world.remove(child);
      child.traverse((object) => {
        if (object.geometry && !object.userData.sharedGeometry && !object.geometry.userData.instrumentShared) object.geometry.dispose();
        if (object.material) {
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) {
            if (material.map && material.map !== glowTexture) material.map.dispose();
            if (!material.userData.instrumentShared) material.dispose();
          }
        }
      });
    }
    planks = [];
    rippleStrikes = [];
    rails = [];
    lyrics = [];
    segments = [];
    ending = null;
  }

  function loadPlan(nextPlan) {
    clearWorld();
    plan = nextPlan;
    const hits = [...(plan.hits || [])].sort((a, b) => a.t - b.t);

    const route = planClearRoute(hits, plan.duration, plan.title || 'music-marbles', BALL_Y);
    events = route.events;
    segments = route.segments;
    ending = route.ending;
    for (const guide of route.guides) {
      const group = makeGuide(guide.under,guide.kind,1,true);
      world.add(group);
      rails.push({group,start:guide.start,end:guide.end,isEnding:guide.isEnding});
    }

    for (const event of events) {
      const pair=pastelPairs[event.index % pastelPairs.length];
      const roll=Math.atan2(event.normal.x,-event.normal.y);
      const item=addInstrument(world,hardware,glowTexture,...pair,{
        width:.37+.085*event.velocity, length:1.95+.52*event.velocity,
        leanX:0,leanY:0,roll,flexible:true,
      });
      // Position the actual broad striking surface one ball radius from its centre.
      item.assembly.position.copy(event.keyCenter).addScaledVector(event.normal,.32+item.thickness/2);
      item.assembly.position.z=ground.position.z;
      planks.push({...item,event,impactGain: event.accentStrength == null ?
                     (event.velocity>.70 || (event.beat && event.velocity>.43) ? 1 : .55) : .44 + 1.25*event.accentStrength,
                   color:new THREE.Color(PALETTE[event.index%PALETTE.length])});
    }

    // Integrate orientation separately from translation. It is conserved
    // during flight and follows the actual distance travelled on a guide.
    let phase = 0;
    let omega = 1.8;
    for (const segment of segments) {
      segment.spinStart = phase;
      if (segment.type === 'hold') continue;
      if (segment.type === 'contact' || segment.type === 'jump') {
        segment.spinVelocity = omega;
        phase += omega * (segment.end - segment.start);
      } else {
        segment.spinSign = Math.sign(segment.curve.getPoint(0).x - segment.curve.getPoint(1).x) || 1;
        const points = segment.curve.getPoints(segment.times.length - 1);
        segment.spinDistances = [0];
        for (let i = 1; i < points.length; i++) {
          segment.spinDistances.push(segment.spinDistances[i - 1] + points[i].distanceTo(points[i - 1]));
        }
        phase += segment.spinSign * segment.spinDistances.at(-1) / 0.32;
        omega = segment.spinSign * segment.endSpeed / 0.32;
      }
    }
    if (ending) ending.spinStart = phase;

    // At first contact project the visible centre of the tongue onto the wall.
    // Store that spot in the wall's coordinates; subsequent camera and ball
    // motion must not drag an older wave along. Also works when seeking directly.
    for (const event of events) {
      const item = planks[event.index];
      if (!item) continue;
      positionCamera(event.t, sampleState(event.t).position);
      const anchor = item.plank.getWorldPosition(new THREE.Vector3());
      const wallScale = (ground.position.z + rippleWallOffset - camera.position.z) / (anchor.z - camera.position.z);
      anchor.sub(camera.position).multiplyScalar(wallScale).add(camera.position);
      rippleStrikes.push({
        t: event.t, anchor,
        strength: event.accentStrength ?? event.velocity,
        tint: item.controls.nearTint.value.clone().lerp(item.controls.farTint.value, .38),
      });
    }

    lyrics = (plan.lyrics || []).map((line, index) => {
      const nearest = events.reduce((best,event)=>Math.abs(event.t-line.start)<Math.abs(best.t-line.start)?event:best,events[0]);
      const hues=['#f3e4fc','#d8edf6','#f8eac9','#e5faf0','#f8dce2'];
      const sprite=makeLyricSprite(line.text,hues[index%hues.length]);
      const echo=makeLyricSprite(line.text,hues[index%hues.length],true);
      sprite.position.set((index%2?1:-1)*(2.4+(index%3)*.35),
                          (nearest?nearest.position.y:BALL_Y)+1.3,.05);
      world.add(sprite,echo);
      echo.scale.copy(sprite.scale);
      echo.scale.y*=.83;
      echo.position.copy(sprite.position);
      echo.position.y-=sprite.scale.y*.98;
      return {sprite,echo,line,z:sprite.position.z};
    });
  }

  function sampleState(time) {
    const t = clamp(Number(time) || 0, 0, plan?.duration || 0);
    if (!events.length) return { position: new THREE.Vector3(0, BALL_Y, 0), velocity: new THREE.Vector3() };
    const first = events[0];
    if (ending && t >= ending.start) {
      const elapsed = Math.min(t - ending.start, ending.stopDuration);
      const speed = Math.max(0, ending.arrivalSpeed - ending.deceleration * elapsed);
      const travelled = arrivalDistance(elapsed);
      return {
        position: ending.curve.getPoint(ending.distance > 1e-9 ? travelled / ending.distance : 0),
        spin: ending.spinStart - Math.sign(ending.curve.v2.x-ending.curve.v1.x)*travelled / 0.32,
        velocity: ending.curve.getTangent(1).multiplyScalar(speed),
      };
    }
    let low = 0;
    let high = segments.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (segments[middle].start <= t) low = middle;
      else high = middle - 1;
    }
    const segment = segments[low];
    if (!segment) return { position: first.position.clone(), velocity: new THREE.Vector3(0, 0, -SPEED) };
    if(segment.type==='hold') return {position:segment.a.clone(),velocity:new THREE.Vector3(),spin:0};
    const elapsed = t - segment.start;
    if (segment.type === 'contact') return { ...segment.sample(elapsed),
      contact:segment, spin:segment.spinStart+elapsed*segment.spinVelocity };
    if (segment.type === 'rail') {
      const { position, u } = railPosition(segment, t);
      const speed = Math.sqrt(Math.max(0, segment.initialSpeedSquared + 2 * GRAVITY * (segment.initialHeight - position.y)));
      const index = Math.min(segment.times.length - 2, Math.floor(u * (segment.times.length - 1)));
      const mix = u * (segment.times.length - 1) - index;
      const distance = THREE.MathUtils.lerp(segment.spinDistances[index], segment.spinDistances[index + 1], mix);
      return { position, velocity: segment.curve.getTangent(u).multiplyScalar(speed),
        spin: segment.spinStart + segment.spinSign * distance / 0.32 };
    }
    return {
      position: new THREE.Vector3(
        segment.a.x + segment.vx * elapsed,
        segment.a.y + segment.vy * elapsed - 0.5 * GRAVITY * elapsed * elapsed,
        segment.a.z + segment.vz * elapsed,
      ),
      velocity: new THREE.Vector3(segment.vx, segment.vy - GRAVITY * elapsed, segment.vz),
      spin: segment.spinStart + elapsed * segment.spinVelocity,
    };
  }

  function routeCenter(time) {
    if (!events.length || time >= events.at(-1).t) return sampleState(time).position;
    let lo = 0, hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (segments[mid].end < time) lo = mid + 1;
      else hi = mid;
    }
    const seg = segments[lo];
    if (seg.type === 'contact') return seg.sample(time-seg.start).position;
    if (seg.type === 'rail') return railPosition(seg, time).position;
    return seg.a.clone().lerp(seg.b, clamp((time - seg.start) / (seg.end - seg.start || 1), 0, 1));
  }

  function arrivalDistance(elapsed) {
    return ending.arrivalSpeed * elapsed - 0.5 * ending.deceleration * elapsed * elapsed;
  }

  function physicsReport() {
    const contactFailures = [];
    let maxJumpAccelerationError = 0;
    let maxRailEnergyError = 0;
    let worstRail = null;
    let maxCollisionEnergyError = 0, maxContactAccelerationError = 0, maxBoundaryVelocityError = 0;
    for (const event of events) {
      const position = sampleState(event.t).position;
      if (position.distanceTo(event.position) > 0.0002) contactFailures.push({ t: event.t, expected: event.position.toArray(), actual: position.toArray() });
      const c = event.contact;
      const dt = c.end-c.start, eps = 1e-6;
      let dissipated=0;
      for (let i=0;i<128;i++) {
        const elapsed=dt*(i+.5)/128, t=c.start+elapsed;
        const state=c.sample(elapsed);
        dissipated+=c.c*state.normalSpeed**2*dt/128;
        if (t+eps>=plan.duration) continue;
        const acceleration=sampleState(t+eps).velocity.sub(sampleState(t-eps).velocity).multiplyScalar(.5/eps);
        acceleration.y+=GRAVITY;
        maxContactAccelerationError=Math.max(maxContactAccelerationError,acceleration.addScaledVector(c.normal,state.force).length());
      }
      const final=c.sample(dt);
      const energyLoss=(event.incomingVelocity.lengthSq()-final.velocity.lengthSq())/2+
        GRAVITY*(event.position.y-final.position.y)-c.k*final.deflection**2/2;
      maxCollisionEnergyError=Math.max(maxCollisionEnergyError,Math.abs(energyLoss-dissipated));
      maxBoundaryVelocityError=Math.max(maxBoundaryVelocityError,
        c.sample(0).velocity.distanceTo(event.incomingVelocity),final.velocity.distanceTo(event.outgoingVelocity));
    }
    for (const segment of segments) {
      if(segment.type==='hold' || segment.type==='contact' || segment.end-segment.start < 1e-8) continue;
      if (segment.type === 'jump') {
        for (const fraction of [0.1, 0.35, 0.6, 0.9]) {
          const t = THREE.MathUtils.lerp(segment.start, segment.end, fraction);
          const epsilon = Math.min(0.0001, (segment.end-segment.start)*.02);
          const before = sampleState(t - epsilon).velocity;
          const after = sampleState(t + epsilon).velocity;
          const acceleration = after.sub(before).multiplyScalar(1 / (2 * epsilon));
          maxJumpAccelerationError = Math.max(maxJumpAccelerationError, Math.hypot(acceleration.x, acceleration.y + GRAVITY, acceleration.z));
        }
      } else {
        for (const fraction of [0.05, 0.25, 0.5, 0.75, 0.95]) {
          const t = THREE.MathUtils.lerp(segment.start, segment.end, fraction);
          const state = sampleState(t);
          const expected = segment.initialSpeedSquared + 2 * GRAVITY * (segment.initialHeight - state.position.y);
          const error = Math.abs(state.velocity.lengthSq() - expected);
          if (error > maxRailEnergyError) {
            maxRailEnergyError = error;
            worstRail = {
              start: segment.start, end: segment.end, fraction, sampleTime: t,
              initialSpeedSquared: segment.initialSpeedSquared, initialHeight: segment.initialHeight,
              expected, position: state.position.toArray(), velocity: state.velocity.toArray(),
            };
          }
        }
      }
    }
    return {
      gravity: gravityMetres,
      metresPerSceneUnit: metresPerUnit,
      restitution: null,
      normalRestitutionRange: events.length ? events.reduce(
        ([lo, hi], e) => [Math.min(lo, e.restitution), Math.max(hi, e.restitution)], [Infinity, -Infinity]
      ) : null,
      model: '重力与单向弹簧阻尼接触',
      maxContactAccelerationError, maxBoundaryVelocityError,
      contacts: events.length,
      contactFailures,
      jumpCount: segments.filter((segment) => segment.type === 'jump').length,
      railCount: segments.filter((segment) => segment.type === 'rail').length,
      maxJumpAccelerationError,
      maxRailEnergyError,
      worstRail,
      maxCollisionEnergyError,
      endSpeed: sampleState(plan.duration).velocity.length(),
      endingRamp: !!ending,
      endStopDelay: ending ? Math.max(0, ending.stopDuration - ending.remaining) : 0,
    };
  }

  function positionCamera(currentTime, position) {
    // Follow the landings along the wall. A camera tied to each instant of
    // flight would travel up and down with the ball, obscuring its apex.
    const focus = new THREE.Vector3();
    for (let i = -3; i <= 3; i++) {
      const t = clamp(currentTime + 0.055 + i * 0.18, 0, plan.duration);
      const guide = routeCenter(t);
      focus.addScaledVector(guide, cameraWeights[i + 3] / 28);
    }
    const limit = (offset, inner, outer) => {
      const magnitude=Math.abs(offset);
      if(magnitude<=inner)return offset;
      return Math.sign(offset)*(inner+(outer-inner)*Math.tanh((magnitude-inner)/(outer-inner)));
    };
    const cameraX = position.x+limit(focus.x-position.x,1.45,2.20);
    const cameraY = position.y+limit(focus.y-position.y,2.4,3.6);
    camera.position.set(cameraX, cameraY + 1.8, 11.6);
    camera.lookAt(cameraX, cameraY - 0.45, 0);
    camera.updateProjectionMatrix();
  }

  function seek(time) {
    if (!plan) return;
    currentTime = clamp(Number(time) || 0, 0, plan.duration);
    const state = sampleState(currentTime);
    const position = state.position;
    ball.position.copy(position);
    ball.rotation.set(-currentTime * 3.4, currentTime * 0.8, currentTime * 0.35);
    const phase=state.spin ?? 0;
    const glass=glassBall.uniforms;
    glass.axis.value.set(Math.cos(phase),Math.sin(phase),.86*Math.cos(phase*.68));
    glass.offset.value=.25+.21*Math.sin(phase*.61);
    glass.bandWidth.value=.19;
    pinkLight.position.set(position.x - 2.4, position.y + 2.1, position.z + 1.5);
    key.position.set(position.x - 3.2, position.y + 4.6, position.z + 12);
    key.target.position.copy(position);
    key.target.updateMatrixWorld();
    ground.position.set(position.x, position.y - 30, -0.65);
    grid.position.set(6.4*Math.round(position.x/6.4),6.4*Math.round(position.y/6.4),-.63);
    dust.position.y = position.y - 2;

    let nearest = null;
    let nearestDistance = Infinity;
    for (const item of planks) {
      const delta = item.event.t - currentTime;
      showInstrument(item,delta > -4 && delta < 20);
      if(!item.assembly.visible) continue;
      const distance = Math.abs(delta);
      if (distance < nearestDistance) {
        nearest = item;
        nearestDistance = distance;
      }
      const age = -delta;
      const pulseTime = item.event.accentStrength == null ? .055 : .043 + .035*item.event.accentStrength;
      const pulse=age>=0?Math.exp(-age/pulseTime):0;
      const level=age<0?1:Math.exp(-age/.16);
      item.plank.morphTargetInfluences[0] = item.event.contact.deflection(age)/item.thickness;
      const base=item.assembly.position;
      const shadowLength=.78+.18*item.length;
      const wallPulse = item.event.accentStrength == null ? pulse : pulse*item.impactGain;
      illuminate(item,level,pulse*item.impactGain,.61*level+.22*wallPulse,
                 base.x,base.y,item.width,shadowLength,-item.face.x*.40,ground.position.z+.04);

    }
    for (const rail of rails) {
      rail.group.visible = rail.end > currentTime - 4 && rail.start < currentTime + 14;

    }
    for (const lyric of lyrics) {
      const near = Math.abs(lyric.z - position.z) < 28;
      const active = lyric.line.end > currentTime - 1.8 && lyric.line.start < currentTime + 12;
      lyric.echo.visible = lyric.sprite.visible = near && active;
      lyric.echo.material.opacity = .19;
      lyric.sprite.material.opacity = clamp(1 - Math.abs(lyric.z - position.z) / 30, 0, 0.94);
    }
    if (nearest) {
      pinkLight.color.copy(nearest.color);
      pinkLight.intensity = 2.8 + Math.exp(-nearestDistance * 4) * 3.2;
    }
    positionCamera(currentTime, position);
    ripples.update(rippleStrikes, currentTime, ground.position.z);
    glassBall.setView(camera, position, ground.position.z);
    composer.render();
  }

  function resize(width, height) {
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
    smoothEdges.uniforms.resolution.value.set(1/width,1/height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (plan) seek(currentTime);
  }

  return {
    loadPlan,
    seek,
    resize,
    renderer,
    projectBall: (time) => {
      seek(time);
      return ball.position.clone().project(camera).toArray();
    },
    projectEventBoards: (eventIndex, time) => {
      const event = events[eventIndex];
      if (!event) return [];
      seek(time ?? event.t);
      return planks.filter((item) => item.event === event).map((item) => item.plank.getWorldPosition(new THREE.Vector3()).project(camera).toArray());
    },
    projectLyric: (lineIndex) => {
      const lyric = lyrics[lineIndex];
      if (!lyric) return null;
      seek(lyric.line.start);
      return lyric.sprite.getWorldPosition(new THREE.Vector3()).project(camera).toArray();
    },
    sampleLyric: (lineIndex) => {
      const lyric = lyrics[lineIndex];
      return lyric ? { position: lyric.sprite.position.toArray(), scale: lyric.sprite.scale.toArray() } : null;
    },
    sampleBall: (time) => sampleState(time).position,
    sampleVelocity: (time) => sampleState(time).velocity,
    freeFlightVelocity: (time) => sampleState(time).velocity,
    contactResponse: (time) => {
      const state = sampleState(time), c = state.contact;
      return c ? { start:c.start, end:c.end, peak:c.start+c.peak, deflection:state.deflection,
        normalSpeed:state.normalSpeed, force:state.force, normal:c.normal } : null;
    },
    contactBall: (time) => {
      const event = events.reduce((best, candidate) => Math.abs(candidate.t - time) < Math.abs(best.t - time) ? candidate : best, events[0]);
      return event ? event.position.clone() : new THREE.Vector3(0, BALL_Y, 0);
    },
    physicsReport,
    getStats: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, events: events.length, rails: rails.length }),
    dispose: () => {
      clearWorld();
      for (const resource of Object.values(hardware)) resource.dispose();
      ripples.dispose();
      glassBall.dispose();
      smoothEdges.dispose();
      bloom.dispose();
      composer.dispose();
      ball.geometry.dispose();
      ball.material.dispose();
      envTarget.dispose();
      glowTexture.dispose();
      renderer.dispose();
    },
  };
}
