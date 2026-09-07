import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Project, CharacterActor, CameraTake, CameraKeyframe, DeviceOrientationData, RemoteMoveData, CameraPoseData } from '../../types';
import { ThreeStage } from '../viewport/ThreeStage';
import { DEFAULT_INITIAL_ACTORS } from './ActingSetupView';
import { CameraRemoteSocket } from '../../services/cameraRemoteService';
import qrcode from 'qrcode-generator';

interface CameraRecordViewProps {
  currentProject: Project;
  onUpdateProject?: (updated: Project) => void;
}

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

export const CameraRecordView: React.FC<CameraRecordViewProps> = ({ currentProject, onUpdateProject }) => {
  // Mode: Live Camera Flight vs Playback Take Review
  const [viewMode, setViewMode] = useState<'live' | 'playback'>('live');
  const [isRecording, setIsRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [showQRPairing, setShowQRPairing] = useState(false);
  const [focalLength, setFocalLength] = useState('35mm');
  const [iso, setIso] = useState('800');

  // Video Export State
  const webglCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isExportingVideo, setIsExportingVideo] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const abortExportRef = useRef(false);

  // Takes Management
  const [takes, setTakes] = useState<CameraTake[]>(currentProject.cameraTakes || []);
  const [activeTakeId, setActiveTakeId] = useState<string | null>(
    currentProject.cameraTakes && currentProject.cameraTakes.length > 0
      ? currentProject.cameraTakes[currentProject.cameraTakes.length - 1].id
      : null
  );
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Synchronize actors from project or default initial actors
  const characters: CharacterActor[] = (currentProject.characters && currentProject.characters.length > 0)
    ? currentProject.characters
    : DEFAULT_INITIAL_ACTORS;

  const assets = currentProject.scenes || [];
  const maxDuration = Math.max(5.0, ...characters.map((c) => c.duration || (c.motionData?.duration) || 4.0));

  // Active Take Reference
  const activeTake = takes.find((t) => t.id === activeTakeId) || (takes.length > 0 ? takes[takes.length - 1] : null);
  const effectiveDuration = (viewMode === 'playback' && activeTake) ? activeTake.duration : maxDuration;

  // Master Timeline Animation State
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [timelineSec, setTimelineSec] = useState<number>(0);
  const [playbackSpeed] = useState<number>(1.0);

  // Keyframes buffer collected while recording
  const recordedFramesRef = useRef<CameraKeyframe[]>([]);

  // Frame Recording Callback from ThreeStage
  const handleRecordFrame = useCallback((frame: CameraKeyframe) => {
    recordedFramesRef.current.push(frame);
  }, []);

  // Stop Recording Handler
  const stopRecording = useCallback(() => {
    setIsRecording(false);
    setIsPlaying(false);

    const frames = [...recordedFramesRef.current];
    if (frames.length > 5) {
      const recordedDuration = Number(Math.max(0.5, timelineSec).toFixed(2));
      const takeNumber = takes.length + 1;
      const newTake: CameraTake = {
        id: `take_${Date.now()}`,
        name: `Take ${takeNumber}`,
        createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        duration: recordedDuration,
        keyframes: frames,
        focalLength,
        fps: 60,
      };

      const updatedTakes = [...takes, newTake];
      setTakes(updatedTakes);
      setActiveTakeId(newTake.id);
      setViewMode('playback'); // Seamlessly transition to review take mode!
      setTimelineSec(0);

      if (onUpdateProject) {
        onUpdateProject({
          ...currentProject,
          cameraTakes: updatedTakes,
        });
      }

      setToastMessage(`Take ${takeNumber} recorded! (${recordedDuration}s • ${frames.length} frames) — Press Play to Review!`);
      setTimeout(() => setToastMessage(null), 4500);
    } else {
      setToastMessage('Take too short — recorded frames discarded.');
      setTimeout(() => setToastMessage(null), 3000);
    }
  }, [takes, timelineSec, focalLength, currentProject, onUpdateProject]);

  // 60 FPS Master Timeline Animation Loop
  const lastTimeRef = useRef<number>(performance.now());
  useEffect(() => {
    let animFrame: number;
    const updateTimeline = (now: number) => {
      const dt = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;

      const dur = (viewMode === 'playback' && activeTake) ? activeTake.duration : maxDuration;

      if (isPlaying) {
        setTimelineSec((prev) => {
          const next = prev + dt * playbackSpeed;
          if (next >= dur) {
            if (isRecording) {
              // Automatically wrap up recording when timeline finishes sequence
              stopRecording();
              return dur;
            } else if (viewMode === 'playback' && !isExportingVideo) {
              // Pause cleanly at end of take review
              setIsPlaying(false);
              return dur;
            } else if (isExportingVideo) {
              return dur;
            } else {
              // Loop live standby playback
              return 0;
            }
          }
          return next;
        });
      }
      animFrame = requestAnimationFrame(updateTimeline);
    };
    animFrame = requestAnimationFrame(updateTimeline);
    return () => cancelAnimationFrame(animFrame);
  }, [isPlaying, playbackSpeed, maxDuration, viewMode, activeTake, isRecording, isExportingVideo, stopRecording]);

  // Recording Duration Counter
  useEffect(() => {
    let timer: any;
    if (isRecording) {
      timer = setInterval(() => {
        setRecSeconds((prev) => prev + 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isRecording]);

  // Toggle Record Button Handler
  const handleToggleRecord = () => {
    if (!isRecording) {
      // Start recording
      recordedFramesRef.current = [];
      setTimelineSec(0);
      setViewMode('live');
      setIsRecording(true);
      setRecSeconds(0);
      setIsPlaying(true); // Actors start animating from t=0
    } else {
      // Stop recording
      stopRecording();
    }
  };

  const handleRewind = () => {
    setTimelineSec(0);
  };

  // --- Mobile Remote Controller Integration ---
  const [remoteRoomId] = useState<string>(() => `take_${Math.random().toString(36).substring(2, 8)}`);
  const [lanIp, setLanIp] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const host = window.location.hostname;
      if (host && host !== 'localhost' && host !== '127.0.0.1') return host;
    }
    return '192.168.101.246';
  });
  const [isPhoneConnected, setIsPhoneConnected] = useState<boolean>(false);
  const [phonePeerCount, setPhonePeerCount] = useState<number>(0);
  const [remoteOrientation, setRemoteOrientation] = useState<DeviceOrientationData | null>(null);
  const [remoteMove, setRemoteMove] = useState<RemoteMoveData | null>(null);
  const [remoteLook, setRemoteLook] = useState<{ deltaPitch: number; deltaYaw: number } | null>(null);
  const [calibrateTrigger, setCalibrateTrigger] = useState<number>(0);
  const [incomingCameraPose, setIncomingCameraPose] = useState<CameraPoseData | null>(null);
  const remoteSocketRef = useRef<CameraRemoteSocket | null>(null);

  // Auto-fetch LAN IP address from server endpoint
  useEffect(() => {
    fetch('/api/network-ip')
      .then((r) => r.json())
      .then((data) => {
        if (data.ip && data.ip !== 'localhost' && data.ip !== '127.0.0.1') {
          setLanIp(data.ip);
        }
      })
      .catch(() => {});
  }, []);

  const handleToggleRecordRef = useRef(handleToggleRecord);
  handleToggleRecordRef.current = handleToggleRecord;

  const handleRewindRef = useRef(handleRewind);
  handleRewindRef.current = handleRewind;

  // Connect Host WebSocket
  useEffect(() => {
    const socket = new CameraRemoteSocket('host', remoteRoomId);
    remoteSocketRef.current = socket;

    const unsubStatus = socket.onStatus((_connected, count) => {
      setIsPhoneConnected(count > 1);
      setPhonePeerCount(count);
    });

    const unsubMsg = socket.onMessage((msg) => {
      if (msg.type === 'peer_joined' && msg.role === 'remote') {
        setIsPhoneConnected(true);
        socket.sendInitScene(currentProject);
        setToastMessage('📱 Mobile Phone Connected! Ready for Landscape 16:9 Tracking.');
        setTimeout(() => setToastMessage(null), 4000);
      } else if (msg.type === 'peer_left' && msg.role === 'remote') {
        setIsPhoneConnected(false);
        setIncomingCameraPose(null);
        setToastMessage('📱 Mobile Phone Disconnected.');
        setTimeout(() => setToastMessage(null), 3000);
      } else if (msg.type === 'camera_pose') {
        setIncomingCameraPose(msg.pose);
      } else if (msg.type === 'gyro') {
        setRemoteOrientation(msg.orientation);
      } else if (msg.type === 'move') {
        setRemoteMove(msg.move);
      } else if (msg.type === 'look') {
        setRemoteLook({ deltaPitch: msg.deltaPitch, deltaYaw: msg.deltaYaw });
      } else if (msg.type === 'toggle_record') {
        handleToggleRecordRef.current();
      } else if (msg.type === 'set_focal_length') {
        setFocalLength(msg.focalLength);
      } else if (msg.type === 'calibrate') {
        setCalibrateTrigger((prev) => prev + 1);
      } else if (msg.type === 'rewind') {
        handleRewindRef.current();
      } else if (msg.type === 'toggle_play') {
        setIsPlaying((prev) => !prev);
      } else if ((msg as any).type === 'request_scene') {
        socket.sendInitScene(currentProject);
      }
    });

    return () => {
      unsubStatus();
      unsubMsg();
      socket.destroy();
      remoteSocketRef.current = null;
    };
  }, [remoteRoomId, currentProject]);

  // Sync Host State back to Phone Remote Controller
  useEffect(() => {
    if (remoteSocketRef.current && isPhoneConnected) {
      remoteSocketRef.current.sendHostState({
        isRecording,
        isPlaying,
        timelineSec,
        effectiveDuration,
        focalLength,
        activeTakeName: activeTake?.name,
      });
    }
  }, [isRecording, isPlaying, timelineSec, effectiveDuration, focalLength, activeTake, isPhoneConnected]);

  const cleanIp = (!lanIp || lanIp === 'localhost' || lanIp === '127.0.0.1') ? '192.168.101.246' : lanIp;
  const proto = typeof window !== 'undefined' ? window.location.protocol : 'http:';
  const remoteUrl = `${proto}//${cleanIp}:3000/#/remote?room=${remoteRoomId}&project=${currentProject.id}`;
  const qrSvgHtml = useMemo(() => {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(remoteUrl);
      qr.make();
      return qr.createSvgTag(6, 0);
    } catch (e) {
      console.warn('QR code generation error:', e);
      return null;
    }
  }, [remoteUrl]);

  const handleDeleteTake = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (window.confirm('Delete this recorded camera take?')) {
      const updated = takes.filter((t) => t.id !== id);
      setTakes(updated);
      if (activeTakeId === id) {
        if (updated.length > 0) {
          setActiveTakeId(updated[updated.length - 1].id);
        } else {
          setActiveTakeId(null);
          setViewMode('live');
        }
      }
      if (onUpdateProject) {
        onUpdateProject({
          ...currentProject,
          cameraTakes: updated,
        });
      }
    }
  };

  const handleExportTakeJson = (take: CameraTake, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(take, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `${take.name.toLowerCase().replace(/\s+/g, '_')}_camera.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  // High-Quality 16:9 Viewfinder MP4 Video Export Engine
  const exportTakeToVideo = async (takeToExport?: CameraTake | null) => {
    const targetTake = takeToExport || activeTake;
    if (!targetTake || !targetTake.keyframes || targetTake.keyframes.length === 0) {
      setToastMessage('No recorded camera take available to export.');
      setTimeout(() => setToastMessage(null), 3000);
      return;
    }

    const webglCanvas = webglCanvasRef.current;
    if (!webglCanvas) {
      setToastMessage('3D Viewport canvas not ready for video capture.');
      setTimeout(() => setToastMessage(null), 3000);
      return;
    }

    // Determine best supported MIME type (prefer MP4, fallback to WebM)
    const mimeCandidates = [
      'video/mp4;codecs=avc1',
      'video/mp4;codecs=h264',
      'video/mp4',
      'video/webm;codecs=h264',
      'video/webm;codecs=vp9',
      'video/webm',
    ];
    let selectedMime = 'video/webm';
    for (const cand of mimeCandidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(cand)) {
        selectedMime = cand;
        break;
      }
    }
    const ext = selectedMime.includes('mp4') ? 'mp4' : 'webm';

    // Set up offscreen 16:9 Full HD canvas (1920x1080)
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = 1920;
    exportCanvas.height = 1080;
    const ctx = exportCanvas.getContext('2d', { alpha: false, willReadFrequently: false });
    if (!ctx) return;

    // Set up MediaRecorder
    const stream = exportCanvas.captureStream(60);
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: selectedMime,
        videoBitsPerSecond: 12000000, // 12 Mbps high quality 1080p
      });
    } catch (err) {
      console.warn('Failed to initialize MediaRecorder with candidate, using default:', err);
      recorder = new MediaRecorder(stream);
    }

    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
      }
    };

    abortExportRef.current = false;
    setIsExportingVideo(true);
    setExportProgress(0);

    // Switch to playback mode and rewind
    setActiveTakeId(targetTake.id);
    setViewMode('playback');
    setTimelineSec(0);
    setIsPlaying(true);

    recorder.start(100);

    const startTime = performance.now();
    const durationMs = targetTake.duration * 1000;
    let capturedFirstFrameDataUrl: string | null = null;

    const renderLoop = () => {
      if (abortExportRef.current) {
        try { recorder.stop(); } catch (_) {}
        setIsExportingVideo(false);
        setIsPlaying(false);
        setToastMessage('Export cancelled.');
        setTimeout(() => setToastMessage(null), 3000);
        return;
      }

      // Crop WebGL canvas to exact 16:9 aspect ratio
      const srcW = webglCanvas.width;
      const srcH = webglCanvas.height;
      const targetAspect = 16 / 9;
      const srcAspect = srcW / srcH;
      let sx = 0, sy = 0, sw = srcW, sh = srcH;
      if (srcAspect > targetAspect) {
        // Canvas is wider than 16:9 -> crop horizontal sides
        sw = srcH * targetAspect;
        sx = (srcW - sw) / 2;
      } else {
        // Canvas is taller than 16:9 -> crop top/bottom
        sh = srcW / targetAspect;
        sy = (srcH - sh) / 2;
      }

      ctx.drawImage(webglCanvas, sx, sy, sw, sh, 0, 0, 1920, 1080);

      // Capture exact first frame (frame 0) of the video at 1080p Full HD
      if (!capturedFirstFrameDataUrl) {
        capturedFirstFrameDataUrl = exportCanvas.toDataURL('image/png');
      }

      const elapsed = performance.now() - startTime;
      const progress = Math.min(100, Math.round((elapsed / durationMs) * 100));
      setExportProgress(progress);

      if (elapsed < durationMs) {
        requestAnimationFrame(renderLoop);
      } else {
        // Final frame render
        ctx.drawImage(webglCanvas, sx, sy, sw, sh, 0, 0, 1920, 1080);
        setTimeout(() => {
          recorder.onstop = () => {
            const videoBlob = new Blob(chunks, { type: selectedMime });
            const downloadUrl = URL.createObjectURL(videoBlob);
            const a = document.createElement('a');
            const safeName = targetTake.name.toLowerCase().replace(/\s+/g, '_');

            // 1. Download the 16:9 Video
            a.href = downloadUrl;
            a.download = `${safeName}_16x9.${ext}`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(downloadUrl), 15000);

            // 2. Download the captured first frame (frame 0) as 1080p PNG image
            if (capturedFirstFrameDataUrl) {
              const imgAnchor = document.createElement('a');
              imgAnchor.href = capturedFirstFrameDataUrl;
              imgAnchor.download = `${safeName}_frame0_poster.png`;
              document.body.appendChild(imgAnchor);
              imgAnchor.click();
              imgAnchor.remove();

              // 3. Save thumbnail in take metadata
              const updatedTakes = takes.map((t) =>
                t.id === targetTake.id ? { ...t, thumbnail: capturedFirstFrameDataUrl! } : t
              );
              setTakes(updatedTakes);
              if (onUpdateProject) {
                onUpdateProject({
                  ...currentProject,
                  cameraTakes: updatedTakes,
                });
              }
            }

            setIsExportingVideo(false);
            setIsPlaying(false);
            setTimelineSec(0);
            setToastMessage(`✅ ${targetTake.name} exported: ${ext.toUpperCase()} video + 1080p first frame PNG captured!`);
            setTimeout(() => setToastMessage(null), 5000);
          };
          try {
            recorder.stop();
          } catch (e) {
            console.error('Error stopping MediaRecorder:', e);
            setIsExportingVideo(false);
          }
        }, 150);
      }
    };

    // Begin render frame loop
    requestAnimationFrame(renderLoop);
  };

  // Capture Current 16:9 Viewfinder Frame as 1080p PNG Still
  const captureFrameImage = (takeToCapture?: CameraTake | null, customFilename?: string): string | null => {
    const targetTake = takeToCapture || activeTake;
    const webglCanvas = webglCanvasRef.current;
    if (!webglCanvas) {
      setToastMessage('3D Viewport canvas not ready.');
      setTimeout(() => setToastMessage(null), 3000);
      return null;
    }

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = 1920;
    exportCanvas.height = 1080;
    const ctx = exportCanvas.getContext('2d', { alpha: false });
    if (!ctx) return null;

    const srcW = webglCanvas.width;
    const srcH = webglCanvas.height;
    const targetAspect = 16 / 9;
    const srcAspect = srcW / srcH;
    let sx = 0, sy = 0, sw = srcW, sh = srcH;
    if (srcAspect > targetAspect) {
      sw = srcH * targetAspect;
      sx = (srcW - sw) / 2;
    } else {
      sh = srcW / targetAspect;
      sy = (srcH - sh) / 2;
    }

    ctx.drawImage(webglCanvas, sx, sy, sw, sh, 0, 0, 1920, 1080);
    const dataUrl = exportCanvas.toDataURL('image/png');

    const filename = customFilename || `${(targetTake?.name || 'still').toLowerCase().replace(/\s+/g, '_')}_frame0_poster.png`;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();

    if (targetTake) {
      const updatedTakes = takes.map((t) =>
        t.id === targetTake.id ? { ...t, thumbnail: dataUrl } : t
      );
      setTakes(updatedTakes);
      if (onUpdateProject) {
        onUpdateProject({
          ...currentProject,
          cameraTakes: updatedTakes,
        });
      }
    }

    setToastMessage(`📸 1080p 16:9 still frame captured & downloaded as PNG!`);
    setTimeout(() => setToastMessage(null), 4000);

    return dataUrl;
  };

  const currentFov = LENS_FOV_MAP[focalLength] || 54;

  return (
    <div className="relative w-full h-[calc(100vh-61px)] overflow-hidden bg-background select-none">
      {/* 3D Scene Viewport with Stage Assets, Character Actors, and Camera Recording/Playback */}
      <ThreeStage
        assets={assets}
        selectedAssetId={null}
        characters={characters}
        currentTimelineTime={timelineSec}
        isPlaying={isPlaying}
        showTrajectories={false}
        panoramaUrl={currentProject.panoramaUrl}
        panoramaRotation={currentProject.panoramaRotation || 0}
        splatUrl={currentProject.splatUrl}
        cameraFov={currentFov}
        isRecordingCamera={isRecording}
        onRecordCameraFrame={handleRecordFrame}
        isPlaybackTake={viewMode === 'playback'}
        playbackTake={activeTake}
        showCameraTrajectory={!isExportingVideo}
        remoteOrientation={remoteOrientation}
        remoteMove={remoteMove}
        remoteLook={remoteLook}
        calibrateTrigger={calibrateTrigger}
        incomingCameraPose={incomingCameraPose}
        onCanvasReady={(canvas) => {
          webglCanvasRef.current = canvas;
        }}
      />

      {/* Toast Alert Banner */}
      {toastMessage && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-40 bg-surface-container-highest/95 border border-primary/50 text-primary px-4 py-2 rounded-xl backdrop-blur-xl shadow-2xl font-mono text-xs flex items-center gap-2 animate-in fade-in slide-in-from-top-2 duration-200">
          <span className="material-symbols-outlined text-primary text-[18px]">check_circle</span>
          <span>{toastMessage}</span>
        </div>
      )}

      {/* 16:9 Video Export Rendering Modal */}
      {isExportingVideo && (
        <div className="fixed inset-0 z-50 bg-background/85 backdrop-blur-md flex items-center justify-center p-md">
          <div className="bg-surface-container border border-cyan-500/50 p-6 max-w-md w-full rounded-2xl shadow-2xl text-center relative flex flex-col items-center gap-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="w-12 h-12 rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center border border-cyan-500/40 animate-pulse">
              <span className="material-symbols-outlined text-[28px]">movie</span>
            </div>
            <div>
              <h3 className="font-headline-sm text-cyan-300 font-semibold mb-1">
                Capturing 16:9 Video
              </h3>
              <p className="text-xs text-on-surface-variant font-mono">
                Rendering {activeTake?.name} ({activeTake?.duration}s) at 1080p 60 FPS...
              </p>
            </div>

            {/* Progress Bar */}
            <div className="w-full bg-surface-container-highest rounded-full h-3 overflow-hidden border border-outline-variant/40 p-0.5">
              <div
                className="bg-gradient-to-r from-cyan-500 to-teal-400 h-full rounded-full transition-all duration-100 ease-out"
                style={{ width: `${exportProgress}%` }}
              />
            </div>
            <div className="flex justify-between w-full text-[11px] font-mono text-on-surface-variant">
              <span>{exportProgress}%</span>
              <span>1080p Widescreen (16:9)</span>
            </div>

            <button
              onClick={() => {
                abortExportRef.current = true;
              }}
              className="px-4 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-xs font-label-caps text-on-surface-variant hover:text-red-400 border border-outline-variant/40 cursor-pointer transition-colors"
            >
              Cancel Export
            </button>
          </div>
        </div>
      )}

      {/* Cinematic Viewfinder HUD Overlay */}
      <div className="absolute inset-0 pointer-events-none p-4 pb-2 flex flex-col justify-between z-20">
        {/* Top HUD Bar */}
        <div className="flex justify-between items-start">
          {/* Left: Mode Switcher, Recording Status & Active Cast */}
          <div className="flex flex-col gap-2 pointer-events-auto">
            {/* Primary Mode Switcher Pills */}
            <div className="flex items-center gap-2">
              <div className="flex items-center bg-surface-container/90 backdrop-blur-md rounded-lg p-0.5 border border-outline-variant/40 shadow-md">
                <button
                  onClick={() => {
                    setViewMode('live');
                    setIsPlaying(true);
                  }}
                  className={`px-3 py-1 text-xs font-label-caps rounded-md cursor-pointer flex items-center gap-1.5 transition-all ${
                    viewMode === 'live'
                      ? 'bg-primary text-background font-semibold shadow-sm'
                      : 'text-on-surface-variant hover:text-primary'
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full ${isRecording ? 'bg-red-500 animate-ping' : 'bg-emerald-400'}`} />
                  LIVE CAMERA
                </button>
                <button
                  onClick={() => {
                    if (takes.length > 0) {
                      setViewMode('playback');
                      setTimelineSec(0);
                      setIsPlaying(false);
                    }
                  }}
                  disabled={takes.length === 0}
                  className={`px-3 py-1 text-xs font-label-caps rounded-md cursor-pointer flex items-center gap-1.5 transition-all ${
                    takes.length === 0 ? 'opacity-40 cursor-not-allowed text-on-surface-variant' : ''
                  } ${
                    viewMode === 'playback'
                      ? 'bg-cyan-500 text-background font-semibold shadow-sm'
                      : 'text-on-surface-variant hover:text-cyan-400'
                  }`}
                >
                  <span className="material-symbols-outlined text-[15px]">movie</span>
                  REVIEW TAKES {takes.length > 0 ? `(${takes.length})` : ''}
                </button>
              </div>

              {/* Status Badge */}
              {viewMode === 'live' ? (
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-xs bg-background/85 backdrop-blur-md px-md py-xs rounded border border-outline-variant/30 font-label-caps text-xs shadow-md">
                    <span className={`w-2.5 h-2.5 rounded-full ${isRecording ? 'bg-red-500 animate-ping' : 'bg-green-500'}`} />
                    <span className="text-primary tracking-widest font-semibold">{isRecording ? 'RECORDING TAKE' : 'STANDBY'}</span>
                  </div>
                  {isRecording && (
                    <span className="font-mono text-xs text-red-400 font-bold tracking-widest bg-background/85 backdrop-blur-md px-sm py-xs border border-red-500/50 rounded shadow-md">
                      REC 00:{recSeconds.toString().padStart(2, '0')}
                    </span>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 bg-cyan-950/80 border border-cyan-500/40 backdrop-blur-md px-3 py-1 rounded text-cyan-300 text-xs font-mono shadow-md">
                    <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                    <span>PLAYBACK MONITOR: {activeTake?.name}</span>
                    <span className="text-[10px] text-cyan-400/80">({activeTake?.duration}s)</span>
                  </div>
                </div>
              )}
            </div>

            {/* Takes Selector Pills Bar (Visible in Playback Mode) */}
            {viewMode === 'playback' && takes.length > 0 && (
              <div className="flex items-center gap-1.5 bg-background/85 backdrop-blur-md p-1 rounded-lg border border-outline-variant/30 shadow-md overflow-x-auto max-w-xl">
                <span className="font-mono text-[10px] text-on-surface-variant font-medium tracking-wider uppercase px-1">
                  TAKES:
                </span>
                {takes.map((t) => (
                  <div
                    key={t.id}
                    onClick={() => {
                      setActiveTakeId(t.id);
                      setTimelineSec(0);
                      setIsPlaying(false);
                    }}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-mono cursor-pointer transition-all border ${
                      activeTake?.id === t.id
                        ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500 font-semibold'
                        : 'bg-surface-container/60 text-on-surface-variant border-transparent hover:border-outline-variant/60'
                    }`}
                  >
                    {t.thumbnail && (
                      <img
                        src={t.thumbnail}
                        alt={t.name}
                        className="w-7 h-4 rounded object-cover border border-cyan-500/40 shadow-sm"
                      />
                    )}
                    <span>{t.name}</span>
                    <span className="text-[10px] opacity-70">({t.duration}s)</span>
                    {activeTake?.id === t.id && (
                      <div className="flex items-center gap-1 ml-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            exportTakeToVideo(t);
                          }}
                          title="Export 16:9 MP4 Video"
                          className="hover:text-emerald-400 text-cyan-300"
                        >
                          <span className="material-symbols-outlined text-[13px]">movie</span>
                        </button>
                        <button
                          onClick={(e) => handleExportTakeJson(t, e)}
                          title="Export Take JSON"
                          className="hover:text-white"
                        >
                          <span className="material-symbols-outlined text-[13px]">download</span>
                        </button>
                        <button
                          onClick={(e) => handleDeleteTake(t.id, e)}
                          title="Delete Take"
                          className="hover:text-red-400"
                        >
                          <span className="material-symbols-outlined text-[13px]">delete</span>
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Cast On Set Badges */}
            <div className="flex items-center gap-1.5 bg-background/80 backdrop-blur-md px-2.5 py-1 rounded-lg border border-outline-variant/30 text-xs shadow-sm">
              <span className="font-mono text-[10px] text-on-surface-variant font-medium tracking-wider uppercase mr-1">
                CAST ({characters.length}):
              </span>
              {characters.map((actor) => (
                <div
                  key={actor.id}
                  className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-surface-container-high/90 border border-outline-variant/40"
                  style={{ borderColor: `${actor.color}40` }}
                >
                  <span className="text-xs">{actor.avatar || '👤'}</span>
                  <span className="font-mono text-[11px] font-semibold text-on-surface" style={{ color: actor.color }}>
                    {actor.name}
                  </span>
                  {actor.motionData ? (
                    <span className="text-[9px] font-mono text-cyan-400 bg-cyan-950/60 px-1 py-0.2 rounded border border-cyan-500/30">
                      DIFFUSION (30FPS)
                    </span>
                  ) : (
                    <span className="text-[9px] font-mono text-on-surface-variant/80">
                      {actor.currentAnimation || 'Idle'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Right: Camera Optical Specs & Take Count */}
          <div className="flex flex-col gap-2 items-end pointer-events-auto">
            <div className="flex items-center gap-sm font-label-caps text-xs text-on-surface-variant bg-background/85 backdrop-blur-md px-md py-xs rounded border border-outline-variant/30 shadow-md">
              <span className="text-primary font-medium">LENS: {focalLength} ({currentFov}°)</span>
              <span className="text-outline-variant">|</span>
              <span>ISO: {iso}</span>
              <span className="text-outline-variant">|</span>
              <span className="text-emerald-400 font-medium font-mono">60 FPS</span>
            </div>
            {takes.length > 0 && (
              <div className="font-mono text-[10px] text-cyan-400/90 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-500/30">
                {takes.length} {takes.length === 1 ? 'TAKE' : 'TAKES'} RECORDED
              </div>
            )}
          </div>
        </div>

        {/* Large 16:9 Director Viewfinder Framing Guide & Matte Mask */}
        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[88vw] max-w-5xl max-h-[66vh] aspect-video pointer-events-none z-20 flex flex-col justify-between p-3"
          style={{ aspectRatio: '16 / 9' }}
        >
          {/* Outer Border & Cinematic Letterbox Matte Shadow */}
          <div
            className={`absolute inset-0 rounded-lg pointer-events-none transition-all duration-300 border-2 ${
              isRecording
                ? 'border-red-500 shadow-[0_0_0_9999px_rgba(0,0,0,0.50)]'
                : viewMode === 'playback'
                ? 'border-cyan-400/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.40)]'
                : 'border-primary/50 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]'
            }`}
          />

          {/* 4 Corner L-Brackets */}
          <div
            className={`w-8 h-8 border-t-4 border-l-4 absolute top-0 left-0 rounded-tl transition-colors ${
              isRecording ? 'border-red-500' : viewMode === 'playback' ? 'border-cyan-400' : 'border-primary'
            }`}
          />
          <div
            className={`w-8 h-8 border-t-4 border-r-4 absolute top-0 right-0 rounded-tr transition-colors ${
              isRecording ? 'border-red-500' : viewMode === 'playback' ? 'border-cyan-400' : 'border-primary'
            }`}
          />
          <div
            className={`w-8 h-8 border-b-4 border-l-4 absolute bottom-0 left-0 rounded-bl transition-colors ${
              isRecording ? 'border-red-500' : viewMode === 'playback' ? 'border-cyan-400' : 'border-primary'
            }`}
          />
          <div
            className={`w-8 h-8 border-b-4 border-r-4 absolute bottom-0 right-0 rounded-br transition-colors ${
              isRecording ? 'border-red-500' : viewMode === 'playback' ? 'border-cyan-400' : 'border-primary'
            }`}
          />

          {/* 90% Action Safe Frame Line */}
          <div
            className={`absolute inset-[5%] border border-dashed rounded pointer-events-none opacity-40 transition-colors ${
              isRecording ? 'border-red-400/60' : viewMode === 'playback' ? 'border-cyan-400/60' : 'border-primary/40'
            }`}
          />

          {/* Rule of Thirds Grid Lines */}
          <div className="absolute inset-0 pointer-events-none grid grid-cols-3 grid-rows-3 opacity-15">
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

          {/* Center Crosshairs & Reticle */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none flex items-center justify-center">
            <div className={`w-8 h-[1px] absolute ${isRecording ? 'bg-red-500/70' : 'bg-primary/50'}`} />
            <div className={`h-8 w-[1px] absolute ${isRecording ? 'bg-red-500/70' : 'bg-primary/50'}`} />
            <div
              className={`w-2.5 h-2.5 rounded-full ${
                isRecording ? 'bg-red-500 animate-pulse' : viewMode === 'playback' ? 'bg-cyan-400/70' : 'bg-primary/70'
              }`}
            />
          </div>

          {/* Top Edge Metadata Badges */}
          <div className="relative flex justify-between items-center px-2 pt-1 text-[10px] font-mono tracking-wider">
            <div className="flex items-center gap-2">
              <span
                className={`px-2 py-0.5 rounded font-bold backdrop-blur-md border ${
                  isRecording
                    ? 'bg-red-950/80 text-red-300 border-red-500/50'
                    : viewMode === 'playback'
                    ? 'bg-cyan-950/80 text-cyan-300 border-cyan-500/50'
                    : 'bg-background/80 text-primary border-outline-variant/40'
                }`}
              >
                16:9 • 1.78:1
              </span>
              <span className="text-on-surface-variant/80 hidden sm:inline">
                SAFE AREA 90%
              </span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-on-surface-variant/80 hidden sm:inline">
                {isRecording ? 'RECORDING 16:9 DCI' : viewMode === 'playback' ? '16:9 PLAYBACK MONITOR' : '16:9 FRAMING'}
              </span>
              <span
                className={`px-2 py-0.5 rounded font-bold backdrop-blur-md border ${
                  isRecording
                    ? 'bg-red-950/80 text-red-400 border-red-500/50 animate-pulse'
                    : 'bg-background/80 text-on-surface-variant border-outline-variant/40'
                }`}
              >
                {isRecording ? 'REC ACTIVE' : '60 FPS'}
              </span>
            </div>
          </div>

          {/* Center Play & Export Buttons for Take Review Mode */}
          {viewMode === 'playback' && !isPlaying && activeTake && !isExportingVideo && (
            <div className="relative my-auto flex flex-col items-center gap-3 pointer-events-auto z-30">
              <div className="flex items-center gap-3 flex-wrap justify-center">
                <button
                  onClick={() => {
                    if (timelineSec >= activeTake.duration) {
                      setTimelineSec(0);
                    }
                    setIsPlaying(true);
                  }}
                  className="px-6 py-3.5 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-background font-label-caps text-sm tracking-widest font-bold shadow-2xl flex items-center gap-2 hover:scale-105 active:scale-95 transition-all cursor-pointer border border-cyan-300"
                >
                  <span className="material-symbols-outlined text-[24px]">play_arrow</span>
                  PLAY RECORDED {activeTake.name.toUpperCase()}
                </button>

                <button
                  onClick={() => exportTakeToVideo(activeTake)}
                  className="px-6 py-3.5 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-label-caps text-sm tracking-widest font-bold shadow-2xl flex items-center gap-2 hover:scale-105 active:scale-95 transition-all cursor-pointer border border-emerald-400"
                  title="Render and download this take as a 1080p 16:9 MP4 video file (also auto-captures first frame PNG)"
                >
                  <span className="material-symbols-outlined text-[22px]">download</span>
                  EXPORT 16:9 MP4
                </button>

                <button
                  onClick={() => {
                    setTimelineSec(0);
                    setIsPlaying(false);
                    setTimeout(() => {
                      const safeName = activeTake.name.toLowerCase().replace(/\s+/g, '_');
                      captureFrameImage(activeTake, `${safeName}_frame0_poster.png`);
                    }, 60);
                  }}
                  className="px-5 py-3.5 rounded-2xl bg-surface-container-highest/90 hover:bg-surface-container-highest text-cyan-300 font-label-caps text-sm tracking-widest font-bold shadow-2xl flex items-center gap-2 hover:scale-105 active:scale-95 transition-all cursor-pointer border border-cyan-500/40 backdrop-blur-md"
                  title="Capture first frame (frame 0) as high-res 1080p 16:9 PNG image"
                >
                  <span className="material-symbols-outlined text-[20px]">photo_camera</span>
                  CAPTURE 1ST FRAME
                </button>
              </div>

              <div className="flex items-center gap-2 bg-background/90 px-3 py-1 rounded-full border border-cyan-500/40 backdrop-blur-md text-[11px] font-mono text-cyan-300 shadow-lg">
                <span>{activeTake.keyframes.length} Frames</span>
                <span>•</span>
                <span>{activeTake.duration}s Sequence</span>
                <span>•</span>
                <span>1080p 16:9 Video Ready</span>
              </div>
            </div>
          )}

          {/* Bottom Edge Metadata Badges */}
          <div className="relative flex justify-between items-center px-2 pb-1 text-[10px] font-mono tracking-wider mt-auto">
            <span className="text-on-surface-variant/70">
              VIRTUAL CAM 01
            </span>
            <span className="text-on-surface-variant/70">
              FOV {currentFov}° • {focalLength}
            </span>
          </div>
        </div>

        {/* Bottom Floating Control Bar - Unified Single Row Anchored at Bottom */}
        <div className="w-full flex items-center justify-between gap-3 pointer-events-auto pb-1">
          {/* Left: Mobile Camera Pairing Button */}
          <button
            onClick={() => setShowQRPairing(true)}
            className={`border px-3 py-2 rounded-xl backdrop-blur-md text-xs font-label-caps tracking-wider flex items-center gap-1.5 cursor-pointer shadow-lg whitespace-nowrap transition-colors ${
              isPhoneConnected
                ? 'bg-[#4ade80]/15 border-[#4ade80] text-[#4ade80]'
                : 'bg-surface-container/90 border-outline-variant/40 hover:border-primary text-primary'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isPhoneConnected ? 'bg-[#4ade80] shadow-[0_0_6px_#4ade80]' : 'bg-primary'
              }`}
            />
            {isPhoneConnected ? '📱 PHONE SYNCED' : 'PAIR PHONE'}
          </button>

          {/* Center: Unified Play & Record Bar */}
          <div className="flex-1 max-w-3xl bg-surface-container/95 border border-outline-variant/40 rounded-xl px-3 py-2 backdrop-blur-xl shadow-2xl flex items-center gap-3">
            {/* Record / Stop Button right next to play controls */}
            {viewMode === 'live' ? (
              <button
                onClick={handleToggleRecord}
                className={`h-9 px-3.5 rounded-lg flex items-center gap-2 cursor-pointer shadow-lg transition-all font-label-caps text-xs font-bold tracking-wider whitespace-nowrap ${
                  isRecording
                    ? 'bg-red-600 ring-2 ring-red-400/50 text-white animate-pulse'
                    : 'bg-red-600 hover:bg-red-500 text-white'
                }`}
                title={isRecording ? 'Stop Recording Take' : 'Start Recording Take'}
              >
                <span className="material-symbols-outlined text-[18px]">
                  {isRecording ? 'stop' : 'fiber_manual_record'}
                </span>
                <span>{isRecording ? 'STOP REC' : 'REC'}</span>
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => {
                    setViewMode('live');
                    handleToggleRecord();
                  }}
                  className="h-9 px-3 rounded-lg bg-red-600 hover:bg-red-500 text-white font-label-caps text-xs font-bold tracking-wider flex items-center gap-1.5 cursor-pointer shadow-lg transition-all whitespace-nowrap"
                  title="Start recording a new take immediately"
                >
                  <span className="material-symbols-outlined text-[16px]">videocam</span>
                  <span>NEW TAKE</span>
                </button>
                <button
                  onClick={() => {
                    setTimelineSec(0);
                    setIsPlaying(true);
                  }}
                  className="h-9 px-2.5 rounded-lg bg-cyan-950/80 hover:bg-cyan-500 hover:text-background text-cyan-300 border border-cyan-500/40 font-label-caps text-xs font-semibold flex items-center gap-1 cursor-pointer transition-colors whitespace-nowrap"
                  title="Replay Take"
                >
                  <span className="material-symbols-outlined text-[16px]">replay</span>
                  <span>REPLAY</span>
                </button>
                <button
                  onClick={() => exportTakeToVideo(activeTake)}
                  disabled={isExportingVideo}
                  className="h-9 px-2.5 rounded-lg bg-emerald-700/90 hover:bg-emerald-600 text-white font-label-caps text-xs font-bold tracking-wider flex items-center gap-1 cursor-pointer shadow-lg transition-all whitespace-nowrap border border-emerald-500/40"
                  title="Render and download this take as an MP4 video (also auto-captures first frame PNG)"
                >
                  <span className="material-symbols-outlined text-[16px]">download</span>
                  <span>EXPORT MP4</span>
                </button>
                <button
                  onClick={() => captureFrameImage(activeTake)}
                  disabled={isExportingVideo}
                  className="h-9 px-2 rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-cyan-300 font-label-caps text-xs font-semibold flex items-center gap-1 cursor-pointer shadow-lg transition-all whitespace-nowrap border border-cyan-500/30"
                  title="Capture current 1080p 16:9 frame and download as PNG"
                >
                  <span className="material-symbols-outlined text-[15px]">photo_camera</span>
                  <span>STILL</span>
                </button>
              </div>
            )}

            <div className="w-[1px] h-6 bg-outline-variant/40" />

            {/* Play/Pause Button */}
            <button
              onClick={() => {
                if (!isPlaying && timelineSec >= effectiveDuration) {
                  setTimelineSec(0);
                }
                setIsPlaying(!isPlaying);
              }}
              className={`p-1.5 rounded-lg border transition-colors flex items-center justify-center cursor-pointer ${
                viewMode === 'playback'
                  ? 'bg-cyan-500/20 hover:bg-cyan-500 hover:text-background text-cyan-300 border-cyan-500/50'
                  : 'bg-surface-container-high hover:bg-primary hover:text-background text-primary border-outline-variant/50'
              }`}
              title={isPlaying ? 'Pause' : 'Play'}
            >
              <span className="material-symbols-outlined text-[20px]">
                {isPlaying ? 'pause' : 'play_arrow'}
              </span>
            </button>

            {/* Rewind Button */}
            <button
              onClick={handleRewind}
              className="p-1.5 rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant hover:text-on-surface border border-outline-variant/50 transition-colors flex items-center justify-center cursor-pointer"
              title="Rewind to Frame 0"
            >
              <span className="material-symbols-outlined text-[18px]">
                skip_previous
              </span>
            </button>

            {/* Timeline Progress Slider */}
            <div className="flex-1 flex flex-col gap-1 min-w-[120px]">
              <input
                type="range"
                min="0"
                max={effectiveDuration}
                step="0.033"
                value={timelineSec}
                onChange={(e) => {
                  setTimelineSec(parseFloat(e.target.value));
                }}
                className={`w-full h-1.5 rounded-lg appearance-none cursor-pointer ${
                  viewMode === 'playback'
                    ? 'bg-cyan-950 accent-cyan-400'
                    : 'bg-surface-container-highest accent-primary'
                }`}
              />
            </div>

            {/* Timecode Indicator */}
            <div
              className={`font-mono text-xs font-semibold tracking-wider whitespace-nowrap px-2 py-1 rounded border ${
                viewMode === 'playback'
                  ? 'text-cyan-300 bg-cyan-950/60 border-cyan-500/40'
                  : 'text-primary bg-surface-container-highest/80 border-outline-variant/30'
              }`}
            >
              {formatTime(timelineSec)} / {formatTime(effectiveDuration)}
            </div>

            {/* Mode Switch to Live Camera in Playback Mode */}
            {viewMode === 'playback' && (
              <button
                onClick={() => {
                  setViewMode('live');
                  setIsPlaying(true);
                }}
                className="px-2 py-1 text-[11px] font-label-caps rounded bg-surface-container-high hover:bg-surface-container-highest text-on-surface border border-outline-variant/50 flex items-center gap-1 cursor-pointer transition-colors whitespace-nowrap"
                title="Return to Live Camera flight"
              >
                <span className="material-symbols-outlined text-[14px]">videocam</span>
                LIVE
              </button>
            )}
          </div>

          {/* Right: Lens & ISO Preset Selectors */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-xs bg-surface-container/90 border border-outline-variant/40 p-1 rounded-xl backdrop-blur-md shadow-md">
              <span className="font-label-caps text-[9px] text-on-surface-variant px-1">LENS</span>
              {['24mm', '35mm', '50mm', '85mm'].map((fl) => (
                <button
                  key={fl}
                  onClick={() => setFocalLength(fl)}
                  className={`px-2 py-1 text-[11px] font-label-caps rounded cursor-pointer transition-colors ${
                    focalLength === fl ? 'bg-primary text-background font-medium' : 'text-on-surface-variant hover:text-primary'
                  }`}
                >
                  {fl}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-xs bg-surface-container/90 border border-outline-variant/40 p-1 rounded-xl backdrop-blur-md shadow-md">
              <span className="font-label-caps text-[9px] text-on-surface-variant px-1">ISO</span>
              {['400', '800', '1600'].map((val) => (
                <button
                  key={val}
                  onClick={() => setIso(val)}
                  className={`px-2 py-1 text-[11px] font-label-caps rounded cursor-pointer transition-colors ${
                    iso === val ? 'bg-primary text-background font-medium' : 'text-on-surface-variant hover:text-primary'
                  }`}
                >
                  {val}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* QR Pairing Modal for Module 3 */}
      {showQRPairing && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-md flex items-center justify-center p-md">
          <div className="bg-surface-container border border-outline-variant/40 p-xl max-w-sm w-full rounded-2xl shadow-2xl text-center relative animate-in fade-in zoom-in-95 duration-200">
            <button
              onClick={() => setShowQRPairing(false)}
              className="absolute top-md right-md text-on-surface-variant hover:text-primary cursor-pointer p-1"
            >
              ✕
            </button>
            <span className="font-label-caps text-[11px] text-primary tracking-widest block mb-xs">
              STAGE 03: VIRTUAL CAMERA
            </span>
            <h3 className="font-headline-sm text-primary mb-2 font-semibold">
              Connect Mobile Director
            </h3>
            <div className="inline-block px-2.5 py-0.5 bg-primary/10 border border-primary/20 rounded-full mb-3">
              <span className="text-[10px] font-mono text-primary uppercase font-bold tracking-wider">
                16:9 Landscape Enforced
              </span>
            </div>

            {/* Dynamic QR Code Box */}
            <div className="w-52 h-52 mx-auto bg-white p-3 rounded-xl flex flex-col items-center justify-center border border-outline-variant/40 mb-3 shadow-inner">
              {qrSvgHtml ? (
                <div
                  className="w-full h-full flex items-center justify-center [&>svg]:w-full [&>svg]:h-full"
                  dangerouslySetInnerHTML={{ __html: qrSvgHtml }}
                />
              ) : (
                <span className="material-symbols-outlined text-background text-[110px]">
                  qr_code_2
                </span>
              )}
            </div>

            {/* Live Pairing Status Indicator */}
            <div className="mb-3 flex items-center justify-center gap-2">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  isPhoneConnected
                    ? 'bg-[#4ade80] shadow-[0_0_8px_#4ade80]'
                    : 'bg-amber-400 animate-pulse'
                }`}
              />
              <span className="text-xs font-mono font-bold text-on-surface">
                {isPhoneConnected
                  ? `PHONE CONNECTED (${phonePeerCount - 1} ACTIVE)`
                  : 'WAITING FOR SCAN...'}
              </span>
            </div>

            <p className="text-xs text-on-surface-variant mb-3 leading-relaxed">
              Scan with your iPhone, iPad or Android device to enable real-time 60 FPS gyroscope camera tracking in 16:9 widescreen.
            </p>

            {/* Controller Guidance */}
            <div className="mb-3 bg-white/5 border border-white/10 rounded-lg p-2.5 text-left text-xs space-y-1">
              <div className="font-bold text-primary flex items-center gap-1.5 text-[11px]">
                <span className="material-symbols-outlined text-[14px]">screen_rotation</span>
                16:9 Landscape Remote Viewfinder
              </div>
              <div className="text-[10px] text-on-surface-variant leading-relaxed">
                Connect on your phone in landscape mode. Tilt phone to aim camera, or swipe the right side of the screen anytime to pan &amp; tilt.
              </div>
            </div>

            {/* Direct URL & Copy Button */}
            <div className="flex items-center gap-2 mb-4 bg-surface-container-highest/60 p-2 rounded-lg border border-outline-variant/30 text-left">
              <span className="text-[10px] font-mono text-on-surface-variant truncate flex-1 select-all">
                {remoteUrl}
              </span>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(remoteUrl);
                  setToastMessage('Mobile remote URL copied to clipboard!');
                  setTimeout(() => setToastMessage(null), 2500);
                }}
                className="px-2 py-1 text-[10px] font-mono font-bold bg-primary/20 hover:bg-primary/30 text-primary rounded cursor-pointer whitespace-nowrap active:scale-95"
              >
                COPY
              </button>
            </div>

            {isPhoneConnected && (
              <button
                onClick={() => {
                  setCalibrateTrigger((p) => p + 1);
                  setToastMessage('Forward direction re-calibrated to 0°');
                  setTimeout(() => setToastMessage(null), 2500);
                }}
                className="w-full mb-2 font-mono text-xs bg-white/10 hover:bg-white/20 border border-white/20 text-white py-2 rounded-lg font-medium cursor-pointer flex items-center justify-center gap-1.5"
              >
                <span className="material-symbols-outlined text-sm">my_location</span>
                CALIBRATE 0° FORWARD
              </button>
            )}

            <button
              onClick={() => setShowQRPairing(false)}
              className="w-full font-label-caps text-xs bg-primary text-background py-sm rounded-lg font-bold cursor-pointer hover:bg-primary/90 transition-colors"
            >
              DONE
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
