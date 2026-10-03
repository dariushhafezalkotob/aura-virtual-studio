import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

/**
 * Bringing a model file in from outside: a prop, a set piece, or a rigged prop with its own
 * animation (a dog's walk cycle, a fan, a door).
 *
 * Everything is stored as one GLB, so the viewport, RoomBake, the phone and the render passes keep
 * dealing with a single format. A .glb goes up exactly as it came; .gltf, .fbx and .obj are
 * converted in the browser first, animations included.
 */

export interface ImportedModel {
  glbUrl: string;
  /** From the file name, without the extension. */
  name: string;
  /** The animations inside the file, in file order. */
  clips: { name: string; duration: number }[];
  /** True when the model has a skeleton (a skinned mesh). */
  rigged: boolean;
  /** A starting scale: 0.01 when the model looks like it was built in centimetres, else 1. */
  scale: number;
  /** Plain words on anything adjusted on the way in, for the screen to show. */
  notes: string[];
}

export const MODEL_IMPORT_ACCEPT = '.glb,.gltf,.fbx,.obj';

const MAX_MB = 200;

async function toGLB(root: THREE.Object3D, animations: THREE.AnimationClip[]): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(root, (result) => resolve(result as ArrayBuffer), (err) => reject(err), { binary: true, animations });
  });
}

function describe(root: THREE.Object3D) {
  let rigged = false;
  let meshes = 0;
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) rigged = true;
    if ((o as THREE.Mesh).isMesh) meshes++;
  });
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
  return { rigged, meshes, maxDim: Math.max(size.x, size.y, size.z) };
}

/** Reads, converts if needed, uploads, and reports what the model contains. */
export async function importModelFile(file: File): Promise<ImportedModel> {
  if (file.size > MAX_MB * 1024 * 1024) throw new Error(`That file is ${(file.size / 1024 / 1024).toFixed(0)} MB; the limit is ${MAX_MB} MB.`);
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const name = file.name.replace(/\.[^.]+$/, '') || 'Imported model';
  const notes: string[] = [];

  let root: THREE.Object3D;
  let animations: THREE.AnimationClip[];
  let glb: ArrayBuffer;

  if (ext === 'glb' || ext === 'gltf') {
    const loader = new GLTFLoader();
    const data = ext === 'glb' ? await file.arrayBuffer() : await file.text();
    if (ext === 'gltf') {
      // A .gltf that points at separate .bin or texture files cannot be read from one upload.
      const json = JSON.parse(data as string);
      const external = [...(json.buffers || []), ...(json.images || [])].some((b: any) => b.uri && !String(b.uri).startsWith('data:'));
      if (external) throw new Error('This .gltf keeps its data in separate files. Export it as a single .glb instead.');
    }
    const gltf = await loader.parseAsync(data, '');
    root = gltf.scene;
    animations = gltf.animations;
    glb = ext === 'glb' ? (data as ArrayBuffer) : await toGLB(root, animations);
  } else if (ext === 'fbx') {
    const group = new FBXLoader().parse(await file.arrayBuffer(), '');
    root = group;
    animations = group.animations || [];
    glb = await toGLB(root, animations);
    notes.push('Converted from FBX. Textures stored as separate files next to the FBX are not included; embedded ones are.');
  } else if (ext === 'obj') {
    root = new OBJLoader().parse(await file.text());
    animations = [];
    glb = await toGLB(root, animations);
    notes.push('Converted from OBJ. Its .mtl materials are not read, so it comes in plain grey.');
  } else {
    throw new Error('Choose a .glb, .gltf, .fbx or .obj file.');
  }

  const { rigged, meshes, maxDim } = describe(root);
  if (meshes === 0) throw new Error('That file has no visible geometry in it.');

  // Mixamo and most FBX exports are in centimetres: a 1.8 m figure arrives 180 units tall.
  let scale = 1;
  if (maxDim > 50) {
    scale = 0.01;
    notes.push(`It was ${maxDim.toFixed(0)} units across, which looks like centimetres, so it was scaled to 1%.`);
  }

  const safe = name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'model';
  const filename = `import_${safe}_${Date.now()}.glb`;
  const res = await fetch(`/api/upload-asset?filename=${filename}`, {
    method: 'POST',
    headers: { 'Content-Type': 'model/gltf-binary' },
    body: glb,
  });
  const out = await res.json().catch(() => null);
  if (!res.ok || !out?.url) throw new Error(`The model could not be saved on the server (HTTP ${res.status}).`);

  return {
    glbUrl: out.url,
    name,
    clips: animations.map((a, i) => ({ name: a.name || `Animation ${i + 1}`, duration: Number(a.duration.toFixed(3)) })),
    rigged,
    scale,
    notes,
  };
}
