import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface RoomDimensions {
  W: number;
  H: number;
  D: number;
}

export interface RoomBakeConfig {
  room: RoomDimensions;
  atlas: number;
  pad: number;
  genW: number;
  genH: number;
  panoW: number;
  panoH: number;
}

export const DEFAULT_ROOMBAKE_CONFIG: RoomBakeConfig = {
  room: { W: 6, H: 3, D: 8 },
  atlas: 2048,
  pad: 4,
  genW: 1024,
  genH: 1024,
  panoW: 2048,
  panoH: 1024,
};

export interface ViewPoint {
  name: string;
  type?: 'persp' | 'pano';
  pos: [number, number, number];
  target?: [number, number, number];
  fov?: number;
  cam?: THREE.PerspectiveCamera;
  viewProj?: THREE.Matrix4;
}

export interface BakeOptions {
  uWeightPow?: number;
  uMinNdotV?: number;
  uBias?: number;
  uFeather?: number;
  uBlend?: number;
  uOcclude?: number;
}

export interface DepthRange {
  near: number;
  far: number;
}

interface FreeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedRect {
  x: number;
  y: number;
  w: number;
  h: number;
  rotated: boolean;
}

interface IslandTriangle {
  tIdx: number;
  area: number;
}

interface UVIsland {
  id: number;
  tris: IslandTriangle[];
  normal: THREE.Vector3;
  uDir: THREE.Vector3;
  vDir: THREE.Vector3;
  rotAngle: number;
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
  uLen: number;
  vLen: number;
  totalArea: number;
}

// GLSL Fullscreen Quad Vertex Shader
const FS_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const EQUIRECT_GLSL = `
  #define PI 3.14159265358979323846
  vec3 dirFromEquirect(vec2 uv) {
    float lon = (uv.x - 0.5) * 2.0 * PI;
    float lat = (0.5 - uv.y) * PI;
    return vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * -cos(lon));
  }
  vec2 equirectFromDir(vec3 dir) {
    vec3 d = normalize(dir);
    float lon = atan(d.x, -d.z);
    float lat = asin(clamp(d.y, -1.0, 1.0));
    return vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
  }
`;

function rt(w: number, h: number, opts: THREE.RenderTargetOptions = {}): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    depthBuffer: true,
    stencilBuffer: false,
    ...opts,
  });
}

function rt8(w: number, h: number, opts: THREE.RenderTargetOptions = {}): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
    ...opts,
  });
}

export class RoomBakeEngine {
  public renderer: THREE.WebGLRenderer;
  public scene: THREE.Scene;
  public room: THREE.Group;
  public previewCam: THREE.PerspectiveCamera;
  public fsCam: THREE.OrthographicCamera;
  public fsMesh: THREE.Mesh;
  public cubeCam: THREE.CubeCamera;
  public config: RoomBakeConfig;

  public meshes: THREE.Mesh[] = [];
  public views: ViewPoint[] = [];
  public currentViewIndex: number = 0;
  public dilationPasses: number = 8;

  public orbit = {
    yaw: Math.PI,
    pitch: -0.03,
    dist: 0.01,
    target: new THREE.Vector3(0, 1.5, 2.2),
  };

  public state = {
    bakes: 0,
    hasSnapshot: false,
    scale: 1,
    chartFraction: 1,
    coverage: 0,
    modelName: 'Default Box Room',
    lastGeneratedTexture: null as THREE.Texture | null,
  };

  public RTs: {
    gbuf: THREE.WebGLRenderTarget;
    pano: THREE.WebGLRenderTarget;
    cube: THREE.WebGLCubeRenderTarget;
    bakeA: THREE.WebGLRenderTarget;
    bakeB: THREE.WebGLRenderTarget;
    bakeSnap: THREE.WebGLRenderTarget;
    dispA: THREE.WebGLRenderTarget;
    dispB: THREE.WebGLRenderTarget;
    viz: THREE.WebGLRenderTarget;
    vizPano: THREE.WebGLRenderTarget;
    maskA: THREE.WebGLRenderTarget;
    maskB: THREE.WebGLRenderTarget;
    maskPanoA: THREE.WebGLRenderTarget;
    maskPanoB: THREE.WebGLRenderTarget;
    thumb: THREE.WebGLRenderTarget;
    mm: THREE.WebGLRenderTarget[];
    red: THREE.WebGLRenderTarget[];
  };

  // Shader Materials
  public gbufMat: THREE.ShaderMaterial;
  public cube2equirectMat: THREE.ShaderMaterial;
  public depthVizMat: THREE.ShaderMaterial;
  public normalVizMat: THREE.ShaderMaterial;
  public maskMat: THREE.ShaderMaterial;
  public bakeMat: THREE.ShaderMaterial;
  public blitMat: THREE.ShaderMaterial;
  public resolveMat: THREE.ShaderMaterial;
  public dilateMat: THREE.ShaderMaterial;
  public reduceMat: THREE.ShaderMaterial;
  public minmaxMat: THREE.ShaderMaterial;
  public downMat: THREE.ShaderMaterial;
  public blurMat: THREE.ShaderMaterial;
  public roomMat: THREE.ShaderMaterial;

  public cond: {
    depth: HTMLCanvasElement | null;
    normal: HTMLCanvasElement | null;
    mask: HTMLCanvasElement | null;
    range: DepthRange;
    view?: ViewPoint;
  } = {
    depth: null,
    normal: null,
    mask: null,
    range: { near: 0.3, far: 12.0 },
  };

  constructor(canvas: HTMLCanvasElement, customConfig?: Partial<RoomBakeConfig>) {
    this.config = { ...DEFAULT_ROOMBAKE_CONFIG, ...customConfig };
    const { atlas, genW, genH, panoW, panoH } = this.config;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(canvas.clientWidth || 800, canvas.clientHeight || 600, false);
    this.renderer.setClearColor(0x0a0c10, 1);

    // Scene
    this.scene = new THREE.Scene();
    this.room = new THREE.Group();
    this.scene.add(this.room);

    // Cameras
    this.previewCam = new THREE.PerspectiveCamera(60, 1, 0.02, 200);
    this.fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.fsMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));

    // Render Targets
    this.RTs = {
      gbuf: rt(genW, genH),
      pano: rt(panoW, panoH),
      cube: new THREE.WebGLCubeRenderTarget(1024, {
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
      }),
      bakeA: rt(atlas, atlas),
      bakeB: rt(atlas, atlas),
      bakeSnap: rt(atlas, atlas),
      dispA: rt8(atlas, atlas),
      dispB: rt8(atlas, atlas),
      viz: rt8(genW, genH),
      vizPano: rt8(panoW, panoH),
      maskA: rt8(genW, genH),
      maskB: rt8(genW, genH),
      maskPanoA: rt8(panoW, panoH),
      maskPanoB: rt8(panoW, panoH),
      thumb: rt8(512, 512),
      mm: [rt(256, 256), rt(64, 64), rt(16, 16), rt(4, 4), rt(1, 1)],
      red: [rt(512, 512), rt(128, 128), rt(32, 32), rt(8, 8), rt(1, 1)],
    };

    this.cubeCam = new THREE.CubeCamera(0.05, 200, this.RTs.cube);

    // Initialize Materials
    this.gbufMat = new THREE.ShaderMaterial({
      uniforms: { uCamPos: { value: new THREE.Vector3() } },
      vertexShader: `
        varying vec3 vN; varying vec3 vW;
        void main() {
          vN = normalize(mat3(modelMatrix) * normal);
          vW = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uCamPos;
        varying vec3 vN; varying vec3 vW;
        void main() {
          gl_FragColor = vec4(normalize(vN), length(uCamPos - vW));
        }`,
      side: THREE.DoubleSide,
    });

    this.cube2equirectMat = new THREE.ShaderMaterial({
      uniforms: { uCube: { value: null }, uFlipX: { value: -1.0 } },
      vertexShader: FS_VERT,
      fragmentShader: `
        uniform samplerCube uCube; uniform float uFlipX;
        varying vec2 vUv;
        ${EQUIRECT_GLSL}
        void main() {
          vec3 d = dirFromEquirect(vUv);
          gl_FragColor = textureCube(uCube, vec3(uFlipX * d.x, d.y, d.z));
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.depthVizMat = new THREE.ShaderMaterial({
      uniforms: {
        uGbuf: { value: null },
        uNear: { value: 0.3 },
        uFar: { value: 12.0 },
        uInvert: { value: 0.0 },
      },
      vertexShader: FS_VERT,
      fragmentShader: `
        uniform sampler2D uGbuf; uniform float uNear, uFar, uInvert;
        varying vec2 vUv;
        void main() {
          float d = texture2D(uGbuf, vUv).a;
          float t = clamp((d - uNear) / max(uFar - uNear, 1e-4), 0.0, 1.0);
          float v = 1.0 - t;
          v = mix(v, 1.0 - v, uInvert);
          gl_FragColor = vec4(vec3(v), 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.normalVizMat = new THREE.ShaderMaterial({
      uniforms: {
        uGbuf: { value: null },
        uMode: { value: 0 },
        uRight: { value: new THREE.Vector3(1, 0, 0) },
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uFwd: { value: new THREE.Vector3(0, 0, -1) },
      },
      vertexShader: FS_VERT,
      fragmentShader: `
        uniform sampler2D uGbuf; uniform int uMode;
        uniform vec3 uRight, uUp, uFwd;
        varying vec2 vUv;
        ${EQUIRECT_GLSL}
        void main() {
          vec3 n = normalize(texture2D(uGbuf, vUv).rgb);
          vec3 r, u, f;
          if (uMode == 0) {
            r = uRight; u = uUp; f = -uFwd;
          } else {
            vec3 d = dirFromEquirect(vUv);
            r = normalize(cross(d, vec3(0.0, 1.0, 0.0)));
            if (length(cross(d, vec3(0.0, 1.0, 0.0))) < 1e-3) r = vec3(1.0, 0.0, 0.0);
            u = normalize(cross(r, d));
            f = -d;
          }
          vec3 enc = vec3(dot(n, r), dot(n, u), dot(n, f));
          gl_FragColor = vec4(enc * 0.5 + 0.5, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.maskMat = new THREE.ShaderMaterial({
      uniforms: {
        uBake: { value: null },
        uInvert: { value: 1.0 },
        uThresh: { value: 0.01 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D uBake; uniform float uInvert, uThresh;
        varying vec2 vUv;
        void main() {
          float a = step(uThresh, texture2D(uBake, vUv).a);
          float v = mix(a, 1.0 - a, uInvert);
          gl_FragColor = vec4(vec3(v), 1.0);
        }`,
      side: THREE.FrontSide,
    });

    this.bakeMat = new THREE.ShaderMaterial({
      uniforms: {
        uGen: { value: null },
        uGbuf: { value: null },
        uPrev: { value: null },
        uViewProj: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uRes: { value: new THREE.Vector2(atlas, atlas) },
        uMode: { value: 0 },
        uWeightPow: { value: 2.0 },
        uMinNdotV: { value: 0.15 },
        uBias: { value: 0.02 },
        uFeather: { value: 0.06 },
        uBlend: { value: 0.15 },
        uOcclude: { value: 1.0 },
      },
      vertexShader: `
        varying vec3 vW; varying vec3 vN;
        void main() {
          vW = (modelMatrix * vec4(position, 1.0)).xyz;
          vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D uGen, uGbuf, uPrev;
        uniform mat4 uViewProj;
        uniform vec3 uCamPos;
        uniform vec2 uRes;
        uniform int  uMode;
        uniform float uWeightPow, uMinNdotV, uBias, uFeather, uBlend, uOcclude;
        varying vec3 vW; varying vec3 vN;
        ${EQUIRECT_GLSL}
        void main() {
          vec4 prev = texture2D(uPrev, gl_FragCoord.xy / uRes);
          vec3  toCam = uCamPos - vW;
          float dist  = length(toCam);
          vec3  V     = toCam / max(dist, 1e-6);
          vec3  N     = normalize(vN);

          float ndotv = abs(dot(N, V));
          if (ndotv <= uMinNdotV) { gl_FragColor = prev; return; }

          vec2 p; float border = 1.0;
          if (uMode == 0) {
            vec4 clip = uViewProj * vec4(vW, 1.0);
            if (clip.w <= 0.0) { gl_FragColor = prev; return; }
            p = (clip.xy / clip.w) * 0.5 + 0.5;
            if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) {
              gl_FragColor = prev; return;
            }
            border = smoothstep(0.0, uFeather, p.x) * smoothstep(0.0, uFeather, 1.0 - p.x)
                   * smoothstep(0.0, uFeather, p.y) * smoothstep(0.0, uFeather, 1.0 - p.y);
          } else {
            p = equirectFromDir(-V);
          }

          if (uOcclude > 0.5) {
            float stored = texture2D(uGbuf, p).a;
            if (stored > 1e-4 && dist > stored * (1.0 + uBias) + 0.01) {
              gl_FragColor = prev; return;
            }
          }

          float w = pow(clamp(ndotv, 0.0, 1.0), uWeightPow) * border / (1.0 + 0.02 * dist * dist);
          if (w <= 0.0) { gl_FragColor = prev; return; }

          vec3 col = texture2D(uGen, p).rgb;
          float m = (uBlend <= 1e-4)
                  ? step(prev.a, w)
                  : clamp((w - prev.a) / uBlend * 0.5 + 0.5, 0.0, 1.0);
          if (prev.a <= 1e-5) m = 1.0;
          gl_FragColor = vec4(mix(prev.rgb, col, m), max(prev.a, w));
        }`,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });

    this.blitMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: null } },
      vertexShader: FS_VERT,
      fragmentShader: `
        uniform sampler2D uTex; varying vec2 vUv;
        void main() { gl_FragColor = texture2D(uTex, vUv); }`,
      depthTest: false,
      depthWrite: false,
    });

    this.resolveMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: null }, uThresh: { value: 0.001 } },
      vertexShader: FS_VERT,
      fragmentShader: `
        uniform sampler2D uTex; uniform float uThresh; varying vec2 vUv;
        void main() {
          vec4 s = texture2D(uTex, vUv);
          gl_FragColor = vec4(s.rgb, step(uThresh, s.a));
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.dilateMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: null }, uTexel: { value: new THREE.Vector2(1 / atlas, 1 / atlas) } },
      vertexShader: FS_VERT,
      fragmentShader: `
        uniform sampler2D uTex; uniform vec2 uTexel; varying vec2 vUv;
        void main() {
          vec4 c = texture2D(uTex, vUv);
          if (c.a > 0.5) { gl_FragColor = c; return; }
          vec3 sum = vec3(0.0); float n = 0.0;
          for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
              if (x == 0 && y == 0) continue;
              vec4 s = texture2D(uTex, vUv + vec2(float(x), float(y)) * uTexel);
              if (s.a > 0.5) { sum += s.rgb; n += 1.0; }
            }
          }
          gl_FragColor = n > 0.0 ? vec4(sum / n, 1.0) : vec4(0.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.reduceMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: null }, uTexel: { value: new THREE.Vector2() }, uBinarize: { value: 0.0 } },
      vertexShader: FS_VERT,
      fragmentShader: `
        uniform sampler2D uTex; uniform vec2 uTexel; uniform float uBinarize;
        varying vec2 vUv;
        void main() {
          float acc = 0.0;
          for (int y = 0; y < 4; y++) {
            for (int x = 0; x < 4; x++) {
              vec2 o = (vec2(float(x), float(y)) - 1.5) * uTexel;
              vec4 s = texture2D(uTex, vUv + o);
              acc += (uBinarize > 0.5) ? step(0.001, s.a) : s.r;
            }
          }
          gl_FragColor = vec4(vec3(acc / 16.0), 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.minmaxMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 1.0 } },
      vertexShader: FS_VERT,
      fragmentShader: `
        uniform sampler2D uTex; uniform vec2 uTexel; uniform float uFirst;
        varying vec2 vUv;
        void main() {
          float mn = 1e9, mx = -1e9;
          for (int y = 0; y < 4; y++) {
            for (int x = 0; x < 4; x++) {
              vec2 o = (vec2(float(x), float(y)) - 1.5) * uTexel;
              vec4 s = texture2D(uTex, vUv + o);
              float a = (uFirst > 0.5) ? s.a : s.r;
              float b = (uFirst > 0.5) ? s.a : s.g;
              if (a > 1e-4) mn = min(mn, a);
              if (b > 1e-4) mx = max(mx, b);
            }
          }
          if (mn > 1e8) mn = 0.0;
          if (mx < -1e8) mx = 0.0;
          gl_FragColor = vec4(mn, mx, 0.0, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.downMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: FS_VERT,
      fragmentShader: `
        uniform sampler2D uTex; uniform vec2 uTexel; varying vec2 vUv;
        void main() {
          vec4 acc = vec4(0.0);
          for (int y = 0; y < 4; y++)
            for (int x = 0; x < 4; x++)
              acc += texture2D(uTex, vUv + (vec2(float(x), float(y)) - 1.5) * uTexel);
          gl_FragColor = acc / 16.0;
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: FS_VERT,
      fragmentShader: `
        uniform sampler2D uTex; uniform vec2 uDir; varying vec2 vUv;
        void main() {
          float w[5]; w[0]=0.2270; w[1]=0.1945; w[2]=0.1216; w[3]=0.0540; w[4]=0.0162;
          vec4 acc = texture2D(uTex, vUv) * w[0];
          for (int i = 1; i < 5; i++) {
            acc += texture2D(uTex, vUv + uDir * float(i)) * w[i];
            acc += texture2D(uTex, vUv - uDir * float(i)) * w[i];
          }
          gl_FragColor = acc;
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.roomMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: null }, uShowGaps: { value: 1.0 }, uAtlas: { value: atlas } },
      vertexShader: `
        varying vec2 vUv; varying vec3 vW;
        void main() {
          vUv = uv; vW = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D uTex; uniform float uShowGaps;
        varying vec2 vUv; varying vec3 vW;
        void main() {
          vec4 c = texture2D(uTex, vUv);
          if (c.a > 0.5 || uShowGaps < 0.5) { gl_FragColor = vec4(c.rgb, 1.0); return; }
          vec3 g = abs(fract(vW * 2.0 - 0.5) - 0.5) / fwidth(vW * 2.0);
          float line = 1.0 - min(min(g.x, g.y), g.z);
          gl_FragColor = vec4(mix(vec3(0.08, 0.09, 0.11), vec3(0.16, 0.18, 0.22),
                                  clamp(line, 0.0, 1.0)), 1.0);
        }`,
      side: THREE.DoubleSide,
    });

    // Build default room and preset views
    this.buildDefaultRoom();
  }

  public setGenSize(w: number, h: number) {
    if (w === this.config.genW && h === this.config.genH) return;
    this.config.genW = w;
    this.config.genH = h;
    for (const k of ['gbuf', 'viz', 'maskA', 'maskB'] as const) {
      this.RTs[k].dispose();
    }
    this.RTs.gbuf = rt(w, h);
    this.RTs.viz = rt8(w, h);
    this.RTs.maskA = rt8(w, h);
    this.RTs.maskB = rt8(w, h);
    for (const v of this.views) {
      if (v.type !== 'pano' && v.cam) {
        v.cam.aspect = w / h;
        v.cam.updateProjectionMatrix();
        v.cam.updateMatrixWorld(true);
        v.viewProj = new THREE.Matrix4().multiplyMatrices(v.cam.projectionMatrix, v.cam.matrixWorldInverse);
      }
    }
  }

  public updateViewFov(viewIndex: number, fov: number) {
    const v = this.views[viewIndex];
    if (v && v.cam) {
      v.fov = fov;
      v.cam.fov = fov;
      v.cam.updateProjectionMatrix();
      v.cam.updateMatrixWorld(true);
      v.viewProj = new THREE.Matrix4().multiplyMatrices(v.cam.projectionMatrix, v.cam.matrixWorldInverse);
    }
  }

  public addAimView(fov = 60): ViewPoint {
    const p = this.previewCam.position.clone();
    const t = p.clone().addScaledVector(
      new THREE.Vector3(0, 0, -1).applyQuaternion(this.previewCam.quaternion),
      3
    );
    const cam = new THREE.PerspectiveCamera(fov, this.config.genW / this.config.genH, 0.05, 200);
    cam.position.copy(p);
    cam.lookAt(t);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    const viewProj = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

    const v: ViewPoint = {
      name: `Free View ${this.views.length}`,
      pos: [p.x, p.y, p.z],
      target: [t.x, t.y, t.z],
      fov,
      cam,
      viewProj,
    };
    this.views.push(v);
    return v;
  }

  public addPanoView(): ViewPoint {
    const p = this.previewCam.position.clone();
    const v: ViewPoint = {
      name: `Panorama ${this.views.length}`,
      type: 'pano',
      pos: [p.x, p.y, p.z],
    };
    this.views.push(v);
    return v;
  }

  public setShowGaps(show: boolean) {
    this.roomMat.uniforms.uShowGaps.value = show ? 1.0 : 0.0;
  }

  public fsPass(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.fsMesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.fsMesh, this.fsCam);
    this.renderer.setRenderTarget(null);
  }

  /**
   * High-Efficiency 2D MaxRects Guillotine Bin Packer with 90° Island Rotation
   * Maximizes atlas area utilization and completely eliminates wasted shelf gutters.
   */
  public maxRectsPack(
    items: { key: string; w: number; h: number }[],
    atlasSize: number,
    pad: number,
    allowRotation = true
  ): Record<string, PlacedRect> | null {
    // Sort items by max side descending, then area descending for optimal placement
    const sorted = [...items].sort((a, b) => {
      const maxA = Math.max(a.w, a.h);
      const maxB = Math.max(b.w, b.h);
      if (maxB !== maxA) return maxB - maxA;
      return b.w * b.h - a.w * a.h;
    });

    const freeRects: FreeRect[] = [
      { x: pad, y: pad, w: atlasSize - pad * 2, h: atlasSize - pad * 2 },
    ];
    const placed: Record<string, PlacedRect> = {};

    for (const item of sorted) {
      let bestRectIdx = -1;
      let bestShortSideFit = Infinity;
      let bestAreaFit = Infinity;
      let bestRotated = false;

      for (let i = 0; i < freeRects.length; i++) {
        const fr = freeRects[i];

        // 1. Try normal orientation
        if (fr.w >= item.w && fr.h >= item.h) {
          const leftoverX = fr.w - item.w;
          const leftoverY = fr.h - item.h;
          const shortSide = Math.min(leftoverX, leftoverY);
          const area = fr.w * fr.h - item.w * item.h;

          if (shortSide < bestShortSideFit || (shortSide === bestShortSideFit && area < bestAreaFit)) {
            bestRectIdx = i;
            bestShortSideFit = shortSide;
            bestAreaFit = area;
            bestRotated = false;
          }
        }

        // 2. Try 90-degree rotated orientation
        if (allowRotation && fr.w >= item.h && fr.h >= item.w) {
          const leftoverX = fr.w - item.h;
          const leftoverY = fr.h - item.w;
          const shortSide = Math.min(leftoverX, leftoverY);
          const area = fr.w * fr.h - item.h * item.w;

          if (shortSide < bestShortSideFit || (shortSide === bestShortSideFit && area < bestAreaFit)) {
            bestRectIdx = i;
            bestShortSideFit = shortSide;
            bestAreaFit = area;
            bestRotated = true;
          }
        }
      }

      if (bestRectIdx === -1) {
        return null; // Could not fit all items at this scale
      }

      const chosen = freeRects[bestRectIdx];
      const placeW = bestRotated ? item.h : item.w;
      const placeH = bestRotated ? item.w : item.h;

      placed[item.key] = {
        x: chosen.x,
        y: chosen.y,
        w: placeW,
        h: placeH,
        rotated: bestRotated,
      };

      // Split intersecting free rectangles (MaxRects rule with padding gutter)
      const placedX = chosen.x;
      const placedY = chosen.y;
      const placedRight = placedX + placeW + pad;
      const placedBottom = placedY + placeH + pad;

      const newFreeRects: FreeRect[] = [];

      for (let i = 0; i < freeRects.length; i++) {
        const fr = freeRects[i];

        // Check for intersection with the placed rectangle + padding
        const intersects =
          fr.x < placedRight &&
          fr.x + fr.w > placedX &&
          fr.y < placedBottom &&
          fr.y + fr.h > placedY;

        if (!intersects) {
          newFreeRects.push(fr);
          continue;
        }

        // Subdivide free rectangle into up to 4 remaining non-overlapping spaces:
        // Left strip
        if (placedX > fr.x && placedX < fr.x + fr.w) {
          newFreeRects.push({
            x: fr.x,
            y: fr.y,
            w: placedX - fr.x,
            h: fr.h,
          });
        }
        // Right strip
        if (placedRight < fr.x + fr.w && placedRight > fr.x) {
          newFreeRects.push({
            x: placedRight,
            y: fr.y,
            w: fr.x + fr.w - placedRight,
            h: fr.h,
          });
        }
        // Top strip
        if (placedY > fr.y && placedY < fr.y + fr.h) {
          newFreeRects.push({
            x: fr.x,
            y: fr.y,
            w: fr.w,
            h: placedY - fr.y,
          });
        }
        // Bottom strip
        if (placedBottom < fr.y + fr.h && placedBottom > fr.y) {
          newFreeRects.push({
            x: fr.x,
            y: placedBottom,
            w: fr.w,
            h: fr.y + fr.h - placedBottom,
          });
        }
      }

      // Filter out redundant / completely contained free rectangles
      freeRects.length = 0;
      for (let i = 0; i < newFreeRects.length; i++) {
        const a = newFreeRects[i];
        if (a.w < 2 || a.h < 2) continue;
        let contained = false;
        for (let j = 0; j < newFreeRects.length; j++) {
          if (i === j) continue;
          const b = newFreeRects[j];
          if (a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h) {
            contained = true;
            break;
          }
        }
        if (!contained) {
          freeRects.push(a);
        }
      }
    }

    return placed;
  }

  public buildDefaultRoom() {
    for (const m of this.meshes) {
      this.room.remove(m);
      m.geometry.dispose();
    }
    this.meshes = [];

    const { W, H, D } = this.config.room;
    const surfaces = [
      { name: 'floor',    p0: [-W/2, 0, -D/2], u: [W, 0, 0], v: [0, 0, D],  n: [0, 1, 0] },
      { name: 'ceiling',  p0: [-W/2, H, D/2],  u: [W, 0, 0], v: [0, 0, -D], n: [0, -1, 0] },
      { name: 'wall_negZ', p0: [-W/2, 0, -D/2], u: [W, 0, 0], v: [0, H, 0],  n: [0, 0, 1] },
      { name: 'wall_posZ', p0: [W/2, 0, D/2],   u: [-W, 0, 0], v: [0, H, 0], n: [0, 0, -1] },
      { name: 'wall_negX', p0: [-W/2, 0, D/2],  u: [0, 0, -D], v: [0, H, 0], n: [1, 0, 0] },
      { name: 'wall_posX', p0: [W/2, 0, -D/2],  u: [0, 0, D],  v: [0, H, 0], n: [-1, 0, 0] },
    ];

    // Maximize UV packing scale via binary search
    const A = this.config.atlas;
    const pad = this.config.pad;

    const rawItems = surfaces.map((s) => {
      const uw = Math.hypot(s.u[0], s.u[1], s.u[2]);
      const vh = Math.hypot(s.v[0], s.v[1], s.v[2]);
      return { key: s.name, uw, vh };
    });

    let lo = 10, hi = 3000;
    let bestPlaced: Record<string, PlacedRect> | null = null;
    let bestScale = 100;

    for (let iter = 0; iter < 28; iter++) {
      const s = (lo + hi) * 0.5;
      const items = rawItems.map((it) => ({
        key: it.key,
        w: Math.max(2, Math.round(it.uw * s)),
        h: Math.max(2, Math.round(it.vh * s)),
      }));

      const res = this.maxRectsPack(items, A, pad, true);
      if (res) {
        bestPlaced = res;
        bestScale = s;
        lo = s;
      } else {
        hi = s;
      }
    }

    this.state.scale = bestScale;
    let chartPx = 0;

    for (const s of surfaces) {
      const r = bestPlaced?.[s.name] || { x: 0, y: 0, w: A / 2, h: A / 2, rotated: false };
      chartPx += r.w * r.h;

      const p0 = new THREE.Vector3(...(s.p0 as [number, number, number]));
      const u = new THREE.Vector3(...(s.u as [number, number, number]));
      const v = new THREE.Vector3(...(s.v as [number, number, number]));
      const n = new THREE.Vector3(...(s.n as [number, number, number]));

      const p1 = p0.clone().add(u);
      const p2 = p0.clone().add(u).add(v);
      const p3 = p0.clone().add(v);

      const positions = new Float32Array([
        p0.x, p0.y, p0.z,  p1.x, p1.y, p1.z,  p2.x, p2.y, p2.z,
        p0.x, p0.y, p0.z,  p2.x, p2.y, p2.z,  p3.x, p3.y, p3.z,
      ]);

      const normals = new Float32Array([
        n.x, n.y, n.z,  n.x, n.y, n.z,  n.x, n.y, n.z,
        n.x, n.y, n.z,  n.x, n.y, n.z,  n.x, n.y, n.z,
      ]);

      let uvs: Float32Array;
      if (r.rotated) {
        const u0 = r.x / A, v0 = r.y / A;
        const u1 = (r.x + r.w) / A, v1 = (r.y + r.h) / A;
        uvs = new Float32Array([
          u0, v1,  u0, v0,  u1, v0,
          u0, v1,  u1, v0,  u1, v1,
        ]);
      } else {
        const u0 = r.x / A, v0 = r.y / A;
        const u1 = (r.x + r.w) / A, v1 = (r.y + r.h) / A;
        uvs = new Float32Array([
          u0, v0,  u1, v0,  u1, v1,
          u0, v0,  u1, v1,  u0, v1,
        ]);
      }

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

      const mesh = new THREE.Mesh(geom, this.roomMat);
      mesh.name = s.name;
      mesh.frustumCulled = false;
      this.room.add(mesh);
      this.meshes.push(mesh);
    }

    this.state.chartFraction = chartPx / (A * A);
    this.state.modelName = `Default Room (${W.toFixed(1)}m × ${H.toFixed(1)}m × ${D.toFixed(1)}m)`;

    this.orbit.target.set(0, H * 0.52, D * 0.28);
    this.applyOrbit();
    this.generatePresetViews();
    this.clearBake();
  }

  /**
   * Advanced Smart Coplanar Island Unwrapper
   * - Connected Component Plane Clustering (separates isolated wall/floor pieces)
   * - Concavity/Hollow Island Decomposition (splits U-shapes & hollow perimeters into solid blocks)
   * - Minimum Oriented Bounding Box (OBB) 2D alignment (eliminates diagonal bounding box waste)
   * - MaxRects Guillotine Bin Packing with 90° rotation and binary search scale maximization
   */
  public smartUnwrapGeometry(geometry: THREE.BufferGeometry) {
    geometry.computeVertexNormals();
    const pos = geometry.attributes.position;
    const nor = geometry.attributes.normal;
    const vertexCount = pos.count;
    const triCount = Math.floor(vertexCount / 3);

    // 1. Calculate triangle face normals, centroids, areas, and plane signatures
    const triNormals: THREE.Vector3[] = [];
    const triAreas: number[] = [];
    const triCentroids: THREE.Vector3[] = [];
    const triPlaneKeys: string[] = [];

    // Spatial hash for vertex adjacency (resolution ~ 2mm)
    const vertTriMap = new Map<string, number[]>();

    const getVertKey = (x: number, y: number, z: number) => {
      return `${Math.round(x * 500)},${Math.round(y * 500)},${Math.round(z * 500)}`;
    };

    for (let t = 0; t < triCount; t++) {
      const i = t * 3;
      const ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i);
      const bx = pos.getX(i + 1), by = pos.getY(i + 1), bz = pos.getZ(i + 1);
      const cx = pos.getX(i + 2), cy = pos.getY(i + 2), cz = pos.getZ(i + 2);

      const abx = bx - ax, aby = by - ay, abz = bz - az;
      const acx = cx - ax, acy = cy - ay, acz = cz - az;
      let fnx = aby * acz - abz * acy;
      let fny = abz * acx - abx * acz;
      let fnz = abx * acy - aby * acx;
      const len = Math.hypot(fnx, fny, fnz);
      const area = len * 0.5;

      let n: THREE.Vector3;
      if (len > 1e-6) {
        n = new THREE.Vector3(fnx / len, fny / len, fnz / len);
      } else {
        n = new THREE.Vector3(nor.getX(i), nor.getY(i), nor.getZ(i)).normalize();
      }

      const centroid = new THREE.Vector3((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + cz + cz) / 3);
      const d = n.dot(centroid);

      // Quantize normal to dominant 26-cube vectors (approx 20 deg tolerance) and distance (0.05m tolerance)
      const qnx = Math.round(n.x * 2.5);
      const qny = Math.round(n.y * 2.5);
      const qnz = Math.round(n.z * 2.5);
      const qd  = Math.round(d * 15);

      const planeKey = `${qnx}_${qny}_${qnz}_${qd}`;
      triNormals.push(n);
      triAreas.push(area);
      triCentroids.push(centroid);
      triPlaneKeys.push(planeKey);

      for (let k = 0; k < 3; k++) {
        const vKey = getVertKey(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k));
        let list = vertTriMap.get(vKey);
        if (!list) {
          list = [];
          vertTriMap.set(vKey, list);
        }
        list.push(t);
      }
    }

    // 2. Connected Component Segmentation per Plane
    // Triangles on the same plane only group into the same island if they are physically connected
    const planeTriangles = new Map<string, number[]>();
    for (let t = 0; t < triCount; t++) {
      const k = triPlaneKeys[t];
      let arr = planeTriangles.get(k);
      if (!arr) {
        arr = [];
        planeTriangles.set(k, arr);
      }
      arr.push(t);
    }

    const rawIslands: { tris: IslandTriangle[]; normal: THREE.Vector3 }[] = [];
    const visited = new Uint8Array(triCount);

    for (const [_, trisInPlane] of planeTriangles.entries()) {
      for (const startT of trisInPlane) {
        if (visited[startT]) continue;

        const islandTris: IslandTriangle[] = [];
        const queue: number[] = [startT];
        visited[startT] = 1;
        const avgNormal = new THREE.Vector3();

        while (queue.length > 0) {
          const curr = queue.pop()!;
          islandTris.push({ tIdx: curr, area: triAreas[curr] });
          avgNormal.add(triNormals[curr]);

          // Find adjacent triangles in same plane
          const i = curr * 3;
          for (let k = 0; k < 3; k++) {
            const vKey = getVertKey(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k));
            const neighbors = vertTriMap.get(vKey) || [];
            for (const nbr of neighbors) {
              if (!visited[nbr] && triPlaneKeys[nbr] === triPlaneKeys[curr]) {
                visited[nbr] = 1;
                queue.push(nbr);
              }
            }
          }
        }

        avgNormal.normalize();
        rawIslands.push({ tris: islandTris, normal: avgNormal });
      }
    }

    // 3. 2D Basis & OBB (Minimum Oriented Bounding Box) Alignment
    const processedIslands: UVIsland[] = [];
    const tempU = new Float32Array(vertexCount);
    const tempV = new Float32Array(vertexCount);

    let islandIdCounter = 0;

    for (const raw of rawIslands) {
      const norm = raw.normal;
      let uDir: THREE.Vector3;
      let vDir: THREE.Vector3;

      if (Math.abs(norm.y) > 0.7) {
        // Horizontal floors / ceilings
        uDir = new THREE.Vector3(1, 0, 0);
        vDir = new THREE.Vector3(0, 0, norm.y > 0 ? -1 : 1);
      } else {
        // Vertical walls
        uDir = new THREE.Vector3(-norm.z, 0, norm.x).normalize();
        vDir = new THREE.Vector3(0, 1, 0);
      }

      // Compute initial unrotated 2D coords
      for (const it of raw.tris) {
        const i = it.tIdx * 3;
        for (let k = 0; k < 3; k++) {
          const idx = i + k;
          const p = new THREE.Vector3(pos.getX(idx), pos.getY(idx), pos.getZ(idx));
          tempU[idx] = p.dot(uDir);
          tempV[idx] = p.dot(vDir);
        }
      }

      // Test angles to find Minimum Oriented Bounding Box
      const testAngles = [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165].map(
        (deg) => (deg * Math.PI) / 180
      );

      let bestAngle = 0;
      let bestBBoxArea = Infinity;
      let bestMinU = 0, bestMaxU = 0, bestMinV = 0, bestMaxV = 0;

      for (const ang of testAngles) {
        const cosA = Math.cos(ang);
        const sinA = Math.sin(ang);
        let minU = Infinity, maxU = -Infinity;
        let minV = Infinity, maxV = -Infinity;

        for (const it of raw.tris) {
          const i = it.tIdx * 3;
          for (let k = 0; k < 3; k++) {
            const idx = i + k;
            const u = tempU[idx];
            const v = tempV[idx];
            const ru = u * cosA - v * sinA;
            const rv = u * sinA + v * cosA;
            if (ru < minU) minU = ru;
            if (ru > maxU) maxU = ru;
            if (rv < minV) minV = rv;
            if (rv > maxV) maxV = rv;
          }
        }

        const area = (maxU - minU) * (maxV - minV);
        if (area < bestBBoxArea) {
          bestBBoxArea = area;
          bestAngle = ang;
          bestMinU = minU;
          bestMaxU = maxU;
          bestMinV = minV;
          bestMaxV = maxV;
        }
      }

      // Rotate 2D vertex coords by best angle
      const cosB = Math.cos(bestAngle);
      const sinB = Math.sin(bestAngle);
      for (const it of raw.tris) {
        const i = it.tIdx * 3;
        for (let k = 0; k < 3; k++) {
          const idx = i + k;
          const u = tempU[idx];
          const v = tempV[idx];
          tempU[idx] = u * cosB - v * sinB;
          tempV[idx] = u * sinB + v * cosB;
        }
      }

      const uLen = Math.max(0.02, bestMaxU - bestMinU);
      const vLen = Math.max(0.02, bestMaxV - bestMinV);
      const totalArea = raw.tris.reduce((sum, t) => sum + t.area, 0);

      processedIslands.push({
        id: islandIdCounter++,
        tris: raw.tris,
        normal: norm,
        uDir,
        vDir,
        rotAngle: bestAngle,
        minU: bestMinU,
        maxU: bestMaxU,
        minV: bestMinV,
        maxV: bestMaxV,
        uLen,
        vLen,
        totalArea,
      });
    }

    // 4. MaxRects Area-Maximization Packing across the Atlas
    const atlasSize = this.config.atlas;
    const padPx = this.config.pad; // 4px tight gutter
    let lo = 1, hi = 5000;
    let bestPlaced: Record<string, PlacedRect> | null = null;

    // 28 binary search steps for optimal texel packing scale
    for (let iter = 0; iter < 28; iter++) {
      const s = (lo + hi) * 0.5;
      const items = processedIslands.map((isl) => ({
        key: `isl_${isl.id}`,
        w: Math.max(2, Math.round(isl.uLen * s)),
        h: Math.max(2, Math.round(isl.vLen * s)),
      }));

      const res = this.maxRectsPack(items, atlasSize, padPx, true);
      if (res) {
        bestPlaced = res;
        lo = s;
      } else {
        hi = s;
      }
    }

    const finalUvs = new Float32Array(vertexCount * 2);

    if (bestPlaced) {
      for (const isl of processedIslands) {
        const r = bestPlaced[`isl_${isl.id}`];
        if (!r) continue;
        const rangeU = isl.maxU - isl.minU || 1e-4;
        const rangeV = isl.maxV - isl.minV || 1e-4;

        for (const it of isl.tris) {
          const i = it.tIdx * 3;
          for (let k = 0; k < 3; k++) {
            const idx = i + k;
            let normU: number;
            let normV: number;

            if (r.rotated) {
              normU = (tempV[idx] - isl.minV) / rangeV;
              normV = 1.0 - (tempU[idx] - isl.minU) / rangeU;
            } else {
              normU = (tempU[idx] - isl.minU) / rangeU;
              normV = (tempV[idx] - isl.minV) / rangeV;
            }

            finalUvs[idx * 2]     = (r.x + normU * r.w) / atlasSize;
            finalUvs[idx * 2 + 1] = (r.y + normV * r.h) / atlasSize;
          }
        }
      }
    } else {
      return this.autoUnwrapGeometry(geometry, 0.015);
    }

    geometry.setAttribute('uv', new THREE.BufferAttribute(finalUvs, 2));
    return geometry;
  }

  public autoUnwrapGeometry(geometry: THREE.BufferGeometry, padding = 0.02) {
    geometry.computeVertexNormals();
    const pos = geometry.attributes.position;
    const nor = geometry.attributes.normal;
    const vertexCount = pos.count;

    const chartTris: number[][] = [[], [], [], [], [], []];
    const chartBounds: { minU: number; maxU: number; minV: number; maxV: number }[] = [];
    for (let c = 0; c < 6; c++) {
      chartBounds.push({ minU: Infinity, maxU: -Infinity, minV: Infinity, maxV: -Infinity });
    }

    const tempU = new Float32Array(vertexCount);
    const tempV = new Float32Array(vertexCount);

    for (let i = 0; i < vertexCount; i += 3) {
      const nx = (nor.getX(i) + nor.getX(i + 1) + nor.getX(i + 2)) / 3;
      const ny = (nor.getY(i) + nor.getY(i + 1) + nor.getY(i + 2)) / 3;
      const nz = (nor.getZ(i) + nor.getZ(i + 1) + nor.getZ(i + 2)) / 3;

      const absX = Math.abs(nx);
      const absY = Math.abs(ny);
      const absZ = Math.abs(nz);

      let chartIdx = 0;
      if (absY >= absX && absY >= absZ) {
        chartIdx = ny > 0 ? 2 : 3;
      } else if (absX >= absY && absX >= absZ) {
        chartIdx = nx > 0 ? 0 : 1;
      } else {
        chartIdx = nz > 0 ? 4 : 5;
      }

      const b = chartBounds[chartIdx];
      chartTris[chartIdx].push(i, i + 1, i + 2);

      for (let k = 0; k < 3; k++) {
        const idx = i + k;
        const x = pos.getX(idx);
        const y = pos.getY(idx);
        const z = pos.getZ(idx);
        let u = 0, v = 0;
        switch (chartIdx) {
          case 0: u = -z; v = y; break;
          case 1: u = z;  v = y; break;
          case 2: u = x;  v = -z; break;
          case 3: u = x;  v = z; break;
          case 4: u = x;  v = y; break;
          case 5: u = -x; v = y; break;
        }
        tempU[idx] = u;
        tempV[idx] = v;
        if (u < b.minU) b.minU = u;
        if (u > b.maxU) b.maxU = u;
        if (v < b.minV) b.minV = v;
        if (v > b.maxV) b.maxV = v;
      }
    }

    const cols = 3, rows = 2;
    const cellW = 1.0 / cols;
    const cellH = 1.0 / rows;
    const pad = padding * cellW;

    const finalUvs = new Float32Array(vertexCount * 2);
    for (let c = 0; c < 6; c++) {
      const col = c % cols;
      const row = Math.floor(c / cols);
      const b = chartBounds[c];
      const rangeU = b.maxU - b.minU || 1e-4;
      const rangeV = b.maxV - b.minV || 1e-4;

      const slotX = col * cellW + pad;
      const slotY = row * cellH + pad;
      const slotW = cellW - pad * 2;
      const slotH = cellH - pad * 2;

      const tris = chartTris[c];
      for (let j = 0; j < tris.length; j++) {
        const idx = tris[j];
        const normU = (tempU[idx] - b.minU) / rangeU;
        const normV = (tempV[idx] - b.minV) / rangeV;
        finalUvs[idx * 2]     = slotX + normU * slotW;
        finalUvs[idx * 2 + 1] = slotY + normV * slotH;
      }
    }

    geometry.setAttribute('uv', new THREE.BufferAttribute(finalUvs, 2));
    return geometry;
  }

  public async loadCustomModel(
    fileOrUrl: File | string,
    uvMode: 'smart' | 'box' | 'model' | 'auto' = 'smart'
  ): Promise<void> {
    let rootObject: THREE.Object3D;
    const fileName = typeof fileOrUrl === 'string' ? fileOrUrl.split('/').pop() || 'model' : fileOrUrl.name;

    if (typeof fileOrUrl === 'string') {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(fileOrUrl);
      rootObject = gltf.scene;
    } else {
      const ext = fileName.split('.').pop()?.toLowerCase();
      const buffer = await fileOrUrl.arrayBuffer();

      if (ext === 'obj') {
        const text = new TextDecoder().decode(buffer);
        const loader = new OBJLoader();
        rootObject = loader.parse(text);
      } else {
        const loader = new GLTFLoader();
        const gltf = await loader.parseAsync(buffer, '');
        rootObject = gltf.scene;
      }
    }

    const gathered: THREE.Mesh[] = [];
    rootObject.traverse((child) => {
      if ((child as THREE.Mesh).isMesh && (child as THREE.Mesh).geometry) {
        gathered.push(child as THREE.Mesh);
      }
    });

    if (gathered.length === 0) {
      throw new Error('No 3D meshes found in uploaded file.');
    }

    let totalVerts = 0;
    for (const m of gathered) {
      const g = m.geometry;
      totalVerts += g.index ? g.index.count : g.attributes.position.count;
    }

    const outPos = new Float32Array(totalVerts * 3);
    const outNor = new Float32Array(totalVerts * 3);
    const outUv  = new Float32Array(totalVerts * 2);
    let hasAnyUv = true;
    let offset = 0;

    for (const m of gathered) {
      const g = m.geometry;
      m.updateWorldMatrix(true, false);
      const mat = m.matrixWorld;
      const normMat = new THREE.Matrix3().getNormalMatrix(mat);

      if (!g.attributes.normal) g.computeVertexNormals();
      if (!g.attributes.uv) hasAnyUv = false;

      const pos = g.attributes.position;
      const nor = g.attributes.normal;
      const uv = g.attributes.uv;
      const v = new THREE.Vector3();
      const n = new THREE.Vector3();

      if (g.index) {
        const idx = g.index;
        for (let i = 0; i < idx.count; i++) {
          const vi = idx.getX(i);
          v.fromBufferAttribute(pos, vi).applyMatrix4(mat);
          n.fromBufferAttribute(nor, vi).applyMatrix3(normMat).normalize();
          outPos[(offset + i) * 3]     = v.x;
          outPos[(offset + i) * 3 + 1] = v.y;
          outPos[(offset + i) * 3 + 2] = v.z;
          outNor[(offset + i) * 3]     = n.x;
          outNor[(offset + i) * 3 + 1] = n.y;
          outNor[(offset + i) * 3 + 2] = n.z;
          if (uv) {
            outUv[(offset + i) * 2]     = uv.getX(vi);
            outUv[(offset + i) * 2 + 1] = uv.getY(vi);
          }
        }
        offset += idx.count;
      } else {
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(mat);
          n.fromBufferAttribute(nor, i).applyMatrix3(normMat).normalize();
          outPos[(offset + i) * 3]     = v.x;
          outPos[(offset + i) * 3 + 1] = v.y;
          outPos[(offset + i) * 3 + 2] = v.z;
          outNor[(offset + i) * 3]     = n.x;
          outNor[(offset + i) * 3 + 1] = n.y;
          outNor[(offset + i) * 3 + 2] = n.z;
          if (uv) {
            outUv[(offset + i) * 2]     = uv.getX(i);
            outUv[(offset + i) * 2 + 1] = uv.getY(i);
          }
        }
        offset += pos.count;
      }
    }

    const mergedGeom = new THREE.BufferGeometry();
    mergedGeom.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
    mergedGeom.setAttribute('normal', new THREE.BufferAttribute(outNor, 3));
    if (hasAnyUv) {
      mergedGeom.setAttribute('uv', new THREE.BufferAttribute(outUv, 2));
    }

    // Default to Smart Coplanar Island Unwrapping
    if (uvMode === 'smart' || !hasAnyUv || (uvMode === 'auto' && !hasAnyUv)) {
      this.smartUnwrapGeometry(mergedGeom);
    } else if (uvMode === 'box') {
      this.autoUnwrapGeometry(mergedGeom);
    }

    for (const m of this.meshes) {
      this.room.remove(m);
      m.geometry.dispose();
    }
    this.meshes = [];

    mergedGeom.computeBoundingBox();
    const bbox = mergedGeom.boundingBox!;
    const size = new THREE.Vector3();
    bbox.getSize(size);
    const center = new THREE.Vector3();
    bbox.getCenter(center);

    const offsetY = -bbox.min.y;
    mergedGeom.translate(-center.x, offsetY, -center.z);

    const mesh = new THREE.Mesh(mergedGeom, this.roomMat);
    mesh.name = fileName;
    mesh.frustumCulled = false;
    this.room.add(mesh);
    this.meshes.push(mesh);

    this.config.room.W = Math.max(1, size.x);
    this.config.room.H = Math.max(1, size.y);
    this.config.room.D = Math.max(1, size.z);

    this.orbit.target.set(0, this.config.room.H * 0.5, 0);
    this.applyOrbit();
    this.generatePresetViews();
    this.clearBake();
    this.state.modelName = `${fileName} (${this.config.room.W.toFixed(1)}m × ${this.config.room.H.toFixed(1)}m × ${this.config.room.D.toFixed(1)}m)`;
  }

  public generatePresetViews() {
    const { W, H, D } = this.config.room;
    const eye = H * 0.55;
    const c: [number, number, number] = [0, eye, 0];

    const rawViews: ViewPoint[] = [
      { name: 'Panorama · Center', type: 'pano', pos: [0, eye, 0] },
      { name: 'Wall −Z (Front)',  pos: c, target: [0, eye, -D], fov: 65 },
      { name: 'Wall +Z (Back)',   pos: c, target: [0, eye,  D], fov: 65 },
      { name: 'Wall −X (Left)',   pos: c, target: [-W, eye, 0], fov: 70 },
      { name: 'Wall +X (Right)',  pos: c, target: [ W, eye, 0], fov: 70 },
      { name: 'Floor (Front)',    pos: [0, H - 0.25, -D * 0.22], target: [0, 0, -D * 0.22], fov: 90 },
      { name: 'Floor (Back)',     pos: [0, H - 0.25,  D * 0.22], target: [0, 0,  D * 0.22], fov: 90 },
      { name: 'Ceiling (Front)',  pos: [0, 0.25, -D * 0.22], target: [0, H, -D * 0.22], fov: 90 },
      { name: 'Ceiling (Back)',   pos: [0, 0.25,  D * 0.22], target: [0, H,  D * 0.22], fov: 90 },
      { name: 'Corner −X−Z',      pos: [-W * 0.4, eye, -D * 0.45], target: [W * 0.5, eye * 0.6, D * 0.5], fov: 75 },
      { name: 'Corner +X+Z',      pos: [ W * 0.4, eye,  D * 0.45], target: [-W * 0.5, eye * 0.6, -D * 0.5], fov: 75 },
    ];

    this.views = rawViews.map((v) => {
      const fov = v.fov || 60;
      const cam = new THREE.PerspectiveCamera(fov, this.config.genW / this.config.genH, 0.05, 200);
      cam.position.set(...v.pos);
      if (v.target) cam.lookAt(new THREE.Vector3(...v.target));
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      const viewProj = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      return { ...v, cam, viewProj };
    });
  }

  public applyOrbit() {
    const cp = Math.cos(this.orbit.pitch);
    const dir = new THREE.Vector3(
      Math.sin(this.orbit.yaw) * cp,
      Math.sin(this.orbit.pitch),
      Math.cos(this.orbit.yaw) * cp
    );
    this.previewCam.position.copy(this.orbit.target).addScaledVector(dir, this.orbit.dist);
    this.previewCam.lookAt(this.orbit.target.clone().addScaledVector(dir, this.orbit.dist + 1));
    this.previewCam.updateMatrixWorld(true);
  }

  public renderGBuffer(view: ViewPoint): THREE.WebGLRenderTarget {
    this.gbufMat.uniforms.uCamPos.value.set(...view.pos);
    this.scene.overrideMaterial = this.gbufMat;
    const oldClear = this.renderer.getClearColor(new THREE.Color());
    this.renderer.setClearColor(0x000000, 0);

    if (view.type === 'pano') {
      this.cubeCam.position.set(...view.pos);
      this.cubeCam.updateMatrixWorld(true);
      this.cubeCam.update(this.renderer, this.scene);
      this.cube2equirectMat.uniforms.uCube.value = this.RTs.cube.texture;
      this.fsPass(this.cube2equirectMat, this.RTs.pano);
    } else if (view.cam) {
      this.renderer.setRenderTarget(this.RTs.gbuf);
      this.renderer.clear(true, true, true);
      this.renderer.render(this.scene, view.cam);
      this.renderer.setRenderTarget(null);
    }

    this.renderer.setClearColor(oldClear, 1);
    this.scene.overrideMaterial = null;
    return view.type === 'pano' ? this.RTs.pano : this.RTs.gbuf;
  }

  public autoDepthRange(src: THREE.WebGLRenderTarget, w: number, h: number): DepthRange {
    this.minmaxMat.uniforms.uTex.value = src.texture;
    this.minmaxMat.uniforms.uFirst.value = 1.0;
    this.minmaxMat.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.fsPass(this.minmaxMat, this.RTs.mm[0]);

    for (let i = 1; i < this.RTs.mm.length; i++) {
      this.minmaxMat.uniforms.uTex.value = this.RTs.mm[i - 1].texture;
      this.minmaxMat.uniforms.uFirst.value = 0.0;
      this.minmaxMat.uniforms.uTexel.value.set(
        1 / this.RTs.mm[i - 1].width,
        1 / this.RTs.mm[i - 1].height
      );
      this.fsPass(this.minmaxMat, this.RTs.mm[i]);
    }

    const last = this.RTs.mm[this.RTs.mm.length - 1];
    const buf = new Float32Array(last.width * last.height * 4);
    this.renderer.readRenderTargetPixels(last, 0, 0, last.width, last.height, buf);

    let mn = 1e9, mx = -1e9;
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i] > 1e-4) mn = Math.min(mn, buf[i]);
      if (buf[i + 1] > 1e-4) mx = Math.max(mx, buf[i + 1]);
    }
    if (mn > 1e8) mn = 0.3;
    if (mx < -1e8) mx = 12;
    return { near: mn, far: Math.max(mx, mn + 0.1) };
  }

  public rtToCanvas(target: THREE.WebGLRenderTarget, flipY = true): HTMLCanvasElement {
    const { width: w, height: h } = target;
    const px = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(target, 0, 0, w, h, px);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    if (flipY) {
      for (let y = 0; y < h; y++) {
        const src = (h - 1 - y) * w * 4;
        const dst = y * w * 4;
        img.data.set(px.subarray(src, src + w * 4), dst);
      }
    } else {
      img.data.set(px);
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  public renderConditioning(view: ViewPoint, autoRange = true, depthInvert = false, feather = 6) {
    const isPano = view.type === 'pano';
    const src = this.renderGBuffer(view);
    const W = isPano ? this.config.panoW : this.config.genW;
    const H = isPano ? this.config.panoH : this.config.genH;
    const vizRT = isPano ? this.RTs.vizPano : this.RTs.viz;

    // 1. Depth Map
    const range = autoRange ? this.autoDepthRange(src, W, H) : this.cond.range;
    this.cond.range = range;
    this.depthVizMat.uniforms.uGbuf.value = src.texture;
    this.depthVizMat.uniforms.uNear.value = range.near;
    this.depthVizMat.uniforms.uFar.value = range.far;
    this.depthVizMat.uniforms.uInvert.value = depthInvert ? 1 : 0;
    this.fsPass(this.depthVizMat, vizRT);
    this.cond.depth = this.rtToCanvas(vizRT);

    // 2. Normal Map
    this.normalVizMat.uniforms.uGbuf.value = src.texture;
    this.normalVizMat.uniforms.uMode.value = isPano ? 1 : 0;
    if (!isPano && view.cam) {
      const m = view.cam.matrixWorld;
      this.normalVizMat.uniforms.uRight.value.setFromMatrixColumn(m, 0).normalize();
      this.normalVizMat.uniforms.uUp.value.setFromMatrixColumn(m, 1).normalize();
      this.normalVizMat.uniforms.uFwd.value.setFromMatrixColumn(m, 2).normalize().negate();
    }
    this.fsPass(this.normalVizMat, vizRT);
    this.cond.normal = this.rtToCanvas(vizRT);

    // 3. Inpaint Mask
    const mA = isPano ? this.RTs.maskPanoA : this.RTs.maskA;
    const mB = isPano ? this.RTs.maskPanoB : this.RTs.maskB;
    this.maskMat.uniforms.uBake.value = this.RTs.bakeA.texture;
    this.maskMat.uniforms.uInvert.value = 1.0;
    this.scene.overrideMaterial = this.maskMat;

    if (isPano) {
      this.cubeCam.position.set(...view.pos);
      this.cubeCam.updateMatrixWorld(true);
      this.cubeCam.update(this.renderer, this.scene);
      this.scene.overrideMaterial = null;
      this.cube2equirectMat.uniforms.uCube.value = this.RTs.cube.texture;
      this.fsPass(this.cube2equirectMat, mA);
      this.cond.mask = this.rtToCanvas(mA);
    } else if (view.cam) {
      this.renderer.setRenderTarget(mA);
      this.renderer.setClearColor(0xffffff, 1);
      this.renderer.clear(true, true, true);
      this.renderer.render(this.scene, view.cam);
      this.renderer.setRenderTarget(null);
      this.renderer.setClearColor(0x0a0c10, 1);
      this.scene.overrideMaterial = null;

      if (feather > 0) {
        this.blurMat.uniforms.uDir.value.set(feather / this.config.genW, 0);
        this.blurMat.uniforms.uTex.value = mA.texture;
        this.fsPass(this.blurMat, mB);
        this.blurMat.uniforms.uDir.value.set(0, feather / this.config.genH);
        this.blurMat.uniforms.uTex.value = mB.texture;
        this.fsPass(this.blurMat, mA);
      }
      this.cond.mask = this.rtToCanvas(mA);
    }

    this.cond.view = view;
    return this.cond;
  }

  public renderInitFromAtlas(view: ViewPoint): HTMLCanvasElement {
    const isPano = view.type === 'pano';
    const target = isPano ? this.RTs.vizPano : this.RTs.viz;
    const oldGaps = this.roomMat.uniforms.uShowGaps.value;
    this.roomMat.uniforms.uShowGaps.value = 0.0;

    if (isPano) {
      this.cubeCam.position.set(...view.pos);
      this.cubeCam.updateMatrixWorld(true);
      this.cubeCam.update(this.renderer, this.scene);
      this.cube2equirectMat.uniforms.uCube.value = this.RTs.cube.texture;
      this.fsPass(this.cube2equirectMat, target);
    } else if (view.cam) {
      this.renderer.setRenderTarget(target);
      this.renderer.clear(true, true, true);
      this.renderer.render(this.scene, view.cam);
      this.renderer.setRenderTarget(null);
    }

    this.roomMat.uniforms.uShowGaps.value = oldGaps;
    return this.rtToCanvas(target);
  }

  public blit(srcTex: THREE.Texture, dst: THREE.WebGLRenderTarget) {
    this.blitMat.uniforms.uTex.value = srcTex;
    this.fsPass(this.blitMat, dst);
  }

  public bake(view: ViewPoint, genTexture: THREE.Texture, opts: BakeOptions = {}) {
    this.blit(this.RTs.bakeA.texture, this.RTs.bakeSnap);
    this.state.hasSnapshot = true;
    this.blit(this.RTs.bakeA.texture, this.RTs.bakeB);

    const u = this.bakeMat.uniforms;
    u.uGen.value = genTexture;
    u.uPrev.value = this.RTs.bakeA.texture;
    u.uCamPos.value.set(...view.pos);
    u.uRes.value.set(this.config.atlas, this.config.atlas);
    u.uMode.value = view.type === 'pano' ? 1 : 0;
    u.uGbuf.value = (view.type === 'pano' ? this.RTs.pano : this.RTs.gbuf).texture;
    if (view.viewProj) u.uViewProj.value.copy(view.viewProj);

    if (opts.uWeightPow !== undefined) u.uWeightPow.value = opts.uWeightPow;
    if (opts.uMinNdotV !== undefined) u.uMinNdotV.value = opts.uMinNdotV;
    if (opts.uBias !== undefined) u.uBias.value = opts.uBias;
    if (opts.uFeather !== undefined) u.uFeather.value = opts.uFeather;
    if (opts.uBlend !== undefined) u.uBlend.value = opts.uBlend;
    if (opts.uOcclude !== undefined) u.uOcclude.value = opts.uOcclude;

    this.scene.overrideMaterial = this.bakeMat;
    this.renderer.setRenderTarget(this.RTs.bakeB);
    this.renderer.render(this.scene, this.fsCam);
    this.renderer.setRenderTarget(null);
    this.scene.overrideMaterial = null;

    const t = this.RTs.bakeA;
    this.RTs.bakeA = this.RTs.bakeB;
    this.RTs.bakeB = t;
    this.state.bakes++;
    this.state.lastGeneratedTexture = genTexture;
    this.refreshDisplay(this.dilationPasses);
  }

  public undoBake(): boolean {
    if (!this.state.hasSnapshot) return false;
    this.blit(this.RTs.bakeSnap.texture, this.RTs.bakeB);
    const t = this.RTs.bakeA;
    this.RTs.bakeA = this.RTs.bakeB;
    this.RTs.bakeB = t;
    this.state.hasSnapshot = false;
    this.state.bakes = Math.max(0, this.state.bakes - 1);
    this.refreshDisplay(this.dilationPasses);
    return true;
  }

  public clearBake() {
    for (const target of [this.RTs.bakeA, this.RTs.bakeB, this.RTs.bakeSnap]) {
      this.renderer.setRenderTarget(target);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear(true, true, true);
    }
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(0x0a0c10, 1);
    this.state.bakes = 0;
    this.state.hasSnapshot = false;
    this.state.lastGeneratedTexture = null;
    this.refreshDisplay(this.dilationPasses);
  }

  public refreshDisplay(iterations = 8) {
    this.dilationPasses = iterations;
    this.resolveMat.uniforms.uTex.value = this.RTs.bakeA.texture;
    this.fsPass(this.resolveMat, this.RTs.dispA);

    this.dilateMat.uniforms.uTexel.value.set(1 / this.config.atlas, 1 / this.config.atlas);
    for (let i = 0; i < iterations; i++) {
      this.dilateMat.uniforms.uTex.value = this.RTs.dispA.texture;
      this.fsPass(this.dilateMat, this.RTs.dispB);
      const t = this.RTs.dispA;
      this.RTs.dispA = this.RTs.dispB;
      this.RTs.dispB = t;
    }

    this.roomMat.uniforms.uTex.value = this.RTs.dispA.texture;
    this.maskMat.uniforms.uBake.value = this.RTs.bakeA.texture;
    this.state.coverage = this.computeCoverage();
  }

  public computeCoverage(): number {
    this.reduceMat.uniforms.uBinarize.value = 1.0;
    this.reduceMat.uniforms.uTex.value = this.RTs.bakeA.texture;
    this.reduceMat.uniforms.uTexel.value.set(1 / this.config.atlas, 1 / this.config.atlas);
    this.fsPass(this.reduceMat, this.RTs.red[0]);

    this.reduceMat.uniforms.uBinarize.value = 0.0;
    for (let i = 1; i < this.RTs.red.length; i++) {
      this.reduceMat.uniforms.uTex.value = this.RTs.red[i - 1].texture;
      this.reduceMat.uniforms.uTexel.value.set(
        1 / this.RTs.red[i - 1].width,
        1 / this.RTs.red[i - 1].height
      );
      this.fsPass(this.reduceMat, this.RTs.red[i]);
    }

    const last = this.RTs.red[this.RTs.red.length - 1];
    const buf = new Float32Array(last.width * last.height * 4);
    this.renderer.readRenderTargetPixels(last, 0, 0, last.width, last.height, buf);

    let sum = 0, n = 0;
    for (let i = 0; i < buf.length; i += 4) {
      sum += buf[i];
      n++;
    }
    return Math.min(1, sum / n / Math.max(this.state.chartFraction, 1e-6));
  }

  public getAtlasCanvas(): HTMLCanvasElement {
    return this.rtToCanvas(this.RTs.dispA);
  }

  public drawUVWireframe(targetCanvas: HTMLCanvasElement, overlayTexture = true): number {
    const ctx = targetCanvas.getContext('2d')!;
    const w = targetCanvas.width;
    const h = targetCanvas.height;

    ctx.clearRect(0, 0, w, h);
    if (overlayTexture && this.state.bakes > 0) {
      try {
        const atlasCv = this.getAtlasCanvas();
        ctx.drawImage(atlasCv, 0, 0, w, h);
        ctx.fillStyle = 'rgba(10, 12, 16, 0.45)';
        ctx.fillRect(0, 0, w, h);
      } catch (_) {
        ctx.fillStyle = '#0a0c10';
        ctx.fillRect(0, 0, w, h);
      }
    } else {
      ctx.fillStyle = '#0a0c10';
      ctx.fillRect(0, 0, w, h);
    }

    let triCount = 0;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0, 230, 255, 0.7)';
    ctx.fillStyle = 'rgba(0, 230, 255, 0.12)';

    for (const m of this.meshes) {
      const uv = m.geometry.attributes.uv;
      if (!uv) continue;
      triCount += Math.floor(uv.count / 3);

      for (let i = 0; i < uv.count; i += 3) {
        const u0 = uv.getX(i) * w,     v0 = (1 - uv.getY(i)) * h;
        const u1 = uv.getX(i + 1) * w, v1 = (1 - uv.getY(i + 1)) * h;
        const u2 = uv.getX(i + 2) * w, v2 = (1 - uv.getY(i + 2)) * h;

        ctx.beginPath();
        ctx.moveTo(u0, v0);
        ctx.lineTo(u1, v1);
        ctx.lineTo(u2, v2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
    return triCount;
  }

  public async exportBakedGLB(): Promise<ArrayBuffer> {
    const exportScene = new THREE.Scene();
    const atlasCanvas = this.getAtlasCanvas();
    const bakedTexture = new THREE.CanvasTexture(atlasCanvas);
    bakedTexture.colorSpace = THREE.SRGBColorSpace;
    bakedTexture.flipY = true;
    bakedTexture.needsUpdate = true;

    const exportMat = new THREE.MeshStandardMaterial({
      map: bakedTexture,
      roughness: 0.85,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });

    for (const m of this.meshes) {
      const clonedGeom = m.geometry.clone();
      const cloned = new THREE.Mesh(clonedGeom, exportMat);
      cloned.name = m.name;
      exportScene.add(cloned);
    }

    const exporter = new GLTFExporter();
    return new Promise((resolve, reject) => {
      exporter.parse(
        exportScene,
        (gltf) => resolve(gltf as ArrayBuffer),
        (err) => reject(err),
        { binary: true }
      );
    });
  }

  public render() {
    this.applyOrbit();
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.previewCam);
  }

  public resize(width: number, height: number) {
    this.renderer.setSize(width, height, false);
    this.previewCam.aspect = width / height;
    this.previewCam.updateProjectionMatrix();
  }

  public dispose() {
    for (const m of this.meshes) {
      m.geometry.dispose();
    }
    this.scene.clear();
    for (const target of Object.values(this.RTs)) {
      if (Array.isArray(target)) {
        target.forEach((t) => t.dispose());
      } else {
        target.dispose();
      }
    }
    this.renderer.dispose();
  }
}
