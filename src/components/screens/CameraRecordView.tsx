import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  CameraHeadPass,
  Project,
  CharacterActor,
  CameraTake,
  CameraKeyframe,
  DeviceOrientationData,
  RemoteMoveData,
  CameraPoseData,
  DepthOfFieldConfig,
  TakeRender,
  TakeVideoRender,
} from '../../types';
import { ThreeStage, type ActorVisibilityFn, type DepthCaptureFn, type DepthMap } from '../viewport/ThreeStage';
import { DEFAULT_INITIAL_ACTORS } from './ActingSetupView';
import { CameraRemoteSocket, LinkStats } from '../../services/cameraRemoteService';
import { stabilizeKeyframes } from '../../services/cameraStabilizer';
import { DEFAULT_TENSION, insertKeyframe, withKeyHandles, EASY_EASE_HANDLE, activeHeadPass } from '../../services/cameraAnimation';
import { KeyframeTimeline } from '../camera/KeyframeTimeline';
import { KeyInspector } from '../camera/KeyInspector';
import { CameraPackagePicker } from '../camera/CameraPackagePicker';
import { TakeRenderPanel, type FirstFrameCapture } from '../camera/TakeRenderPanel';
import type { PeopleMask } from '../../services/renderService';
import { objectAnimationEnd } from '../../services/objectAnimation';
import { EXPORT_FRAME_RATES, createFrameExporter } from '../../services/videoExport';
import { DEFAULT_PACKAGE, normalizePackage, packageLabel, cameraById, lensById, type CameraPackage } from '../../services/cameraPackage';
import { useDialogueAudioSync } from '../../services/dialogueService';
import qrcode from 'qrcode-generator';

interface CameraRecordViewProps {
  currentProject: Project;
  onUpdateProject?: (updated: Project) => void;
}

const LENS_FOV_MAP: Record<string, number> = {
  '18mm': 90,
  '24mm': 74,
  '35mm': 54,
  '50mm': 40,
  '85mm': 24,
  '135mm': 15,
};

/** The lens whose field of view is closest - a keyed fov between two lenses reads as the nearer. */
function nearestLens(fov: number): string {
  let best = '35mm';
  let bestDiff = Infinity;
  for (const [lens, lensFov] of Object.entries(LENS_FOV_MAP)) {
    const diff = Math.abs(lensFov - fov);
    if (diff < bestDiff) {
      best = lens;
      bestDiff = diff;
    }
  }
  return best;
}

const KEY_LENSES = Object.entries(LENS_FOV_MAP).map(([label, fov]) => ({ label, fov }));

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms}`;
}

/** Stabilizer strength for newly recorded takes: removes typical hand shake, keeps deliberate moves. */
const DEFAULT_STABILIZER = 35;

// The operator's current camera package is a per-browser preference; each take stores its own.
const PACKAGE_STORAGE_KEY = 'pantilt.cameraPackage';

function loadStoredPackage(): CameraPackage {
  try {
    return normalizePackage(JSON.parse(localStorage.getItem(PACKAGE_STORAGE_KEY) || 'null') || DEFAULT_PACKAGE);
  } catch {
    return DEFAULT_PACKAGE;
  }
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export const CameraRecordView: React.FC<CameraRecordViewProps> = ({ currentProject, onUpdateProject }) => {
  // Mode: Live Camera Flight vs Playback Take Review
  const [viewMode, setViewMode] = useState<'live' | 'playback'>('live');
  const [isRecording, setIsRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [showQRPairing, setShowQRPairing] = useState(false);
  const [focalLength, setFocalLength] = useState('35mm');
  const [iso, setIso] = useState('800');

  // Camera body, lens set and film back: recorded onto every take, used when the take is rendered.
  const [cameraPackage, setCameraPackageState] = useState<CameraPackage>(loadStoredPackage);
  const [showPackageMenu, setShowPackageMenu] = useState(false);
  const setCameraPackage = (pkg: CameraPackage) => {
    setCameraPackageState(pkg);
    try {
      localStorage.setItem(PACKAGE_STORAGE_KEY, JSON.stringify(pkg));
    } catch {
      // Private windows can refuse storage; the choice still holds for this visit.
    }
  };
  const [renderTakeId, setRenderTakeId] = useState<string | null>(null);

  // Cinematic Depth of Field & Optics State
  const [aperture, setAperture] = useState<string>('f/2.8');
  const [focusMode, setFocusMode] = useState<'auto' | 'manual'>('auto');
  const [focusDistance, setFocusDistance] = useState<number>(3.5);
  const [autoFocusReadout, setAutoFocusReadout] = useState<number>(3.5);
  const [focusPeaking, setFocusPeaking] = useState<boolean>(false);
  const [showFocusPullerMenu, setShowFocusPullerMenu] = useState<boolean>(false);


  // Video Export State
  const webglCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isExportingVideo, setIsExportingVideo] = useState(false);
  // Frame rate of the exported MP4. 24/25/30 are rendered frame by frame at exact times; 60 is the
  // older live recording of the viewport, whose real rate depends on how fast the scene draws.
  const [exportFps, setExportFpsState] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem('pantilt.exportFps'));
      if ([...EXPORT_FRAME_RATES, 60].includes(saved as any)) return saved;
    } catch {
      // Private windows can refuse storage.
    }
    return 24;
  });
  const setExportFps = (fps: number) => {
    setExportFpsState(fps);
    try {
      localStorage.setItem('pantilt.exportFps', String(fps));
    } catch {
      // The choice still holds for this visit.
    }
  };
  /** True while an export steps the clock itself, one frame at a time, instead of letting it run. */
  const [frameStepping, setFrameStepping] = useState(false);
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
  const maxDuration = Math.max(
    5.0,
    currentProject.dialogue?.duration || 0,
    ...characters.map((c) => c.duration || (c.motionData?.duration) || 4.0),
    // A car still driving after the actors finish is part of the scene's length too.
    objectAnimationEnd(assets)
  );

  // Active Take Reference
  const activeTake = takes.find((t) => t.id === activeTakeId) || (takes.length > 0 ? takes[takes.length - 1] : null);
  const effectiveDuration = (viewMode === 'playback' && activeTake) ? activeTake.duration : maxDuration;

  // What playback and export actually fly: the recorded path with the take's stabilizer applied.
  //
  // A keyed move is never stabilized - there is no handheld shake in it to smooth, and running a
  // hand-placed key through a smoothing filter would drag it off the position it was placed at.
  const stabilizedTake = useMemo<CameraTake | null>(() => {
    if (!activeTake || !activeTake.stabilizer) return activeTake;
    if (activeTake.mode === 'keyed') {
      // A crane take: steady the operated head pass the same way a handheld take is steadied.
      // The keys (position, lens, focus) are programmed and need no steadying.
      const pass = activeHeadPass(activeTake);
      if (!pass) return activeTake;
      const smoothed = stabilizeKeyframes(
        pass.samples.map((p) => ({ time: p.time, position: [0, 0, 0] as [number, number, number], quaternion: p.quaternion })),
        activeTake.stabilizer
      );
      return {
        ...activeTake,
        headPasses: activeTake.headPasses!.map((p) =>
          p.id === pass.id ? { ...p, samples: smoothed.map((k) => ({ time: k.time, quaternion: k.quaternion })) } : p
        ),
      };
    }
    return { ...activeTake, keyframes: stabilizeKeyframes(activeTake.keyframes, activeTake.stabilizer) };
  }, [activeTake]);

  const isKeyedTake = activeTake?.mode === 'keyed';

  /**
   * Crane mode: the keyed move holds the camera's position while the head is operated live, and
   * REC records the head (orientation) as a pass over the move instead of a new take. Armed per
   * move, and only once there is a move (two keys).
   */
  const [craneArmed, setCraneArmed] = useState(false);
  const craneActive = craneArmed && isKeyedTake && (activeTake?.keyframes.length ?? 0) >= 2;
  useEffect(() => { setCraneArmed(false); }, [activeTakeId]);
  const craneTake = useMemo(
    () => (craneActive && activeTake
      ? { mode: 'keyed' as const, keyframes: activeTake.keyframes, tension: activeTake.tension, duration: activeTake.duration }
      : null),
    [craneActive, activeTake]
  );
  const headSamplesRef = useRef<CameraHeadPass['samples']>([]);
  const handleRecordHeadSample = useCallback((sample: CameraHeadPass['samples'][number]) => {
    headSamplesRef.current.push(sample);
  }, []);

  /** Does the move being edited actually key the lens? If so the shader has to be running. */
  const keyedLens = useMemo(() => {
    const keys = activeTake?.mode === 'keyed' ? activeTake.keyframes : [];
    return {
      focus: keys.some((k) => (k.focusDistance ?? 0) > 0),
      iris: keys.some((k) => (k.aperture ?? 0) > 0),
    };
  }, [activeTake]);

  const dofConfig = useMemo<DepthOfFieldConfig>(() => ({
    // A keyed rack focus turns depth of field on by itself. Keying focus and seeing nothing
    // happen because the IRIS control was left OFF is not a useful lesson.
    enabled: aperture !== 'OFF' || keyedLens.focus || keyedLens.iris,
    aperture:
      aperture === 'OFF'
        ? (keyedLens.iris || keyedLens.focus ? 2.8 : 999.0)
        : parseFloat(aperture.replace('f/', '')) || 2.8,
    focusDistance: focusDistance,
    focalLengthMm: parseInt(focalLength.replace('mm', '')) || 35,
    autoFocus: focusMode === 'auto',
    focusPeaking: focusPeaking,
    bokehScale: 1.0,
  }), [aperture, focusDistance, focalLength, focusMode, focusPeaking, keyedLens]);


  // Master Timeline Animation State
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [timelineSec, setTimelineSec] = useState<number>(0);
  const [playbackSpeed] = useState<number>(1.0);
  // Hear the scene's dialogue while recording or reviewing camera takes.
  useDialogueAudioSync(currentProject.dialogue?.audioUrl, isPlaying && !frameStepping, timelineSec, playbackSpeed);

  // ---- Hand-keyed camera moves ------------------------------------------------------------
  const [showKeyPanel, setShowKeyPanel] = useState<boolean>(false);
  const [showNewTakeMenu, setShowNewTakeMenu] = useState<boolean>(false);
  const [keyCaptureTrigger, setKeyCaptureTrigger] = useState<number>(0);
  /**
   * When set, the next capture is filed at THIS time rather than the playhead's.
   *
   * That is what "re-take this key" means: correct where an existing key looks from without
   * having to land the playhead exactly on it first.
   */
  const captureAtRef = useRef<number | null>(null);
  const [selectedKeyTime, setSelectedKeyTime] = useState<number | null>(null);

  /**
   * Edits the take being worked on AND writes it into the project.
   *
   * Takes only reach disk when something hands the new array to onUpdateProject - there is no
   * effect watching this state. Every key edit goes through here, so this is the one place that
   * has to remember, which is what it was not doing: keys survived until the screen was left.
   */
  const updateActiveTake = useCallback(
    (change: (t: CameraTake) => CameraTake) => {
      if (!activeTake) return;
      const next = takes.map((t) => (t.id === activeTake.id ? change(t) : t));
      setTakes(next);
      onUpdateProject?.({ ...currentProject, cameraTakes: next });
    },
    [activeTake, takes, currentProject, onUpdateProject]
  );

  // A render finishes about two minutes after it starts, so it must write into the takes and the
  // project as they are THEN, not as they were when the button was pressed.
  const latestRef = useRef({ takes, currentProject, onUpdateProject });
  latestRef.current = { takes, currentProject, onUpdateProject };
  const mountedRef = useRef(true);
  useEffect(() => {
    // Set on mount as well as cleared on unmount: React's development mode mounts every screen
    // twice, and a flag only ever cleared stayed false, so every finished render was dropped.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * A character sheet added or removed in the render window goes onto that character in the
   * scene, so every later render of the scene sends it too. A scene still showing the default
   * actors gets them written out as its own characters, with the sheet on the one it belongs to.
   */
  const handleUpdateCharacter = useCallback((id: string, patch: Partial<CharacterActor>) => {
    const { currentProject: project, onUpdateProject: update } = latestRef.current;
    const current = project.characters && project.characters.length > 0 ? project.characters : DEFAULT_INITIAL_ACTORS;
    update?.({ ...project, characters: current.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  }, []);

  const handleTakeRendered = useCallback((takeId: string, render: TakeRender) => {
    // Once this screen is gone its project copy is stale, and writing it would undo later edits.
    // The frame itself is already saved on the server either way.
    if (!mountedRef.current) return;
    const { takes: latestTakes, currentProject: project, onUpdateProject: update } = latestRef.current;
    const next = latestTakes.map((t) => (t.id === takeId ? { ...t, renders: [...(t.renders || []), render] } : t));
    setTakes(next);
    update?.({ ...project, cameraTakes: next });
    setToastMessage('Render finished.');
    setTimeout(() => setToastMessage(null), 3000);
  }, []);

  /** A change made in the render window (package, look, pass, note) is kept on the take. */
  const handleUpdateTake = useCallback((takeId: string, patch: Partial<CameraTake>) => {
    if (!mountedRef.current) return;
    const { takes: latestTakes, currentProject: project, onUpdateProject: update } = latestRef.current;
    const next = latestTakes.map((t) => (t.id === takeId ? { ...t, ...patch } : t));
    setTakes(next);
    update?.({ ...project, cameraTakes: next });
  }, []);

  const handleVideoRendered = useCallback((takeId: string, video: TakeVideoRender) => {
    if (!mountedRef.current) return;
    const { takes: latestTakes, currentProject: project, onUpdateProject: update } = latestRef.current;
    const next = latestTakes.map((t) => (t.id === takeId ? { ...t, videoRenders: [...(t.videoRenders || []), video] } : t));
    setTakes(next);
    update?.({ ...project, cameraTakes: next });
    setToastMessage('Video render finished.');
    setTimeout(() => setToastMessage(null), 3000);
  }, []);

  /** The approved render every later render of this scene is matched to, or none. */
  const handleSetMaster = useCallback((url: string | undefined) => {
    const { currentProject: project, onUpdateProject: update } = latestRef.current;
    update?.({ ...project, setMasterUrl: url });
  }, []);

  const depthCaptureRef = useRef<DepthCaptureFn | null>(null);
  const actorVisibilityRef = useRef<ActorVisibilityFn | null>(null);
  // Read inside the capture above, which is created once.
  const dofRef = useRef(dofConfig);
  dofRef.current = dofConfig;
  const autoFocusRef = useRef(autoFocusReadout);
  autoFocusRef.current = autoFocusReadout;

  /** The on-screen camera frame (the blue 16:9 rectangle) - what the operator is framing. */
  const frameGuideRef = useRef<HTMLDivElement | null>(null);

  /**
   * Where the camera frame sits on the canvas, as fractions of its width and height. The frame is
   * a DOM overlay (88% of the window, capped), smaller than the canvas, so cropping the canvas's
   * own widest 16:9 captured more than the operator framed. Falls back to that crop if the frame
   * is not on screen.
   */
  const frameRectOnCanvas = (canvas: HTMLCanvasElement) => {
    const c = canvas.getBoundingClientRect();
    const f = frameGuideRef.current?.getBoundingClientRect();
    if (f && c.width > 0 && c.height > 0 && f.width > 0 && f.height > 0) {
      // Its width and max-height rules can leave the box a little off 16:9 on some window
      // shapes; take the largest 16:9 centred inside it so nothing is squashed.
      let fw = f.width;
      let fh = f.height;
      if (fw / fh > 16 / 9) fw = fh * (16 / 9);
      else fh = fw / (16 / 9);
      const left = f.left + (f.width - fw) / 2;
      const top = f.top + (f.height - fh) / 2;
      const x = Math.max(0, (left - c.left) / c.width);
      const y = Math.max(0, (top - c.top) / c.height);
      return { x, y, w: Math.min(1 - x, fw / c.width), h: Math.min(1 - y, fh / c.height) };
    }
    const target = 16 / 9;
    const aspect = canvas.width / canvas.height;
    return aspect > target
      ? { x: (1 - target / aspect) / 2, y: 0, w: target / aspect, h: 1 }
      : { x: 0, y: (1 - aspect / target) / 2, w: 1, h: aspect / target };
  };

  /** Exactly the camera frame, at 1080p. */
  const grabViewport = (): string | null => {
    const canvas = webglCanvasRef.current;
    if (!canvas || !canvas.width || !canvas.height) return null;
    const out = document.createElement('canvas');
    out.width = 1920;
    out.height = 1080;
    const ctx = out.getContext('2d', { alpha: false });
    if (!ctx) return null;
    const r = frameRectOnCanvas(canvas);
    ctx.drawImage(canvas, r.x * canvas.width, r.y * canvas.height, r.w * canvas.width, r.h * canvas.height, 0, 0, 1920, 1080);
    return out.toDataURL('image/jpeg', 0.92);
  };

  /** The depth map cut to the same camera frame as the picture. */
  const cropDepthToFrame = (depth: DepthMap | null): DepthMap | null => {
    const canvas = webglCanvasRef.current;
    if (!depth || !canvas) return depth;
    const r = frameRectOnCanvas(canvas);
    const x0 = Math.floor(r.x * depth.width);
    const y0 = Math.floor(r.y * depth.height);
    const w = Math.max(1, Math.min(depth.width - x0, Math.round(r.w * depth.width)));
    const h = Math.max(1, Math.min(depth.height - y0, Math.round(r.h * depth.height)));
    const metres = new Float32Array(w * h);
    for (let y = 0; y < h; y++) metres.set(depth.metres.subarray((y0 + y) * depth.width + x0, (y0 + y) * depth.width + x0 + w), y * w);
    return { width: w, height: h, metres };
  };

  /**
   * Which actor covers each pixel of the camera frame right now: what the camera sees (things in
   * front hide an actor) and each whole figure, both cut to the blue frame like the picture.
   */
  const peopleInFrame = (): PeopleMask | null => {
    const canvas = webglCanvasRef.current;
    const map = actorVisibilityRef.current?.(1600);
    if (!map || !canvas) return null;
    const r = frameRectOnCanvas(canvas);
    const x0 = Math.floor(r.x * map.width);
    const y0 = Math.floor(r.y * map.height);
    const w = Math.max(1, Math.min(map.width - x0, Math.round(r.w * map.width)));
    const h = Math.max(1, Math.min(map.height - y0, Math.round(r.h * map.height)));
    const ids = new Uint8Array(w * h);
    const fullIds = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const from = (y0 + y) * map.width + x0;
      ids.set(map.ids.subarray(from, from + w), y * w);
      fullIds.set(map.fullIds.subarray(from, from + w), y * w);
    }
    return { width: w, height: h, ids, fullIds, actorIds: map.actorIds };
  };

  /**
   * The actors that show in the frame, hidden ones (behind a wall, say) not counted. An actor needs
   * about 0.05% of the frame, so a far figure still counts but a stray pixel of an arm does not.
   */
  const actorsShowing = (people: PeopleMask | null): string[] | null => {
    if (!people) return null;
    const counts = new Array(people.actorIds.length + 1).fill(0);
    for (let p = 0; p < people.ids.length; p++) counts[people.ids[p]]++;
    const minPixels = Math.max(12, people.width * people.height * 0.0005);
    return people.actorIds.filter((_, i) => counts[i + 1] >= minPixels);
  };

  /**
   * The take's first frame exactly as the viewport draws it, depth of field included: the take
   * is put in playback at 0s and paused, and a few frames are let through so the camera and the
   * actors reach frame 1.
   */
  const captureTakeFirstFrame = useCallback(async (takeId: string): Promise<FirstFrameCapture | null> => {
    setActiveTakeId(takeId);
    setViewMode('playback');
    setIsPlaying(false);
    setTimelineSec(0);
    for (let i = 0; i < 6; i++) await nextFrame();
    await new Promise((r) => setTimeout(r, 250));
    await nextFrame();
    const frame = grabViewport();
    if (!frame) return null;

    // The same moment's depth, at the size the layout passes are worked on, and the lens the
    // viewport drew this frame with - so the passes can blur by exactly what that lens would.
    // Captured over the whole canvas, then cut to the camera frame like the picture.
    const depth = cropDepthToFrame(depthCaptureRef.current?.(1600) ?? null);
    const dof = dofRef.current;
    const lens = {
      focalMm: dof.focalLengthMm,
      stop: dof.enabled && dof.aperture < 100 ? dof.aperture : null,
      focusM: dof.autoFocus ? autoFocusRef.current || dof.focusDistance : dof.focusDistance,
    };
    const people = peopleInFrame();
    return { frame, depth, lens, people, inFrame: actorsShowing(people) };
  }, []);

  /** Starts an empty hand-keyed move and makes it the take being edited. */
  const handleNewKeyedTake = () => {
    const keyed: CameraTake = {
      id: `keyed_${Date.now()}`,
      name: `Move ${takes.filter((t) => t.mode === 'keyed').length + 1}`,
      createdAt: new Date().toISOString(),
      duration: 4,
      keyframes: [],
      mode: 'keyed',
      tension: DEFAULT_TENSION,
      fps: 60,
      // The same package and lens a recorded take is stamped with, so its render window opens set.
      focalLength,
      aperture,
      iso,
      cameraPackage,
    };
    const next = [...takes, keyed];
    setTakes(next);
    onUpdateProject?.({ ...currentProject, cameraTakes: next });
    setActiveTakeId(keyed.id);
    setViewMode('playback');
    setIsPlaying(false);
    setTimelineSec(0);
    setShowKeyPanel(true);
    setSelectedKeyTime(null);
    setToastMessage('New keyed move. Fly the camera, then SET KEY.');
    setTimeout(() => setToastMessage(null), 3000);
  };

  /**
   * The camera as it sits right now becomes a key at the playhead. Re-keying a time replaces the
   * key there, which is how you correct a position rather than stacking two keys on one frame.
   */
  const handleKeyCaptured = useCallback(
    (frame: CameraKeyframe) => {
      if (!activeTake || activeTake.mode !== 'keyed') return;
      const retake = captureAtRef.current !== null;
      const time = captureAtRef.current ?? frame.time;
      captureAtRef.current = null;
      const existing = activeTake.keyframes.find((k) => Math.abs(k.time - time) <= 1e-3);
      // Set Key keys the lens as the controls show it, not the viewport camera's fov: scrubbing
      // a keyed move puts an earlier key's fov on the camera, and reading that back stamped the
      // old lens (e.g. 15 = 135mm) on every new key while focus and iris were never keyed at all.
      // Re-take only replaces the pose, so it keeps the key's own lens.
      const lens: Partial<CameraKeyframe> = retake
        ? { fov: existing?.fov ?? frame.fov, focusDistance: existing?.focusDistance, aperture: existing?.aperture }
        : {
            fov: LENS_FOV_MAP[focalLength] ?? frame.fov,
            focusDistance: focusMode === 'auto' ? autoFocusReadout || focusDistance : focusDistance,
            aperture: aperture === 'OFF' ? undefined : parseFloat(aperture.replace('f/', '')) || undefined,
          };
      const key: CameraKeyframe = {
        ...frame,
        ...lens,
        time,
        // Keep whatever shaping the old key at this time had.
        ease: existing?.ease ?? 'ease-in-out',
        easeHandles: existing?.easeHandles,
        // A take already on per-key handles gives a new key its own, easing to a stop like the
        // old default; otherwise the segments around it would fall back to the old ease.
        ...(activeTake.keyframes.some((k) => k.handleIn || k.handleOut)
          ? {
              ease: existing?.ease === 'hold' ? 'hold' : undefined,
              easeHandles: undefined,
              handleIn: existing?.handleIn ?? { ...EASY_EASE_HANDLE },
              handleOut: existing?.handleOut ?? { ...EASY_EASE_HANDLE },
              handleMode: existing?.handleMode,
            }
          : {}),
        roll: existing?.roll,
      };
      const keyframes = insertKeyframe(activeTake.keyframes, key);
      updateActiveTake((t) => ({
        ...t,
        keyframes,
        duration: Math.max(t.duration, keyframes[keyframes.length - 1].time),
      }));
      setSelectedKeyTime(key.time);
      setToastMessage(existing ? `Key at ${key.time.toFixed(2)}s re-taken` : `Key set at ${key.time.toFixed(2)}s`);
      setTimeout(() => setToastMessage(null), 2000);
    },
    [activeTake, updateActiveTake, focalLength, focusMode, autoFocusReadout, focusDistance, aperture]
  );

  /**
   * On a keyed move the LENS / FOCUS / IRIS controls show the key at or before the playhead, so
   * what they say is what that key holds, and Set Key after changing one keys the change. Without
   * this the controls kept whatever was last clicked while the camera showed the key's lens.
   */
  const lensKey = useMemo(() => {
    if (!isKeyedTake || !activeTake || activeTake.keyframes.length === 0) return null;
    const keys = activeTake.keyframes;
    let k = keys[0];
    for (const key of keys) {
      if (key.time <= timelineSec + 1e-3) k = key;
      else break;
    }
    return k;
  }, [isKeyedTake, activeTake, timelineSec]);

  useEffect(() => {
    if (!lensKey) return;
    if (lensKey.fov) setFocalLength(nearestLens(lensKey.fov));
    if (lensKey.focusDistance && lensKey.focusDistance > 0) {
      setFocusDistance(lensKey.focusDistance);
      setFocusMode('manual');
    }
    if (lensKey.aperture && lensKey.aperture > 0) setAperture(`f/${lensKey.aperture.toFixed(1)}`);
  }, [lensKey?.fov, lensKey?.focusDistance, lensKey?.aperture, lensKey?.time]);

  /**
   * Jump the playhead to the key before or after the current time, and select it.
   *
   * Scrubbing by hand never lands exactly on a key, and "exactly on it" is what re-taking and
   * re-easing a key need - a hair off and Set Key makes a second key beside the first.
   */
  const goToAdjacentKey = useCallback(
    (direction: 1 | -1) => {
      const keys = activeTake?.keyframes || [];
      if (keys.length === 0) return;
      const EPS = 1e-3;
      const target =
        direction > 0
          ? keys.find((k) => k.time > timelineSec + EPS)
          : [...keys].reverse().find((k) => k.time < timelineSec - EPS);
      if (!target) return;
      setIsPlaying(false);
      setTimelineSec(target.time);
      setSelectedKeyTime(target.time);
    },
    [activeTake, timelineSec]
  );

  /** Replaces the selected key's pose with wherever the camera is now, keeping its time. */
  const handleRetakeKey = (time: number) => {
    captureAtRef.current = time;
    setKeyCaptureTrigger((n) => n + 1);
  };

  const handleDeleteKey = (time: number) => {
    updateActiveTake((t) => ({ ...t, keyframes: t.keyframes.filter((k) => k.time !== time) }));
    setSelectedKeyTime(null);
  };

  const handleKeyChange = (time: number, change: Partial<CameraKeyframe>) => {
    // The first handle edit on an older take converts its segment eases into per-key handles,
    // so the rest of the curve keeps its shape instead of jumping when the user grabs one key.
    const touchesHandles = 'handleIn' in change || 'handleOut' in change || 'handleMode' in change;
    updateActiveTake((t) => ({
      ...t,
      keyframes: (touchesHandles ? withKeyHandles(t.keyframes) : t.keyframes).map((k) => (k.time === time ? { ...k, ...change } : k)),
    }));
  };

  /** Moving a key in time re-sorts, so the list and playback never disagree about the order. */
  const handleMoveKey = (time: number, newTime: number) => {
    const clamped = Math.max(0, Number(newTime.toFixed(3)));
    updateActiveTake((t) => {
      const key = t.keyframes.find((k) => k.time === time);
      if (!key) return t;
      const keyframes = insertKeyframe(
        t.keyframes.filter((k) => k.time !== time),
        { ...key, time: clamped }
      );
      return { ...t, keyframes, duration: Math.max(t.duration, keyframes[keyframes.length - 1].time) };
    });
    setSelectedKeyTime(clamped);
  };

  /** Play/pause, from the transport button or the spacebar. */
  const togglePlay = useCallback(() => {
    setIsPlaying((playing) => {
      if (!playing && timelineSec >= effectiveDuration) setTimelineSec(0);
      return !playing;
    });
  }, [timelineSec, effectiveDuration]);

  /**
   * Space starts and stops playback, and nothing else.
   *
   * Without this it did whatever the focused control did, because a button keeps focus after a
   * click and the browser fires it again on space - so tapping space after pressing Set Key set
   * another key. preventDefault also stops the page scrolling under the viewport.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay]);

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

    if (craneActive && activeTake) {
      // A head pass over the keyed move, not a new take.
      //
      // Do NOT clear headSamplesRef here: this runs inside the timeline's state updater, which
      // React may call twice (it does in development), and the second call must find the same
      // samples or its "too short" outcome replaces the real pass. The take path below is
      // idempotent the same way. The buffer is emptied when the next pass starts.
      const samples = [...headSamplesRef.current];
      if (samples.length < 6) {
        setToastMessage('Pass too short - nothing recorded.');
        setTimeout(() => setToastMessage(null), 3000);
        return;
      }
      const passNumber = (activeTake.headPasses?.length ?? 0) + 1;
      const pass: CameraHeadPass = {
        id: `pass_${Date.now()}`,
        name: `Pass ${passNumber}`,
        createdAt: new Date().toISOString(),
        samples,
      };
      updateActiveTake((t) => ({
        ...t,
        headPasses: [...(t.headPasses || []), pass],
        activeHeadPassId: pass.id,
        stabilizer: t.stabilizer ?? DEFAULT_STABILIZER,
      }));
      // Disarm so pressing play shows the pass just recorded; arm again for another one.
      setCraneArmed(false);
      setTimelineSec(0);
      setToastMessage(`${pass.name} recorded - press play to watch it. Arm CRANE again for another pass.`);
      setTimeout(() => setToastMessage(null), 4500);
      return;
    }

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
        aperture,
        iso,
        cameraPackage,
        fps: 60,
        stabilizer: DEFAULT_STABILIZER,
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
  }, [takes, timelineSec, focalLength, aperture, iso, cameraPackage, currentProject, onUpdateProject, craneActive, activeTake, updateActiveTake]);

  // 60 FPS Master Timeline Animation Loop
  const lastTimeRef = useRef<number>(performance.now());
  useEffect(() => {
    let animFrame: number;
    const updateTimeline = (now: number) => {
      const dt = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;

      // A head pass runs exactly the length of the move it is operated over.
      const dur = isRecording && craneActive && activeTake
        ? activeTake.duration
        : (viewMode === 'playback' && activeTake) ? activeTake.duration : maxDuration;

      // A frame-by-frame export sets the time itself; the clock must not run under it.
      if (isPlaying && !frameStepping) {
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
  }, [isPlaying, frameStepping, playbackSpeed, maxDuration, viewMode, activeTake, isRecording, isExportingVideo, stopRecording, craneActive]);

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
    if (!isRecording && craneActive) {
      // Operate the head over the keyed move from its start.
      headSamplesRef.current = [];
      setTimelineSec(0);
      setIsRecording(true);
      setRecSeconds(0);
      setIsPlaying(true);
    } else if (!isRecording) {
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
  // One room per scene, so two operators shooting two scenes of the same film do not end up
  // driving each other's camera, and a phone that drops out reconnects to the right one.
  const remoteRoomId = useMemo(() => {
    if (typeof window !== 'undefined') {
      const hash = window.location.hash;
      const search = window.location.search;
      const urlParams = new URLSearchParams(search || (hash.includes('?') ? hash.split('?')[1] : ''));
      const r = urlParams.get('room');
      if (r) return r;
    }
    const sceneId = (currentProject as any).sceneId;
    return sceneId ? `${currentProject.id}:${sceneId}` : currentProject.id;
  }, [currentProject.id, (currentProject as any).sceneId]);

  // A short-lived code the phone trades for permission to join this room. Minted when the pairing
  // panel opens, because it expires in three minutes and a stale QR is worse than no QR.
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [linkStats, setLinkStats] = useState<LinkStats>({ transport: 'offline', rttMs: null, dropped: 0 });
  const [lanIp, setLanIp] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const host = window.location.hostname;
      if (host && host !== 'localhost' && host !== '127.0.0.1') return host;
    }
    return '192.168.100.38';
  });
  const [isPhoneConnected, setIsPhoneConnected] = useState<boolean>(false);
  const [phonePeerCount, setPhonePeerCount] = useState<number>(0);
  const [remoteOrientation, setRemoteOrientation] = useState<DeviceOrientationData | null>(null);
  const remoteOrientationRef = useRef<DeviceOrientationData | null>(null);
  const [remoteMove, setRemoteMove] = useState<RemoteMoveData | null>(null);
  const remoteMoveRef = useRef<RemoteMoveData | null>(null);
  const [remoteLook, setRemoteLook] = useState<{ deltaPitch: number; deltaYaw: number } | null>(null);
  const remoteLookRef = useRef<{ deltaPitch: number; deltaYaw: number } | null>(null);
  const [calibrateTrigger, setCalibrateTrigger] = useState<number>(0);
  const [incomingCameraPose, setIncomingCameraPose] = useState<CameraPoseData | null>(null);
  const incomingCameraPoseRef = useRef<CameraPoseData | null>(null);
  const remoteSocketRef = useRef<CameraRemoteSocket | null>(null);

  // Where should the phone go?
  //
  // Whatever address this page is already on, except in local development. Asking the server for
  // its own network address made sense when the server WAS this laptop; on a hosted box it answers
  // with the datacentre's IP and an internal port that no firewall lets through, which is exactly
  // how the QR ended up pointing at a host the phone could never reach.
  //
  // On localhost there is still nothing useful in the address bar - a phone cannot open
  // "localhost" and mean this machine - so the LAN lookup stays for that case alone.
  useEffect(() => {
    const host = typeof window !== 'undefined' ? window.location.hostname : '';
    const isLocal = host === 'localhost' || host === '127.0.0.1';
    if (!isLocal) return;

    fetch('/api/network-ip')
      .then((r) => r.json())
      .then((data) => {
        if (data.ip && data.ip !== 'localhost' && data.ip !== '127.0.0.1') {
          setLanIp(data.ip);
        }
      })
      .catch(() => {});
  }, []);

  // Ask for a fresh pairing code whenever the QR panel is opened, and again every two and a half
  // minutes while it stays open, so what is on screen is always claimable.
  useEffect(() => {
    if (!showQRPairing) return;
    let cancelled = false;

    const mint = async () => {
      try {
        const res = await fetch('/api/camera-remote/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ room: remoteRoomId, projectId: currentProject.id }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (data.success && data.code) {
          setPairingCode(data.code);
          setPairingError(null);
        } else {
          setPairingError(data.error || 'Could not create a pairing code.');
        }
      } catch (err: any) {
        if (!cancelled) setPairingError(err?.message || 'Could not reach the server for a pairing code.');
      }
    };

    mint();
    const id = setInterval(mint, 150000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [showQRPairing, remoteRoomId, currentProject.id]);

  const handleToggleRecordRef = useRef(handleToggleRecord);
  handleToggleRecordRef.current = handleToggleRecord;

  const handleRewindRef = useRef(handleRewind);
  handleRewindRef.current = handleRewind;

  // The socket reads the project through a ref so a project edit does not tear the connection down
  // and drop the phone mid-take; edits reach the phone through the resend effect below instead.
  const currentProjectRef = useRef(currentProject);
  currentProjectRef.current = currentProject;

  // Connect Host WebSocket
  useEffect(() => {
    const socket = new CameraRemoteSocket('host', remoteRoomId);
    remoteSocketRef.current = socket;

    const unsubStatus = socket.onStatus((_connected, count) => {
      setIsPhoneConnected(count > 1);
      setPhonePeerCount(count);
    });

    const unsubStats = socket.onStats(setLinkStats);

    const unsubMsg = socket.onMessage((msg) => {
      if (msg.type === 'peer_joined' && msg.role === 'remote') {
        setIsPhoneConnected(true);
        socket.sendInitScene(currentProjectRef.current);
        setToastMessage('📱 Mobile Phone Connected! Ready for Landscape 16:9 Tracking.');
        setTimeout(() => setToastMessage(null), 4000);
      } else if (msg.type === 'peer_left' && msg.role === 'remote') {
        setIsPhoneConnected(false);
        incomingCameraPoseRef.current = null;
        setIncomingCameraPose(null);
        remoteOrientationRef.current = null;
        setRemoteOrientation(null);
        remoteMoveRef.current = null;
        setRemoteMove(null);
        setToastMessage('📱 Mobile Phone Disconnected.');
        setTimeout(() => setToastMessage(null), 3000);
      } else if (msg.type === 'camera_pose') {
        incomingCameraPoseRef.current = msg.pose;
        if (!incomingCameraPose) {
          setIncomingCameraPose(msg.pose);
        }
      } else if (msg.type === 'gyro') {
        remoteOrientationRef.current = msg.orientation;
        setRemoteOrientation(msg.orientation);
      } else if (msg.type === 'move') {
        remoteMoveRef.current = msg.move;
        setRemoteMove(msg.move);
      } else if (msg.type === 'look') {
        remoteLookRef.current = { deltaPitch: msg.deltaPitch, deltaYaw: msg.deltaYaw };
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
        socket.sendInitScene(currentProjectRef.current);
      }
    });

    return () => {
      unsubStatus();
      unsubStats();
      unsubMsg();
      socket.destroy();
      remoteSocketRef.current = null;
    };
  }, [remoteRoomId]);

  // Resend the scene when the actors or set change while the phone is connected. Without this the
  // phone keeps whatever it received on connect, so motion generated afterwards never animates there.
  // Debounced because the project object changes in bursts (e.g. several updates per edit).
  useEffect(() => {
    if (!isPhoneConnected) return;
    const t = setTimeout(() => {
      remoteSocketRef.current?.sendInitScene(currentProjectRef.current);
    }, 400);
    return () => clearTimeout(t);
  }, [
    isPhoneConnected,
    currentProject.characters,
    currentProject.scenes,
    currentProject.panoramaUrl,
    currentProject.panoramaRotation,
    currentProject.splatUrl,
  ]);

  // Sync Host State back to Phone Remote Controller.
  // Discrete changes (play, record, lens, seek while paused) go out immediately. While playing, the
  // phone advances its own clock, so the timeline only needs a periodic correction instead of a
  // message every frame, which re-rendered the whole phone UI 60 times a second.
  const timelineSecRef = useRef(timelineSec);
  timelineSecRef.current = timelineSec;
  const sendHostStateNow = useCallback(() => {
    remoteSocketRef.current?.sendHostState({
      isRecording,
      isPlaying,
      timelineSec: timelineSecRef.current,
      effectiveDuration,
      focalLength,
      activeTakeName: activeTake?.name,
      playbackSpeed,
      // The phone rides the same path while its gyro operates the head.
      craneTake: craneTake ?? undefined,
    });
  }, [isRecording, isPlaying, effectiveDuration, focalLength, activeTake, playbackSpeed, craneTake]);

  useEffect(() => {
    if (isPhoneConnected) sendHostStateNow();
  }, [sendHostStateNow, isPhoneConnected]);

  useEffect(() => {
    if (isPhoneConnected && !isPlaying) sendHostStateNow();
  }, [timelineSec, isPlaying, isPhoneConnected, sendHostStateNow]);

  useEffect(() => {
    if (!isPhoneConnected || !isPlaying) return;
    const id = setInterval(sendHostStateNow, 250);
    return () => clearInterval(id);
  }, [isPhoneConnected, isPlaying, sendHostStateNow]);

  const cleanIp = (!lanIp || lanIp === 'localhost' || lanIp === '127.0.0.1') ? '192.168.100.38' : lanIp;
  // The phone's gyro only reports in a secure context, so pair over whatever scheme the page is
  // actually served on rather than a hardcoded http:// that silently kills the sensors.
  const remoteScheme = typeof window !== 'undefined' ? window.location.protocol.replace(':', '') : 'https';
  const remotePort = (typeof window !== 'undefined' && window.location.port) || '3000';
  const pageHost = typeof window !== 'undefined' ? window.location.hostname : '';
  const isLocalHost = pageHost === 'localhost' || pageHost === '127.0.0.1' || pageHost === '';

  // Hosted: the origin as served, port and all (443 is implied, so no port is appended).
  // Local dev: the LAN address, because a phone cannot resolve "localhost" to this laptop.
  const remoteOrigin = isLocalHost
    ? `${remoteScheme}://${cleanIp}:${remotePort}`
    : window.location.origin;

  // The code is what lets the phone in; without one it would only reach the sign-in screen.
  const remoteUrl =
    `${remoteOrigin}/#/remote?room=${encodeURIComponent(remoteRoomId)}&project=${currentProject.id}` +
    (pairingCode ? `&code=${pairingCode}` : '');
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

  // Slider moves update the view live; the project (large, written to disk) is saved once it settles.
  const stabilizerSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleStabilizerChange = (takeId: string, value: number) => {
    const updated = takes.map((t) => (t.id === takeId ? { ...t, stabilizer: value } : t));
    setTakes(updated);
    if (stabilizerSaveTimerRef.current) clearTimeout(stabilizerSaveTimerRef.current);
    stabilizerSaveTimerRef.current = setTimeout(() => {
      onUpdateProject?.({ ...currentProjectRef.current, cameraTakes: updated });
    }, 600);
  };

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
  /** The widest centred 16:9 of the viewport, as the export has always framed it. */
  const drawViewport16x9 = (ctx: CanvasRenderingContext2D, webglCanvas: HTMLCanvasElement, width = 1920, height = 1080) => {
    const srcW = webglCanvas.width;
    const srcH = webglCanvas.height;
    const targetAspect = 16 / 9;
    let sx = 0, sy = 0, sw = srcW, sh = srcH;
    if (srcW / srcH > targetAspect) {
      sw = srcH * targetAspect;
      sx = (srcW - sw) / 2;
    } else {
      sh = srcW / targetAspect;
      sy = (srcH - sh) / 2;
    }
    ctx.drawImage(webglCanvas, sx, sy, sw, sh, 0, 0, width, height);
  };

  /** Downloads the video and its first frame, and keeps that frame as the take's thumbnail. */
  const deliverExport = (targetTake: CameraTake, video: Blob, fileName: string, firstFrame: string | null, doneMessage: string) => {
    const safeName = targetTake.name.toLowerCase().replace(/\s+/g, '_');
    const downloadUrl = URL.createObjectURL(video);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 15000);

    if (firstFrame) {
      const imgAnchor = document.createElement('a');
      imgAnchor.href = firstFrame;
      imgAnchor.download = `${safeName}_frame0_poster.png`;
      document.body.appendChild(imgAnchor);
      imgAnchor.click();
      imgAnchor.remove();

      const { takes: latestTakes, currentProject: project, onUpdateProject: update } = latestRef.current;
      const updatedTakes = latestTakes.map((t) => (t.id === targetTake.id ? { ...t, thumbnail: firstFrame } : t));
      setTakes(updatedTakes);
      update?.({ ...project, cameraTakes: updatedTakes });
    }
    setToastMessage(doneMessage);
    setTimeout(() => setToastMessage(null), 5000);
  };

  /**
   * Renders a take frame by frame at an exact frame rate: the clock is stepped to frame/fps, the
   * viewport is given time to draw that moment, and the frame is encoded with that timestamp. How
   * long a frame takes to draw no longer matters, so a heavy scene comes out as smooth as a light
   * one - just slower. Returns 'unsupported' when this browser has no H.264 encoder.
   *
   * `crop` is what the picture is cut to: 'wide' is the widest 16:9 of the viewport, as EXPORT has
   * always framed it; 'frame' is the blue camera frame, the same cut a first-frame render uses, so
   * a video render and its first frame are the same picture.
   */
  const renderTakeFrames = async (
    targetTake: CameraTake,
    opts: { fps: number; width: number; height: number; crop: 'wide' | 'frame'; maxSeconds?: number; showProgress: boolean }
  ): Promise<{ video: Blob; firstFrame: string | null; total: number } | 'unsupported' | 'cancelled'> => {
    const webglCanvas = webglCanvasRef.current;
    if (!webglCanvas) return 'unsupported';
    const { fps, width, height } = opts;
    const exporter = await createFrameExporter({ width, height, fps });
    if (!exporter) return 'unsupported';

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = width;
    exportCanvas.height = height;
    const ctx = exportCanvas.getContext('2d', { alpha: false });
    if (!ctx) {
      exporter.cancel();
      return 'unsupported';
    }
    const draw = () => {
      if (opts.crop === 'wide') {
        drawViewport16x9(ctx, webglCanvas, width, height);
      } else {
        const r = frameRectOnCanvas(webglCanvas);
        ctx.drawImage(webglCanvas, r.x * webglCanvas.width, r.y * webglCanvas.height, r.w * webglCanvas.width, r.h * webglCanvas.height, 0, 0, width, height);
      }
    };

    abortExportRef.current = false;
    if (opts.showProgress) {
      setIsExportingVideo(true);
      setExportProgress(0);
    }
    setActiveTakeId(targetTake.id);
    setViewMode('playback');
    setFrameStepping(true);
    setIsPlaying(true);
    setTimelineSec(0);

    const restore = () => {
      setFrameStepping(false);
      if (opts.showProgress) setIsExportingVideo(false);
      setIsPlaying(false);
      setTimelineSec(0);
    };

    try {
      // Let the take, the camera and the actors reach their first frame.
      for (let i = 0; i < 6; i++) await nextFrame();
      await new Promise((r) => setTimeout(r, 250));

      // Both ends of the take are frames: 2 s at 24 fps is frames 0..48.
      const seconds = Math.min(targetTake.duration, opts.maxSeconds ?? Infinity);
      const total = Math.max(1, Math.round(seconds * fps) + 1);
      let firstFrame: string | null = null;
      for (let i = 0; i < total; i++) {
        if (abortExportRef.current) {
          exporter.cancel();
          restore();
          return 'cancelled';
        }
        setTimelineSec(Math.min(targetTake.duration, i / fps));
        // One frame for the screen to take the new time, two for the viewport to have drawn it.
        await nextFrame();
        await nextFrame();
        await nextFrame();
        draw();
        if (i === 0) firstFrame = exportCanvas.toDataURL('image/png');
        await exporter.addFrame(exportCanvas, i);
        if (opts.showProgress) setExportProgress(Math.round(((i + 1) / total) * 100));
      }

      const video = await exporter.finish();
      restore();
      return { video, firstFrame, total };
    } catch (err) {
      exporter.cancel();
      restore();
      throw err;
    }
  };

  // Called from callbacks that are created once, so they reach the current one through a ref.
  const renderTakeFramesRef = useRef(renderTakeFrames);
  renderTakeFramesRef.current = renderTakeFrames;

  /** EXPORT MP4 at an exact frame rate. Returns false when the browser cannot, so the caller records live. */
  const exportTakeFrameByFrame = async (targetTake: CameraTake, fps: number): Promise<boolean> => {
    try {
      const result = await renderTakeFrames(targetTake, { fps, width: 1920, height: 1080, crop: 'wide', showProgress: true });
      if (result === 'unsupported') return false;
      if (result === 'cancelled') {
        setToastMessage('Export cancelled.');
        setTimeout(() => setToastMessage(null), 3000);
        return true;
      }
      const safeName = targetTake.name.toLowerCase().replace(/\s+/g, '_');
      deliverExport(targetTake, result.video, `${safeName}_16x9_${fps}fps.mp4`, result.firstFrame, `✅ ${targetTake.name} exported: MP4 at ${fps} fps (${result.total} frames) + first frame PNG.`);
    } catch (err: any) {
      console.error('Frame-by-frame export failed:', err);
      setToastMessage(`Export failed: ${err?.message || 'the video could not be encoded'}.`);
      setTimeout(() => setToastMessage(null), 5000);
    }
    return true;
  };

  /**
   * The take's previs as a clip for a video render: 24 fps, 720p, cut to the blue camera frame like
   * the first-frame render, and at most the 15 seconds the video model reads.
   */
  const captureTakeVideo = useCallback(async (takeId: string): Promise<Blob | null> => {
    const target = latestRef.current.takes.find((t) => t.id === takeId);
    if (!target) return null;
    const result = await renderTakeFramesRef.current(target, { fps: 24, width: 1280, height: 720, crop: 'frame', maxSeconds: 15, showProgress: false });
    return typeof result === 'string' ? null : result.video;
  }, []);

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

    if (exportFps !== 60) {
      const done = await exportTakeFrameByFrame(targetTake, exportFps);
      if (done) return;
      // This browser cannot encode H.264 itself: fall through to the live recording.
      setToastMessage('This browser cannot export at an exact frame rate. Recording live instead.');
      setTimeout(() => setToastMessage(null), 4000);
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
        pointLights={currentProject.pointLights}
        characters={characters}
        animateObjects
        lightIntensity={(currentProject.lightIntensity !== undefined ? currentProject.lightIntensity : 1.0) * ((parseInt(iso, 10) || 800) / 800)}
        stageSpecularity={currentProject.stageSpecularity}
        environmentPreset={currentProject.environmentPreset || 'studio'}
        currentTimelineTime={timelineSec}
        isPlaying={isPlaying}
        showTrajectories={false}
        panoramaUrl={currentProject.panoramaUrl}
        panoramaRotation={currentProject.panoramaRotation || 0}
        showPanorama={currentProject.showPanorama !== false}
        splatUrl={currentProject.splatUrl}
        cameraFov={currentFov}
        isRecordingCamera={isRecording && !craneActive}
        onRecordCameraFrame={handleRecordFrame}
        craneTake={craneTake}
        isRecordingHead={isRecording && craneActive}
        onRecordHeadSample={handleRecordHeadSample}
        // A keyed move ignores the live/playback switch entirely: playing means watch it, paused
        // means fly the camera and set the next key. Tying it to playback mode meant pressing play
        // while flying in live mode animated nothing, which is exactly backwards.
        //
        // Under two keys there is no move to watch, and handing the camera to a take that cannot
        // drive it would just freeze it - so it stays flyable until there is something to play.
        //
        // Crane mode hands the orientation to the operator, so the take drives nothing then; the
        // crane lock holds the position instead.
        isPlaybackTake={
          isKeyedTake ? !craneActive && isPlaying && (activeTake?.keyframes.length ?? 0) >= 2 : viewMode === 'playback'
        }
        // Paused on a keyed move: scrubbing shows the move, but the camera is still yours to fly
        // to the next position and key. Without this, dragging the playhead moved the actors and
        // left the camera behind.
        followTake={isKeyedTake && !craneActive && !isPlaying && (activeTake?.keyframes.length ?? 0) >= 2}
        playbackTake={stabilizedTake}
        keyCaptureTrigger={keyCaptureTrigger}
        onKeyCaptured={handleKeyCaptured}
        showCameraTrajectory={!isExportingVideo}
        remoteOrientation={remoteOrientation}
        remoteOrientationRef={remoteOrientationRef}
        remoteMove={remoteMove}
        remoteMoveRef={remoteMoveRef}
        remoteLook={remoteLook}
        remoteLookRef={remoteLookRef}
        calibrateTrigger={calibrateTrigger}
        incomingCameraPose={incomingCameraPose}
        incomingCameraPoseRef={incomingCameraPoseRef}
        dofConfig={dofConfig}
        onAutoFocusDistance={(dist) => setAutoFocusReadout(dist)}
        depthCaptureRef={depthCaptureRef}
        actorVisibilityRef={actorVisibilityRef}
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
                Rendering {activeTake?.name} ({activeTake?.duration}s) at 1080p, {exportFps} fps{exportFps === 60 ? ' (live)' : ', frame by frame'}...
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
        {/* Top HUD Bar
            Everything that is a setting rather than a transport control lives on this one line:
            pairing, keyframing, focus, iris, lens and ISO. They used to be spread along the bottom
            bar, which is where the timeline needs the width. */}
        <div className="flex justify-between items-start gap-3">
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
                  className={`px-3 py-1 text-xs font-label-caps rounded-md cursor-pointer flex items-center gap-1.5 transition-all whitespace-nowrap ${
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
                  className={`px-3 py-1 text-xs font-label-caps rounded-md cursor-pointer flex items-center gap-1.5 transition-all whitespace-nowrap ${
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

              {/* New take: fly and record one, or build one from keyframes. */}
              <div className="relative">
                <button
                  onClick={() => setShowNewTakeMenu((v) => !v)}
                  disabled={isRecording}
                  className={`px-3 py-1.5 text-xs font-label-caps rounded-lg border flex items-center gap-1.5 cursor-pointer shadow-md transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed ${
                    showNewTakeMenu
                      ? 'bg-red-600 border-red-400 text-white'
                      : 'bg-surface-container/90 border-red-500/60 text-red-300 hover:bg-red-600 hover:text-white'
                  }`}
                  title="Start a new take: record it live, or build it from keyframes"
                >
                  <span className="material-symbols-outlined text-[15px]">add</span>
                  NEW TAKE
                  <span className="material-symbols-outlined text-[15px]">expand_more</span>
                </button>
                {showNewTakeMenu && (
                  <div className="absolute top-full mt-1.5 left-0 w-60 bg-surface-container/95 backdrop-blur-xl border border-outline-variant/50 p-1 rounded-xl shadow-2xl flex flex-col z-40">
                    <button
                      onClick={() => {
                        setShowNewTakeMenu(false);
                        setShowKeyPanel(false);
                        setViewMode('live');
                        setIsPlaying(true);
                        setToastMessage('Live camera. Frame the shot, then press REC.');
                        setTimeout(() => setToastMessage(null), 3000);
                      }}
                      className="flex items-start gap-2 px-2.5 py-2 rounded-lg text-left hover:bg-red-600/20 cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[18px] text-red-400">fiber_manual_record</span>
                      <span className="flex flex-col">
                        <span className="text-xs font-label-caps text-on-surface">Record</span>
                        <span className="text-[10px] text-on-surface-variant leading-snug">Fly the camera or the phone and record the move live.</span>
                      </span>
                    </button>
                    <button
                      onClick={() => {
                        setShowNewTakeMenu(false);
                        handleNewKeyedTake();
                      }}
                      className="flex items-start gap-2 px-2.5 py-2 rounded-lg text-left hover:bg-primary/15 cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[18px] text-primary">linear_scale</span>
                      <span className="flex flex-col">
                        <span className="text-xs font-label-caps text-on-surface">Keyframe</span>
                        <span className="text-[10px] text-on-surface-variant leading-snug">Place the camera key by key and let the move flow between them.</span>
                      </span>
                    </button>
                  </div>
                )}
              </div>

              {/* Status Badge */}
              {viewMode === 'live' ? (
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-xs bg-background/85 backdrop-blur-md px-md py-xs rounded border border-outline-variant/30 font-label-caps text-xs shadow-md">
                    <span className={`w-2.5 h-2.5 rounded-full ${isRecording ? 'bg-red-500 animate-ping' : 'bg-green-500'}`} />
                    <span className="text-primary tracking-widest font-semibold">{isRecording ? (craneActive ? 'RECORDING HEAD PASS' : 'RECORDING TAKE') : craneActive ? 'CRANE ARMED' : 'STANDBY'}</span>
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
                            setRenderTakeId(t.id);
                          }}
                          title="Render the first frame as a real film frame"
                          className="hover:text-amber-300 text-cyan-300"
                        >
                          <span className="material-symbols-outlined text-[13px]">auto_awesome</span>
                        </button>
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
              <span className={aperture !== 'OFF' ? 'text-amber-300 font-medium' : ''}>IRIS: {aperture}</span>
              <span className="text-outline-variant">|</span>
              <span className="text-cyan-400 font-mono">
                {focusMode === 'auto' ? `AF ${(autoFocusReadout || focusDistance).toFixed(2)}m` : `MF ${focusDistance.toFixed(2)}m`}
              </span>
              {focusPeaking && (
                <>
                  <span className="text-outline-variant">|</span>
                  <span className="text-emerald-400 font-bold text-[10px] bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-500/40 animate-pulse">
                    PEAKING
                  </span>
                </>
              )}
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
          {/* Right of the top row: pairing, keyframing and the lens controls, all one line. */}
          <div className="min-w-0 flex items-center flex-wrap justify-end gap-2 pointer-events-auto">
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

            {/* Hand-keyed camera moves, as opposed to recording one by flying it. */}
            <button
              onClick={() => setShowKeyPanel((v) => !v)}
              className={`border px-3 py-2 rounded-xl backdrop-blur-md text-xs font-label-caps tracking-wider flex items-center gap-1.5 cursor-pointer shadow-lg whitespace-nowrap transition-colors ${
                showKeyPanel || isKeyedTake
                  ? 'bg-primary/15 border-primary text-primary'
                  : 'bg-surface-container/90 border-outline-variant/40 hover:border-primary text-on-surface-variant'
              }`}
              title="Build a camera move from keyframes instead of recording it"
            >
              <span className="material-symbols-outlined text-[15px]">linear_scale</span>
              KEYFRAME
            </button>


            {/* Right: Camera package, Iris (DoF), Lens, ISO and the Focus Puller. Wraps rather
                than running off the right edge of a narrower window. */}
            <div className="min-w-0 flex items-center flex-wrap justify-end gap-2">
              {/* Camera package: body, lens set, film back. Stored on every take recorded. */}
              <div className="relative">
                <button
                  onClick={() => setShowPackageMenu(!showPackageMenu)}
                  className={`px-2 py-1 text-[11px] font-label-caps rounded-xl border flex items-center gap-1.5 cursor-pointer transition-all shadow-md ${
                    showPackageMenu
                      ? 'bg-amber-400/20 text-amber-100 border-amber-300 font-semibold'
                      : 'bg-surface-container/90 text-on-surface border-amber-300/50 hover:border-amber-300'
                  }`}
                  title={`Camera package: ${packageLabel(cameraPackage)}`}
                >
                  <span className="material-symbols-outlined text-[15px] text-amber-300">photo_camera</span>
                  <span className="text-amber-300 font-bold">PACKAGE</span>
                  <span className="max-w-[160px] truncate">
                    {cameraById(cameraPackage.cameraId)?.name.replace(/^(ARRI|RED|Sony|Panavision|Blackmagic) /, '')} ·{' '}
                    {lensById(cameraPackage.lensId)?.name.replace(/^(Panavision|ARRI|Zeiss|Leica|Canon) /, '')}
                  </span>
                </button>
                {showPackageMenu && (
                  <div className="absolute top-full mt-2 right-0 w-72 bg-surface-container/95 backdrop-blur-xl border border-outline-variant/50 p-3 rounded-2xl shadow-2xl flex flex-col gap-2.5 z-40 animate-in fade-in slide-in-from-top-2 duration-150">
                    <div className="flex justify-between items-center pb-1.5 border-b border-outline-variant/20">
                      <div className="flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-[16px] text-amber-300">photo_camera</span>
                        <span className="font-label-caps text-[11px] text-amber-200 font-bold uppercase tracking-wider">Camera package</span>
                      </div>
                      <button onClick={() => setShowPackageMenu(false)} className="text-on-surface-variant hover:text-on-surface text-[12px] cursor-pointer">
                        ✕
                      </button>
                    </div>
                    <CameraPackagePicker value={cameraPackage} onChange={setCameraPackage} idPrefix="record" />
                    <span className="text-[10px] text-on-surface-variant/80 leading-snug">
                      Every take you record keeps this package, with its focal length, iris and ISO. It is used when the take is sent to RENDER.
                    </span>
                  </div>
                )}
              </div>

              {/* IRIS / Aperture (DoF) */}
              <div className="flex items-center gap-xs bg-surface-container/90 border border-outline-variant/40 p-1 rounded-xl backdrop-blur-md shadow-md">
                <span className="font-label-caps text-[9px] text-on-surface-variant px-1" title="Aperture / Depth of Field (Circle of Confusion)">IRIS</span>
                {['f/1.4', 'f/2.0', 'f/2.8', 'f/4.0', 'f/8.0', 'OFF'].map((val) => (
                  <button
                    key={val}
                    onClick={() => setAperture(val)}
                    className={`px-1.5 py-1 text-[11px] font-label-caps rounded cursor-pointer transition-colors ${
                      aperture === val ? 'bg-amber-400 text-black font-bold shadow' : 'text-on-surface-variant hover:text-amber-300'
                    }`}
                  >
                    {val}
                  </button>
                ))}
              </div>

              {/* Lens Selector */}
              <div className="flex items-center gap-xs bg-surface-container/90 border border-outline-variant/40 p-1 rounded-xl backdrop-blur-md shadow-md">
                <span className="font-label-caps text-[9px] text-on-surface-variant px-1">LENS</span>
                {['18mm', '24mm', '35mm', '50mm', '85mm', '135mm'].map((fl) => (
                  <button
                    key={fl}
                    onClick={() => setFocalLength(fl)}
                    className={`px-1.5 py-1 text-[11px] font-label-caps rounded cursor-pointer transition-colors ${
                      focalLength === fl ? 'bg-primary text-background font-medium' : 'text-on-surface-variant hover:text-primary'
                    }`}
                  >
                    {fl}
                  </button>
                ))}
              </div>

              {/* ISO Selector */}
              <div className="flex items-center gap-xs bg-surface-container/90 border border-outline-variant/40 p-1 rounded-xl backdrop-blur-md shadow-md">
                <span className="font-label-caps text-[9px] text-on-surface-variant px-1">ISO</span>
                {['400', '800', '1600'].map((val) => (
                  <button
                    key={val}
                    onClick={() => setIso(val)}
                    className={`px-1.5 py-1 text-[11px] font-label-caps rounded cursor-pointer transition-colors ${
                      iso === val ? 'bg-primary text-background font-medium' : 'text-on-surface-variant hover:text-primary'
                    }`}
                  >
                    {val}
                  </button>
                ))}
              </div>

              {/* Focus Puller & Depth of Field Controls. Last in the row so it sits at the right
                  edge of the screen and its menu opens there, beside the viewfinder, not over it. */}
              <div className="relative">
                <button
                  onClick={() => setShowFocusPullerMenu(!showFocusPullerMenu)}
                  className={`px-2 py-1 text-[11px] font-label-caps rounded-xl border flex items-center gap-1.5 cursor-pointer transition-all shadow-md ${
                    showFocusPullerMenu || focusMode === 'manual' || focusPeaking
                      ? 'bg-cyan-500/20 text-cyan-300 border-cyan-400/60 font-semibold'
                      : 'bg-surface-container/90 text-on-surface-variant border-outline-variant/40 hover:text-on-surface'
                  }`}
                  title="Focus Puller & Depth of Field Engine"
                >
                  <span className="material-symbols-outlined text-[15px] text-cyan-400">center_focus_strong</span>
                  <span>{focusMode === 'auto' ? `AF ${(autoFocusReadout || focusDistance).toFixed(1)}m` : `MF ${focusDistance.toFixed(1)}m`}</span>
                </button>

                {/* Floating Focus Puller HUD Box */}
                {/* Opens downward, anchored to the right edge. This button used to live on the bottom
                    bar, where upward was the only direction that fitted; on the top row that ran off
                    the screen. */}
                {showFocusPullerMenu && (
                  <div className="absolute top-full mt-2 right-0 w-64 bg-surface-container/95 backdrop-blur-xl border border-outline-variant/50 p-3 rounded-2xl shadow-2xl flex flex-col gap-2.5 z-40 animate-in fade-in slide-in-from-top-2 duration-150">
                    <div className="flex justify-between items-center pb-1.5 border-b border-outline-variant/20">
                      <div className="flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-[16px] text-cyan-400">tune</span>
                        <span className="font-label-caps text-[11px] text-cyan-300 font-bold uppercase tracking-wider">
                          Cinema Focus Puller
                        </span>
                      </div>
                      <button
                        onClick={() => setShowFocusPullerMenu(false)}
                        className="text-on-surface-variant hover:text-on-surface text-[12px] cursor-pointer"
                      >
                        ✕
                      </button>
                    </div>

                    {/* Mode Toggle: Auto (Center Raycast) vs Manual (Rack Focus) */}
                    <div className="flex items-center bg-surface-container-high/60 p-0.5 rounded-lg border border-outline-variant/30">
                      <button
                        onClick={() => setFocusMode('auto')}
                        className={`flex-1 py-1 rounded text-[10px] font-label-caps transition-all cursor-pointer ${
                          focusMode === 'auto'
                            ? 'bg-cyan-500 text-black font-bold shadow'
                            : 'text-on-surface-variant hover:text-on-surface'
                        }`}
                      >
                        AUTOFOCUS (CENTER)
                      </button>
                      <button
                        onClick={() => setFocusMode('manual')}
                        className={`flex-1 py-1 rounded text-[10px] font-label-caps transition-all cursor-pointer ${
                          focusMode === 'manual'
                            ? 'bg-cyan-500 text-black font-bold shadow'
                            : 'text-on-surface-variant hover:text-on-surface'
                        }`}
                      >
                        MANUAL FOCUS
                      </button>
                    </div>

                    {/* Focus Distance Slider (Manual Mode) */}
                    <div className="space-y-1">
                      <div className="flex justify-between items-center text-[10px] font-mono">
                        <span className="text-on-surface-variant">Focus Plane Distance:</span>
                        <span className="text-cyan-300 font-bold">
                          {(focusMode === 'auto' ? autoFocusReadout || focusDistance : focusDistance).toFixed(2)}m
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0.5}
                        max={25.0}
                        step={0.1}
                        disabled={focusMode === 'auto'}
                        value={focusDistance}
                        onChange={(e) => {
                          setFocusDistance(parseFloat(e.target.value));
                          if (focusMode === 'auto') setFocusMode('manual');
                        }}
                        className="w-full h-1.5 bg-surface-variant rounded-lg appearance-none cursor-pointer accent-cyan-400 disabled:opacity-40"
                      />
                      {/* Quick Rack Focus Distance Presets */}
                      <div className="flex items-center justify-between gap-1 pt-0.5">
                        {[
                          { label: 'Close', dist: 1.5 },
                          { label: 'Med', dist: 3.0 },
                          { label: 'Body', dist: 5.0 },
                          { label: 'Stage', dist: 10.0 },
                          { label: 'Inf', dist: 25.0 },
                        ].map((p) => (
                          <button
                            key={p.label}
                            onClick={() => {
                              setFocusDistance(p.dist);
                              setFocusMode('manual');
                            }}
                            className={`px-1.5 py-0.5 rounded text-[9px] font-mono border transition-colors cursor-pointer ${
                              focusMode === 'manual' && Math.abs(focusDistance - p.dist) < 0.2
                                ? 'bg-cyan-400/20 text-cyan-300 border-cyan-400/50'
                                : 'text-on-surface-variant border-outline-variant/30 hover:text-on-surface'
                            }`}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Focus Peaking Assist Toggle */}
                    <div className="flex items-center justify-between pt-1.5 border-t border-outline-variant/20">
                      <span className="text-[10px] text-on-surface-variant flex items-center gap-1 font-mono">
                        <span className="material-symbols-outlined text-[13px] text-emerald-400">filter_center_focus</span>
                        Focus Peaking (Assist)
                      </span>
                      <button
                        type="button"
                        onClick={() => setFocusPeaking(!focusPeaking)}
                        className={`px-2 py-0.5 rounded text-[9px] font-label-caps font-bold transition-colors cursor-pointer border ${
                          focusPeaking
                            ? 'bg-emerald-500/20 text-emerald-400 border-emerald-400/50'
                            : 'bg-surface-container-high/60 text-on-surface-variant border-outline-variant/30'
                        }`}
                      >
                        {focusPeaking ? 'ON' : 'OFF'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Large 16:9 Director Viewfinder Framing Guide & Matte Mask */}
        <div
          ref={frameGuideRef}
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
                <select
                  value={exportFps}
                  onChange={(e) => setExportFps(Number(e.target.value))}
                  disabled={isExportingVideo}
                  title="Frame rate of the exported video. 24, 25 and 30 are rendered frame by frame at an exact rate; 60 records the viewport live."
                  className="px-2 py-3.5 rounded-2xl bg-emerald-950/90 text-emerald-200 font-label-caps text-sm font-bold shadow-2xl border border-emerald-400/60 cursor-pointer outline-none"
                >
                  {EXPORT_FRAME_RATES.map((f) => (
                    <option key={f} value={f}>{f} fps</option>
                  ))}
                  <option value={60}>60 fps (live)</option>
                </select>

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
                <button
                  onClick={() => setRenderTakeId(activeTake.id)}
                  className="px-5 py-3.5 rounded-2xl bg-amber-400 hover:bg-amber-300 text-black font-label-caps text-sm tracking-widest font-bold shadow-2xl flex items-center gap-2 hover:scale-105 active:scale-95 transition-all cursor-pointer"
                  title="Turn this take's first frame into a real film frame with its camera package"
                >
                  <span className="material-symbols-outlined text-[20px]">auto_awesome</span>
                  RENDER 1ST FRAME
                </button>
              </div>

              <div className="flex items-center gap-2 bg-background/90 px-3 py-1 rounded-full border border-cyan-500/40 backdrop-blur-md text-[11px] font-mono text-cyan-300 shadow-lg">
                <label className="flex items-center gap-2" title="Smooths out hand shake in this take. Your original recording is kept.">
                  <span className="material-symbols-outlined text-[14px]">blur_on</span>
                  <span>Stabilizer</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={activeTake.stabilizer ?? 0}
                    onChange={(e) => handleStabilizerChange(activeTake.id, Number(e.target.value))}
                    className="w-24 accent-cyan-400 cursor-pointer"
                  />
                  <span className="w-8 text-right">{activeTake.stabilizer ? `${activeTake.stabilizer}%` : 'Off'}</span>
                </label>
                <span>•</span>
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

        {/* One card under the picture: transport, then the keys, then the curve.
            They were three floating pieces; a camera move is one thing, so it reads as one. */}
        <div className="w-full flex justify-center pointer-events-auto pb-1">
          <div className="w-full max-w-6xl bg-surface-container/95 border border-outline-variant/40 rounded-xl backdrop-blur-xl shadow-2xl overflow-hidden">
            {/* Transport */}
            <div className="flex items-center gap-3 px-3 py-2">
          <div className="flex-1 flex items-center gap-3 min-w-0">
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
                <select
                  value={exportFps}
                  onChange={(e) => setExportFps(Number(e.target.value))}
                  disabled={isExportingVideo}
                  title="Frame rate of the exported video. 24, 25 and 30 are rendered frame by frame at an exact rate; 60 records the viewport live."
                  className="h-9 px-1 rounded-lg bg-emerald-950/80 text-emerald-200 font-label-caps text-xs font-bold border border-emerald-500/40 cursor-pointer outline-none"
                >
                  {EXPORT_FRAME_RATES.map((f) => (
                    <option key={f} value={f}>{f} fps</option>
                  ))}
                  <option value={60}>60 fps (live)</option>
                </select>
                <button
                  onClick={() => captureFrameImage(activeTake)}
                  disabled={isExportingVideo}
                  className="h-9 px-2 rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-cyan-300 font-label-caps text-xs font-semibold flex items-center gap-1 cursor-pointer shadow-lg transition-all whitespace-nowrap border border-cyan-500/30"
                  title="Capture current 1080p 16:9 frame and download as PNG"
                >
                  <span className="material-symbols-outlined text-[15px]">photo_camera</span>
                  <span>STILL</span>
                </button>
                <button
                  onClick={() => activeTake && setRenderTakeId(activeTake.id)}
                  disabled={isExportingVideo || !activeTake}
                  className="h-9 px-2.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-black font-label-caps text-xs font-bold tracking-wider flex items-center gap-1 cursor-pointer shadow-lg transition-all whitespace-nowrap disabled:opacity-50"
                  title="Turn this take's first frame into a real film frame with its camera package"
                >
                  <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
                  <span>RENDER</span>
                </button>
              </div>
            )}

            <div className="w-[1px] h-6 bg-outline-variant/40" />

            {/* Play/Pause Button */}
            <button
              onClick={togglePlay}
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

            </div>

            {/* Keys and curve, in the same card so time reads straight down it. */}
            {showKeyPanel && (
              <div className="border-t border-outline-variant/30">
                {!isKeyedTake ? (
                  <div className="px-3 py-2.5 flex items-center justify-between gap-4">
                    <p className="text-[11px] text-on-surface-variant leading-snug">
                      A keyed move is built from positions you place yourself: fly the camera, set a key,
                      move the playhead, set another. The path between them is a curve, and the timing is yours.
                    </p>
                    <button
                      onClick={handleNewKeyedTake}
                      className="shrink-0 px-4 py-2 bg-primary/15 border border-primary/50 text-primary rounded-lg text-xs font-label-caps tracking-wider hover:bg-primary/25 transition-colors cursor-pointer"
                    >
                      New Keyed Move
                    </button>
                  </div>
                ) : (
                  <KeyframeTimeline
                    take={activeTake!}
                    currentTime={timelineSec}
                    selectedKeyTime={selectedKeyTime}
                    onSelectKey={setSelectedKeyTime}
                    onMoveKey={handleMoveKey}
                    onChangeKey={handleKeyChange}
                    onScrub={(t) => { setIsPlaying(false); setTimelineSec(t); }}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </div>


      {/* The selected key's values, floated bottom-left on its own.
          Kept out of the timeline card so editing a key never costs the viewport any height. */}
      {showKeyPanel && isKeyedTake && activeTake && (
        <div className="fixed left-4 bottom-4 z-40 pointer-events-none">
          <KeyInspector
            take={activeTake}
            selectedKey={activeTake.keyframes.find((k) => k.time === selectedKeyTime) || null}
            keyIndex={activeTake.keyframes.findIndex((k) => k.time === selectedKeyTime)}
            onChangeKey={handleKeyChange}
            onMoveKey={handleMoveKey}
            onDeleteKey={handleDeleteKey}
            onSetKey={() => setKeyCaptureTrigger((n) => n + 1)}
            onRetakeKey={handleRetakeKey}
            onGoToKey={goToAdjacentKey}
            onTensionChange={(tension) => updateActiveTake((t) => ({ ...t, tension }))}
            lenses={KEY_LENSES}
            craneArmed={craneActive}
            isRecording={isRecording}
            onToggleCrane={() => {
              if (isRecording) return;
              setIsPlaying(false);
              setCraneArmed((v) => !v);
            }}
            onSelectHeadPass={(id) => updateActiveTake((t) => ({ ...t, activeHeadPassId: id ?? undefined }))}
            onDeleteHeadPass={(id) => updateActiveTake((t) => ({
              ...t,
              headPasses: (t.headPasses || []).filter((p) => p.id !== id),
              activeHeadPassId: t.activeHeadPassId === id ? undefined : t.activeHeadPassId,
            }))}
            onStabilizerChange={(v) => activeTake && handleStabilizerChange(activeTake.id, v)}
          />
        </div>
      )}

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
            <div className="w-52 h-52 mx-auto bg-white p-3 rounded-xl flex flex-col items-center justify-center border border-outline-variant/40 my-3 shadow-inner">
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

            {/* The code, spelled out, for when a camera cannot read the screen - and the reason
                when there is no code at all, since a QR without one only reaches the sign-in page. */}
            {pairingError ? (
              <div className="mb-3 px-2.5 py-2 bg-red-500/15 border border-red-500/40 rounded-lg text-[11px] text-red-300 text-center">
                {pairingError}
              </div>
            ) : pairingCode ? (
              <div className="mb-3 text-center">
                <div className="text-[10px] font-mono text-on-surface-variant mb-0.5">PAIRING CODE</div>
                <div className="font-mono font-bold text-lg tracking-[0.3em] text-white">{pairingCode}</div>
                <div className="text-[10px] text-on-surface-variant">valid for 3 minutes · one device</div>
              </div>
            ) : (
              <div className="mb-3 text-center text-[11px] text-on-surface-variant">
                Getting a pairing code…
              </div>
            )}

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

            {/* What the link is actually doing. DIRECT means the phone and this laptop are talking
                across the room; RELAY means every sample is going via the server and back. */}
            {isPhoneConnected && (
              <div className="mb-3 flex items-center justify-center gap-2 text-[10px] font-mono">
                <span
                  className={`px-1.5 py-0.5 rounded border ${
                    linkStats.transport === 'direct'
                      ? 'border-[#4ade80]/50 text-[#4ade80] bg-[#4ade80]/10'
                      : 'border-amber-400/50 text-amber-300 bg-amber-400/10'
                  }`}
                >
                  {linkStats.transport === 'direct' ? 'DIRECT LINK' : 'VIA SERVER'}
                </span>
                <span className="text-on-surface-variant">
                  {linkStats.rttMs === null ? 'measuring…' : `${linkStats.rttMs} ms round trip`}
                </span>
                {linkStats.dropped > 0 && (
                  <span className="text-on-surface-variant">· {linkStats.dropped} stale dropped</span>
                )}
              </div>
            )}

            <div className="mb-3 bg-white/5 border border-white/10 rounded-lg p-2.5 text-left text-xs space-y-1">
              <div className="font-bold text-white flex items-center gap-1.5 text-[11px]">
                <span className="material-symbols-outlined text-[14px]">photo_camera</span>
                Scan to Open Mobile Viewfinder
              </div>
              <div className="text-[10px] text-on-surface-variant leading-relaxed">
                Aim phone to track virtual camera. Use joystick on left to dolly/truck and swipe screen to aim.
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

      {renderTakeId && takes.some((t) => t.id === renderTakeId) && (
        <TakeRenderPanel
          projectId={currentProject.id}
          take={takes.find((t) => t.id === renderTakeId)!}
          sceneHeading={(currentProject as any).sceneHeading}
          captureFirstFrame={() => captureTakeFirstFrame(renderTakeId)}
          onRendered={handleTakeRendered}
          characters={characters}
          onUpdateCharacter={handleUpdateCharacter}
          onUpdateTake={handleUpdateTake}
          fallbackPackage={cameraPackage}
          captureTakeVideo={() => captureTakeVideo(renderTakeId)}
          onVideoRendered={handleVideoRendered}
          setMasterUrl={currentProject.setMasterUrl}
          onSetMaster={handleSetMaster}
          onClose={() => setRenderTakeId(null)}
        />
      )}
    </div>
  );
};
