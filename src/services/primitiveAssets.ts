import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

export type PrimitiveKind = 'box' | 'plane' | 'wall' | 'cylinder' | 'sphere';

export interface PrimitiveDef {
  kind: PrimitiveKind;
  label: string;
  icon: string; // material symbol
  hint: string;
}

/** What the PRIMITIVES menu offers, in display order. */
export const PRIMITIVE_DEFS: PrimitiveDef[] = [
  { kind: 'box', label: 'Box', icon: 'deployed_code', hint: '1 × 1 × 1 m cube' },
  { kind: 'plane', label: 'Floor plane', icon: 'crop_square', hint: '4 × 4 m flat ground plane' },
  { kind: 'wall', label: 'Wall', icon: 'wall_art', hint: '4 × 3 m upright panel' },
  // 'database' is the cylinder glyph; Material Symbols has no plain 'cylinder'.
  { kind: 'cylinder', label: 'Cylinder', icon: 'database', hint: '0.5 m radius, 1 m tall' },
  { kind: 'sphere', label: 'Sphere', icon: 'circle', hint: '0.5 m radius' },
];

/**
 * Geometry for a primitive, sitting on the ground (y = 0) and already UV-mapped.
 * Box faces each get the full 0..1 UV square from three, which overlaps -- RoomBake
 * re-unwraps whatever it loads, so the bake still gets its own atlas space per face.
 */
function buildGeometry(kind: PrimitiveKind): THREE.BufferGeometry {
  switch (kind) {
    case 'box': {
      const g = new THREE.BoxGeometry(1, 1, 1);
      g.translate(0, 0.5, 0); // stand on the floor instead of straddling it
      return g;
    }
    case 'plane': {
      const g = new THREE.PlaneGeometry(4, 4);
      g.rotateX(-Math.PI / 2); // lie flat; PlaneGeometry is upright by default
      return g;
    }
    case 'wall': {
      const g = new THREE.PlaneGeometry(4, 3);
      g.translate(0, 1.5, 0);
      return g;
    }
    case 'cylinder': {
      const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 1);
      g.translate(0, 0.5, 0);
      return g;
    }
    case 'sphere': {
      const g = new THREE.SphereGeometry(0.5, 48, 32);
      g.translate(0, 0.5, 0);
      return g;
    }
  }
}

/**
 * A plain, untextured primitive as a GLB, so it is an ordinary scene asset: the
 * gizmo, the inspector and RoomBake all work on it without special cases.
 */
export async function createPrimitiveGLB(kind: PrimitiveKind): Promise<ArrayBuffer> {
  const geometry = buildGeometry(kind);
  const material = new THREE.MeshStandardMaterial({
    color: 0xb8b8b8,
    roughness: 0.9,
    metalness: 0.0,
    // Flat pieces are invisible from behind otherwise, and RoomBake projects onto both faces.
    side: kind === 'plane' || kind === 'wall' ? THREE.DoubleSide : THREE.FrontSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = kind;

  const scene = new THREE.Scene();
  scene.add(mesh);

  const exporter = new GLTFExporter();
  const glb = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      scene,
      (result) => resolve(result as ArrayBuffer),
      (err) => reject(err),
      { binary: true }
    );
  });

  geometry.dispose();
  material.dispose();
  return glb;
}

/** Saves the primitive to disk so it survives a reload, and returns its asset URL. */
export async function createPrimitiveAssetUrl(kind: PrimitiveKind): Promise<string> {
  const glb = await createPrimitiveGLB(kind);
  const filename = `primitive_${kind}_${Date.now()}.glb`;
  const res = await fetch(`/api/upload-asset?filename=${filename}`, {
    method: 'POST',
    headers: { 'Content-Type': 'model/gltf-binary' },
    body: glb,
  });
  if (!res.ok) {
    throw new Error(`Could not save the ${kind} to disk (HTTP ${res.status}).`);
  }
  const data = await res.json();
  if (!data.url) throw new Error(`Could not save the ${kind} to disk.`);
  return data.url;
}
