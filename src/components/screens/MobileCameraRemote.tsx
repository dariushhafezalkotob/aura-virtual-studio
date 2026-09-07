import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { CameraRemoteSocket } from '../../services/cameraRemoteService';
import { CameraRemoteState, Project, CharacterActor, CameraPoseData, DeviceOrientationData, RemoteMoveData } from '../../types';
import { ThreeStage } from '../viewport/ThreeStage';
import { DEFAULT_INITIAL_ACTORS } from './ActingSetupView';

const LENS_FOV_MAP: Record<string, number> = {
  '24mm': 74,
  '35mm': 54,
  '50mm': 40,
  '85mm': 24,
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms}`;
}

interface MobileCameraRemoteProps {
  initialProject?: Project | null;
}

export const MobileCameraRemote: React.FC<MobileCameraRemoteProps> = ({ initialProject }) => {
  // 1. URL Query Extraction
  const [roomId, setRoomId] = useState<string>('default');
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash;
    const search = window.location.search;
    const urlParams = new URLSearchParams(search || (hash.includes('?') ? hash.split('?')[1] : ''));
    const r = urlParams.get('room');
    const p = urlParams.get('project');
    if (r) setRoomId(r);
    if (p) setProjectId(p);
  }, []);

  // 2. Project & Scene Data (Loaded from prop, WebSocket init_scene, or /api/projects)
  const [project, setProject] = useState<Project | null>(initialProject || null);

  useEffect(() => {
    if (project) return;
    fetch('/api/projects')
      .then((res) => res.json())
      .then((data) => {
        const projs: Project[] = Array.isArray(data) ? data : data?.projects || [];
        if (projs.length > 0) {
          const match = projectId ? projs.find((p) => p.id === projectId) : null;
          setProject(match || projs[0]);
        }
      })
      .catch(() => {});
  }, [project, projectId]);

  // Synchronize actors from project or default initial actors
  const characters: CharacterActor[] = useMemo(() => {
    if (project?.characters && project.characters.length > 0) {
      return project.characters;
    }
    return DEFAULT_INITIAL_ACTORS;
  }, [project]);

  // 3. Landscape Orientation Check
  const [isLandscape, setIsLandscape] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth >= window.innerHeight;
    }
    return true;
  });

  useEffect(() => {
    const checkOrientation = () => {
      setIsLandscape(window.innerWidth >= window.innerHeight);
    };
    window.addEventListener('resize', checkOrientation);
    window.addEventListener('orientationchange', checkOrientation);
    return () => {
      window.removeEventListener('resize', checkOrientation);
      window.removeEventListener('orientationchange', checkOrientation);
    };
  }, []);

  // 4. WebSocket Connection
  const socketRef = useRef<CameraRemoteSocket | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [peerCount, setPeerCount] = useState<number>(0);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Host state mirrored
  const [hostState, setHostState] = useState<CameraRemoteState>({
    isRecording: false,
    isPlaying: false,
    timelineSec: 0,
    effectiveDuration: 5.0,
    focalLength: '35mm',
  });

  // Gyroscope tracking state
  const [hasGyroPermission, setHasGyroPermission] = useState<boolean>(false);
  const [gyroActive, setGyroActive] = useState<boolean>(false);
  const [gyroStatusText, setGyroStatusText] = useState<string>('Touch Drag / Gyro Standby');
  const [currentAngles, setCurrentAngles] = useState<DeviceOrientationData | null>(null);
  const [calibrateTrigger, setCalibrateTrigger] = useState<number>(0);

  // Touch Move / Joystick state
  const [activeMove, setActiveMove] = useState<RemoteMoveData | null>(null);
  const [activeLook, setActiveLook] = useState<{ deltaPitch: number; deltaYaw: number } | null>(null);

  // Initialize WebSocket
  useEffect(() => {
    if (!roomId) return;
    const socket = new CameraRemoteSocket('remote', roomId);
    socketRef.current = socket;

    const unsubStatus = socket.onStatus((connected, count) => {
      setIsConnected(connected);
      setPeerCount(count);
      if (connected) {
        socket.send({ type: 'request_scene' } as any);
      }
    });

    const unsubMsg = socket.onMessage((msg) => {
      if (msg.type === 'init_scene') {
        if (msg.project) {
          setProject(msg.project);
        }
      } else if (msg.type === 'host_state') {
        setHostState(msg.state);
      }
    });

    return () => {
      unsubStatus();
      unsubMsg();
      socket.destroy();
      socketRef.current = null;
    };
  }, [roomId]);

  // 5. Gyroscope Permission & Multi-Sensor Listener (deviceorientation + devicemotion)
  const hasRealOrientationRef = useRef<boolean>(false);

  const requestGyroPermission = async () => {
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof (DeviceOrientationEvent as any).requestPermission === 'function'
    ) {
      try {
        setGyroStatusText('Requesting sensor permission...');
        const response = await (DeviceOrientationEvent as any).requestPermission();
        if (response === 'granted') {
          setHasGyroPermission(true);
          setGyroActive(true);
          setGyroStatusText('Gyro Active');
          setToastMessage('✅ Gyroscope Active! Tilt phone to aim camera.');
          setTimeout(() => setToastMessage(null), 3000);
        } else {
          setHasGyroPermission(true);
          setGyroActive(true);
          setGyroStatusText('Swipe / Tilt Active');
          setToastMessage('💡 Swipe right side of screen to pan & tilt camera.');
          setTimeout(() => setToastMessage(null), 3500);
        }
      } catch (err: any) {
        console.warn('Gyro requestPermission error:', err);
        setHasGyroPermission(true);
        setGyroActive(true);
        setGyroStatusText('Swipe / Tilt Active');
        setToastMessage('💡 Swipe right side of screen to pan & tilt camera.');
        setTimeout(() => setToastMessage(null), 3500);
      }
    } else {
      // Android / Standard Browsers
      setHasGyroPermission(true);
      setGyroActive(true);
      setGyroStatusText('Gyro Active');
      setToastMessage('✅ Gyroscope Active! Tilt phone to aim camera.');
      setTimeout(() => setToastMessage(null), 2500);
    }
  };

  // Auto-probe sensors on mount
  useEffect(() => {
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof (DeviceOrientationEvent as any).requestPermission !== 'function'
    ) {
      const probeHandler = (e: DeviceOrientationEvent) => {
        if (e.alpha !== null || e.beta !== null || e.gamma !== null) {
          setHasGyroPermission(true);
          setGyroActive(true);
          setGyroStatusText('Gyro Active');
          window.removeEventListener('deviceorientation', probeHandler);
        }
      };
      window.addEventListener('deviceorientation', probeHandler, { once: true });
      return () => {
        window.removeEventListener('deviceorientation', probeHandler);
      };
    }
  }, []);

  // Multi-Sensor tracking loop (deviceorientation + devicemotion fallback)
  const lastGyroSendRef = useRef<number>(0);
  const integratedYawRef = useRef<number>(180);
  const lastMotionTimeRef = useRef<number>(0);

  useEffect(() => {
    if (!gyroActive) return;

    // A. Primary: DeviceOrientationEvent (Absolute Euler angles from compass/gyro)
    const handleOrientation = (e: DeviceOrientationEvent) => {
      if (e.alpha === null && e.beta === null && e.gamma === null) {
        return;
      }
      hasRealOrientationRef.current = true;

      const alpha = e.alpha ?? 0;
      const beta = e.beta ?? 0;
      const gamma = e.gamma ?? 0;

      let screenAngle = 90;
      if (typeof window.screen?.orientation?.angle === 'number') {
        screenAngle = window.screen.orientation.angle;
      } else if (typeof window.orientation === 'number') {
        screenAngle = window.orientation;
      }

      const orientData: DeviceOrientationData = {
        alpha,
        beta,
        gamma,
        screenOrientation: screenAngle,
      };

      setCurrentAngles(orientData);

      const now = performance.now();
      if (now - lastGyroSendRef.current > 16) {
        lastGyroSendRef.current = now;
        socketRef.current?.sendGyro(orientData);
      }
    };

    // B. Fallback: DeviceMotionEvent (Physical tilt from gravity accelerometer + rotationRate)
    const handleMotion = (e: DeviceMotionEvent) => {
      if (hasRealOrientationRef.current) return;

      const now = performance.now();
      const dt = lastMotionTimeRef.current > 0 ? (now - lastMotionTimeRef.current) / 1000 : 0.016;
      lastMotionTimeRef.current = now;

      const acc = e.accelerationIncludingGravity;
      const rot = e.rotationRate;

      let screenAngle = 90;
      if (typeof window.screen?.orientation?.angle === 'number') {
        screenAngle = window.screen.orientation.angle;
      } else if (typeof window.orientation === 'number') {
        screenAngle = window.orientation;
      }

      if (acc && (acc.x !== null || acc.y !== null || acc.z !== null)) {
        const ax = acc.x ?? 0;
        const ay = acc.y ?? 0;
        const az = acc.z ?? 0;

        // In landscape mode (90deg), ax represents forward-back tilt
        let pitchDeg = 0;
        const denom = Math.sqrt(ay * ay + az * az) || 0.001;
        if (screenAngle === 90) {
          pitchDeg = Math.atan2(ax, denom) * (180 / Math.PI);
        } else {
          pitchDeg = Math.atan2(-ax, denom) * (180 / Math.PI);
        }

        // Integrate yaw from rotationRate (gamma in landscape is yaw around vertical axis)
        if (rot && rot.gamma !== null && Math.abs(rot.gamma) > 0.5) {
          integratedYawRef.current -= (rot.gamma || 0) * dt;
        }

        const orientData: DeviceOrientationData = {
          alpha: integratedYawRef.current,
          beta: 90 - pitchDeg,
          gamma: 0,
          screenOrientation: screenAngle,
        };

        setCurrentAngles(orientData);

        if (now - lastGyroSendRef.current > 16) {
          lastGyroSendRef.current = now;
          socketRef.current?.sendGyro(orientData);
        }
      }
    };

    window.addEventListener('deviceorientation', handleOrientation, true);
    window.addEventListener('deviceorientationabsolute', handleOrientation as any, true);
    window.addEventListener('devicemotion', handleMotion, true);

    return () => {
      window.removeEventListener('deviceorientation', handleOrientation, true);
      window.removeEventListener('deviceorientationabsolute', handleOrientation as any, true);
      window.removeEventListener('devicemotion', handleMotion, true);
    };
  }, [gyroActive]);

  // 6. Camera Pose Streaming: as local camera moves in ThreeStage, stream pose to desktop!
  const lastPoseSendRef = useRef<number>(0);
  const handleLocalCameraPose = useCallback((pose: CameraPoseData) => {
    const now = performance.now();
    if (now - lastPoseSendRef.current < 16) return; // ~60 FPS
    lastPoseSendRef.current = now;
    socketRef.current?.sendCameraPose(pose);
  }, []);

  // 7. Touch Drag Look (Right half of viewfinder: Pan & Tilt)
  const lookTouchStartRef = useRef<{ x: number; y: number } | null>(null);
  const handleLookTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    lookTouchStartRef.current = { x: t.clientX, y: t.clientY };
  };

  const handleLookTouchMove = (e: React.TouchEvent) => {
    if (!lookTouchStartRef.current) return;
    const t = e.touches[0];
    const dx = t.clientX - lookTouchStartRef.current.x;
    const dy = t.clientY - lookTouchStartRef.current.y;
    lookTouchStartRef.current = { x: t.clientX, y: t.clientY };

    const lookDelta = { deltaPitch: dy * 0.005, deltaYaw: dx * 0.005 };
    setActiveLook(lookDelta);
    socketRef.current?.sendLook(lookDelta.deltaPitch, lookDelta.deltaYaw);
  };

  const handleLookTouchEnd = () => {
    lookTouchStartRef.current = null;
    setActiveLook(null);
  };

  // 8. Virtual Joystick (Left thumb: Dolly & Truck move)
  const joyStartRef = useRef<{ x: number; y: number } | null>(null);
  const [joyOffset, setJoyOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const moveIntervalRef = useRef<any>(null);
  const activeMoveRef = useRef<{ x: number; z: number; y: number }>({ x: 0, z: 0, y: 0 });

  const startMoveLoop = useCallback(() => {
    if (moveIntervalRef.current) return;
    moveIntervalRef.current = setInterval(() => {
      const { x, z, y } = activeMoveRef.current;
      if (x !== 0 || z !== 0 || y !== 0) {
        const moveData = { moveX: x, moveZ: z, moveY: y };
        setActiveMove(moveData);
        socketRef.current?.sendMove(moveData);
      }
    }, 16);
  }, []);

  const stopMoveLoop = useCallback(() => {
    if (moveIntervalRef.current) {
      clearInterval(moveIntervalRef.current);
      moveIntervalRef.current = null;
    }
    activeMoveRef.current = { x: 0, z: 0, y: 0 };
    setActiveMove(null);
    socketRef.current?.sendMove({ moveX: 0, moveZ: 0, moveY: 0 });
  }, []);

  const handleJoyStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    joyStartRef.current = { x: t.clientX, y: t.clientY };
    startMoveLoop();
  };

  const handleJoyMove = (e: React.TouchEvent) => {
    if (!joyStartRef.current) return;
    const t = e.touches[0];
    const maxRadius = 45;
    let dx = t.clientX - joyStartRef.current.x;
    let dy = t.clientY - joyStartRef.current.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > maxRadius) {
      dx = (dx / dist) * maxRadius;
      dy = (dy / dist) * maxRadius;
    }

    setJoyOffset({ x: dx, y: dy });

    activeMoveRef.current.x = dx / maxRadius;
    activeMoveRef.current.z = -dy / maxRadius;
  };

  const handleJoyEnd = () => {
    joyStartRef.current = null;
    setJoyOffset({ x: 0, y: 0 });
    stopMoveLoop();
  };

  // Elevation (Pedestal Up / Down)
  const handlePedestal = (dir: 1 | -1) => {
    const moveData = { moveX: 0, moveZ: 0, moveY: dir * 0.4 };
    setActiveMove(moveData);
    socketRef.current?.sendMove(moveData);
    setTimeout(() => setActiveMove(null), 100);
  };

  // Actions
  const toggleRecord = () => {
    socketRef.current?.sendToggleRecord();
  };

  const togglePlay = () => {
    socketRef.current?.sendTogglePlay();
  };

  const rewind = () => {
    socketRef.current?.sendRewind();
  };

  const calibrateZero = () => {
    setCalibrateTrigger((p) => p + 1);
    socketRef.current?.sendCalibrate();
    setToastMessage('Forward direction zeroed (0°)');
    setTimeout(() => setToastMessage(null), 2000);
  };

  const selectFocalLength = (fl: string) => {
    socketRef.current?.sendFocalLength(fl);
  };

  const currentFov = LENS_FOV_MAP[hostState.focalLength] || 54;

  // 9. Portrait Warning Overlay
  if (!isLandscape) {
    return (
      <div className="fixed inset-0 z-50 bg-[#0c0d0e] text-[#d6e3ff] flex flex-col items-center justify-center p-8 select-none text-center">
        <div className="relative w-28 h-28 mb-6 flex items-center justify-center">
          <div className="absolute inset-0 rounded-full border-2 border-primary/30 animate-ping opacity-25" />
          <div className="w-20 h-32 rounded-2xl border-2 border-primary bg-surface-container flex items-center justify-center shadow-lg shadow-primary/20 rotate-90 transition-transform duration-500">
            <span className="material-symbols-outlined text-primary text-3xl">
              screen_rotation
            </span>
          </div>
        </div>
        <div className="inline-block px-3 py-1 bg-primary/10 border border-primary/30 rounded-full mb-3">
          <span className="font-mono text-xs tracking-widest text-primary font-semibold uppercase">
            16:9 Landscape Required
          </span>
        </div>
        <h2 className="text-xl font-bold text-white mb-2 font-display">
          Rotate Device to Landscape
        </h2>
        <p className="text-xs text-on-surface-variant max-w-xs leading-relaxed mb-6">
          AURA Virtual Director controller operates exclusively in 16:9 widescreen orientation for accurate camera framing.
        </p>
        <div className="text-[11px] font-mono text-outline uppercase tracking-wider">
          Turn your phone sideways to unlock the 3D director HUD
        </div>
      </div>
    );
  }

  // 10. Landscape 16:9 Live 3D Viewfinder & Director HUD
  return (
    <div className="fixed inset-0 z-50 bg-black text-white flex flex-col select-none overflow-hidden touch-none font-mono">

      {/* Toast Alert Banner */}
      {toastMessage && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-50 bg-black/85 border border-primary text-primary px-4 py-1.5 rounded-full backdrop-blur-xl text-xs flex items-center gap-2 animate-in fade-in duration-150">
          <span>{toastMessage}</span>
        </div>
      )}

      {/* LIVE 3D SCENE VIEWPORT (Renders Stage & Characters on Phone!) */}
      <div className="absolute inset-0 z-0">
        <ThreeStage
          assets={project?.scenes || []}
          selectedAssetId={null}
          characters={characters}
          currentTimelineTime={hostState.timelineSec}
          isPlaying={hostState.isPlaying}
          showTrajectories={false}
          panoramaUrl={project?.panoramaUrl}
          panoramaRotation={project?.panoramaRotation || 0}
          splatUrl={project?.splatUrl}
          cameraFov={currentFov}
          isRecordingCamera={false}
          isPlaybackTake={false}
          showGrid={true}
          remoteOrientation={gyroActive ? currentAngles : null}
          remoteMove={activeMove}
          remoteLook={activeLook}
          calibrateTrigger={calibrateTrigger}
          onCameraPose={handleLocalCameraPose}
        />
      </div>

      {/* 16:9 Transparent Director HUD Overlay */}
      <div className="relative z-10 w-full h-full flex flex-col justify-between p-3 pointer-events-none">
        {/* Subtle 16:9 Frame Brackets & Center Reticle */}
        <div className="absolute inset-0 pointer-events-none m-2 rounded-lg flex flex-col justify-between">
          {/* Rule of Thirds Guide Lines */}
          <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 pointer-events-none opacity-15">
            <div className="border-r border-b border-white" />
            <div className="border-r border-b border-white" />
            <div className="border-b border-white" />
            <div className="border-r border-b border-white" />
            <div className="border-r border-b border-white" />
            <div className="border-b border-white" />
            <div className="border-r border-white" />
            <div className="border-r border-white" />
            <div />
          </div>

          {/* Corner Framing Brackets */}
          <div className="absolute top-2 left-2 w-6 h-6 border-t-2 border-l-2 border-primary" />
          <div className="absolute top-2 right-2 w-6 h-6 border-t-2 border-r-2 border-primary" />
          <div className="absolute bottom-2 left-2 w-6 h-6 border-b-2 border-l-2 border-primary" />
          <div className="absolute bottom-2 right-2 w-6 h-6 border-b-2 border-r-2 border-primary" />

          {/* Center Crosshair */}
          <div className="absolute inset-0 flex items-center justify-center opacity-40">
            <div className="w-8 h-px bg-primary" />
            <div className="h-8 w-px bg-primary absolute" />
            <div className="w-2 h-2 rounded-full border border-primary absolute" />
          </div>
        </div>

        {/* Top Header Bar */}
        <header className="pointer-events-auto flex items-center justify-between px-3 py-1 bg-black/60 backdrop-blur-md rounded-lg border border-white/15 shadow-lg">
          {/* Left: Connection & Room */}
          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-1.5">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  isConnected ? 'bg-[#4ade80] shadow-[0_0_8px_#4ade80]' : 'bg-red-500 animate-pulse'
                }`}
              />
              <span className="text-[11px] font-bold tracking-wider">
                {isConnected ? 'LIVE SYNCED' : 'CONNECTING...'}
              </span>
            </div>
            <span className="text-[10px] text-white/60 bg-white/10 px-2 py-0.5 rounded border border-white/10">
              ROOM: {roomId.slice(0, 8)} {peerCount > 1 ? '• 2/2' : ''}
            </span>
          </div>

          {/* Center: Lens Focal Length Selector */}
          <div className="flex items-center gap-1 bg-white/10 p-0.5 rounded-md border border-white/10">
            {['24mm', '35mm', '50mm', '85mm'].map((fl) => (
              <button
                key={fl}
                onClick={() => selectFocalLength(fl)}
                className={`px-2.5 py-0.5 text-[10px] font-bold rounded transition-colors ${
                  hostState.focalLength === fl
                    ? 'bg-primary text-black'
                    : 'text-white/70 hover:text-white'
                }`}
              >
                {fl}
              </button>
            ))}
          </div>

          {/* Right: Gyro Activation & Zero Calibration */}
          <div className="flex items-center gap-2">
            {!hasGyroPermission ? (
              <button
                onClick={requestGyroPermission}
                className="px-2.5 py-1 text-[10px] font-bold bg-primary text-black rounded animate-pulse cursor-pointer shadow flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-[14px]">screen_rotation</span>
                ENABLE GYRO
              </button>
            ) : (
              <button
                onClick={() => setGyroActive(!gyroActive)}
                className={`px-2 py-1 text-[10px] font-bold rounded border ${
                  gyroActive
                    ? 'bg-[#4ade80]/20 border-[#4ade80] text-[#4ade80]'
                    : 'bg-white/10 border-white/20 text-white/50'
                }`}
              >
                {gyroActive ? 'GYRO: ON' : 'GYRO: OFF'}
              </button>
            )}

            <button
              onClick={calibrateZero}
              className="px-2.5 py-1 text-[10px] font-bold bg-white/15 hover:bg-white/25 border border-white/20 rounded active:scale-95 text-white flex items-center gap-1 cursor-pointer"
              title="Calibrate forward zero direction"
            >
              <span className="material-symbols-outlined text-[14px]">my_location</span>
              ZERO 0°
            </button>
          </div>
        </header>

        {/* Center Field: Virtual Joystick, Pedestal, Timecode, and Full-Surface Touch-Look */}
        <div className="flex-1 relative flex items-center justify-between px-4 py-2 pointer-events-none">
          {/* Left Side: Virtual Joystick & Height Pedestal */}
          <div className="pointer-events-auto flex items-center gap-3 z-30">
            {/* Joystick (Dolly & Truck) */}
            <div className="flex flex-col items-center gap-1">
              <div
                className="relative w-28 h-28 rounded-full bg-black/50 border-2 border-white/30 flex items-center justify-center touch-none backdrop-blur-md shadow-2xl active:border-primary"
                onTouchStart={handleJoyStart}
                onTouchMove={handleJoyMove}
                onTouchEnd={handleJoyEnd}
                onTouchCancel={handleJoyEnd}
              >
                <div className="w-10 h-10 rounded-full border border-white/30 pointer-events-none" />
                <div
                  className="absolute w-12 h-12 rounded-full bg-primary/90 shadow-[0_0_15px_rgba(74,222,128,0.5)] flex items-center justify-center pointer-events-none transition-transform duration-75"
                  style={{
                    transform: `translate(${joyOffset.x}px, ${joyOffset.y}px)`,
                  }}
                >
                  <span className="material-symbols-outlined text-black text-sm">
                    drag_pan
                  </span>
                </div>
              </div>
              <span className="text-[9px] text-white/70 tracking-widest uppercase font-bold drop-shadow">
                DOLLY / TRUCK
              </span>
            </div>

            {/* Elevation Pedestal Up/Down */}
            <div className="flex flex-col gap-2">
              <button
                onTouchStart={() => handlePedestal(1)}
                onClick={() => handlePedestal(1)}
                className="w-10 h-11 bg-black/50 border border-white/30 rounded-lg flex items-center justify-center active:bg-primary active:text-black transition-colors backdrop-blur-md shadow-lg"
                title="Camera Up"
              >
                <span className="material-symbols-outlined text-sm">arrow_upward</span>
              </button>
              <button
                onTouchStart={() => handlePedestal(-1)}
                onClick={() => handlePedestal(-1)}
                className="w-10 h-11 bg-black/50 border border-white/30 rounded-lg flex items-center justify-center active:bg-primary active:text-black transition-colors backdrop-blur-md shadow-lg"
                title="Camera Down"
              >
                <span className="material-symbols-outlined text-sm">arrow_downward</span>
              </button>
            </div>
          </div>

          {/* Center Info / Timecode Readout */}
          <div className="flex flex-col items-center text-center pointer-events-none drop-shadow-md z-10">
            <div className="text-2xl font-black tracking-wider text-white font-mono bg-black/50 px-3 py-1 rounded-lg backdrop-blur-sm border border-white/15">
              {formatTime(hostState.timelineSec)}
              <span className="text-xs text-white/60 font-normal ml-1">
                / {formatTime(hostState.effectiveDuration)}
              </span>
            </div>
            <div className="text-[9px] text-primary font-mono mt-1 bg-black/60 px-2 py-0.5 rounded border border-primary/20 flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${gyroActive && currentAngles ? 'bg-[#4ade80]' : 'bg-white/40'}`} />
              <span>
                {gyroActive && currentAngles
                  ? `PITCH ${Math.round(currentAngles.beta)}° • YAW ${Math.round(currentAngles.alpha)}°`
                  : gyroStatusText}
              </span>
            </div>
            {hostState.isRecording && (
              <div className="mt-1.5 flex items-center gap-1.5 px-3 py-1 bg-red-600/70 border border-red-500 rounded-full animate-pulse backdrop-blur-sm">
                <span className="w-2 h-2 rounded-full bg-white" />
                <span className="text-[10px] font-bold text-white tracking-wider">
                  RECORDING TAKE LIVE
                </span>
              </div>
            )}
          </div>

          {/* Right 55% Full Screen Surface: Wide Touch-Drag Look Pad (Pan & Tilt) */}
          <div
            className="pointer-events-auto absolute right-0 top-0 bottom-0 w-[55%] z-20 touch-none flex flex-col justify-end items-end p-3 select-none"
            onTouchStart={handleLookTouchStart}
            onTouchMove={handleLookTouchMove}
            onTouchEnd={handleLookTouchEnd}
            onTouchCancel={handleLookTouchEnd}
          >
            <div className="bg-black/40 border border-white/20 rounded-full px-3 py-1 flex items-center gap-1.5 backdrop-blur-sm pointer-events-none opacity-60">
              <span className="material-symbols-outlined text-sm text-primary">touch_app</span>
              <span className="text-[9px] font-bold tracking-wider text-white uppercase font-mono">
                Swipe Screen to Aim
              </span>
            </div>
          </div>
        </div>

        {/* Bottom Master Transport Bar */}
        <footer className="pointer-events-auto flex items-center justify-between px-4 py-2 bg-black/60 backdrop-blur-md rounded-lg border border-white/15 shadow-lg">
          {/* Left: Rewind & Play Controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={rewind}
              className="px-3 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded text-[11px] font-bold flex items-center gap-1 active:scale-95"
            >
              <span className="material-symbols-outlined text-[15px]">fast_rewind</span>
              REWIND
            </button>
            <button
              onClick={togglePlay}
              className={`px-3 py-1.5 rounded text-[11px] font-bold flex items-center gap-1 active:scale-95 border ${
                hostState.isPlaying
                  ? 'bg-primary/30 border-primary text-primary'
                  : 'bg-white/10 border-white/20 text-white'
              }`}
            >
              <span className="material-symbols-outlined text-[15px]">
                {hostState.isPlaying ? 'pause' : 'play_arrow'}
              </span>
              {hostState.isPlaying ? 'PAUSE' : 'PLAY'}
            </button>
          </div>

          {/* Center: Big Tactile REC Button */}
          <div className="flex items-center justify-center">
            <button
              onClick={toggleRecord}
              className={`px-6 py-2.5 rounded-full font-black text-xs tracking-widest flex items-center gap-2 shadow-xl transition-all active:scale-95 ${
                hostState.isRecording
                  ? 'bg-red-600 text-white shadow-red-600/50 animate-pulse border-2 border-white'
                  : 'bg-red-600 hover:bg-red-500 text-white shadow-red-600/30'
              }`}
            >
              <span
                className={`w-3 h-3 rounded-full ${
                  hostState.isRecording ? 'bg-white' : 'bg-white animate-ping'
                }`}
              />
              {hostState.isRecording ? '■ STOP RECORD' : '● REC TAKE'}
            </button>
          </div>

          {/* Right: Scene / Take Info */}
          <div className="flex items-center gap-2 text-right">
            <div className="text-[10px] text-white/80">
              <span className="font-bold">{project?.name || 'AURA STAGE'}</span>
              <div className="text-white/50 text-[9px]">16:9 LIVE MONITOR</div>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
};

export default MobileCameraRemote;
