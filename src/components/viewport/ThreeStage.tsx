import React, { useRef, useState, useEffect, Suspense, Component, ReactNode } from 'react';
import { Canvas } from '@react-three/fiber';
import {
  OrbitControls,
  useGLTF,
  Center,
  Html,
  TransformControls,
  Environment,
  ContactShadows,
  Splat,
} from '@react-three/drei';
import * as THREE from 'three';
import { SceneAsset } from '../../types';

export type TransformMode = 'translate' | 'rotate' | 'scale';
export type LightingEnvironmentPreset = 'studio' | 'city' | 'sunset' | 'dawn' | 'park';

interface ThreeStageProps {
  assets: SceneAsset[];
  selectedAssetId: string | null;
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
            const mat = mesh.material as THREE.MeshStandardMaterial;
            if (mat.map) {
              mat.map.colorSpace = THREE.SRGBColorSpace;
              mat.map.needsUpdate = true;
            }
            if (mat.metalness !== undefined) mat.metalness = Math.min(mat.metalness, 0.35);
            if (mat.roughness !== undefined) mat.roughness = Math.max(0.3, Math.min(mat.roughness, 0.85));
            mat.needsUpdate = true;
          }
        }
      });
      return c;
    }, [scene]);

    content = (
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

export const ThreeStage: React.FC<ThreeStageProps> = ({
  assets,
  selectedAssetId,
  transformMode = 'translate',
  lightIntensity = 2.4,
  environmentPreset = 'studio',
  panoramaUrl,
  panoramaRotation = 0,
  showPanorama = true,
  splatUrl,
  onSelectAsset,
  onUpdateAssetTransform,
  showGrid = true,
}) => {
  const controlsRef = useRef<any>(null);
  const [isTransformDragging, setIsTransformDragging] = useState(false);

  return (
    <div className="w-full h-full absolute inset-0 select-none overflow-hidden">
      <Canvas
        camera={{ position: [0, 2.5, 6.5], fov: 50, near: 0.1, far: 1000 }}
        gl={{
          antialias: true,
          alpha: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: panoramaUrl && showPanorama ? 1.25 : 1.5,
          outputColorSpace: THREE.SRGBColorSpace,
        }}
        onPointerMissed={() => {
          if (!isTransformDragging) {
            onSelectAsset?.(null);
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
        <Environment preset={environmentPreset} environmentIntensity={lightIntensity * 0.7} />

        {/* High-Power Ambient & Studio Lighting */}
        <ambientLight intensity={lightIntensity * 1.1} color="#ffffff" />
        <hemisphereLight
          args={['#ffffff', '#7a7a80', lightIntensity * 0.9]}
          position={[0, 50, 0]}
        />
        
        {/* Main Directional Sun / Key Light */}
        <directionalLight
          position={[8, 14, 8]}
          intensity={lightIntensity * 1.3}
          color="#ffffff"
          castShadow
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
        />
        
        {/* Front Direct Camera Fill Light */}
        <directionalLight
          position={[0, 5, 8]}
          intensity={lightIntensity * 1.0}
          color="#ffffff"
        />

        {/* Soft Secondary Fill Light */}
        <directionalLight
          position={[-8, 6, -6]}
          intensity={lightIntensity * 0.7}
          color="#e0e8f0"
        />

        {/* Center Stage Point Light */}
        <pointLight position={[0, 6, 0]} intensity={lightIntensity * 0.8} distance={25} />

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
                onSelect={() => onSelectAsset?.(asset.id)}
                onDraggingChange={setIsTransformDragging}
                onTransformChange={onUpdateAssetTransform}
              />
            </ModelErrorBoundary>
          ))}

          {/* Default Demo Pedestal if empty */}
          {assets.length === 0 && (
            <group position={[0, 0, 0]}>
              <mesh position={[0, 0.05, 0]}>
                <cylinderGeometry args={[1.5, 1.6, 0.1, 32]} />
                <meshStandardMaterial color="#2c2c2e" roughness={0.5} metalness={0.2} />
              </mesh>
            </group>
          )}
        </Suspense>

        <OrbitControls
          ref={controlsRef}
          makeDefault
          enabled={!isTransformDragging}
          enableDamping
          dampingFactor={0.05}
          maxPolarAngle={Math.PI / 2 + 0.08}
          minDistance={0.5}
          maxDistance={80}
        />
      </Canvas>
    </div>
  );
};
