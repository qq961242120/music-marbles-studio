import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const vertexShader = `
  varying vec2 screenUv;
  void main() {
    screenUv = uv;
    gl_Position = vec4(position.xy, 0., 1.);
  }
`;

// The background pass already contains the keys, guides, shadows and colour on the wall.
// Trace the ray through both interfaces of a solid sphere before reading that image.
const fragmentShader = `
  #include <cube_uv_reflection_fragment>
  uniform sampler2D tDiffuse, sceneDepth, room;
  uniform mat3 cameraRotation;
  uniform mat4 projection, inverseProjection;
  uniform vec3 center, wallNormal, axis;
  uniform vec2 viewport;
  uniform float wallConstant, radius, offset, bandWidth;
  varying vec2 screenUv;

  vec2 projectPoint(vec3 p) {
    vec4 clip = projection * vec4(p, 1.);
    return clip.xy / clip.w * .5 + .5;
  }
  vec3 unproject(vec2 uv, float depth) {
    vec4 p = inverseProjection * vec4(uv*2.-1.,depth*2.-1.,1.);
    return p.xyz/p.w;
  }
  // The lenticular inclusion makes the swept band bend a second image of the scenery.
  vec3 stretch(vec3 p, vec3 a) {return p+2.1*a*dot(p,a);}
  void interiorLens(inout vec3 p, inout vec3 v, float ior){
    vec3 a=normalize(axis);
    vec3 origin=center + a*radius*clamp(offset*.42,-.42,.42);
    vec3 q=stretch(p-origin,a), dv=stretch(v,a);
    float size=radius*.76, A=dot(dv,dv), B=dot(q,dv);
    float disc=B*B-A*(dot(q,q)-size*size);
    if(disc<=0.) return;
    float t=(-B-sqrt(disc))/A;
    if(t<=0.) return;
    p+=t*v;
    vec3 insideNormal=normalize(stretch(stretch(p-origin,a),a));
    vec3 bent=refract(v,insideNormal,ior/1.26);
    if(dot(bent,bent)<.5){v=reflect(v,insideNormal);return;}
    q=stretch(p-origin,a);
    dv=stretch(bent,a);
    p+=bent*(-2.*dot(q,dv)/dot(dv,dv));
    insideNormal=normalize(stretch(stretch(p-origin,a),a));
    v=refract(bent,-insideNormal,1.26/ior);
  }
  vec3 studioLight(vec3 ray, float roughness) {
    vec3 light=textureCubeUV(room,cameraRotation*ray,roughness).rgb;
    return light/(vec3(1.)+.90*light);
  }
  vec3 outgoingLight(vec3 origin, vec3 dir) {
    float approach=dot(wallNormal,dir);
    if(approach>=-.035) return studioLight(dir,.075);
    float dist=-(dot(wallNormal,origin)+wallConstant)/approach;
    if(dist<=0.) return studioLight(dir,.075);
    vec2 wallUv=projectPoint(origin+dir*dist);
    if(any(lessThan(wallUv,vec2(0.)))||any(greaterThan(wallUv,vec2(1.)))) return studioLight(dir,.075);
    vec3 surface=unproject(wallUv,texture2D(sceneDepth,wallUv).x);
    float depthHit=(surface.z-origin.z)/min(dir.z,-.035);
    if(depthHit>0. && depthHit<dist) wallUv=projectPoint(origin+dir*depthHit);
    return texture2D(tDiffuse,clamp(wallUv,.5/viewport,1.-.5/viewport)).rgb;
  }
  vec3 throughGlass(vec3 incident, vec3 entry, vec3 normal, float ior) {
    vec3 inside = refract(incident, normal, 1./ior);
    vec3 p=entry;
    interiorLens(p,inside,ior);
    vec3 q=p-center;
    float b=dot(q,inside);
    vec3 exitPoint=p+inside*(-b+sqrt(max(0.,b*b-dot(q,q)+radius*radius)));
    vec3 exitNormal = normalize(exitPoint-center);
    vec3 outRay = refract(inside,-exitNormal,ior);
    // The oblate inclusion can push a ray past the critical angle. Trace its path
    // through the inclusion again rather than sampling the environment with a zero ray.
    for(int bounceIndex=0;bounceIndex<2;bounceIndex++){
      if(dot(outRay,outRay)>.5) break;
      inside=reflect(inside,-exitNormal);
      p=exitPoint+inside*radius*.0002;
      interiorLens(p,inside,ior);
      q=p-center;
      b=dot(q,inside);
      exitPoint=p+inside*(-b+sqrt(max(0.,b*b-dot(q,q)+radius*radius)));
      exitNormal=normalize(exitPoint-center);
      outRay=refract(inside,-exitNormal,ior);
    }
    if(dot(outRay,outRay)<.5){
      // A longer trapped path is unresolved on screen; approximate the attenuated
      // local radiance with the wall and the prefiltered environment.
      vec3 trapped=reflect(inside,-exitNormal);
      vec3 local=texture2D(tDiffuse,clamp(projectPoint(exitPoint),.5/viewport,1.-.5/viewport)).rgb;
      return .78*mix(local,studioLight(trapped,.25),.22);
    }
    vec3 direct=outgoingLight(exitPoint,outRay);
    vec3 back=reflect(inside,-exitNormal);
    vec3 secondExit=exitPoint-back*(2.*dot(exitPoint-center,back));
    vec3 secondRay=refract(back,-normalize(secondExit-center),ior);
    float bounce=.04+.37*pow(1.-abs(dot(inside,exitNormal)),3.);
    if(dot(secondRay,secondRay)>.5) direct=mix(direct,outgoingLight(secondExit,secondRay),bounce);
    return direct;
  }
  void main() {
    vec4 background = texture2D(tDiffuse,screenUv);
    vec3 ray = normalize(unproject(screenUv, .5));
    float nearT = dot(ray,center);
    vec3 closest = center-nearT*ray;
    float h = radius*radius-dot(closest,closest);
    if(h<=0. || nearT<=0.) {gl_FragColor=background; return;}
    vec3 entry = ray*(nearT-sqrt(h));
    if(unproject(screenUv,texture2D(sceneDepth,screenUv).x).z>entry.z+.0005) {
      gl_FragColor=background; return;
    }
    vec3 N = normalize(entry-center);
    vec3 transmitted=vec3(throughGlass(ray,entry,N,1.486).r,
                          throughGlass(ray,entry,N,1.501).g,
                          throughGlass(ray,entry,N,1.519).b);
    // Subpixel integration softens sub-pixel caustics at the inclusion's critical angle.
    vec3 subRay=normalize(unproject(screenUv+vec2(.32,-.28)/viewport,.5));
    float subT=dot(subRay,center);
    vec3 subClosest=center-subT*subRay;
    float subH=radius*radius-dot(subClosest,subClosest);
    if(subH>0.) {
      vec3 subEntry=subRay*(subT-sqrt(subH));
      transmitted=mix(transmitted,throughGlass(subRay,subEntry,normalize(subEntry-center),1.501),.30);
    }
    float cosine = clamp(dot(N,-ray),0.,1.);
    float fresnel = .04+.96*pow(1.-cosine,5.);
    float ice=smoothstep(-.6,.65,N.x+.35*N.y);
    vec3 surfaceTint = mix(vec3(.94,.69,.77),vec3(.67,1.,.91),ice);
    float x = (dot(N,normalize(axis))-offset)/max(.075,bandWidth);
    float ribbon = exp(-.5*x*x);
    float lip = exp(-pow((x+.85)/.36,2.));
    float accent = exp(-58.*dot(N.xy-vec2(-.33,.73),N.xy-vec2(-.33,.73)));
    vec3 studio=outgoingLight(entry,reflect(ray,N));
    vec3 reflected=mix(studio,surfaceTint,.09+.14*ribbon);
    vec3 glass = mix(transmitted*vec3(.975,.99,.985),reflected,.035+.95*fresnel);
    // A broad curved studio reflection rides over the refracted image. Keep the transparent
    // side of the band open so a passing gold rail or green key can colour the interior.
    float dimEdge=exp(-pow((x-1.06)/.33,2.));
    glass*=1.-.26*dimEdge;
    glass=mix(glass,mix(surfaceTint,vec3(.98,.97,.94),.42),.25*ribbon+.38*lip);
    float innerLip=exp(-pow((x-1.65)/.38,2.));
    glass+=.055*studio*studio + .105*innerLip*mix(vec3(.61,.94,1.),vec3(1.,.69,.58),ice);
    glass += .19*accent + surfaceTint*.43*pow(1.-cosine,2.7);
    float coverage = smoothstep(0.,max(fwidth(h),.00002),h);
    gl_FragColor = vec4(mix(background.rgb,glass,coverage),1.);
  }
`;

export class GlassBallPass extends ShaderPass {
  constructor(composer) {
    super({
      uniforms: {
        tDiffuse: { value: null },
        sceneDepth: { value: null },
        room: { value: null },
        cameraRotation: { value: new THREE.Matrix3() },
        center: { value: new THREE.Vector3() },
        wallNormal: { value: new THREE.Vector3() },
        wallConstant: { value: 0 },
        radius: { value: 0.326 },
        projection: { value: new THREE.Matrix4() },
        inverseProjection: { value: new THREE.Matrix4() },
        viewport: { value: new THREE.Vector2(1, 1) },
        axis: { value: new THREE.Vector3(0, 1, 0.5) },
        offset: { value: 0.2 },
        bandWidth: { value: 0.18 },
      },
      vertexShader,
      fragmentShader,
    });
    for (const target of [composer.renderTarget1, composer.renderTarget2]) {
      target.depthTexture = new THREE.DepthTexture(target.width, target.height);
    }
    this.wall = new THREE.Plane();
    this.material.depthTest = false;
    this.material.depthWrite = false;
  }
  setEnvironment(target) {
    const maxMip = Math.log2(target.height) - 2;
    this.material.defines = {
      ENVMAP_TYPE_CUBE_UV: 1,
      CUBEUV_MAX_MIP: maxMip.toFixed(1),
      CUBEUV_TEXEL_WIDTH: (1 / target.width).toPrecision(12),
      CUBEUV_TEXEL_HEIGHT: (1 / target.height).toPrecision(12),
    };
    this.uniforms.room.value = target.texture;
    this.material.needsUpdate = true;
  }
  setView(camera, ballPosition, wallZ) {
    camera.updateMatrixWorld();
    const u = this.uniforms;
    u.cameraRotation.value.setFromMatrix4(camera.matrixWorld);
    u.center.value.copy(ballPosition).applyMatrix4(camera.matrixWorldInverse);
    u.projection.value.copy(camera.projectionMatrix);
    u.inverseProjection.value.copy(camera.projectionMatrix).invert();
    this.wall.normal.set(0, 0, 1);
    this.wall.constant = -wallZ;
    this.wall.applyMatrix4(camera.matrixWorldInverse);
    u.wallNormal.value.copy(this.wall.normal);
    u.wallConstant.value = this.wall.constant;
  }
  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    this.uniforms.sceneDepth.value = readBuffer.depthTexture;
    this.uniforms.viewport.value.set(readBuffer.width, readBuffer.height);
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}
