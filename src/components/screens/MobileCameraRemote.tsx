import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { CameraRemoteSocket } from '../../services/cameraRemoteService';
import { CameraRemoteState, Project, CharacterActor, CameraPoseData, DeviceOrientationData, RemoteMoveData } from '../../types';
import { ThreeStage } from '../viewport/ThreeStage';
import { DEFAULT_INITIAL_ACTORS } from './ActingSetupView';

/** Which hardware stream is currently driving the aim filter. */
type SensorSource = 'deviceorientation' | 'deviceorientationabsolute' | 'sensor';

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
  // 1. URL Query Extraction (Synchronous initialization on first mount)
  const [roomId, setRoomId] = useState<string>(() => {
    if (typeof window === 'undefined') return 'aura_main';
    const hash = window.location.hash;
    const search = window.location.search;
    const urlParams = new URLSearchParams(search || (hash.includes('?') ? hash.split('?')[1] : ''));
    const r = urlParams.get('room');
    if (r) {
      try { localStorage.setItem('aura_remote_room_id', r); } catch (_) {}
      return r;
    }
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('aura_remote_room_id') : null;
    return saved || 'aura_main';
  });
  const [projectId, setProjectId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const hash = window.location.hash;
    const search = window.location.search;
    const urlParams = new URLSearchParams(search || (hash.includes('?') ? hash.split('?')[1] : ''));
    return urlParams.get('project');
  });

  useEffect(() => {
    const hash = window.location.hash;
    const search = window.location.search;
    const urlParams = new URLSearchParams(search || (hash.includes('?') ? hash.split('?')[1] : ''));
    const r = urlParams.get('room');
    const p = urlParams.get('project');
    if (r) setRoomId(r);
    if (p) setProjectId(p);
  }, []);

  // 2. Project & Scene Data (Loaded from /api/projects, WebSocket init_scene, or prop)
  const [project, setProject] = useState<Project | null>(() => {
    if (initialProject && (!projectId || initialProject.id === projectId)) {
      return initialProject;
    }
    return null;
  });

  useEffect(() => {
    // Always fetch projects from server to get full scene geometry & baked room assets
    fetch('/api/projects')
      .then((res) => res.json())
      .then((data) => {
        const projs: Project[] = Array.isArray(data) ? data : data?.projects || [];
        if (projs.length > 0) {
          const match = projectId ? projs.find((p) => p.id === projectId) : null;
          const chosen = match || projs[0];
          setProject((prev) => {
            if (prev && prev.id === chosen.id && prev.scenes && prev.scenes.length > 0) {
              return prev;
            }
            return chosen;
          });
        }
      })
      .catch((err) => console.warn('[MobileRemote] Failed to load projects from server:', err));
  }, [projectId]);

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

  // Gyroscope tracking state.
  // DeviceOrientationEvent, DeviceMotionEvent and the Generic Sensor API are all gated behind a
  // secure context. Over plain http:// the listeners attach without error and simply never fire,
  // so detect that up front rather than reporting a gyro that can never deliver a reading.
  const isSecure = typeof window !== 'undefined' && window.isSecureContext;
  const isIosPermissionRequired =
    typeof window !== 'undefined' &&
    typeof DeviceOrientationEvent !== 'undefined' &&
    typeof (DeviceOrientationEvent as any).requestPermission === 'function';

  const [hasGyroPermission, setHasGyroPermission] = useState<boolean>(() => isSecure && !isIosPermissionRequired);
  const [gyroActive, setGyroActive] = useState<boolean>(() => isSecure && !isIosPermissionRequired);
  const [showGyroHelp, setShowGyroHelp] = useState<boolean>(false);
  const [gyroStatusText, setGyroStatusText] = useState<string>(() => {
    if (!isSecure) return 'Gyro Blocked — Page Not HTTPS';
    return isIosPermissionRequired ? 'Touch Drag / Gyro Standby' : 'Gyro Starting...';
  });
  const [currentAngles, setCurrentAngles] = useState<DeviceOrientationData | null>(null);
  const orientationRef = useRef<DeviceOrientationData | null>(null);
  const lastHudUpdateRef = useRef<number>(0);
  const [calibrateTrigger, setCalibrateTrigger] = useState<number>(0);
  const packetCountRef = useRef<number>(0);
  const [livePackets, setLivePackets] = useState<number>(0);

  // Touch Move / Joystick state
  const [activeMove, setActiveMove] = useState<RemoteMoveData | null>(null);
  const [activeLook, setActiveLook] = useState<{ deltaPitch: number; deltaYaw: number } | null>(null);
  const activeLookRef = useRef<{ deltaPitch: number; deltaYaw: number } | null>(null);

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

  // 5. Gyroscope Permission & Multi-Sensor Listener

  const requestGyroPermission = async () => {
    // No secure context means no sensor will ever fire, whatever the user taps.
    if (!isSecure) {
      setHasGyroPermission(false);
      setGyroActive(false);
      setGyroStatusText('Gyro Blocked — Page Not HTTPS');
      setToastMessage(
        `⚠️ Motion sensors require HTTPS. Reopen this page as https://${typeof window !== 'undefined' ? window.location.host : ''}`
      );
      setTimeout(() => setToastMessage(null), 6000);
      return;
    }
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
          // Denied: leave the enable button in place so it can be retried, and fall back to touch.
          setHasGyroPermission(false);
          setGyroActive(false);
          setGyroStatusText('Gyro Denied — Touch Aim Active');
          setToastMessage('💡 Motion access denied. Swipe right side of screen to pan & tilt.');
          setTimeout(() => setToastMessage(null), 3500);
        }
      } catch (err: any) {
        // requestPermission throws outside a user gesture, and on insecure origins.
        console.warn('Gyro requestPermission error:', err);
        setHasGyroPermission(false);
        setGyroActive(false);
        setGyroStatusText('Gyro Unavailable — Touch Aim Active');
        setToastMessage('💡 Could not reach motion sensors. Swipe right side of screen to aim.');
        setTimeout(() => setToastMessage(null), 3500);
      }
    } else {
      // Android / Standard Browsers. The watchdog below downgrades this if nothing reports.
      setHasGyroPermission(true);
      setGyroActive(true);
      setGyroStatusText('Gyro Starting...');
    }
  };

  // Auto-probe sensors on mount (Android / Chrome)
  useEffect(() => {
    if (isSecure && !isIosPermissionRequired && typeof window !== 'undefined') {
      const probeHandler = (e: DeviceOrientationEvent) => {
        if (e.alpha !== null || e.beta !== null || e.gamma !== null) {
          setHasGyroPermission(true);
          setGyroActive(true);
          setGyroStatusText('Gyro Active');
          window.removeEventListener('deviceorientation', probeHandler);
          window.removeEventListener('deviceorientationabsolute' as any, probeHandler);
        }
      };
      window.addEventListener('deviceorientation', probeHandler);
      window.addEventListener('deviceorientationabsolute' as any, probeHandler);
      return () => {
        window.removeEventListener('deviceorientation', probeHandler);
        window.removeEventListener('deviceorientationabsolute' as any, probeHandler);
      };
    }
  }, [isSecure, isIosPermissionRequired]);

  // 5. Gyroscope Tracking with Angle Unwrapping and Low-Pass Filtering
  const lastGyroSendRef = useRef<number>(0);
  const smoothAnglesRef = useRef<{ alpha: number; beta: number; gamma: number } | null>(null);
  const lastRawAlphaRef = useRef<number | null>(null);

  useEffect(() => {
    if (!gyroActive) {
      smoothAnglesRef.current = null;
      lastRawAlphaRef.current = null;
      return;
    }

    let isDisposed = false;
    let lastEventTime = 0;
    const baselinePackets = packetCountRef.current;

    // Only one hardware stream may drive the filter. Android Chrome fires both `deviceorientation`
    // (relative) and `deviceorientationabsolute` (magnetometer-referenced), and the Generic Sensor
    // API reports a third convention — pushing all of them through one low-pass filter makes yaw
    // fight itself. The highest-priority source that actually reports wins, and the filter restarts
    // on handover so the new reference frame is not blended into the old one.
    const SOURCE_PRIORITY: Record<SensorSource, number> = {
      sensor: 1,
      deviceorientation: 2,
      deviceorientationabsolute: 3,
    };
    let activeSource: SensorSource | null = null;

    // Helper to process raw angles from any hardware sensor source
    const processAngles = (
      source: SensorSource,
      rawAlpha: number,
      rawBeta: number,
      rawGamma: number,
      screenAngle: number
    ) => {
      if (isDisposed) return;
      if (activeSource === null) {
        activeSource = source;
      } else if (activeSource !== source) {
        if (SOURCE_PRIORITY[source] <= SOURCE_PRIORITY[activeSource]) return;
        activeSource = source;
        smoothAnglesRef.current = null;
        lastRawAlphaRef.current = null;
      }
      const now = performance.now();
      // Drop duplicate events that fire within 4ms
      if (now - lastEventTime < 4) return;
      lastEventTime = now;

      // Angle Unwrapping on Yaw (alpha) across 0° / 360° discontinuity
      if (lastRawAlphaRef.current === null || !smoothAnglesRef.current) {
        lastRawAlphaRef.current = rawAlpha;
        smoothAnglesRef.current = {
          alpha: rawAlpha,
          beta: rawBeta,
          gamma: rawGamma,
        };
      } else {
        let diff = rawAlpha - lastRawAlphaRef.current;
        while (diff < -180) diff += 360;
        while (diff > 180) diff -= 360;
        lastRawAlphaRef.current = rawAlpha;

        // Smooth low-pass accumulation for silky 60 FPS aiming without jitter or drift
        const factor = 0.5;
        const nextAlpha = ((smoothAnglesRef.current.alpha + diff * factor) % 360 + 360) % 360;
        const nextBeta = smoothAnglesRef.current.beta + (rawBeta - smoothAnglesRef.current.beta) * factor;
        const nextGamma = smoothAnglesRef.current.gamma + (rawGamma - smoothAnglesRef.current.gamma) * factor;

        smoothAnglesRef.current.alpha = nextAlpha;
        smoothAnglesRef.current.beta = nextBeta;
        smoothAnglesRef.current.gamma = nextGamma;
      }

      const orientData: DeviceOrientationData = {
        alpha: smoothAnglesRef.current.alpha,
        beta: smoothAnglesRef.current.beta,
        gamma: smoothAnglesRef.current.gamma,
        screenOrientation: screenAngle,
      };

      orientationRef.current = orientData;
      if (packetCountRef.current === baselinePackets) {
        setGyroStatusText('Gyro Active');
      }
      packetCountRef.current++;

      // Realtime 60 FPS gyro packet streaming to Host Studio
      if (now - lastGyroSendRef.current >= 15) {
        lastGyroSendRef.current = now;
        socketRef.current?.sendGyro(orientData);
      }

      // Throttle React state HUD update to ~4 Hz (every 250ms) to eliminate main-thread stutter
      if (now - lastHudUpdateRef.current > 250) {
        lastHudUpdateRef.current = now;
        setLivePackets(packetCountRef.current);
        setCurrentAngles(orientData);
      }
    };

    const readScreenAngle = (): number => {
      if (typeof window.screen?.orientation?.angle === 'number') return window.screen.orientation.angle;
      if (typeof window.orientation === 'number') return window.orientation;
      return 90;
    };

    // 1. Standard W3C DeviceOrientation listeners
    const makeOrientationHandler = (source: SensorSource) => (e: DeviceOrientationEvent) => {
      if (e.alpha === null && e.beta === null && e.gamma === null) return;
      processAngles(source, e.alpha ?? 0, e.beta ?? 0, e.gamma ?? 0, readScreenAngle());
    };
    const handleOrientation = makeOrientationHandler('deviceorientation');
    const handleOrientationAbsolute = makeOrientationHandler('deviceorientationabsolute');

    window.addEventListener('deviceorientation', handleOrientation, true);
    window.addEventListener('deviceorientationabsolute' as any, handleOrientationAbsolute, true);

    // 2. Modern W3C Generic Sensor API (RelativeOrientationSensor / AbsoluteOrientationSensor)
    let genericSensor: any = null;
    try {
      const SensorClass = (window as any).RelativeOrientationSensor || (window as any).AbsoluteOrientationSensor;
      if (SensorClass) {
        genericSensor = new SensorClass({ frequency: 60, referenceFrame: 'device' });
        genericSensor.addEventListener('reading', () => {
          const q = genericSensor.quaternion;
          if (!q || q.length < 4) return;
          // Calculate Euler angles from sensor quaternion
          const qObj = new THREE.Quaternion(q[0], q[1], q[2], q[3]);
          const euler = new THREE.Euler().setFromQuaternion(qObj, 'YXZ');
          const a = ((euler.y * 180 / Math.PI) % 360 + 360) % 360;
          const b = euler.x * 180 / Math.PI;
          const g = euler.z * 180 / Math.PI;
          processAngles('sensor', a, b, g, readScreenAngle());
        });
        genericSensor.addEventListener('error', (event: any) => {
          console.warn('[GenericSensor error]', event.error);
        });
        genericSensor.start();
      }
    } catch (_) {}

    // 3. User Gesture Touch to Wake Sensors
    const handleUserTouchWake = () => {
      if (packetCountRef.current === 0) {
        requestGyroPermission();
        try { genericSensor?.start(); } catch (_) {}
      }
    };
    window.addEventListener('touchstart', handleUserTouchWake, { passive: true });
    window.addEventListener('click', handleUserTouchWake, { passive: true });

    // 4. Sensor watchdog. Listeners attach without error on platforms that will never deliver a
    // reading, so downgrade the badge instead of leaving a green "Gyro Active" claim standing.
    const watchdog = setTimeout(() => {
      if (isDisposed || packetCountRef.current > baselinePackets) return;
      setGyroStatusText(isSecure ? 'No Sensor Data — Touch Aim Active' : 'Gyro Blocked — Page Not HTTPS');
    }, 2500);

    return () => {
      isDisposed = true;
      clearTimeout(watchdog);
      window.removeEventListener('deviceorientation', handleOrientation, true);
      window.removeEventListener('deviceorientationabsolute' as any, handleOrientationAbsolute, true);
      window.removeEventListener('touchstart', handleUserTouchWake);
      window.removeEventListener('click', handleUserTouchWake);
      try { genericSensor?.stop(); } catch (_) {}
    };
  }, [gyroActive, isSecure]);

  // 6. Camera Pose Streaming: as local camera moves in ThreeStage, stream pose to desktop!
  const lastPoseSendRef = useRef<number>(0);
  const handleLocalCameraPose = useCallback((pose: CameraPoseData) => {
    const now = performance.now();
    if (now - lastPoseSendRef.current < 15) return; // ~60 FPS
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
    activeLookRef.current = lookDelta;
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
  const activeMoveRef = useRef<RemoteMoveData | null>({ moveX: 0, moveZ: 0, moveY: 0 });

  const startMoveLoop = useCallback(() => {
    if (moveIntervalRef.current) return;
    moveIntervalRef.current = setInterval(() => {
      const cur = activeMoveRef.current;
      if (cur && (cur.moveX !== 0 || cur.moveZ !== 0 || cur.moveY !== 0)) {
        setActiveMove({ ...cur });
        socketRef.current?.sendMove(cur);
      }
    }, 16);
  }, []);

  const stopMoveLoop = useCallback(() => {
    if (moveIntervalRef.current) {
      clearInterval(moveIntervalRef.current);
      moveIntervalRef.current = null;
    }
    activeMoveRef.current = { moveX: 0, moveZ: 0, moveY: 0 };
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

    if (!activeMoveRef.current) {
      activeMoveRef.current = { moveX: 0, moveZ: 0, moveY: 0 };
    }
    activeMoveRef.current.moveX = dx / maxRadius;
    activeMoveRef.current.moveZ = -dy / maxRadius;
  };

  const handleJoyEnd = () => {
    joyStartRef.current = null;
    setJoyOffset({ x: 0, y: 0 });
    stopMoveLoop();
  };

  // Elevation (Pedestal Up / Down)
  const handlePedestal = (dir: 1 | -1) => {
    if (!activeMoveRef.current) {
      activeMoveRef.current = { moveX: 0, moveZ: 0, moveY: 0 };
    }
    activeMoveRef.current.moveY = dir * 0.4;
    const moveData: RemoteMoveData = { moveX: 0, moveZ: 0, moveY: dir * 0.4 };
    setActiveMove(moveData);
    socketRef.current?.sendMove(moveData);
    setTimeout(() => {
      if (activeMoveRef.current) activeMoveRef.current.moveY = 0;
      setActiveMove(null);
    }, 120);
  };

  // 8.2 Virtual Aim Joystick (Right thumb: Pan & Tilt continuous rotation)
  const lookJoyStartRef = useRef<{ x: number; y: number } | null>(null);
  const [lookJoyOffset, setLookJoyOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const lookJoyIntervalRef = useRef<any>(null);
  const activeLookJoyRef = useRef<{ yaw: number; pitch: number }>({ yaw: 0, pitch: 0 });

  const startLookJoyLoop = useCallback(() => {
    if (lookJoyIntervalRef.current) return;
    lookJoyIntervalRef.current = setInterval(() => {
      const { yaw, pitch } = activeLookJoyRef.current;
      if (yaw !== 0 || pitch !== 0) {
        const deltaYaw = yaw * 0.035;
        const deltaPitch = pitch * 0.025;
        const lookData = { deltaPitch, deltaYaw };
        activeLookRef.current = lookData;
        setActiveLook(lookData);
        socketRef.current?.sendLook(deltaPitch, deltaYaw);
      }
    }, 16);
  }, []);

  const stopLookJoyLoop = useCallback(() => {
    if (lookJoyIntervalRef.current) {
      clearInterval(lookJoyIntervalRef.current);
      lookJoyIntervalRef.current = null;
    }
    activeLookJoyRef.current = { yaw: 0, pitch: 0 };
    setActiveLook(null);
  }, []);

  const handleLookJoyStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    const t = e.touches[0];
    lookJoyStartRef.current = { x: t.clientX, y: t.clientY };
    startLookJoyLoop();
  };

  const handleLookJoyMove = (e: React.TouchEvent) => {
    e.stopPropagation();
    if (!lookJoyStartRef.current) return;
    const t = e.touches[0];
    const maxRadius = 45;
    let dx = t.clientX - lookJoyStartRef.current.x;
    let dy = t.clientY - lookJoyStartRef.current.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > maxRadius) {
      dx = (dx / dist) * maxRadius;
      dy = (dy / dist) * maxRadius;
    }

    setLookJoyOffset({ x: dx, y: dy });
    activeLookJoyRef.current.yaw = dx / maxRadius;
    activeLookJoyRef.current.pitch = dy / maxRadius;
  };

  const handleLookJoyEnd = (e: React.TouchEvent) => {
    e.stopPropagation();
    lookJoyStartRef.current = null;
    setLookJoyOffset({ x: 0, y: 0 });
    stopLookJoyLoop();
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
          isMobileViewfinder={true}
          assets={project?.scenes || []}
          selectedAssetId={null}
          characters={characters}
          stageSpecularity={project?.stageSpecularity}
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
          remoteOrientationRef={gyroActive ? orientationRef : undefined}
          remoteMove={activeMove}
          remoteMoveRef={activeMoveRef}
          remoteLook={activeLook}
          remoteLookRef={activeLookRef}
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
            <div className="flex flex-col items-center gap-1 mt-1">
              <div className="text-[9px] text-primary font-mono bg-black/60 px-2 py-0.5 rounded border border-primary/20 flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${gyroActive && packetCountRef.current > 0 ? 'bg-[#4ade80] animate-pulse' : 'bg-cyan-400'}`} />
                <span>
                  {gyroActive && currentAngles && packetCountRef.current > 0
                    ? `HARDWARE GYRO (${livePackets > 30 ? '60fps' : `${livePackets}pkts`}): PITCH ${Math.round(currentAngles.beta)}° • YAW ${Math.round(currentAngles.alpha)}°`
                    : gyroStatusText || 'GIMBAL JOYSTICKS & TOUCH AIM ACTIVE'}
                </span>
                <button
                  onClick={() => setShowGyroHelp(true)}
                  className="pointer-events-auto ml-1 w-4 h-4 rounded-full bg-white/10 hover:bg-white/20 text-white/70 text-[9px] flex items-center justify-center font-bold cursor-pointer"
                  title="Gyro & Aiming Info"
                >
                  ?
                </button>
              </div>
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

          {/* Right Side: Virtual Aim Joystick (Pan & Tilt) + Wide Touch-Drag Look Pad */}
          <div
            className="pointer-events-auto absolute right-0 top-0 bottom-0 w-[55%] z-20 touch-none flex items-center justify-end px-4 py-2 select-none"
            onTouchStart={handleLookTouchStart}
            onTouchMove={handleLookTouchMove}
            onTouchEnd={handleLookTouchEnd}
            onTouchCancel={handleLookTouchEnd}
          >
            {/* Pan & Tilt Aim Joystick */}
            <div className="flex flex-col items-center gap-1 z-30 pointer-events-auto">
              <div
                className="relative w-28 h-28 rounded-full bg-black/50 border-2 border-white/30 flex items-center justify-center touch-none backdrop-blur-md shadow-2xl active:border-cyan-400"
                onTouchStart={handleLookJoyStart}
                onTouchMove={handleLookJoyMove}
                onTouchEnd={handleLookJoyEnd}
                onTouchCancel={handleLookJoyEnd}
              >
                <div className="w-10 h-10 rounded-full border border-white/30 pointer-events-none" />
                <div
                  className="absolute w-12 h-12 rounded-full bg-cyan-400/90 shadow-[0_0_15px_rgba(34,211,238,0.5)] flex items-center justify-center pointer-events-none transition-transform duration-75"
                  style={{
                    transform: `translate(${lookJoyOffset.x}px, ${lookJoyOffset.y}px)`,
                  }}
                >
                  <span className="material-symbols-outlined text-black text-sm">
                    videocam
                  </span>
                </div>
              </div>
              <span className="text-[9px] text-cyan-400/90 tracking-widest uppercase font-bold drop-shadow">
                PAN / TILT AIM
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

      {/* Gyro & Chrome Settings Diagnostic Modal */}
      {showGyroHelp && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-[#16181c] border border-white/20 rounded-2xl p-5 max-w-sm w-full text-left space-y-3 font-sans shadow-2xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <div className="flex items-center gap-2 font-bold text-white text-xs">
                <span className="material-symbols-outlined text-primary text-base">screen_rotation</span>
                Mobile Gyroscope & Aiming
              </div>
              <button
                onClick={() => setShowGyroHelp(false)}
                className="w-6 h-6 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center text-xs cursor-pointer"
              >
                ✕
              </button>
            </div>
            <div className="text-[11px] text-white/80 space-y-2 leading-relaxed">
              <p>
                <strong className="text-white">Dual Joysticks:</strong> Use the left stick to Dolly/Truck (walk), and the right stick (or swipe screen) to Pan/Tilt aim.
              </p>
              <p>
                <strong className="text-white">Enable Physical Phone Tilt:</strong>{' '}
                {isSecure
                  ? 'This page is on a secure origin, so the motion sensors are allowed. If the badge still reads "No Sensor Data", the browser or device is not reporting orientation — use touch aim instead.'
                  : 'iOS and Android only expose the motion sensors on a secure origin. This page is loaded over plain HTTP, so no reading will ever arrive. Reopen it over HTTPS:'}
              </p>
              {!isSecure && (
                <>
                  <div className="bg-black/60 p-2 rounded border border-white/15 font-mono text-[9px] text-primary select-all break-all">
                    https://{typeof window !== 'undefined' ? window.location.host : '192.168.100.38:3000'}
                  </div>
                  <p className="text-[10px] text-white/60">
                    The dev server uses a self-signed certificate, so tap <strong>Advanced</strong> then{' '}
                    <strong>Proceed</strong> on the warning once. Re-scan the pairing QR code from the desktop
                    to get the correct link.
                  </p>
                </>
              )}
            </div>
            <button
              onClick={() => setShowGyroHelp(false)}
              className="w-full py-2 bg-primary text-black font-bold rounded-lg text-xs cursor-pointer active:scale-95"
            >
              GOT IT
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default MobileCameraRemote;
