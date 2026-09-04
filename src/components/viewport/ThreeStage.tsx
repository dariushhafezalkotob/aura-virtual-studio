import React, { useRef, useState, useEffect, Suspense, Component, ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  useGLTF,
  Center,
  Html,
  TransformControls,
  Environment,
  ContactShadows,
  Splat,
} from '@react-three/drei';
import * as THREE from 'three';
import { SceneAsset, CharacterActor } from '../../types';
import { CharacterActorModel } from './CharacterActorModel';

export type TransformMode = 'translate' | 'rotate' | 'scale';
export type LightingEnvironmentPreset = 'studio' | 'city' | 'sunset' | 'dawn' | 'park';

interface ThreeStageProps {
  assets: SceneAsset[];
  selectedAssetId: string | null;
  characters?: CharacterActor[];
  selectedActorId?: string | null;
  transformMode?: TransformMode;
  lightIntensity?: number;
  environmentPreset?: LightingEnvironmentPreset;
  panoramaUrl?: string | null;
  panoramaRotation?: number;
  showPanorama?: boolean;
  splatUrl?: string | null;
  onSelectAsset?: (id: string | null) => void;
  onUpdateAssetTransform?: (
    id: string,
    position: [number, number, number],
    rotation: [number, number, number],
    scale: [number, number, number]
  ) => void;
  onSelectActor?: (id: string | null) => void;
  onUpdateActorTransform?: (
    id: string,
    position: [number, number, number],
    rotation: [number, number, number],
    scale: [number, number, number]
  ) => void;
  currentTimelineTime?: number;
  isPlaying?: boolean;
  showTrajectories?: boolean;
  showGrid?: boolean;
}

// 360° Equirectangular Panorama Dome (Resilient Non-Blocking Loader)
const PanoramaDome: React.FC<{ url: string; rotationY: number }> = ({ url, rotationY }) => {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    if (!url) {
      setTexture(null);
      return;
    }

    let isMounted = true;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');

    // Proxy remote external images through /api/proxy-image to avoid WebGL CORS issues
    const safeUrl = (url.startsWith('http://') || url.startsWith('https://')) && !url.includes('localhost')
      ? `/api/proxy-image?url=${encodeURIComponent(url)}`
      : url;

    loader.load(
      safeUrl,
      (loaded) => {
        if (!isMounted) return;
        loaded.colorSpace = THREE.SRGBColorSpace;
        loaded.mapping = THREE.EquirectangularReflectionMapping;
        setTexture(loaded);
      },
      undefined,
      (err) => {
        console.warn('360 Panorama texture load failed gracefully:', err);
      }
    );

    return () => {
      isMounted = false;
    };
  }, [url]);

  if (!texture) return null;

  return (
    <group rotation={[0, rotationY, 0]}>
      {/* 360° Inverted Sphere Skybox */}
      <mesh scale={[-1, 1, 1]}>
        <sphereGeometry args={[100, 64, 32]} />
        <meshBasicMaterial map={texture} side={THREE.BackSide} toneMapped={false} />
      </mesh>
    </group>
  );
};


// Walkable 3D Gaussian Splatting Scene Component (Low-RAM Optimized)
const GaussianSplatScene: React.FC<{ url: string }> = ({ url }) => {
  const safeUrl = (url.startsWith('http://') || url.startsWith('https://')) && !url.includes('localhost')
    ? `/api/proxy-image?url=${encodeURIComponent(url)}`
    : url;

  return (
    <ModelErrorBoundary fallbackName="3D Gaussian Splatting Scene">
      <Suspense fallback={null}>
        <group position={[0, 0, 0]} rotation={[0, 0, 0]}>
          <Splat src={safeUrl} alphaTest={0.05} />
        </group>
      </Suspense>
    </ModelErrorBoundary>
  );
};

// Custom 3D Error Boundary
class ModelErrorBoundary extends Component<
  { children: ReactNode; fallbackName: string },
  { hasError: boolean }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: any) {
    console.warn('Model loading fallback triggered:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <group position={[0, 0.5, 0]}>
          <mesh>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial color="#444748" wireframe />
          </mesh>
          <Html center distanceFactor={8}>
            <div className="font-label-caps text-[9px] text-on-surface-variant bg-surface-container/90 px-xs py-[2px] border border-outline-variant/30 whitespace-nowrap">
              {this.props.fallbackName}
            </div>
          </Html>
        </group>
      );
    }
    return this.props.children;
  }
}

const GLTFModel: React.FC<{
  asset: SceneAsset;
  isSelected: boolean;
  transformMode: TransformMode;
  onSelect: () => void;
  onDraggingChange: (isDragging: boolean) => void;
  onTransformChange?: (
    id: string,
    position: [number, number, number],
    rotation: [number, number, number],
    scale: [number, number, number]
  ) => void;
}> = ({
  asset,
  isSelected,
  transformMode,
  onSelect,
  onDraggingChange,
  onTransformChange,
}) => {
  const groupRef = useRef<THREE.Group>(null);
  const { glbUrl, position, rotation, scale } = asset;

  // Synchronize internal Three.js group coordinates whenever props update (e.g. Undo/Redo)
  useEffect(() => {
    if (groupRef.current) {
      groupRef.current.position.set(position[0], position[1], position[2]);
      groupRef.current.rotation.set(rotation[0], rotation[1], rotation[2]);
      groupRef.current.scale.set(scale[0], scale[1], scale[2]);
      groupRef.current.updateMatrixWorld(true);
    }
  }, [position[0], position[1], position[2], rotation[0], rotation[1], rotation[2], scale[0], scale[1], scale[2]]);

  // If not a valid model URL, return procedural box
  const isCustomModel =
    glbUrl &&
    (glbUrl.includes('.glb') ||
      glbUrl.includes('.gltf') ||
      glbUrl.includes('/file=') ||
      glbUrl.includes('gradio_api') ||
      glbUrl.startsWith('blob:') ||
      glbUrl.startsWith('http://') ||
      glbUrl.startsWith('https://'));

  let content: ReactNode;
  if (isCustomModel) {
    const { scene } = useGLTF(glbUrl);
    const cloned = React.useMemo(() => {
      const c = scene.clone();
      // Enhance brightness & PBR material properties across all meshes
      c.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          if (mesh.material) {
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const m of mats) {
              const mat = m as THREE.MeshStandardMaterial;
              if (mat.map) {
                mat.map.colorSpace = THREE.SRGBColorSpace;
                mat.map.needsUpdate = true;
              }
              if (mesh.geometry?.attributes?.color) {
                mat.vertexColors = true;
              }
              if (mat.metalness !== undefined) mat.metalness = Math.min(mat.metalness, 0.25);
              if (mat.roughness !== undefined) mat.roughness = Math.max(0.3, Math.min(mat.roughness, 0.85));
              mat.side = THREE.DoubleSide;
              mat.needsUpdate = true;
            }
          }
        }
      });
      return c;
    }, [scene]);

    content = asset.category === 'environment' ? (
      <primitive object={cloned} />
    ) : (
      <Center top>
        <primitive object={cloned} />
      </Center>
    );
  } else {
    content = (
      <mesh position={[0, 0.5, 0]}>
        <boxGeometry args={[0.8, 0.8, 0.8]} />
        <meshStandardMaterial color="#505050" roughness={0.4} metalness={0.2} />
      </mesh>
    );
  }

  const handleTransformEnd = () => {
    onDraggingChange(false);
    if (groupRef.current && onTransformChange) {
      const pos: [number, number, number] = [
        groupRef.current.position.x,
        groupRef.current.position.y,
        groupRef.current.position.z,
      ];
      const rot: [number, number, number] = [
        groupRef.current.rotation.x,
        groupRef.current.rotation.y,
        groupRef.current.rotation.z,
      ];
      const scl: [number, number, number] = [
        groupRef.current.scale.x,
        groupRef.current.scale.y,
        groupRef.current.scale.z,
      ];
      onTransformChange(asset.id, pos, rot, scl);
    }
  };

  return (
    <>
      <group
        ref={groupRef}
        position={position}
        rotation={rotation}
        scale={scale}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
      >
        {content}
        {isSelected && (
          <mesh position={[0, 0, 0]}>
            <ringGeometry args={[1.2, 1.25, 32]} />
            <meshBasicMaterial color="#00ffcc" side={THREE.DoubleSide} />
          </mesh>
        )}
      </group>

      {isSelected && groupRef.current && (
        <TransformControls
          object={groupRef.current}
          mode={transformMode}
          size={0.75}
          onMouseDown={() => onDraggingChange(true)}
          onMouseUp={handleTransformEnd}
        />
      )}
    </>
  );
};

const FallbackLoader = () => (
  <Html center>
    <div className="flex items-center gap-xs font-label-caps text-[11px] text-primary tracking-widest bg-surface-container/90 px-md py-sm border border-outline-variant/40 backdrop-blur-md whitespace-nowrap">
      <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>
      LOADING 3D SCENE...
    </div>
  </Html>
);

// 60 FPS Unreal Engine First-Person Flight & Camera Navigation Controller (Identical to RoomBake)
const UnrealCameraNavigation: React.FC<{
  enabled: boolean;
}> = ({ enabled }) => {
  const { camera, gl } = useThree();
  const keysDown = useRef<Set<string>>(new Set());
  const orbitRef = useRef({
    yaw: Math.PI,
    pitch: -0.15,
    dist: 0.01,
    target: new THREE.Vector3(0, 2.2, 6.5),
  });

  // Track pointer dragging for exact Unreal Look / Pan
  useEffect(() => {
    const canvas = gl.domElement;
    let dragging = false;
    let dragButton = 0;
    let lx = 0, ly = 0;

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!enabled) return;
      dragging = true;
      dragButton = e.button;
      lx = e.clientX;
      ly = e.clientY;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    };

    const onPointerUp = (e: PointerEvent) => {
      dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging || !enabled) return;
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;

      const orbit = orbitRef.current;
      const cp = Math.cos(orbit.pitch);
      const fwd = new THREE.Vector3(
        Math.sin(orbit.yaw) * cp,
        Math.sin(orbit.pitch),
        Math.cos(orbit.yaw) * cp
      ).normalize();
      const rgt = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();

      // Middle click (1) or Alt/Shift+Left Click = Unreal Pan
      if (dragButton === 1 || (dragButton === 0 && (e.altKey || e.shiftKey))) {
        const panSpeed = 0.005 * Math.max(0.5, orbit.dist);
        orbit.target.addScaledVector(rgt, -dx * panSpeed);
        orbit.target.y += dy * panSpeed;
      } else {
        // Left Click (0) or Right Click (2) = Unreal Free Fly Look (Rotates around camera's own eye!)
        orbit.yaw -= dx * 0.004;
        orbit.pitch -= dy * 0.004;
        orbit.pitch = Math.max(-1.55, Math.min(1.55, orbit.pitch));
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (!enabled) return;
      e.preventDefault();
      const orbit = orbitRef.current;
      const cp = Math.cos(orbit.pitch);
      const fwd = new THREE.Vector3(
        Math.sin(orbit.yaw) * cp,
        Math.sin(orbit.pitch),
        Math.cos(orbit.yaw) * cp
      ).normalize();
      orbit.target.addScaledVector(fwd, -Math.sign(e.deltaY) * 0.45);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!enabled) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'q', 'e', 'shift'].includes(k)) {
        keysDown.current.add(k);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      keysDown.current.delete(k);
    };

    const onBlur = () => {
      keysDown.current.clear();
      dragging = false;
    };

    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    return () => {
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      keysDown.current.clear();
    };
  }, [enabled, gl]);

  useFrame((_, delta) => {
    const orbit = orbitRef.current;

    if (enabled && keysDown.current.size > 0) {
      const isShift = keysDown.current.has('shift');
      const moveSpeed = (isShift ? 9.0 : 3.8) * delta;

      const cp = Math.cos(orbit.pitch);
      const fwd = new THREE.Vector3(
        Math.sin(orbit.yaw) * cp,
        Math.sin(orbit.pitch),
        Math.cos(orbit.yaw) * cp
      ).normalize();
      const rgt = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
      const up = new THREE.Vector3(0, 1, 0);

      if (keysDown.current.has('w')) orbit.target.addScaledVector(fwd, moveSpeed);
      if (keysDown.current.has('s')) orbit.target.addScaledVector(fwd, -moveSpeed);
      if (keysDown.current.has('d')) orbit.target.addScaledVector(rgt, moveSpeed);
      if (keysDown.current.has('a')) orbit.target.addScaledVector(rgt, -moveSpeed);
      if (keysDown.current.has('e')) orbit.target.addScaledVector(up, moveSpeed);
      if (keysDown.current.has('q')) orbit.target.addScaledVector(up, -moveSpeed);
    }

    // Apply exact camera position and orientation around eye
    const cp = Math.cos(orbit.pitch);
    const dir = new THREE.Vector3(
      Math.sin(orbit.yaw) * cp,
      Math.sin(orbit.pitch),
      Math.cos(orbit.yaw) * cp
    );
    camera.position.copy(orbit.target).addScaledVector(dir, orbit.dist);
    camera.lookAt(orbit.target.clone().addScaledVector(dir, orbit.dist + 1));
    camera.updateMatrixWorld(true);
  });

  return null;
};

export const ThreeStage: React.FC<ThreeStageProps> = ({
  assets,
  selectedAssetId,
  characters = [],
  selectedActorId = null,
  transformMode = 'translate',
  lightIntensity = 1.0,
  environmentPreset = 'studio',
  panoramaUrl,
  panoramaRotation = 0,
  showPanorama = true,
  splatUrl,
  onSelectAsset,
  onUpdateAssetTransform,
  onSelectActor,
  onUpdateActorTransform,
  currentTimelineTime = 0,
  isPlaying = false,
  showTrajectories = true,
  showGrid = true,
}) => {
  const [isTransformDragging, setIsTransformDragging] = useState(false);

  return (
    <div className="w-full h-full absolute inset-0 select-none overflow-hidden">
      <Canvas
        camera={{ position: [0, 2.5, 6.5], fov: 50, near: 0.1, far: 1000 }}
        gl={{
          antialias: true,
          alpha: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.0,
          outputColorSpace: THREE.SRGBColorSpace,
        }}
        onPointerMissed={() => {
          if (!isTransformDragging) {
            onSelectAsset?.(null);
            onSelectActor?.(null);
          }
        }}
      >
        <color attach="background" args={['#1c1c1e']} />

        {/* 3D Gaussian Splatting Walkable World Scene */}
        {splatUrl && (
          <GaussianSplatScene url={splatUrl} />
        )}

        {/* 360° Equirectangular Panorama Dome (Resilient) */}
        {panoramaUrl && showPanorama && (
          <PanoramaDome url={panoramaUrl} rotationY={panoramaRotation} />
        )}

        {/* Realistic Image-Based Environment Lighting (IBL) */}
        <Environment preset={environmentPreset} environmentIntensity={lightIntensity * 0.6} />

        {/* Balanced Ambient & Studio Lighting */}
        <ambientLight intensity={lightIntensity * 0.4} color="#ffffff" />
        <hemisphereLight
          args={['#ffffff', '#444448', lightIntensity * 0.35]}
          position={[0, 50, 0]}
        />
        
        {/* Main Directional Sun / Key Light */}
        <directionalLight
          position={[8, 14, 8]}
          intensity={lightIntensity * 1.0}
          color="#ffffff"
          castShadow
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
        />
        
        {/* Front Direct Camera Fill Light */}
        <directionalLight
          position={[0, 5, 8]}
          intensity={lightIntensity * 0.45}
          color="#ffffff"
        />

        {/* Soft Secondary Fill Light */}
        <directionalLight
          position={[-8, 6, -6]}
          intensity={lightIntensity * 0.35}
          color="#e0e8f0"
        />

        {/* Center Stage Point Light */}
        <pointLight position={[0, 6, 0]} intensity={lightIntensity * 0.25} distance={25} />

        {/* Realistic Ground Contact Shadows */}
        <ContactShadows
          position={[0, 0, 0]}
          opacity={0.65}
          scale={30}
          blur={1.8}
          far={10}
          resolution={512}
          color="#000000"
        />

        <Suspense fallback={<FallbackLoader />}>
          {/* Ground Grid Helper */}
          {showGrid && (
            <gridHelper
              args={[30, 30, '#8e8e93', '#48484a']}
              position={[0, 0.001, 0]}
            />
          )}

          {/* Render All Scene Assets with Transform Controls */}
          {assets.map((asset) => (
            <ModelErrorBoundary key={asset.id} fallbackName={asset.name}>
              <GLTFModel
                asset={asset}
                isSelected={asset.id === selectedAssetId}
                transformMode={transformMode}
                onSelect={() => {
                  onSelectActor?.(null);
                  onSelectAsset?.(asset.id);
                }}
                onDraggingChange={setIsTransformDragging}
                onTransformChange={onUpdateAssetTransform}
              />
            </ModelErrorBoundary>
          ))}

          {/* Render All Character Actors with Kimodo Kinematics & Trajectories */}
          {characters.map((actor) => (
            <CharacterActorModel
              key={actor.id}
              actor={actor}
              isSelected={actor.id === selectedActorId}
              transformMode={transformMode}
              currentTimelineTime={currentTimelineTime}
              isPlaying={isPlaying}
              showTrajectory={showTrajectories}
              onSelect={() => {
                onSelectAsset?.(null);
                onSelectActor?.(actor.id);
              }}
              onDraggingChange={setIsTransformDragging}
              onTransformChange={onUpdateActorTransform}
            />
          ))}

          {/* Default Demo Pedestal if empty */}
          {assets.length === 0 && characters.length === 0 && (
            <group position={[0, 0, 0]}>
              <mesh position={[0, 0.05, 0]}>
                <cylinderGeometry args={[1.5, 1.6, 0.1, 32]} />
                <meshStandardMaterial color="#2c2c2e" roughness={0.5} metalness={0.2} />
              </mesh>
            </group>
          )}
        </Suspense>

        {/* 60 FPS Continuous Unreal Engine Keyboard & Mouse Flight Controller (Exact RoomBake Camera) */}
        <UnrealCameraNavigation enabled={!isTransformDragging} />
      </Canvas>
    </div>
  );
};
