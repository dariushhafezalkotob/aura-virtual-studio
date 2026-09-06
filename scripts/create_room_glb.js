import * as THREE from 'three';
import fs from 'fs';
import path from 'path';

// Polyfill FileReader for Node.js GLTFExporter
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReader {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = buf;
        this.onloadend?.();
      });
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buf) => {
        const base64 = Buffer.from(buf).toString('base64');
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${base64}`;
        this.onloadend?.();
      });
    }
  };
}

import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

const assetsDir = path.join(process.cwd(), 'data', 'assets');
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

const scene = new THREE.Scene();

// Create realistic virtual production studio room (8m wide, 3.5m high, 8m deep)
const roomGroup = new THREE.Group();
roomGroup.name = 'VirtualStudioRoom';

const W = 8;
const H = 3.5;
const D = 8;

// Floor (subtle dark metallic studio grid)
const floorGeom = new THREE.PlaneGeometry(W, D);
floorGeom.rotateX(-Math.PI / 2);
const floorMat = new THREE.MeshStandardMaterial({
  color: 0x16181c,
  roughness: 0.4,
  metalness: 0.3,
  side: THREE.DoubleSide,
});
const floorMesh = new THREE.Mesh(floorGeom, floorMat);
floorMesh.name = 'studio_floor';
roomGroup.add(floorMesh);

// Back Wall
const backWallGeom = new THREE.PlaneGeometry(W, H);
backWallGeom.translate(0, H / 2, -D / 2);
const wallMat = new THREE.MeshStandardMaterial({
  color: 0x22252a,
  roughness: 0.85,
  metalness: 0.1,
  side: THREE.DoubleSide,
});
const backWall = new THREE.Mesh(backWallGeom, wallMat);
backWall.name = 'studio_back_wall';
roomGroup.add(backWall);

// Left Wall
const leftWallGeom = new THREE.PlaneGeometry(D, H);
leftWallGeom.rotateY(Math.PI / 2);
leftWallGeom.translate(-W / 2, H / 2, 0);
const leftWall = new THREE.Mesh(leftWallGeom, wallMat);
leftWall.name = 'studio_left_wall';
roomGroup.add(leftWall);

// Right Wall
const rightWallGeom = new THREE.PlaneGeometry(D, H);
rightWallGeom.rotateY(-Math.PI / 2);
rightWallGeom.translate(W / 2, H / 2, 0);
const rightWall = new THREE.Mesh(rightWallGeom, wallMat);
rightWall.name = 'studio_right_wall';
roomGroup.add(rightWall);

// Ceiling
const ceilingGeom = new THREE.PlaneGeometry(W, D);
ceilingGeom.rotateX(Math.PI / 2);
ceilingGeom.translate(0, H, 0);
const ceilingMat = new THREE.MeshStandardMaterial({
  color: 0x181a1f,
  roughness: 0.9,
  metalness: 0.05,
  side: THREE.DoubleSide,
});
const ceiling = new THREE.Mesh(ceilingGeom, ceilingMat);
ceiling.name = 'studio_ceiling';
roomGroup.add(ceiling);

// Baseboards / Trims for cinematic realism
const trimMat = new THREE.MeshStandardMaterial({
  color: 0x0a0a0c,
  roughness: 0.5,
  metalness: 0.6,
});
const trimBackGeom = new THREE.BoxGeometry(W, 0.12, 0.06);
trimBackGeom.translate(0, 0.06, -D / 2 + 0.03);
roomGroup.add(new THREE.Mesh(trimBackGeom, trimMat));

const trimLeftGeom = new THREE.BoxGeometry(0.06, 0.12, D);
trimLeftGeom.translate(-W / 2 + 0.03, 0.06, 0);
roomGroup.add(new THREE.Mesh(trimLeftGeom, trimMat));

const trimRightGeom = new THREE.BoxGeometry(0.06, 0.12, D);
trimRightGeom.translate(W / 2 - 0.03, 0.06, 0);
roomGroup.add(new THREE.Mesh(trimRightGeom, trimMat));

scene.add(roomGroup);

const exporter = new GLTFExporter();
exporter.parse(
  scene,
  (gltf) => {
    const filePath = path.join(assetsDir, 'baked_room_studio.glb');
    fs.writeFileSync(filePath, Buffer.from(gltf));
    console.log('Successfully generated baked_room_studio.glb at:', filePath);
  },
  (err) => {
    console.error('Error exporting GLB:', err);
  },
  { binary: true }
);
