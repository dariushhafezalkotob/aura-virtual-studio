import React, { useState, useEffect, useRef, useCallback } from 'react';
import { CameraRemoteSocket } from '../../services/cameraRemoteService';
import { CameraRemoteState } from '../../types';

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms}`;
}

export const MobileCameraRemote: React.FC = () => {
  // 1. URL Query Extraction
  const [roomId, setRoomId] = useState<string>('default');
  useEffect(() => {
    const hash = window.location.hash;
    const search = window.location.search;
    const urlParams = new URLSearchParams(search || (hash.includes('?') ? hash.split('?')[1] : ''));
    const r = urlParams.get('room');
    if (r) setRoomId(r);
  }, []);

  // 2. Landscape Orientation Check
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

  // 3. WebSocket Connection
  const socketRef = useRef<CameraRemoteSocket | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [peerCount, setPeerCount] = useState<number>(0);

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
  const [currentAngles, setCurrentAngles] = useState<{ alpha: number; beta: number; gamma: number }>({
    alpha: 0,
    beta: 0,
    gamma: 0,
  });

  // Initialize socket
  useEffect(() => {
    if (!roomId) return;
    const socket = new CameraRemoteSocket('remote', roomId);
    socketRef.current = socket;

    const unsubStatus = socket.onStatus((connected, count) => {
      setIsConnected(connected);
      setPeerCount(count);
    });

    const unsubMsg = socket.onMessage((msg) => {
      if (msg.type === 'host_state') {
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

  // Request Motion Permission on iOS 13+ & Setup DeviceOrientation listener
  const requestGyroPermission = async () => {
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof (DeviceOrientationEvent as any).requestPermission === 'function'
    ) {
      try {
        const response = await (DeviceOrientationEvent as any).requestPermission();
        if (response === 'granted') {
          setHasGyroPermission(true);
          setGyroActive(true);
        } else {
          alert('Gyroscope permission was denied. Camera orientation tracking requires motion sensors.');
        }
      } catch (err: any) {
        console.error('Error requesting gyro permission:', err);
      }
    } else {
      // Android or Non-iOS browsers do not require explicit requestPermission
      setHasGyroPermission(true);
      setGyroActive(true);
    }
  };

  // Device orientation streaming loop (throttled at ~60fps)
  const lastGyroTime = useRef<number>(0);
  useEffect(() => {
    if (!gyroActive) return;

    const handleOrientation = (e: DeviceOrientationEvent) => {
      const now = performance.now();
      if (now - lastGyroTime.current < 15) return; // ~60fps throttle
      lastGyroTime.current = now;

      const alpha = e.alpha ?? 0;
      const beta = e.beta ?? 0;
      const gamma = e.gamma ?? 0;

      // In landscape mode, determine screen orientation angle
      let screenAngle = 90;
      if (typeof window.screen?.orientation?.angle === 'number') {
        screenAngle = window.screen.orientation.angle;
      } else if (typeof window.orientation === 'number') {
        screenAngle = window.orientation;
      }

      setCurrentAngles({ alpha, beta, gamma });

      if (socketRef.current) {
        socketRef.current.sendGyro({
          alpha,
          beta,
          gamma,
          screenOrientation: screenAngle,
        });
      }
    };

    window.addEventListener('deviceorientation', handleOrientation, true);
    return () => {
      window.removeEventListener('deviceorientation', handleOrientation, true);
    };
  }, [gyroActive]);

  // Touch Drag Pad (Right thumb: Pan / Tilt Look)
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

    if (socketRef.current) {
      // Send fine look deltas
      socketRef.current.sendLook(dy * 0.005, dx * 0.005);
    }
  };

  const handleLookTouchEnd = () => {
    lookTouchStartRef.current = null;
  };

  // Virtual Joystick (Left thumb: Dolly & Truck move)
  const joyStartRef = useRef<{ x: number; y: number } | null>(null);
  const [joyOffset, setJoyOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const moveIntervalRef = useRef<any>(null);
  const activeMoveRef = useRef<{ x: number; z: number; y: number }>({ x: 0, z: 0, y: 0 });

  const startMoveLoop = useCallback(() => {
    if (moveIntervalRef.current) return;
    moveIntervalRef.current = setInterval(() => {
      const { x, z, y } = activeMoveRef.current;
      if ((x !== 0 || z !== 0 || y !== 0) && socketRef.current) {
        socketRef.current.sendMove({
          moveX: x,
          moveZ: z,
          moveY: y,
        });
      }
    }, 16);
  }, []);

  const stopMoveLoop = useCallback(() => {
    if (moveIntervalRef.current) {
      clearInterval(moveIntervalRef.current);
      moveIntervalRef.current = null;
    }
    activeMoveRef.current = { x: 0, z: 0, y: 0 };
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

    // Normalized move: dx -> Truck (moveX), -dy -> Dolly (moveZ forward is negative or positive depending on camera)
    activeMoveRef.current.x = dx / maxRadius;
    activeMoveRef.current.z = -dy / maxRadius;
  };

  const handleJoyEnd = () => {
    joyStartRef.current = null;
    setJoyOffset({ x: 0, y: 0 });
    stopMoveLoop();
    if (socketRef.current) {
      socketRef.current.sendMove({ moveX: 0, moveZ: 0, moveY: 0 });
    }
  };

  // Elevation (Pedestal Up / Down)
  const handlePedestal = (dir: 1 | -1) => {
    if (socketRef.current) {
      socketRef.current.sendMove({ moveX: 0, moveZ: 0, moveY: dir * 0.4 });
    }
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
    socketRef.current?.sendCalibrate();
  };

  const selectFocalLength = (fl: string) => {
    socketRef.current?.sendFocalLength(fl);
  };

  // 4. Portrait Warning Overlay
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
          Turn your phone sideways to unlock the director HUD
        </div>
      </div>
    );
  }

  // 5. Landscape 16:9 Director HUD
  return (
    <div className="fixed inset-0 z-50 bg-black text-white flex flex-col select-none overflow-hidden touch-none font-mono">
      {/* 16:9 Aspect Ratio Director Frame */}
      <div className="relative w-full h-full flex flex-col justify-between p-3">
        {/* Background Subtle Letterbox Matte & Grid */}
        <div className="absolute inset-0 pointer-events-none border-2 border-primary/20 m-2 rounded-lg flex flex-col justify-between">
          {/* Rule of Thirds Guide Overlay */}
          <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 pointer-events-none opacity-15">
            <div className="border-r border-b border-primary" />
            <div className="border-r border-b border-primary" />
            <div className="border-b border-primary" />
            <div className="border-r border-b border-primary" />
            <div className="border-r border-b border-primary" />
            <div className="border-b border-primary" />
            <div className="border-r border-primary" />
            <div className="border-r border-primary" />
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
        <header className="relative z-20 flex items-center justify-between px-3 py-1 bg-black/60 backdrop-blur-md rounded-lg border border-white/10">
          {/* Left: Connection & Room */}
          <div className="flex items-center gap-3">
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
            <span className="text-[10px] text-white/50 bg-white/5 px-2 py-0.5 rounded border border-white/10">
              ROOM: {roomId.slice(0, 10)} {peerCount > 1 ? '• LINKED' : ''}
            </span>
          </div>

          {/* Center: Lens Focal Length Selector */}
          <div className="flex items-center gap-1 bg-white/5 p-0.5 rounded-md border border-white/10">
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

          {/* Right: Gyroscope Status & Calibrate */}
          <div className="flex items-center gap-2">
            {!hasGyroPermission ? (
              <button
                onClick={requestGyroPermission}
                className="px-2.5 py-1 text-[10px] font-bold bg-primary text-black rounded animate-pulse cursor-pointer shadow"
              >
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
              className="px-2.5 py-1 text-[10px] font-bold bg-white/10 hover:bg-white/20 border border-white/20 rounded active:scale-95 text-white flex items-center gap-1 cursor-pointer"
              title="Calibrate forward zero direction"
            >
              <span className="material-symbols-outlined text-[14px]">my_location</span>
              ZERO 0°
            </button>
          </div>
        </header>

        {/* Center Touch Control Field */}
        <div className="relative z-10 flex-1 flex items-center justify-between px-6">
          {/* Left Thumb: Virtual Joystick (Dolly & Truck) */}
          <div className="flex flex-col items-center gap-2">
            <div
              className="relative w-28 h-28 rounded-full bg-white/5 border border-white/20 flex items-center justify-center touch-none backdrop-blur-sm"
              onTouchStart={handleJoyStart}
              onTouchMove={handleJoyMove}
              onTouchEnd={handleJoyEnd}
              onTouchCancel={handleJoyEnd}
            >
              {/* Center Rest Indicator */}
              <div className="w-10 h-10 rounded-full border border-white/20 pointer-events-none" />

              {/* Thumb Stick Knob */}
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
            <span className="text-[9px] text-white/50 tracking-widest uppercase">
              Dolly / Truck
            </span>
          </div>

          {/* Center Info / Gyro Angles Live Readout */}
          <div className="flex flex-col items-center text-center opacity-80 pointer-events-none">
            <div className="text-[10px] text-primary/80 font-mono tracking-widest mb-1">
              VIRTUAL CAMERA CONTROLLER
            </div>
            <div className="text-2xl font-black tracking-wider text-white font-mono">
              {formatTime(hostState.timelineSec)}
              <span className="text-xs text-white/50 font-normal ml-1">
                / {formatTime(hostState.effectiveDuration)}
              </span>
            </div>
            {gyroActive && (
              <div className="flex items-center gap-2 text-[9px] text-white/60 font-mono mt-1">
                <span>YAW: {Math.round(currentAngles.alpha)}°</span>
                <span>PITCH: {Math.round(currentAngles.beta)}°</span>
                <span>ROLL: {Math.round(currentAngles.gamma)}°</span>
              </div>
            )}
            {hostState.isRecording && (
              <div className="mt-2 flex items-center gap-1.5 px-3 py-1 bg-red-600/30 border border-red-500 rounded-full animate-pulse">
                <span className="w-2 h-2 rounded-full bg-red-500" />
                <span className="text-[10px] font-bold text-red-400 tracking-wider">
                  RECORDING TAKE LIVE
                </span>
              </div>
            )}
          </div>

          {/* Right Thumb: Touch Look Pad & Height Pedestal */}
          <div className="flex items-center gap-4">
            {/* Height Elevation (Pedestal) */}
            <div className="flex flex-col gap-2">
              <button
                onTouchStart={() => handlePedestal(1)}
                onClick={() => handlePedestal(1)}
                className="w-10 h-11 bg-white/10 border border-white/20 rounded flex items-center justify-center active:bg-primary active:text-black transition-colors"
                title="Camera Up"
              >
                <span className="material-symbols-outlined text-sm">arrow_upward</span>
              </button>
              <button
                onTouchStart={() => handlePedestal(-1)}
                onClick={() => handlePedestal(-1)}
                className="w-10 h-11 bg-white/10 border border-white/20 rounded flex items-center justify-center active:bg-primary active:text-black transition-colors"
                title="Camera Down"
              >
                <span className="material-symbols-outlined text-sm">arrow_downward</span>
              </button>
            </div>

            {/* Pan / Tilt Look Touch Pad */}
            <div className="flex flex-col items-center gap-2">
              <div
                className="w-28 h-28 rounded-2xl bg-white/5 border border-white/20 flex flex-col items-center justify-center touch-none backdrop-blur-sm active:border-primary/50"
                onTouchStart={handleLookTouchStart}
                onTouchMove={handleLookTouchMove}
                onTouchEnd={handleLookTouchEnd}
                onTouchCancel={handleLookTouchEnd}
              >
                <span className="material-symbols-outlined text-white/30 text-2xl mb-1">
                  open_with
                </span>
                <span className="text-[9px] text-white/40 tracking-wider">
                  DRAG LOOK
                </span>
              </div>
              <span className="text-[9px] text-white/50 tracking-widest uppercase">
                Pan / Tilt
              </span>
            </div>
          </div>
        </div>

        {/* Bottom Master Transport Bar */}
        <footer className="relative z-20 flex items-center justify-between px-4 py-2 bg-black/70 backdrop-blur-md rounded-lg border border-white/10">
          {/* Left: Timeline Rewind & Play Controls */}
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
                  ? 'bg-primary/20 border-primary text-primary'
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
              className={`px-6 py-2.5 rounded-full font-black text-xs tracking-widest flex items-center gap-2 shadow-lg transition-all active:scale-95 ${
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

          {/* Right: Take Info */}
          <div className="flex items-center gap-2 text-right">
            <div className="text-[10px] text-white/60">
              <span>{hostState.activeTakeName || 'READY FOR TAKE'}</span>
              <div className="text-white/40 text-[9px]">16:9 FULL HD</div>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
};

export default MobileCameraRemote;
