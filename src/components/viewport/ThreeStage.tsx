import React, { useRef, useState, useEffect, useCallback, Suspense, Component, ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  useGLTF,
  Center,
  TransformControls,
  Environment,
  ContactShadows,
  Splat,
} from '@react-three/drei';
import * as THREE from 'three';
import {
  SceneAsset,
  CharacterActor,
  CameraTake,
  CameraKeyframe,
  DeviceOrientationData,
  RemoteMoveData,
  CameraPoseData,
} from '../../types';
import { CharacterActorModel, ActorErrorBoundary } from './CharacterActorModel';
import { computeDeviceQuaternion } from '../../services/cameraRemoteService';

export type TransformMode = 'translate' | 'rotate' | 'scale';
export type LightingEnvironmentPreset = 'studio' | 'city' | 'sunset' | 'dawn' | 'park';

interface ThreeStageProps {
  isMobileViewfinder?: boolean;
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
  cameraFov?: number;
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
  isRecordingCamera?: boolean;
  onRecordCameraFrame?: (frame: CameraKeyframe) => void;
  isPlaybackTake?: boolean;
  playbackTake?: CameraTake | null;
  showCameraTrajectory?: boolean;
  onCanvasReady?: (canvas: HTMLCanvasElement) => void;
  remoteOrientation?: DeviceOrientationData | null;
  remoteOrientationRef?: React.MutableRefObject<DeviceOrientationData | null>;
  remoteMove?: RemoteMoveData | null;
  remoteMoveRef?: React.MutableRefObject<RemoteMoveData | null>;
  remoteLook?: { deltaPitch: number; deltaYaw: number } | null;
  remoteLookRef?: React.MutableRefObject<{ deltaPitch: number; deltaYaw: number } | null>;
  calibrateTrigger?: number;
  incomingCameraPose?: CameraPoseData | null;
  incomingCameraPoseRef?: React.MutableRefObject<CameraPoseData | null>;
  onCameraPose?: (pose: CameraPoseData) => void;
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
interface ModelErrorBoundaryProps {
  asset?: SceneAsset;
  fallbackName?: string;
  isSelected?: boolean;
  transformMode?: TransformMode;
  onSelect?: () => void;
  onDraggingChange?: (isDragging: boolean) => void;
  onTransformChange?: (
    id: string,
    position: [number, number, number],
    rotation: [number, number, number],
    scale: [number, number, number]
  ) => void;
  children: ReactNode;
}

class ModelErrorBoundary extends Component<
  ModelErrorBoundaryProps,
  { hasError: boolean; errorMsg?: string }
> {
  private groupRef = React.createRef<THREE.Group>();

  constructor(props: ModelErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, errorMsg: error?.message || 'Failed to load 3D model' };
  }

  componentDidCatch(error: any) {
    console.warn('Model loading fallback triggered for:', this.props.asset?.name || this.props.fallbackName, error);
  }

  handleTransformEnd = () => {
    this.props.onDraggingChange?.(false);
    if (this.groupRef.current && this.props.onTransformChange && this.props.asset) {
      const pos: [number, number, number] = [
        this.groupRef.current.position.x,
        this.groupRef.current.position.y,
        this.groupRef.current.position.z,
      ];
      const rot: [number, number, number] = [
        this.groupRef.current.rotation.x,
        this.groupRef.current.rotation.y,
        this.groupRef.current.rotation.z,
      ];
      const scl: [number, number, number] = [
        this.groupRef.current.scale.x,
        this.groupRef.current.scale.y,
        this.groupRef.current.scale.z,
      ];
      this.props.onTransformChange(this.props.asset.id, pos, rot, scl);
    }
  };

  render() {
    if (this.state.hasError) {
      const {
        asset,
        isSelected = false,
        transformMode = 'translate',
        onSelect,
        onDraggingChange,
        fallbackName,
      } = this.props;

      const displayName = asset?.name || fallbackName || 'Scene Object';
      const isRoomOrEnv =
        asset?.category === 'environment' ||
        displayName.toLowerCase().includes('room') ||
        (asset?.id && asset.id.startsWith('roombake_'));

      const pos = asset?.position || [0, 0, 0];
      const rot = asset?.rotation || [0, 0, 0];
      const scl = asset?.scale || [1, 1, 1];

      return (
        <>
          <group
            ref={this.groupRef}
            position={pos}
            rotation={rot}
            scale={scl}
            onClick={(e) => {
              e.stopPropagation();
              onSelect?.();
            }}
          >
            {isRoomOrEnv ? (
              // Procedural Studio Room Enclosure so the stage is always visible
              <group>
                {/* Floor */}
                <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
                  <planeGeometry args={[8, 8]} />
                  <meshStandardMaterial color="#16181c" roughness={0.5} metalness={0.2} side={THREE.DoubleSide} />
                </mesh>
                {/* Back wall */}
                <mesh position={[0, 1.75, -4]} receiveShadow>
                  <planeGeometry args={[8, 3.5]} />
                  <meshStandardMaterial color="#22252a" roughness={0.85} side={THREE.DoubleSide} />
                </mesh>
                {/* Left wall */}
                <mesh position={[-4, 1.75, 0]} rotation={[0, Math.PI / 2, 0]} receiveShadow>
                  <planeGeometry args={[8, 3.5]} />
                  <meshStandardMaterial color="#1f2227" roughness={0.85} side={THREE.DoubleSide} />
                </mesh>
                {/* Right wall */}
                <mesh position={[4, 1.75, 0]} rotation={[0, -Math.PI / 2, 0]} receiveShadow>
                  <planeGeometry args={[8, 3.5]} />
                  <meshStandardMaterial color="#1f2227" roughness={0.85} side={THREE.DoubleSide} />
                </mesh>
                {/* Ceiling */}
                <mesh position={[0, 3.5, 0]} rotation={[Math.PI / 2, 0, 0]}>
                  <planeGeometry args={[8, 8]} />
                  <meshStandardMaterial color="#14161a" roughness={0.9} side={THREE.DoubleSide} />
                </mesh>
              </group>
            ) : (
              <mesh position={[0, 0.5, 0]}>
                <boxGeometry args={[1, 1, 1]} />
                <meshStandardMaterial
                  color={isSelected ? '#00ffcc' : '#f59e0b'}
                  wireframe
                />
              </mesh>
            )}

            {/* Selection highlight ring */}
            {isSelected && (
              <mesh position={[0, 0.01, 0]}>
                <ringGeometry args={[isRoomOrEnv ? 4.2 : 1.2, isRoomOrEnv ? 4.25 : 1.25, 32]} />
                <meshBasicMaterial color="#00ffcc" side={THREE.DoubleSide} />
              </mesh>
            )}
          </group>

          {isSelected && this.groupRef.current && (
            <TransformControls
              object={this.groupRef.current}
              mode={transformMode}
              size={0.75}
              onMouseDown={() => onDraggingChange?.(true)}
              onMouseUp={this.handleTransformEnd}
            />
          )}
        </>
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

  // Resolve expired blob URLs or baked room models to permanent asset storage
  const resolvedGlbUrl = React.useMemo(() => {
    if (
      glbUrl &&
      glbUrl.startsWith('blob:') &&
      (asset.id.startsWith('roombake_') || asset.category === 'environment' || asset.name.toLowerCase().includes('room'))
    ) {
      return '/api/assets/baked_room_studio.glb';
    }
    return glbUrl;
  }, [glbUrl, asset.id, asset.category, asset.name]);

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
    resolvedGlbUrl &&
    (resolvedGlbUrl.includes('.glb') ||
      resolvedGlbUrl.includes('.gltf') ||
      resolvedGlbUrl.includes('/file=') ||
      resolvedGlbUrl.includes('gradio_api') ||
      resolvedGlbUrl.startsWith('/api/assets') ||
      resolvedGlbUrl.startsWith('blob:') ||
      resolvedGlbUrl.startsWith('http://') ||
      resolvedGlbUrl.startsWith('https://'));

  let content: ReactNode;
  if (isCustomModel) {
    const { scene } = useGLTF(resolvedGlbUrl);
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

// 60 FPS Unreal Engine First-Person Flight & Camera Navigation Controller with Mobile Gyro Integration
const UnrealCameraNavigation: React.FC<{
  enabled: boolean;
  remoteOrientation?: DeviceOrientationData | null;
  remoteOrientationRef?: React.MutableRefObject<DeviceOrientationData | null>;
  remoteMove?: RemoteMoveData | null;
  remoteMoveRef?: React.MutableRefObject<RemoteMoveData | null>;
  remoteLook?: { deltaPitch: number; deltaYaw: number } | null;
  remoteLookRef?: React.MutableRefObject<{ deltaPitch: number; deltaYaw: number } | null>;
  calibrateTrigger?: number;
  incomingCameraPose?: CameraPoseData | null;
  incomingCameraPoseRef?: React.MutableRefObject<CameraPoseData | null>;
  onCameraPose?: (pose: CameraPoseData) => void;
}> = ({
  enabled,
  remoteOrientation,
  remoteOrientationRef,
  remoteMove,
  remoteMoveRef,
  remoteLook,
  remoteLookRef,
  calibrateTrigger,
  incomingCameraPose,
  incomingCameraPoseRef,
  onCameraPose,
}) => {
  const { camera, gl } = useThree();
  const keysDown = useRef<Set<string>>(new Set());
  const orbitRef = useRef({
    yaw: Math.PI,
    pitch: -0.15,
    dist: 0.01,
    target: new THREE.Vector3(0, 2.2, 6.5),
  });

  // Mobile Gyroscope Device Orientation Tracking & Heading Alignment
  const alignYawOffsetRef = useRef<number>(0);
  const alignPitchOffsetRef = useRef<number>(0);
  const isCalibratedRef = useRef<boolean>(false);
  const targetCamQuatRef = useRef<THREE.Quaternion | null>(null);

  // Calibration routine: aligns phone forward direction with virtual camera line-of-sight
  const lastCalibrateRef = useRef<number | undefined>(calibrateTrigger);
  const calibrateOrientation = useCallback((devQ?: THREE.Quaternion) => {
    let q = devQ;
    const activeOrient = remoteOrientationRef?.current || remoteOrientation;
    if (!q && activeOrient) {
      q = computeDeviceQuaternion(
        activeOrient.alpha,
        activeOrient.beta,
        activeOrient.gamma,
        activeOrient.screenOrientation ?? 90
      );
    }
    if (q) {
      // 1. Physical forward vector of the device in room space:
      const fwdRoom = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      // 2. Physical room heading (yaw angle around vertical Y axis):
      const roomYaw = Math.atan2(fwdRoom.x, fwdRoom.z);
      // 3. Desired camera yaw in virtual studio (facing stage actors along -Z):
      const targetYaw = Math.PI;
      // 4. Align offset:
      alignYawOffsetRef.current = targetYaw - roomYaw;
      alignPitchOffsetRef.current = 0;
      orbitRef.current.yaw = targetYaw;
      orbitRef.current.pitch = -0.15;
      isCalibratedRef.current = true;
    }
  }, [remoteOrientation, remoteOrientationRef]);

  useEffect(() => {
    if (calibrateTrigger !== undefined && calibrateTrigger !== lastCalibrateRef.current) {
      lastCalibrateRef.current = calibrateTrigger;
      calibrateOrientation();
    }
  }, [calibrateTrigger, calibrateOrientation]);

  // Update target quaternion whenever new remoteOrientation packet arrives (prop-based fallback)
  useEffect(() => {
    if (remoteOrientationRef) return; // Computed per-frame in useFrame if ref provided
    if (!remoteOrientation) {
      targetCamQuatRef.current = null;
      isCalibratedRef.current = false;
      return;
    }

    const currentDevQ = computeDeviceQuaternion(
      remoteOrientation.alpha,
      remoteOrientation.beta,
      remoteOrientation.gamma,
      remoteOrientation.screenOrientation ?? 90
    );

    if (!isCalibratedRef.current) {
      calibrateOrientation(currentDevQ);
    }

    // 1. Pure vertical heading alignment around world Y (preserves true gravity & pitch):
    const qYawAlign = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      alignYawOffsetRef.current
    );
    const alignedQ = qYawAlign.multiply(currentDevQ);

    // 2. Apply fine touch pitch offset around camera horizontal right axis if swiped:
    if (Math.abs(alignPitchOffsetRef.current) > 0.001) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(alignedQ);
      const rgt = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
      const qPitchAlign = new THREE.Quaternion().setFromAxisAngle(rgt, alignPitchOffsetRef.current);
      targetCamQuatRef.current = qPitchAlign.multiply(alignedQ);
    } else {
      targetCamQuatRef.current = alignedQ;
    }
  }, [remoteOrientation, calibrateOrientation, remoteOrientationRef]);

  // Handle mobile fine touch look deltas (pan & tilt swipe adjustments)
  useEffect(() => {
    if (!remoteLook) return;
    const orbit = orbitRef.current;
    orbit.yaw -= remoteLook.deltaYaw;
    orbit.pitch -= remoteLook.deltaPitch;
    orbit.pitch = Math.max(-1.55, Math.min(1.55, orbit.pitch));

    // Seamlessly update gyro offsets so orientation tracking maintains the swipe adjustment:
    alignYawOffsetRef.current -= remoteLook.deltaYaw;
    alignPitchOffsetRef.current -= remoteLook.deltaPitch;
    alignPitchOffsetRef.current = Math.max(-1.4, Math.min(1.4, alignPitchOffsetRef.current));
  }, [remoteLook]);

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

        alignYawOffsetRef.current -= dx * 0.004;
        alignPitchOffsetRef.current -= dy * 0.004;
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

  // When re-enabling navigation (e.g. exiting take playback), sync orbit target with current camera
  const wasEnabledRef = useRef(enabled);
  useEffect(() => {
    if (enabled && !wasEnabledRef.current) {
      const fwd = new THREE.Vector3();
      camera.getWorldDirection(fwd);
      orbitRef.current.target.copy(camera.position);
      orbitRef.current.pitch = Math.asin(Math.max(-0.99, Math.min(0.99, fwd.y)));
      orbitRef.current.yaw = Math.atan2(fwd.x, fwd.z);
    }
    wasEnabledRef.current = enabled;
  }, [enabled, camera]);

  useFrame((_, delta) => {
    if (!enabled) return;
    const orbit = orbitRef.current;

    // Direct incoming camera pose mirror (e.g. Host mirroring Remote)
    const activeIncomingPose = incomingCameraPoseRef?.current || incomingCameraPose;
    const hasActiveGyro = Boolean((remoteOrientationRef && remoteOrientationRef.current) || remoteOrientation);

    if (activeIncomingPose) {
      orbit.target.set(
        activeIncomingPose.position[0],
        activeIncomingPose.position[1],
        activeIncomingPose.position[2]
      );
      if (!hasActiveGyro) {
        camera.position.set(
          activeIncomingPose.position[0],
          activeIncomingPose.position[1],
          activeIncomingPose.position[2]
        );
        camera.quaternion.set(
          activeIncomingPose.quaternion[0],
          activeIncomingPose.quaternion[1],
          activeIncomingPose.quaternion[2],
          activeIncomingPose.quaternion[3]
        );
        camera.updateMatrixWorld(true);
        const fwd = new THREE.Vector3();
        camera.getWorldDirection(fwd);
        orbit.pitch = Math.asin(Math.max(-0.99, Math.min(0.99, fwd.y)));
        orbit.yaw = Math.atan2(fwd.x, fwd.z);
        return;
      }
    }

    // Desktop Keyboard Flight Controls
    if (keysDown.current.size > 0) {
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

    // Mobile Virtual Joystick Move Controls (Dolly / Truck / Pedestal)
    const activeMove = remoteMoveRef?.current || remoteMove;
    if (activeMove && (activeMove.moveX !== 0 || activeMove.moveZ !== 0 || activeMove.moveY !== 0)) {
      const speed = 4.5 * delta;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      fwd.y = 0;
      if (fwd.lengthSq() > 0.001) fwd.normalize();
      const rgt = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
      const up = new THREE.Vector3(0, 1, 0);

      orbit.target.addScaledVector(rgt, activeMove.moveX * speed);
      orbit.target.addScaledVector(fwd, activeMove.moveZ * speed);
      orbit.target.addScaledVector(up, (activeMove.moveY || 0) * speed);
    }

    // Mobile Fine Touch Look Swipe Adjustments (from ref if available)
    if (remoteLookRef && remoteLookRef.current) {
      const lk = remoteLookRef.current;
      if (lk.deltaPitch !== 0 || lk.deltaYaw !== 0) {
        orbit.yaw -= lk.deltaYaw;
        orbit.pitch -= lk.deltaPitch;
        orbit.pitch = Math.max(-1.55, Math.min(1.55, orbit.pitch));
        alignYawOffsetRef.current -= lk.deltaYaw;
        alignPitchOffsetRef.current -= lk.deltaPitch;
        alignPitchOffsetRef.current = Math.max(-1.4, Math.min(1.4, alignPitchOffsetRef.current));
      }
      remoteLookRef.current = null;
    }

    // Mobile Gyroscope Tracking: compute directly in useFrame if ref provided
    if (remoteOrientationRef && remoteOrientationRef.current) {
      const orient = remoteOrientationRef.current;
      const currentDevQ = computeDeviceQuaternion(
        orient.alpha,
        orient.beta,
        orient.gamma,
        orient.screenOrientation ?? 90
      );

      if (!isCalibratedRef.current) {
        calibrateOrientation(currentDevQ);
      }

      const qYawAlign = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        alignYawOffsetRef.current
      );
      const alignedQ = qYawAlign.multiply(currentDevQ);

      if (Math.abs(alignPitchOffsetRef.current) > 0.001) {
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(alignedQ);
        const rgt = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
        const qPitchAlign = new THREE.Quaternion().setFromAxisAngle(rgt, alignPitchOffsetRef.current);
        targetCamQuatRef.current = qPitchAlign.multiply(alignedQ);
      } else {
        targetCamQuatRef.current = alignedQ;
      }
    } else if (remoteOrientationRef && !remoteOrientationRef.current && !remoteOrientation) {
      targetCamQuatRef.current = null;
      isCalibratedRef.current = false;
    }

    // Mobile Gyroscope Tracking or Orbit Look Update
    if (targetCamQuatRef.current) {
      camera.quaternion.slerp(targetCamQuatRef.current, Math.min(1.0, delta * 35.0));
      camera.position.copy(orbit.target);
      camera.updateMatrixWorld(true);

      const fwd = new THREE.Vector3();
      camera.getWorldDirection(fwd);
      orbit.pitch = Math.asin(Math.max(-0.99, Math.min(0.99, fwd.y)));
      orbit.yaw = Math.atan2(fwd.x, fwd.z);
    } else {
      const cp = Math.cos(orbit.pitch);
      const dir = new THREE.Vector3(
        Math.sin(orbit.yaw) * cp,
        Math.sin(orbit.pitch),
        Math.cos(orbit.yaw) * cp
      );
      camera.position.copy(orbit.target).addScaledVector(dir, orbit.dist);
      camera.lookAt(orbit.target.clone().addScaledVector(dir, orbit.dist + 1));
      camera.updateMatrixWorld(true);
    }

    // Broadcast Camera Pose if onCameraPose callback is provided
    if (onCameraPose) {
      const p = camera.position;
      const q = camera.quaternion;
      const pCam = camera as THREE.PerspectiveCamera;
      onCameraPose({
        position: [p.x, p.y, p.z],
        quaternion: [q.x, q.y, q.z, q.w],
        fov: pCam.fov,
      });
    }
  });

  return null;
};

// Cached scratch objects to avoid GC allocation during 60 FPS animation frames
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();

// 60 FPS Camera Trajectory Playback Driver
const CameraPlaybackDriver: React.FC<{
  take: CameraTake;
  currentTime: number;
}> = ({ take, currentTime }) => {
  const { camera } = useThree();

  useFrame(() => {
    const kfs = take.keyframes;
    if (!kfs || kfs.length === 0) return;

    const pCam = camera as THREE.PerspectiveCamera;

    if (currentTime <= kfs[0].time) {
      const k0 = kfs[0];
      camera.position.set(k0.position[0], k0.position[1], k0.position[2]);
      camera.quaternion.set(k0.quaternion[0], k0.quaternion[1], k0.quaternion[2], k0.quaternion[3]);
      if (k0.fov && pCam.isPerspectiveCamera && Math.abs(pCam.fov - k0.fov) > 0.1) {
        pCam.fov = k0.fov;
        pCam.updateProjectionMatrix();
      }
      camera.updateMatrixWorld(true);
      return;
    }

    const lastIdx = kfs.length - 1;
    if (currentTime >= kfs[lastIdx].time) {
      const kn = kfs[lastIdx];
      camera.position.set(kn.position[0], kn.position[1], kn.position[2]);
      camera.quaternion.set(kn.quaternion[0], kn.quaternion[1], kn.quaternion[2], kn.quaternion[3]);
      if (kn.fov && pCam.isPerspectiveCamera && Math.abs(pCam.fov - kn.fov) > 0.1) {
        pCam.fov = kn.fov;
        pCam.updateProjectionMatrix();
      }
      camera.updateMatrixWorld(true);
      return;
    }

    // Binary search to find keyframe bracket [idx0, idx1]
    let low = 0;
    let high = lastIdx;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (kfs[mid].time <= currentTime) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const idx0 = Math.max(0, high);
    const idx1 = Math.min(lastIdx, idx0 + 1);
    const k0 = kfs[idx0];
    const k1 = kfs[idx1];

    const dt = k1.time - k0.time;
    const alpha = dt > 0.0001 ? Math.max(0, Math.min(1, (currentTime - k0.time) / dt)) : 0;

    _p0.set(k0.position[0], k0.position[1], k0.position[2]);
    _p1.set(k1.position[0], k1.position[1], k1.position[2]);
    camera.position.copy(_p0).lerp(_p1, alpha);

    _q0.set(k0.quaternion[0], k0.quaternion[1], k0.quaternion[2], k0.quaternion[3]);
    _q1.set(k1.quaternion[0], k1.quaternion[1], k1.quaternion[2], k1.quaternion[3]);
    camera.quaternion.copy(_q0).slerp(_q1, alpha);

    if (k0.fov && k1.fov && pCam.isPerspectiveCamera) {
      const targetFov = THREE.MathUtils.lerp(k0.fov, k1.fov, alpha);
      if (Math.abs(pCam.fov - targetFov) > 0.1) {
        pCam.fov = targetFov;
        pCam.updateProjectionMatrix();
      }
    }

    camera.updateMatrixWorld(true);
  });

  return null;
};

// Continuous Camera Keyframe Recorder (Samples at ~60 FPS)
const CameraRecorder: React.FC<{
  isRecording: boolean;
  currentTime: number;
  onRecordFrame?: (frame: CameraKeyframe) => void;
}> = ({ isRecording, currentTime, onRecordFrame }) => {
  const { camera } = useThree();
  const lastRecordedTimeRef = useRef<number>(-1);

  useFrame(() => {
    if (!isRecording || !onRecordFrame) return;

    // Sample camera keyframe at ~60 FPS (at least 12ms apart)
    if (lastRecordedTimeRef.current >= 0 && Math.abs(currentTime - lastRecordedTimeRef.current) < 0.012) {
      return;
    }
    lastRecordedTimeRef.current = currentTime;

    const pCam = camera as THREE.PerspectiveCamera;
    const frame: CameraKeyframe = {
      time: Math.max(0, currentTime),
      position: [camera.position.x, camera.position.y, camera.position.z],
      quaternion: [camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w],
      fov: pCam.isPerspectiveCamera ? pCam.fov : 50,
    };
    onRecordFrame(frame);
  });

  useEffect(() => {
    if (!isRecording) {
      lastRecordedTimeRef.current = -1;
    }
  }, [isRecording]);

  return null;
};

// Holographic 3D Trajectory Ribbon for Recorded Camera Path
const CameraTrajectoryVisualizer: React.FC<{
  take: CameraTake | null | undefined;
}> = ({ take }) => {
  const lineObj = React.useMemo(() => {
    if (!take || !take.keyframes || take.keyframes.length < 2) return null;
    const points = take.keyframes.map((k) => new THREE.Vector3(k.position[0], k.position[1], k.position[2]));
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: 0x00ffcc,
      linewidth: 2,
      transparent: true,
      opacity: 0.65,
    });
    return new THREE.Line(geometry, material);
  }, [take]);

  if (!lineObj) return null;
  return <primitive object={lineObj} />;
};

// Dynamic Camera FOV Controller for Virtual Lenses
const CameraFovUpdater: React.FC<{ fov?: number }> = ({ fov }) => {
  const { camera } = useThree();
  useEffect(() => {
    if (fov && (camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const pCam = camera as THREE.PerspectiveCamera;
      if (Math.abs(pCam.fov - fov) > 0.1) {
        pCam.fov = fov;
        pCam.updateProjectionMatrix();
      }
    }
  }, [fov, camera]);
  return null;
};

// Canvas Publisher Component to share the WebGL DOM element for video capture
const CanvasPublisher: React.FC<{ onCanvasReady?: (canvas: HTMLCanvasElement) => void }> = ({ onCanvasReady }) => {
  const { gl } = useThree();
  useEffect(() => {
    onCanvasReady?.(gl.domElement);
  }, [gl, onCanvasReady]);
  return null;
};

export const ThreeStage: React.FC<ThreeStageProps> = ({
  isMobileViewfinder = false,
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
  cameraFov,
  onSelectAsset,
  onUpdateAssetTransform,
  onSelectActor,
  onUpdateActorTransform,
  currentTimelineTime = 0,
  isPlaying = false,
  showTrajectories = true,
  showGrid = true,
  isRecordingCamera = false,
  onRecordCameraFrame,
  isPlaybackTake = false,
  playbackTake = null,
  showCameraTrajectory = true,
  onCanvasReady,
  remoteOrientation = null,
  remoteOrientationRef,
  remoteMove = null,
  remoteMoveRef,
  remoteLook = null,
  remoteLookRef,
  calibrateTrigger = 0,
  incomingCameraPose = null,
  incomingCameraPoseRef,
  onCameraPose,
}) => {
  const [isTransformDragging, setIsTransformDragging] = useState(false);

  return (
    <div className="w-full h-full absolute inset-0 select-none overflow-hidden">
      <Canvas
        camera={{ position: [0, 2.5, 6.5], fov: cameraFov || 50, near: 0.1, far: 1000 }}
        dpr={isMobileViewfinder ? [1, 1.25] : [1, 2]}
        shadows={!isMobileViewfinder}
        gl={{
          antialias: !isMobileViewfinder,
          alpha: true,
          preserveDrawingBuffer: !isMobileViewfinder,
          powerPreference: 'high-performance',
          precision: isMobileViewfinder ? 'mediump' : 'highp',
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
        <CanvasPublisher onCanvasReady={onCanvasReady} />
        <CameraFovUpdater fov={cameraFov} />
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
        <Suspense fallback={null}>
          <Environment preset={environmentPreset} environmentIntensity={lightIntensity * 0.6} />
        </Suspense>

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
          castShadow={!isMobileViewfinder}
          shadow-mapSize-width={isMobileViewfinder ? 512 : 2048}
          shadow-mapSize-height={isMobileViewfinder ? 512 : 2048}
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
        {!isMobileViewfinder && (
          <ContactShadows
            position={[0, 0, 0]}
            opacity={0.65}
            scale={30}
            blur={1.8}
            far={10}
            resolution={512}
            color="#000000"
          />
        )}

        {/* Permanent Studio Ground Stage Floor & Grid (Always Visible Instantly) */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.005, 0]} receiveShadow={!isMobileViewfinder}>
          <circleGeometry args={[25, isMobileViewfinder ? 32 : 64]} />
          <meshStandardMaterial color="#14161a" roughness={0.75} metalness={0.15} />
        </mesh>

        {showGrid && (
          <gridHelper
            args={[30, 30, '#8e8e93', '#33353b']}
            position={[0, 0.001, 0]}
          />
        )}

        {/* Render All Scene Assets with Individual Suspense Boundaries */}
        {assets.map((asset) => (
          <ModelErrorBoundary
            key={asset.id}
            asset={asset}
            isSelected={asset.id === selectedAssetId}
            transformMode={transformMode}
            onSelect={() => {
              onSelectActor?.(null);
              onSelectAsset?.(asset.id);
            }}
            onDraggingChange={setIsTransformDragging}
            onTransformChange={onUpdateAssetTransform}
          >
            <Suspense fallback={null}>
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
            </Suspense>
          </ModelErrorBoundary>
        ))}

        {/* Render All Character Actors with Kimodo Kinematics & Trajectories */}
        {characters.map((actor) => (
          <ActorErrorBoundary key={actor.id} actor={actor}>
            <Suspense fallback={null}>
              <CharacterActorModel
                actor={actor}
                allActors={characters}
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
            </Suspense>
          </ActorErrorBoundary>
        ))}

          {/* 3D Visualizers for Active Constraints (Waypoints & Look-At Targets) */}
          {characters.map((actor) => {
            if (!actor.constraints) return null;
            return actor.constraints.map((c) => {
              if (!c.enabled) return null;
              const isActive = currentTimelineTime >= c.startTime && currentTimelineTime <= c.endTime;

              return (
                <group key={`${actor.id}_${c.id}`}>
                  {/* Destination Waypoint Ring on Floor */}
                  {c.type === 'destination' && c.destination && (
                    <group position={[c.destination.position[0], 0.02, c.destination.position[2]]}>
                      <mesh rotation={[-Math.PI / 2, 0, 0]}>
                        <ringGeometry args={[0.35, 0.42, 32]} />
                        <meshBasicMaterial
                          color={isActive ? '#af52de' : '#6b3096'}
                          transparent
                          opacity={isActive ? 0.9 : 0.4}
                          side={THREE.DoubleSide}
                        />
                      </mesh>
                      <mesh rotation={[-Math.PI / 2, 0, 0]}>
                        <circleGeometry args={[0.15, 24]} />
                        <meshBasicMaterial
                          color={isActive ? '#af52de' : '#6b3096'}
                          transparent
                          opacity={isActive ? 0.7 : 0.25}
                          side={THREE.DoubleSide}
                        />
                      </mesh>
                    </group>
                  )}

                  {/* Look-At Target 3D Point */}
                  {c.type === 'look_at' && c.lookAt?.targetType === 'point' && c.lookAt.targetPoint && (
                    <group position={c.lookAt.targetPoint}>
                      <mesh>
                        <sphereGeometry args={[0.08, 16, 16]} />
                        <meshBasicMaterial color={isActive ? '#00ffcc' : '#007a66'} wireframe={!isActive} />
                      </mesh>
                    </group>
                  )}
                </group>
              );
            });
          })}

          {/* Default Demo Pedestal if empty */}
          {assets.length === 0 && characters.length === 0 && (
            <group position={[0, 0, 0]}>
              <mesh position={[0, 0.05, 0]}>
                <cylinderGeometry args={[1.5, 1.6, 0.1, 32]} />
                <meshStandardMaterial color="#2c2c2e" roughness={0.5} metalness={0.2} />
              </mesh>
            </group>
          )}

        {/* Continuous Camera Keyframe Recorder */}
        <CameraRecorder
          isRecording={isRecordingCamera}
          currentTime={currentTimelineTime}
          onRecordFrame={onRecordCameraFrame}
        />

        {/* Camera Playback Driver (Smoothly animates camera during take review) */}
        {isPlaybackTake && playbackTake && (
          <CameraPlaybackDriver take={playbackTake} currentTime={currentTimelineTime} />
        )}

        {/* Holographic 3D Camera Trajectory Ribbon */}
        {showCameraTrajectory && playbackTake && (
          <CameraTrajectoryVisualizer take={playbackTake} />
        )}

        {/* 60 FPS Continuous Unreal Engine Keyboard & Mouse Flight Controller with Mobile Gyro Integration */}
        <UnrealCameraNavigation
          enabled={!isTransformDragging && !isPlaybackTake}
          remoteOrientation={remoteOrientation}
          remoteOrientationRef={remoteOrientationRef}
          remoteMove={remoteMove}
          remoteMoveRef={remoteMoveRef}
          remoteLook={remoteLook}
          remoteLookRef={remoteLookRef}
          calibrateTrigger={calibrateTrigger}
          incomingCameraPose={incomingCameraPose}
          incomingCameraPoseRef={incomingCameraPoseRef}
          onCameraPose={onCameraPose}
        />
      </Canvas>
    </div>
  );
};
