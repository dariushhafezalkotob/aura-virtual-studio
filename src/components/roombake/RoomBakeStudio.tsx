import React, { useEffect, useRef, useState, useCallback } from 'react';
import { RoomBakeEngine, ViewPoint } from '../../services/roombakeEngine';
import { generateTexture } from '../../services/roombakeAiService';
import { UVInspectorModal } from './UVInspectorModal';
import { SceneAsset } from '../../types';
import * as THREE from 'three';

interface RoomBakeStudioProps {
  isOpen: boolean;
  onClose: () => void;
  onAddSceneAsset?: (assetData: { name: string; glbUrl?: string; modelBlob?: Blob }) => void;
  targetAsset?: SceneAsset | null;
}

export const RoomBakeStudio: React.FC<RoomBakeStudioProps> = ({
  isOpen,
  onClose,
  onAddSceneAsset,
  targetAsset,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<RoomBakeEngine | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const userImageInputRef = useRef<HTMLInputElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  // UI State
  const [logs, setLogs] = useState<{ text: string; type: 'info' | 'ok' | 'err' }[]>([]);
  const [coverage, setCoverage] = useState(0);
  const [bakesCount, setBakesCount] = useState(0);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [modelStatus, setModelStatus] = useState('Model: Default room (6.0m × 3.0m × 8.0m)');
  const [showUVModal, setShowUVModal] = useState(false);
  const [showGenModal, setShowGenModal] = useState(false);

  // 00 Geometry
  const [uvMode, setUvMode] = useState<'smart' | 'auto' | 'box' | 'model'>('smart');

  // 01 View
  const [views, setViews] = useState<ViewPoint[]>([]);
  const [selectedViewIdx, setSelectedViewIdx] = useState(1);
  const [fov, setFov] = useState(60);

  // 02 Conditioning
  const [frameSize, setFrameSize] = useState('1024x1024');
  const [condInfo, setCondInfo] = useState('—');
  const nearDist = 0.3;
  const farDist = 12.0;
  const [autoRange, setAutoRange] = useState(true);
  const [depthInvert, setDepthInvert] = useState(false);
  const [maskFeather, setMaskFeather] = useState(6);
  const [depthThumb, setDepthThumb] = useState<string | null>(null);
  const [normalThumb, setNormalThumb] = useState<string | null>(null);
  const [maskThumb, setMaskThumb] = useState<string | null>(null);
  const [atlasThumb, setAtlasThumb] = useState<string | null>(null);

  // 03 Generate
  const [srcSelect, setSrcSelect] = useState<'gemini' | 'mock' | 'normals' | 'upload'>('gemini');
  const [genericPrompt, setGenericPrompt] = useState('warm oak parquet floor, lime-plaster walls, matte white ceiling, flat even lighting, no cast shadows, albedo texture, interior photograph');
  const [genericSeed, setGenericSeed] = useState(20260903);

  // Gemini State
  const gemKey = localStorage.getItem('roombake_gemini_key') || (import.meta as any).env?.VITE_GEMINI_API_KEY || '';
  const [gemSendCond, setGemSendCond] = useState(true);
  const [gemStyle, setGemStyle] = useState('A futuristic cyberpunk hideout interior, industrial sci-fi architecture, aged black metal wall panels, wet polished concrete floor, subtle holographic interface glow on the walls, cinematic warm tungsten lighting mixed with cold blue ambient light, realistic materials, believable wear and scratches.');
  const gemTemplate = `Photorealistic architectural photograph of a room interior wall and surface view.\nScene style: {{STYLE}}.\nLighting: flat even diffused interior lighting, architectural photography, ultra sharp textures, no distortion, high detail, ARRI style 8K detail.\nSeamless continuity: If any portion of a wall, floor, or ceiling is already textured in the reference view, seamlessly continue and extend that exact material, color palette, scale, and pattern across the rest of the surface with an invisible boundary.`;

  // Generated Image Thumbnail & Canvas
  const [genThumb, setGenThumb] = useState<string | null>(null);
  const [currentGenCanvas, setCurrentGenCanvas] = useState<HTMLCanvasElement | null>(null);

  // 04 Projection Bake
  const [wpow, setWpow] = useState(2.0);
  const [minndotv, setMinndotv] = useState(0.15);
  const [bias, setBias] = useState(0.02);
  const [feather, setFeather] = useState(0.06);
  const [blend, setBlend] = useState(0.15);
  const [occlude, setOcclude] = useState(true);

  // 05 Atlas
  const [dilate, setDilate] = useState(8);
  const [showGaps, setShowGaps] = useState(true);

  // Process / Busy State
  const [busy, setBusy] = useState(false);
  const [autoProgress, setAutoProgress] = useState<{ current: number; total: number } | null>(null);

  // Collapsible Sections
  const [openSections, setOpenSections] = useState({
    s00: true,
    s01: true,
    s02: true,
    s03: true,
    s04: true,
    s05: true,
    s06: true,
  });

  const toggleSection = (key: keyof typeof openSections) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const addLog = useCallback((text: string, type: 'info' | 'ok' | 'err' = 'info') => {
    setLogs((prev) => [...prev.slice(-150), { text, type }]);
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const updateStats = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.cond.depth) setDepthThumb(engine.cond.depth.toDataURL());
    if (engine.cond.normal) setNormalThumb(engine.cond.normal.toDataURL());
    if (engine.cond.mask) setMaskThumb(engine.cond.mask.toDataURL());
    const atlasCv = engine.getAtlasCanvas();
    if (atlasCv) setAtlasThumb(atlasCv.toDataURL());
    setCoverage(engine.state.coverage);
    setBakesCount(engine.state.bakes);
    setHasSnapshot(engine.state.hasSnapshot);
  }, []);

  const refreshViewInfo = useCallback((_view: ViewPoint) => {
    // viewInfo removed from UI per simplified 01 layout
  }, []);

  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const keysDownRef = useRef<Set<string>>(new Set());
  const lastLoadedTargetKeyRef = useRef<string | null>(null);

  // Initialize Engine & Viewport (Persistent Session with Unreal Navigation)
  useEffect(() => {
    if (!canvasRef.current) return;

    if (!engineRef.current) {
      const engine = new RoomBakeEngine(canvasRef.current);
      engineRef.current = engine;
      setViews([...engine.views]);
      setModelStatus(engine.state.modelName);

      addLog('RoomBake projective texture baking engine online.', 'ok');

      const v = engine.views[1] || engine.views[0];
      if (v) {
        engine.renderConditioning(v, autoRange, depthInvert, maskFeather);
        refreshViewInfo(v);
        updateStats();
      }
    }

    let dragging = false;
    let dragButton = 0;
    let lx = 0, ly = 0;
    const canvas = canvasRef.current;

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    const onPointerDown = (e: PointerEvent) => {
      dragging = true;
      dragButton = e.button;
      lx = e.clientX;
      ly = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };

    const onPointerUp = (e: PointerEvent) => {
      dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging || !engineRef.current) return;
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;

      const eng = engineRef.current;
      const cp = Math.cos(eng.orbit.pitch);
      const fwd = new THREE.Vector3(
        Math.sin(eng.orbit.yaw) * cp,
        Math.sin(eng.orbit.pitch),
        Math.cos(eng.orbit.yaw) * cp
      ).normalize();
      const rgt = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();

      // Middle click (1) or Alt/Shift+Left Click = Unreal Pan
      if (dragButton === 1 || (dragButton === 0 && (e.altKey || e.shiftKey))) {
        const panSpeed = 0.005 * Math.max(0.5, eng.orbit.dist);
        eng.orbit.target.addScaledVector(rgt, -dx * panSpeed);
        eng.orbit.target.y += dy * panSpeed;
      } else {
        // Left Click (0) or Right Click (2) = Unreal Free Fly Look
        eng.orbit.yaw -= dx * 0.004;
        eng.orbit.pitch -= dy * 0.004;
        eng.orbit.pitch = Math.max(-1.55, Math.min(1.55, eng.orbit.pitch));
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (!engineRef.current) return;
      e.preventDefault();
      const eng = engineRef.current;
      const cp = Math.cos(eng.orbit.pitch);
      const fwd = new THREE.Vector3(
        Math.sin(eng.orbit.yaw) * cp,
        Math.sin(eng.orbit.pitch),
        Math.cos(eng.orbit.yaw) * cp
      ).normalize();
      eng.orbit.target.addScaledVector(fwd, -Math.sign(e.deltaY) * 0.35);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isOpenRef.current || !engineRef.current) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'q', 'e', 'shift'].includes(k)) {
        keysDownRef.current.add(k);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      keysDownRef.current.delete(k);
    };

    const onBlur = () => {
      keysDownRef.current.clear();
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
      if (engineRef.current) {
        engineRef.current.dispose();
        engineRef.current = null;
      }
    };
  }, []);

  // Resume / Pause 60 FPS Render Loop & Delta-Time Unreal Fly Navigation
  useEffect(() => {
    const engine = engineRef.current;
    if (!isOpen || !engine || !canvasRef.current) return;

    engine.resize(canvasRef.current.clientWidth || 800, canvasRef.current.clientHeight || 600);
    updateStats();
    const v = engine.views[selectedViewIdx];
    if (v) refreshViewInfo(v);

    let animId: number;
    let lastTime = performance.now();

    const renderLoop = (time: number) => {
      const dt = Math.min(0.1, (time - lastTime) / 1000);
      lastTime = time;

      if (keysDownRef.current.size > 0 && engineRef.current) {
        const eng = engineRef.current;
        const isShift = keysDownRef.current.has('shift');
        const moveSpeed = (isShift ? 9.0 : 3.8) * dt;

        const cp = Math.cos(eng.orbit.pitch);
        const fwd = new THREE.Vector3(
          Math.sin(eng.orbit.yaw) * cp,
          Math.sin(eng.orbit.pitch),
          Math.cos(eng.orbit.yaw) * cp
        ).normalize();
        const rgt = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
        const up = new THREE.Vector3(0, 1, 0);

        if (keysDownRef.current.has('w')) eng.orbit.target.addScaledVector(fwd, moveSpeed);
        if (keysDownRef.current.has('s')) eng.orbit.target.addScaledVector(fwd, -moveSpeed);
        if (keysDownRef.current.has('d')) eng.orbit.target.addScaledVector(rgt, moveSpeed);
        if (keysDownRef.current.has('a')) eng.orbit.target.addScaledVector(rgt, -moveSpeed);
        if (keysDownRef.current.has('e')) eng.orbit.target.addScaledVector(up, moveSpeed);
        if (keysDownRef.current.has('q')) eng.orbit.target.addScaledVector(up, -moveSpeed);
      }

      engine.render();
      animId = requestAnimationFrame(renderLoop);
    };
    animId = requestAnimationFrame(renderLoop);

    return () => {
      cancelAnimationFrame(animId);
      keysDownRef.current.clear();
    };
  }, [isOpen, selectedViewIdx, updateStats, refreshViewInfo]);

  // Auto-load target scene model (e.g. baked room or selected asset) with its textures whenever RoomBake opens
  useEffect(() => {
    if (!isOpen) return;
    const engine = engineRef.current;
    if (!engine) return;

    if (!targetAsset || !targetAsset.glbUrl) return;

    const targetKey = `${targetAsset.id}_${targetAsset.glbUrl}`;
    const needsLoad =
      targetKey !== lastLoadedTargetKeyRef.current ||
      engine.state.modelName.toLowerCase().includes('default');

    if (needsLoad) {
      lastLoadedTargetKeyRef.current = targetKey;
      addLog(`Loading scene model: "${targetAsset.name}" with its textures into RoomBake...`, 'info');

      // Resolve expired blob URLs or fallbacks to permanent asset storage
      const resolvedUrl =
        targetAsset.glbUrl.startsWith('blob:') &&
        (targetAsset.id.startsWith('roombake_') ||
          targetAsset.category === 'environment' ||
          targetAsset.name.toLowerCase().includes('room'))
          ? '/api/assets/baked_room_studio.glb'
          : targetAsset.glbUrl;

      engine
        .loadCustomModel(resolvedUrl, 'model')
        .then(() => {
          if (!engineRef.current) return;
          setViews([...engineRef.current.views]);
          setModelStatus(targetAsset.name);
          setSelectedViewIdx(1);
          const v = engineRef.current.views[1] || engineRef.current.views[0];
          if (v) {
            engineRef.current.renderConditioning(v, autoRange, depthInvert, maskFeather);
            refreshViewInfo(v);
          }
          setShowGaps(false);
          updateStats();
          addLog(`✓ Loaded "${targetAsset.name}" with its textures into RoomBake!`, 'ok');
        })
        .catch((err) => {
          console.warn('Failed to load targetAsset in RoomBake:', err);
          addLog(`Could not load target model (${err.message}). Using default room.`, 'err');
        });
    }
  }, [
    isOpen,
    targetAsset,
    autoRange,
    depthInvert,
    maskFeather,
    refreshViewInfo,
    updateStats,
    addLog,
  ]);

  // Section 00: Geometry Handlers
  const handleImport3DModel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const engine = engineRef.current;
    if (!file || !engine) return;

    try {
      addLog(`Importing 3D Model: ${file.name}...`, 'info');
      await engine.loadCustomModel(file, uvMode);
      setViews([...engine.views]);
      setModelStatus(engine.state.modelName);
      setSelectedViewIdx(1);
      const v = engine.views[1] || engine.views[0];
      if (v) {
        engine.renderConditioning(v, autoRange, depthInvert, maskFeather);
        refreshViewInfo(v);
      }
      setShowGaps(false);
      updateStats();
      addLog(`Model "${file.name}" imported with ${uvMode.toUpperCase()} UV layout!`, 'ok');
    } catch (err: any) {
      addLog(`Model import failed: ${err.message}`, 'err');
    }
  };

  const handleResetBox = () => {
    const engine = engineRef.current;
    if (!engine) return;
    lastLoadedTargetKeyRef.current = null;
    engine.buildDefaultRoom();
    setViews([...engine.views]);
    setModelStatus(engine.state.modelName);
    setSelectedViewIdx(1);
    const v = engine.views[1] || engine.views[0];
    if (v) {
      engine.renderConditioning(v, autoRange, depthInvert, maskFeather);
      refreshViewInfo(v);
    }
    updateStats();
    addLog('Reset to procedural box room.', 'ok');
  };

  // Section 01: View Handlers
  const handleFovChange = (newFov: number) => {
    setFov(newFov);
    const engine = engineRef.current;
    if (!engine) return;
    engine.updateViewFov(selectedViewIdx, newFov);
    const v = engine.views[selectedViewIdx];
    if (v) {
      engine.renderConditioning(v, autoRange, depthInvert, maskFeather);
      refreshViewInfo(v);
      updateStats();
    }
  };

  const handleAimFromHere = () => {
    const engine = engineRef.current;
    if (!engine) return;
    const newView = engine.addAimView(fov);
    setViews([...engine.views]);
    const newIdx = engine.views.length - 1;
    setSelectedViewIdx(newIdx);
    engine.renderConditioning(newView, autoRange, depthInvert, maskFeather);
    refreshViewInfo(newView);
    updateStats();
    addLog(`Added capture view "${newView.name}" aiming from preview camera.`, 'ok');
  };

  const handlePanoHere = () => {
    const engine = engineRef.current;
    if (!engine) return;
    const newView = engine.addPanoView();
    setViews([...engine.views]);
    const newIdx = engine.views.length - 1;
    setSelectedViewIdx(newIdx);
    engine.renderConditioning(newView, autoRange, depthInvert, maskFeather);
    refreshViewInfo(newView);
    updateStats();
    addLog(`Added panorama viewpoint "${newView.name}" at preview position.`, 'ok');
  };

  // Section 02: Conditioning Handlers
  const handleFrameSizeChange = (val: string) => {
    setFrameSize(val);
    const [w, h] = val.split('x').map((n) => parseInt(n, 10));
    const engine = engineRef.current;
    if (!engine) return;
    engine.setGenSize(w, h);
    const v = engine.views[selectedViewIdx];
    if (v) {
      engine.renderConditioning(v, autoRange, depthInvert, maskFeather);
      updateStats();
    }
    addLog(`Capture frame resolution updated to ${w} × ${h}px`, 'info');
  };

  const handleRenderConditioning = () => {
    const engine = engineRef.current;
    if (!engine) return;
    const v = engine.views[selectedViewIdx];
    if (!v) return;
    if (!autoRange) {
      engine.cond.range = { near: nearDist, far: farDist };
    }
    const res = engine.renderConditioning(v, autoRange, depthInvert, maskFeather);
    setCondInfo(
      `${v.type === 'pano' ? '2048×1024' : frameSize} · depth ${res.range.near.toFixed(2)}–${res.range.far.toFixed(2)} m`
    );
    updateStats();
    addLog(`Rendered depth, normal, and mask for ${v.name}`, 'ok');
  };

  const downloadCanvas = (canvas: HTMLCanvasElement | null, filename: string) => {
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = filename;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  const saveCondMap = (type: 'depth' | 'normal' | 'mask') => {
    const engine = engineRef.current;
    if (!engine) return;
    const cv = engine.cond[type];
    if (!cv) {
      addLog(`No ${type} map rendered yet. Click "Render depth · normal · mask" first.`, 'err');
      return;
    }
    const viewName = (engine.views[selectedViewIdx]?.name || 'view').replace(/[^a-zA-Z0-9_-]/g, '_');
    downloadCanvas(cv, `${viewName}-${type}.png`);
    addLog(`Saved ${viewName}-${type}.png`, 'ok');
  };

  // Section 03: Generate Image (Without Baking)
  const handleGenerateImageOnly = async () => {
    const engine = engineRef.current;
    if (!engine || busy) return;
    const v = engine.views[selectedViewIdx];
    if (!v) return;

    setBusy(true);
    addLog(`Generating image for ${v.name}...`, 'info');

    try {
      if (!engine.cond.depth) {
        engine.renderConditioning(v, autoRange, depthInvert, maskFeather);
      }
      const initCv = engine.state.bakes > 0 ? engine.renderInitFromAtlas(v) : null;

      const activeModel = 'gemini-3.1-flash-lite-image';
      const activeKey = gemKey;
      const activePrompt = srcSelect === 'gemini' ? gemTemplate : genericPrompt;
      const activeStyle = srcSelect === 'gemini' ? gemStyle : '';

      const genCv = await generateTexture({
        provider: srcSelect === 'gemini' || srcSelect === 'mock' || srcSelect === 'normals'
          ? srcSelect
          : 'mock',
        model: activeModel,
        prompt: activePrompt,
        style: activeStyle,
        apiKey: activeKey,
        sendCond: gemSendCond,
        quality: 'standard',
        size: frameSize,
        images: {
          depth: engine.cond.depth,
          normal: engine.cond.normal,
          mask: engine.cond.mask,
          base: initCv,
        },
      });

      setCurrentGenCanvas(genCv);
      setGenThumb(genCv.toDataURL());
      addLog('Generated image ready for projection baking!', 'ok');
    } catch (err: any) {
      addLog(`Generate failed: ${err.message}`, 'err');
    } finally {
      setBusy(false);
    }
  };

  const handleUploadUserImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = img.width;
      cv.height = img.height;
      const ctx = cv.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      setCurrentGenCanvas(cv);
      setGenThumb(cv.toDataURL());
      addLog(`Uploaded custom texture "${file.name}" (${cv.width}×${cv.height}px)`, 'ok');
    };
    img.src = URL.createObjectURL(file);
  };

  // Section 04: Projection Bake Handlers
  const handleBakeThisView = () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!currentGenCanvas) {
      addLog('Nothing to bake — click "Generate image" first or upload an image.', 'err');
      return;
    }
    const v = engine.views[selectedViewIdx];
    if (!v) return;

    const texture = new THREE.CanvasTexture(currentGenCanvas);
    texture.colorSpace = THREE.LinearSRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    engine.bake(v, texture, {
      uWeightPow: wpow,
      uMinNdotV: minndotv,
      uBias: bias,
      uFeather: feather,
      uBlend: blend,
      uOcclude: occlude ? 1.0 : 0.0,
    });

    updateStats();
    addLog(`Baked ${v.name}! Total bakes: ${engine.state.bakes}`, 'ok');
  };

  const handleStepOnce = async (viewIndex: number) => {
    const engine = engineRef.current;
    if (!engine) return;
    const v = engine.views[viewIndex];
    if (!v) return;

    engine.renderConditioning(v, autoRange, depthInvert, maskFeather);
    const initCv = engine.state.bakes > 0 ? engine.renderInitFromAtlas(v) : null;

    const activeModel = 'gemini-3.1-flash-lite-image';
    const activeKey = gemKey;
    const activePrompt = srcSelect === 'gemini' ? gemTemplate : genericPrompt;
    const activeStyle = srcSelect === 'gemini' ? gemStyle : '';

    const genCv = await generateTexture({
      provider: srcSelect === 'gemini' || srcSelect === 'mock' || srcSelect === 'normals'
        ? srcSelect
        : 'mock',
      model: activeModel,
      prompt: activePrompt,
      style: activeStyle,
      apiKey: activeKey,
      sendCond: gemSendCond,
      quality: 'standard',
      size: frameSize,
      images: {
        depth: engine.cond.depth,
        normal: engine.cond.normal,
        mask: engine.cond.mask,
        base: initCv,
      },
    });

    setCurrentGenCanvas(genCv);
    setGenThumb(genCv.toDataURL());

    const texture = new THREE.CanvasTexture(genCv);
    texture.colorSpace = THREE.LinearSRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    engine.bake(v, texture, {
      uWeightPow: wpow,
      uMinNdotV: minndotv,
      uBias: bias,
      uFeather: feather,
      uBlend: blend,
      uOcclude: occlude ? 1.0 : 0.0,
    });

    updateStats();
  };

  const handleConditionGenerateBake = async () => {
    if (busy) return;
    setBusy(true);
    addLog(`Condition → Generate → Bake for view: ${views[selectedViewIdx]?.name}...`, 'info');
    try {
      await handleStepOnce(selectedViewIdx);
      addLog(`Completed ${views[selectedViewIdx]?.name}`, 'ok');
    } catch (err: any) {
      addLog(`Step failed: ${err.message}`, 'err');
    } finally {
      setBusy(false);
    }
  };

  const handleRunEveryView = async () => {
    const engine = engineRef.current;
    if (!engine || busy) return;

    setBusy(true);
    setAutoProgress({ current: 0, total: engine.views.length });
    addLog(`Starting automated multi-view baking across ${engine.views.length} viewpoints...`, 'info');

    try {
      const isAI = srcSelect === 'gemini';
      for (let i = 0; i < engine.views.length; i++) {
        const v = engine.views[i];
        if (isAI && v.type === 'pano') {
          addLog(`[${i + 1}/${engine.views.length}] ${v.name} (skipped — panoramas not supported by AI image APIs)`, 'info');
          continue;
        }
        setSelectedViewIdx(i);
        setAutoProgress({ current: i + 1, total: engine.views.length });
        refreshViewInfo(v);
        addLog(`[${i + 1}/${engine.views.length}] Processing ${v.name}...`, 'info');
        await handleStepOnce(i);
        await new Promise((r) => setTimeout(r, 40));
      }
      addLog('All camera perspectives synthesized and projectively baked into UV space!', 'ok');
    } catch (err: any) {
      addLog(`Auto run stopped: ${err.message}`, 'err');
    } finally {
      setBusy(false);
      setAutoProgress(null);
    }
  };

  const handleUndoBake = () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.undoBake()) {
      updateStats();
      addLog('Undid last bake pass.', 'ok');
    } else {
      addLog('Nothing to undo.', 'info');
    }
  };

  // Section 05: Atlas Handlers
  const handleDilateChange = (passes: number) => {
    setDilate(passes);
    const engine = engineRef.current;
    if (!engine) return;
    engine.refreshDisplay(passes);
    updateStats();
  };

  const handleToggleGaps = (show: boolean) => {
    setShowGaps(show);
    const engine = engineRef.current;
    if (!engine) return;
    engine.setShowGaps(show);
  };

  const handleClearAtlas = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.clearBake();
    setCurrentGenCanvas(null);
    setGenThumb(null);
    updateStats();
    addLog('Atlas cleared.', 'ok');
  };

  // Section 06: Export Handlers
  const handleDownloadAtlasPng = () => {
    const engine = engineRef.current;
    if (!engine) return;
    downloadCanvas(engine.getAtlasCanvas(), 'atlas.png');
    addLog('Downloaded atlas.png', 'ok');
  };

  const handleDownloadGlb = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      addLog('Packaging baked 3D scene into GLB...', 'info');
      const glbBuffer = await engine.exportBakedGLB();
      const blob = new Blob([glbBuffer], { type: 'model/gltf-binary' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = 'room-baked.glb';
      link.href = url;
      link.click();
      addLog('Downloaded room-baked.glb successfully!', 'ok');
    } catch (err: any) {
      addLog(`Export GLB error: ${err.message}`, 'err');
    }
  };

  const handleDownloadCondPng = () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!engine.cond.depth) {
      addLog('Render the conditioning first.', 'err');
      return;
    }
    saveCondMap('depth');
    saveCondMap('normal');
    saveCondMap('mask');
  };

  const handleAddToActiveScene = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      addLog('Exporting baked room into active Virtual Stage...', 'info');
      const glbBuffer = await engine.exportBakedGLB();
      const blob = new Blob([glbBuffer], { type: 'model/gltf-binary' });
      let glbUrl = URL.createObjectURL(blob);

      // Persist to local disk so the model remains permanent across browser reloads
      try {
        const uploadRes = await fetch(`/api/upload-asset?filename=roombake_${Date.now()}.glb`, {
          method: 'POST',
          headers: { 'Content-Type': 'model/gltf-binary' },
          body: glbBuffer,
        });
        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          if (uploadData.url) {
            glbUrl = uploadData.url;
          }
        }
      } catch (uploadErr) {
        console.warn('Could not persist baked room to disk, using blob fallback', uploadErr);
      }

      if (onAddSceneAsset) {
        onAddSceneAsset({
          name: targetAsset?.name || 'AI Baked Room Environment',
          glbUrl,
          modelBlob: blob,
        });
      }
      addLog('Successfully added baked room to your Virtual Production Scene!', 'ok');
      onClose();
    } catch (err: any) {
      addLog(`Add to scene error: ${err.message}`, 'err');
    }
  };

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col bg-surface-container-lowest text-on-surface overflow-hidden font-sans ${
        isOpen ? 'flex animate-fade-in' : 'hidden'
      }`}
    >
      {/* Top Header Bar */}
      <header className="h-14 border-b border-surface-container-highest bg-surface-container-low px-6 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-[28px]">brush</span>
            <span className="font-headline-lg text-lg text-primary tracking-wide font-medium">
              ROOMBAKE
            </span>
          </div>
          <span className="text-xs font-mono px-2.5 py-1 bg-surface-container border border-outline-variant/40 rounded text-on-surface-variant">
            PROJECTIVE BAKE HARNESS
          </span>
          {targetAsset ? (
            <span className="text-xs font-mono px-2.5 py-1 bg-cyan-500/15 border border-cyan-400/40 rounded text-cyan-300 font-semibold flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[15px]">view_in_ar</span>
              ACTIVE TARGET: {targetAsset.name}
            </span>
          ) : (
            <span className="text-xs font-mono text-on-surface-variant/80 hidden md:inline">
              {modelStatus}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleAddToActiveScene}
            className="flex items-center gap-2 px-4 py-1.5 bg-primary text-on-primary font-medium text-xs tracking-wider uppercase rounded hover:opacity-90 transition-opacity shadow-lg shadow-primary/20"
          >
            <span className="material-symbols-outlined text-[18px]">add_box</span>
            Add to Active Scene
          </button>
          <button
            onClick={onClose}
            className="text-on-surface-variant hover:text-on-surface p-1.5 rounded transition-colors"
          >
            <span className="material-symbols-outlined text-[24px]">close</span>
          </button>
        </div>
      </header>

      {/* Main Studio Body */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left Side: 3D Stage & Bottom Status Strip */}
        <div className="flex-1 flex flex-col min-w-0 bg-black/80 relative">
          {/* Canvas Wrap */}
          <div className="flex-1 relative min-h-0">
            <canvas ref={canvasRef} className="w-full h-full block cursor-grab active:cursor-grabbing" />

            {/* Brand Badge */}
            <div className="absolute top-3 left-3 pointer-events-none bg-surface-container-low/85 backdrop-blur-md border border-outline-variant/40 px-3 py-1.5 rounded text-xs font-mono flex items-center gap-2 shadow-md">
              <b className="text-primary font-semibold">RoomBake</b>
              <span className="text-on-surface-variant">projective bake harness</span>
            </div>

            {/* Hint Badge */}
            <div className="absolute top-3 right-3 pointer-events-none bg-surface-container-low/85 backdrop-blur-md border border-outline-variant/40 px-3 py-1.5 rounded text-[11px] font-mono text-on-surface-variant shadow-md">
              drag to look · wheel to pull back · WASD/QE to move
            </div>

            {/* Progress Badge */}
            {autoProgress && (
              <div className="absolute bottom-4 right-4 bg-primary/20 backdrop-blur-md border border-primary px-4 py-2 rounded text-primary text-xs font-mono flex items-center gap-3 animate-pulse shadow-lg">
                <span className="material-symbols-outlined animate-spin text-[18px]">sync</span>
                Auto-Baking Views: {autoProgress.current} / {autoProgress.total}
              </div>
            )}
          </div>

          {/* Bottom Status & Conditioning Strip */}
          <div className="h-44 border-t border-surface-container-highest bg-surface-container-low grid grid-cols-12 gap-px shrink-0">
            {/* Atlas Thumbnail */}
            <div className="col-span-2 p-3 flex flex-col justify-between bg-surface-container/40 border-r border-surface-container-highest">
              <span className="font-mono text-[10px] uppercase text-on-surface-variant tracking-wider font-semibold">
                ATLAS
              </span>
              <div
                onClick={handleDownloadAtlasPng}
                className="w-24 h-24 mx-auto bg-surface-container-lowest border border-outline-variant/50 rounded overflow-hidden cursor-pointer hover:border-primary transition-colors flex items-center justify-center relative group"
                title="Click to Download Atlas PNG"
              >
                {atlasThumb ? (
                  <img src={atlasThumb} alt="Atlas" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-[10px] font-mono text-on-surface-variant">Empty</span>
                )}
                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-primary">
                  <span className="material-symbols-outlined text-[16px]">download</span>
                </div>
              </div>
            </div>

            {/* Coverage Meter & Conditioning Cells */}
            <div className="col-span-5 p-3 bg-surface-container/40 border-r border-surface-container-highest flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-mono text-[10px] uppercase text-on-surface-variant tracking-wider font-semibold">
                    COVERAGE
                  </span>
                  <span className="font-mono text-[11px] text-primary font-medium">
                    {(coverage * 100).toFixed(1)}% ({bakesCount} bake{bakesCount === 1 ? '' : 's'})
                  </span>
                </div>
                <div className="w-full h-2 bg-surface-container-highest rounded-full overflow-hidden border border-outline-variant/30">
                  <div
                    className="h-full bg-gradient-to-r from-primary to-cyan-400 transition-all duration-300"
                    style={{ width: `${Math.min(100, coverage * 100)}%` }}
                  />
                </div>
              </div>

              {/* Conditioning Cells */}
              <div className="grid grid-cols-4 gap-2 mt-2">
                <div
                  onClick={() => saveCondMap('depth')}
                  className="flex flex-col gap-1 cursor-pointer group"
                  title="Click to Save Depth Map"
                >
                  <span className="font-mono text-[9px] text-center text-on-surface-variant font-medium">DEPTH</span>
                  <div className="h-14 bg-surface-container-lowest border border-outline-variant/50 rounded overflow-hidden flex items-center justify-center group-hover:border-primary transition-colors">
                    {depthThumb && <img src={depthThumb} alt="Depth" className="w-full h-full object-cover" />}
                  </div>
                </div>

                <div
                  onClick={() => saveCondMap('normal')}
                  className="flex flex-col gap-1 cursor-pointer group"
                  title="Click to Save Normal Map"
                >
                  <span className="font-mono text-[9px] text-center text-on-surface-variant font-medium">NORMAL</span>
                  <div className="h-14 bg-surface-container-lowest border border-outline-variant/50 rounded overflow-hidden flex items-center justify-center group-hover:border-primary transition-colors">
                    {normalThumb && <img src={normalThumb} alt="Normal" className="w-full h-full object-cover" />}
                  </div>
                </div>

                <div
                  onClick={() => saveCondMap('mask')}
                  className="flex flex-col gap-1 cursor-pointer group"
                  title="Click to Save Inpaint Mask"
                >
                  <span className="font-mono text-[9px] text-center text-on-surface-variant font-medium">INPAINT</span>
                  <div className="h-14 bg-surface-container-lowest border border-outline-variant/50 rounded overflow-hidden flex items-center justify-center group-hover:border-primary transition-colors">
                    {maskThumb && <img src={maskThumb} alt="Mask" className="w-full h-full object-cover" />}
                  </div>
                </div>

                <div
                  onClick={() => genThumb && setShowGenModal(true)}
                  className={`flex flex-col gap-1 ${genThumb ? 'cursor-pointer group' : 'opacity-40'}`}
                  title={genThumb ? 'Click to view full-size Generated Image' : 'No image generated yet'}
                >
                  <span className="font-mono text-[9px] text-center text-primary font-medium">GENERATED</span>
                  <div className={`h-14 bg-surface-container-lowest border rounded overflow-hidden flex items-center justify-center transition-colors relative ${genThumb ? 'border-primary/60 group-hover:border-primary' : 'border-outline-variant/30'}`}>
                    {genThumb ? (
                      <img src={genThumb} alt="Generated" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-[9px] font-mono text-on-surface-variant/40">—</span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Live Log Console */}
            <div className="col-span-5 p-3 bg-surface-container-lowest flex flex-col justify-between overflow-hidden">
              <span className="font-mono text-[10px] uppercase text-on-surface-variant tracking-wider font-semibold mb-1">
                SYSTEM LOG
              </span>
              <div className="flex-1 overflow-y-auto font-mono text-[11px] leading-relaxed flex flex-col gap-0.5 select-text">
                {logs.map((l, i) => (
                  <div
                    key={i}
                    className={
                      l.type === 'ok'
                        ? 'text-emerald-400'
                        : l.type === 'err'
                        ? 'text-red-400'
                        : 'text-on-surface-variant'
                    }
                  >
                    {l.text}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          </div>
        </div>

        {/* Right Side: Control Rail (Sections 00 - 06) */}
        <aside className="w-96 border-l border-surface-container-highest bg-surface-container-low flex flex-col overflow-y-auto select-none shrink-0 divide-y divide-surface-container-highest">
          {/* Section 00: Geometry */}
          <div className="p-4 flex flex-col gap-3">
            <div
              onClick={() => toggleSection('s00')}
              className="flex items-center justify-between cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-primary font-bold">00</span>
                <span className="text-xs font-semibold uppercase tracking-wider text-on-surface">
                  GEOMETRY
                </span>
              </div>
              <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
                {openSections.s00 ? 'expand_less' : 'expand_more'}
              </span>
            </div>

            {openSections.s00 && (
              <div className="flex flex-col gap-3 pt-1 animate-fade-in">
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] font-mono text-on-surface-variant">
                    Import 3D Model (.obj, .glb, .gltf, .fbx)
                  </label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".obj,.glb,.gltf,.fbx"
                    onChange={handleImport3DModel}
                    className="text-xs font-mono text-on-surface-variant file:mr-2 file:py-1 file:px-2.5 file:rounded file:border-0 file:text-xs file:font-mono file:bg-surface-container file:text-on-surface hover:file:bg-surface-container-high cursor-pointer"
                  />
                </div>

                <div className="font-mono text-[10.5px] text-on-surface-variant/80">
                  {modelStatus}
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[11px] font-mono text-on-surface-variant">
                    UV Mapping Strategy
                  </label>
                  <select
                    value={uvMode}
                    onChange={(e) => setUvMode(e.target.value as any)}
                    className="w-full bg-surface-container border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface rounded outline-none focus:border-primary font-mono"
                  >
                    <option value="smart">Smart Coplanar Island Unwrap (Maximum Area, Zero Overlap)</option>
                    <option value="auto">Auto: Keep Model UVs if present, else Smart Unwrap</option>
                    <option value="box">Simple 6-Way Box Projection</option>
                    <option value="model">Force File UVs</option>
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowUVModal(true)}
                    className="flex-1 py-1.5 px-3 bg-surface-container border border-outline-variant text-xs text-on-surface hover:bg-surface-container-high transition-colors font-mono"
                  >
                    Inspect UV Layout
                  </button>
                  <button
                    onClick={handleResetBox}
                    className="py-1.5 px-3 bg-surface-container border border-outline-variant text-xs text-on-surface hover:bg-surface-container-high transition-colors whitespace-nowrap font-mono"
                  >
                    Reset Box
                  </button>
                </div>

                <p className="text-[11px] text-on-surface-variant/70 leading-relaxed font-sans">
                  If your model has no UVs, <b>Smart Coplanar Unwrap</b> groups surfaces by wall/floor planes and packs them into dedicated non-overlapping atlas charts with zero overlap.
                </p>
              </div>
            )}
          </div>

          {/* Section 01: View */}
          <div className="p-4 flex flex-col gap-3">
            <div
              onClick={() => toggleSection('s01')}
              className="flex items-center justify-between cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-primary font-bold">01</span>
                <span className="text-xs font-semibold uppercase tracking-wider text-on-surface">
                  VIEW
                </span>
              </div>
              <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
                {openSections.s01 ? 'expand_less' : 'expand_more'}
              </span>
            </div>

            {openSections.s01 && (
              <div className="flex flex-col gap-3 pt-1 animate-fade-in">
                <div className="flex flex-col gap-1">
                  <div className="flex justify-between text-[11px] font-mono text-on-surface-variant">
                    <span>Field of view</span>
                    <b>{fov}°</b>
                  </div>
                  <input
                    type="range"
                    min="30"
                    max="110"
                    step="1"
                    value={fov}
                    onChange={(e) => handleFovChange(parseInt(e.target.value, 10))}
                    className="accent-primary"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleAimFromHere}
                    className="flex-1 py-1.5 px-3 bg-surface-container border border-outline-variant text-xs text-on-surface hover:bg-surface-container-high transition-colors font-mono"
                  >
                    Aim from here
                  </button>
                  <button
                    onClick={handlePanoHere}
                    className="flex-1 py-1.5 px-3 bg-surface-container border border-outline-variant text-xs text-on-surface hover:bg-surface-container-high transition-colors font-mono"
                  >
                    Panorama here
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Section 02: Conditioning */}
          <div className="p-4 flex flex-col gap-3">
            <div
              onClick={() => toggleSection('s02')}
              className="flex items-center justify-between cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-primary font-bold">02</span>
                <span className="text-xs font-semibold uppercase tracking-wider text-on-surface">
                  CONDITIONING
                </span>
              </div>
              <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
                {openSections.s02 ? 'expand_less' : 'expand_more'}
              </span>
            </div>

            {openSections.s02 && (
              <div className="flex flex-col gap-3 pt-1 animate-fade-in">
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] font-mono text-on-surface-variant">
                    Capture frame
                  </label>
                  <select
                    value={frameSize}
                    onChange={(e) => handleFrameSizeChange(e.target.value)}
                    className="w-full bg-surface-container border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface rounded outline-none focus:border-primary font-mono"
                  >
                    <option value="1024x1024">1024 × 1024 — square</option>
                    <option value="1536x1024">1536 × 1024 — landscape</option>
                    <option value="1024x1536">1024 × 1536 — portrait</option>
                    <option value="768x768">768 × 768 — fast, local models</option>
                  </select>
                </div>

                <button
                  onClick={handleRenderConditioning}
                  className="w-full py-2 px-3 bg-surface-container border border-outline-variant text-xs text-on-surface hover:bg-surface-container-high transition-colors font-mono"
                >
                  Render depth · normal · mask
                </button>

                {condInfo && (
                  <div className="font-mono text-[10.5px] text-on-surface-variant/80">
                    {condInfo}
                  </div>
                )}

                <label className="flex items-center gap-2 cursor-pointer text-xs font-mono text-on-surface-variant select-none">
                  <input
                    type="checkbox"
                    checked={autoRange}
                    onChange={(e) => setAutoRange(e.target.checked)}
                    className="accent-primary"
                  />
                  Auto depth range per view
                </label>

                <label className="flex items-center gap-2 cursor-pointer text-xs font-mono text-on-surface-variant select-none">
                  <input
                    type="checkbox"
                    checked={depthInvert}
                    onChange={(e) => setDepthInvert(e.target.checked)}
                    className="accent-primary"
                  />
                  Invert depth (far = white)
                </label>

                <div className="flex flex-col gap-1">
                  <div className="flex justify-between text-[11px] font-mono text-on-surface-variant">
                    <span>Mask feather</span>
                    <b>{maskFeather} px</b>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="24"
                    step="1"
                    value={maskFeather}
                    onChange={(e) => setMaskFeather(parseInt(e.target.value, 10))}
                    className="accent-primary"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Section 03: Generate */}
          <div className="p-4 flex flex-col gap-3">
            <div
              onClick={() => toggleSection('s03')}
              className="flex items-center justify-between cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-primary font-bold">03</span>
                <span className="text-xs font-semibold uppercase tracking-wider text-on-surface">
                  GENERATE
                </span>
              </div>
              <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
                {openSections.s03 ? 'expand_less' : 'expand_more'}
              </span>
            </div>

            {openSections.s03 && (
              <div className="flex flex-col gap-3 pt-1 animate-fade-in">
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] font-mono text-on-surface-variant">
                    Image source
                  </label>
                  <select
                    value={srcSelect}
                    onChange={(e) => setSrcSelect(e.target.value as any)}
                    className="w-full bg-surface-container border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface rounded outline-none focus:border-primary font-mono"
                  >
                    <option value="gemini">Google Gemini AI</option>
                    <option value="upload">Upload an image</option>
                    <option value="mock">Placeholder (Mock render)</option>
                    <option value="normals">Placeholder (Surface normals)</option>
                  </select>
                </div>

                {/* Generic Prompt & Seed (for mock / normals) */}
                {(srcSelect === 'mock' || srcSelect === 'normals') && (
                  <div className="flex flex-col gap-2 pt-1 border-t border-surface-container-highest">
                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-mono text-on-surface-variant">Prompt</label>
                      <textarea
                        rows={2}
                        value={genericPrompt}
                        onChange={(e) => setGenericPrompt(e.target.value)}
                        className="w-full bg-surface-container border border-outline-variant p-2 text-xs text-on-surface rounded font-mono resize-y"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-mono text-on-surface-variant">Seed</label>
                      <input
                        type="number"
                        value={genericSeed}
                        onChange={(e) => setGenericSeed(parseInt(e.target.value, 10))}
                        className="w-full bg-surface-container border border-outline-variant px-2.5 py-1 text-xs text-on-surface rounded font-mono"
                      />
                    </div>
                  </div>
                )}

                {/* Upload an image */}
                {srcSelect === 'upload' && (
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-mono text-on-surface-variant">Select Image File</label>
                    <input
                      ref={userImageInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleUploadUserImage}
                      className="text-xs font-mono text-on-surface-variant"
                    />
                  </div>
                )}

                {/* Gemini Box */}
                {srcSelect === 'gemini' && (
                  <div className="flex flex-col gap-3 pt-1">
                    <label className="flex items-center gap-2 cursor-pointer text-xs font-mono text-on-surface-variant select-none">
                      <input
                        type="checkbox"
                        checked={gemSendCond}
                        onChange={(e) => setGemSendCond(e.target.checked)}
                        className="accent-primary"
                      />
                      Send depth & normal maps as multimodal vision reference
                    </label>

                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-mono text-on-surface-variant">Prompt / Scene Style</label>
                      <textarea
                        rows={3}
                        value={gemStyle}
                        onChange={(e) => setGemStyle(e.target.value)}
                        placeholder="e.g. Modern minimalist interior, light oak wood floor, concrete plaster accent wall, soft diffused lighting"
                        className="w-full bg-surface-container border border-outline-variant p-2 text-xs text-on-surface rounded font-mono resize-y"
                      />
                    </div>
                  </div>
                )}

                <button
                  disabled={busy}
                  onClick={handleGenerateImageOnly}
                  className="w-full py-2.5 px-4 bg-primary text-on-primary font-medium text-xs tracking-wider uppercase rounded hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-primary/20"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    {busy ? 'hourglass_top' : 'auto_fix_high'}
                  </span>
                  {busy ? 'Generating Image...' : 'Generate image'}
                </button>

                {/* Generated Image Preview Card (Enlarged) */}
                {genThumb && (
                  <div className="flex flex-col gap-2 p-3 bg-surface-container rounded-lg border border-outline-variant/60 shadow-sm mt-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-primary font-mono text-xs font-semibold uppercase tracking-wider">
                        <span className="material-symbols-outlined text-[15px]">image</span>
                        Generated Image
                      </div>
                      {currentGenCanvas && (
                        <span className="text-[10px] font-mono text-on-surface-variant bg-surface-container-high px-1.5 py-0.5 rounded border border-outline-variant/30">
                          {currentGenCanvas.width} × {currentGenCanvas.height} px
                        </span>
                      )}
                    </div>

                    <div
                      onClick={() => setShowGenModal(true)}
                      className="relative group cursor-pointer overflow-hidden rounded-md border border-outline-variant/50 bg-black/40 w-full flex items-center justify-center transition-all hover:border-primary"
                      style={{ maxHeight: '280px', minHeight: '180px' }}
                      title="Click to view full size"
                    >
                      <img
                        src={genThumb}
                        alt="Generated AI Texture"
                        className="w-full h-auto max-h-[280px] object-contain rounded transition-transform duration-200 group-hover:scale-[1.02]"
                      />
                      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1.5 text-white">
                        <span className="material-symbols-outlined text-[28px]">fullscreen</span>
                        <span className="text-[11px] font-mono tracking-wide">Click to view full size</span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-[10.5px] font-mono pt-0.5">
                      <span className="text-emerald-400 font-medium flex items-center gap-1">
                        <span className="material-symbols-outlined text-[14px]">check_circle</span>
                        Ready to bake
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          downloadCanvas(currentGenCanvas, `roombake-generated-${Date.now()}.png`);
                        }}
                        className="px-2 py-0.5 bg-surface-container hover:bg-surface-container-high border border-outline-variant rounded text-on-surface hover:text-primary transition-colors flex items-center gap-1"
                        title="Download image"
                      >
                        <span className="material-symbols-outlined text-[13px]">download</span>
                        Save PNG
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Section 04: Projection bake */}
          <div className="p-4 flex flex-col gap-3">
            <div
              onClick={() => toggleSection('s04')}
              className="flex items-center justify-between cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-primary font-bold">04</span>
                <span className="text-xs font-semibold uppercase tracking-wider text-on-surface">
                  PROJECTION BAKE
                </span>
              </div>
              <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
                {openSections.s04 ? 'expand_less' : 'expand_more'}
              </span>
            </div>

            {openSections.s04 && (
              <div className="flex flex-col gap-3 pt-1 animate-fade-in">
                <div className="flex flex-col gap-2 text-[11px] font-mono text-on-surface-variant">
                  <div className="flex justify-between">
                    <span>Angle weight exponent</span>
                    <b>{wpow.toFixed(2)}</b>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="8"
                    step="0.25"
                    value={wpow}
                    onChange={(e) => setWpow(parseFloat(e.target.value))}
                    className="accent-primary"
                  />

                  <div className="flex justify-between">
                    <span>Reject below N·V</span>
                    <b>{minndotv.toFixed(2)}</b>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="0.8"
                    step="0.01"
                    value={minndotv}
                    onChange={(e) => setMinndotv(parseFloat(e.target.value))}
                    className="accent-primary"
                  />

                  <div className="flex justify-between">
                    <span>Occlusion bias</span>
                    <b>{bias.toFixed(3)}</b>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="0.15"
                    step="0.005"
                    value={bias}
                    onChange={(e) => setBias(parseFloat(e.target.value))}
                    className="accent-primary"
                  />

                  <div className="flex justify-between">
                    <span>Border feather</span>
                    <b>{feather.toFixed(2)}</b>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="0.3"
                    step="0.01"
                    value={feather}
                    onChange={(e) => setFeather(parseFloat(e.target.value))}
                    className="accent-primary"
                  />

                  <div className="flex justify-between">
                    <span>View crossfade band</span>
                    <b>{blend.toFixed(2)}</b>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="0.6"
                    step="0.01"
                    value={blend}
                    onChange={(e) => setBlend(parseFloat(e.target.value))}
                    className="accent-primary"
                  />
                </div>

                <label className="flex items-center gap-2 cursor-pointer text-xs font-mono text-on-surface-variant select-none">
                  <input
                    type="checkbox"
                    checked={occlude}
                    onChange={(e) => setOcclude(e.target.checked)}
                    className="accent-primary"
                  />
                  Depth-test each texel against the capture view
                </label>

                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    disabled={busy || !currentGenCanvas}
                    onClick={handleBakeThisView}
                    className="py-2 px-3 bg-primary text-on-primary font-medium text-xs tracking-wider uppercase rounded hover:opacity-90 transition-opacity disabled:opacity-40 font-mono shadow"
                  >
                    Bake this view
                  </button>
                  <button
                    disabled={busy}
                    onClick={handleConditionGenerateBake}
                    className="py-2 px-2 bg-surface-container border border-outline-variant text-[11px] text-on-surface hover:bg-surface-container-high transition-colors font-mono disabled:opacity-40"
                  >
                    Condition → gen → bake
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    disabled={busy}
                    onClick={handleRunEveryView}
                    className="py-2 px-3 bg-surface-container-high border border-primary/50 text-primary font-medium text-xs tracking-wider uppercase rounded hover:bg-primary/10 transition-colors disabled:opacity-40 font-mono"
                  >
                    Run every view
                  </button>
                  <button
                    disabled={busy || !hasSnapshot}
                    onClick={handleUndoBake}
                    className="py-2 px-3 bg-surface-container border border-outline-variant text-xs text-on-surface-variant hover:text-on-surface disabled:opacity-40 transition-colors font-mono"
                  >
                    Undo last bake
                  </button>
                </div>

                <p className="text-[11px] text-on-surface-variant/70 leading-relaxed font-sans">
                  Crossfade at 0 is a hard highest-weight-wins merge: crisp, but you see where one view ends. Widen the band to trade sharpness for a softer transition.
                </p>
              </div>
            )}
          </div>

          {/* Section 05: Atlas */}
          <div className="p-4 flex flex-col gap-3">
            <div
              onClick={() => toggleSection('s05')}
              className="flex items-center justify-between cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-primary font-bold">05</span>
                <span className="text-xs font-semibold uppercase tracking-wider text-on-surface">
                  ATLAS
                </span>
              </div>
              <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
                {openSections.s05 ? 'expand_less' : 'expand_more'}
              </span>
            </div>

            {openSections.s05 && (
              <div className="flex flex-col gap-3 pt-1 animate-fade-in">
                <div className="flex flex-col gap-1">
                  <div className="flex justify-between text-[11px] font-mono text-on-surface-variant">
                    <span>Seam dilation passes</span>
                    <b>{dilate}</b>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="24"
                    step="1"
                    value={dilate}
                    onChange={(e) => handleDilateChange(parseInt(e.target.value, 10))}
                    className="accent-primary"
                  />
                </div>

                <label className="flex items-center gap-2 cursor-pointer text-xs font-mono text-on-surface-variant select-none">
                  <input
                    type="checkbox"
                    checked={showGaps}
                    onChange={(e) => handleToggleGaps(e.target.checked)}
                    className="accent-primary"
                  />
                  Show untextured surface as grid
                </label>

                <button
                  disabled={busy}
                  onClick={handleClearAtlas}
                  className="w-full py-2 px-3 bg-surface-container border border-outline-variant text-xs text-red-400 hover:bg-red-500/10 transition-colors font-mono"
                >
                  Clear the atlas
                </button>

                <p className="text-[11px] text-on-surface-variant/70 leading-relaxed font-sans">
                  Dilation bleeds colour past every chart edge into the gutter. Set it to 0 and the wall joins go black as soon as bilinear filtering samples outside a chart.
                </p>
              </div>
            )}
          </div>

          {/* Section 06: Export */}
          <div className="p-4 flex flex-col gap-3">
            <div
              onClick={() => toggleSection('s06')}
              className="flex items-center justify-between cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-primary font-bold">06</span>
                <span className="text-xs font-semibold uppercase tracking-wider text-on-surface">
                  EXPORT
                </span>
              </div>
              <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
                {openSections.s06 ? 'expand_less' : 'expand_more'}
              </span>
            </div>

            {openSections.s06 && (
              <div className="flex flex-col gap-2 pt-1 animate-fade-in">
                <button
                  onClick={handleDownloadAtlasPng}
                  className="w-full py-2 px-3 bg-surface-container border border-outline-variant text-xs text-on-surface hover:bg-surface-container-high transition-colors flex items-center justify-center gap-2 font-mono"
                >
                  <span className="material-symbols-outlined text-[16px]">image</span>
                  Download atlas PNG
                </button>

                <button
                  onClick={handleDownloadGlb}
                  className="w-full py-2 px-3 bg-surface-container border border-outline-variant text-xs text-on-surface hover:bg-surface-container-high transition-colors flex items-center justify-center gap-2 font-mono"
                >
                  <span className="material-symbols-outlined text-[16px]">file_download</span>
                  Download room-baked.glb
                </button>

                <button
                  onClick={handleDownloadCondPng}
                  className="w-full py-2 px-3 bg-surface-container border border-outline-variant text-xs text-on-surface hover:bg-surface-container-high transition-colors flex items-center justify-center gap-2 font-mono"
                >
                  <span className="material-symbols-outlined text-[16px]">photo_library</span>
                  Download this view's conditioning
                </button>

                <button
                  onClick={handleAddToActiveScene}
                  className="w-full py-2.5 px-3 bg-primary text-on-primary font-medium text-xs tracking-wider uppercase rounded hover:opacity-90 transition-opacity flex items-center justify-center gap-2 font-mono shadow-md mt-1"
                >
                  <span className="material-symbols-outlined text-[18px]">add_box</span>
                  Add to Active Scene
                </button>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* UV Inspector Modal */}
      <UVInspectorModal
        engine={engineRef.current}
        isOpen={showUVModal}
        onClose={() => setShowUVModal(false)}
      />

      {/* Generated Image Full-Size Modal */}
      {showGenModal && genThumb && (
        <div
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex flex-col items-center justify-center p-4 animate-fade-in"
          onClick={() => setShowGenModal(false)}
        >
          <div
            className="relative max-w-[92vw] max-h-[92vh] bg-surface-container-lowest border border-outline-variant rounded-xl shadow-2xl overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-surface-container border-b border-surface-container-highest">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[20px] text-primary">image</span>
                <span className="text-xs font-mono font-semibold text-on-surface">Generated Image Preview</span>
                {currentGenCanvas && (
                  <span className="text-[10px] font-mono text-on-surface-variant bg-surface-container-high px-2 py-0.5 rounded border border-outline-variant/30">
                    {currentGenCanvas.width} × {currentGenCanvas.height} px
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => downloadCanvas(currentGenCanvas, `roombake-generated-${Date.now()}.png`)}
                  className="px-3 py-1 bg-surface-container-high hover:bg-surface-container-highest border border-outline-variant text-xs text-on-surface rounded font-mono flex items-center gap-1.5 transition-colors"
                >
                  <span className="material-symbols-outlined text-[15px]">download</span>
                  Save PNG
                </button>
                <button
                  type="button"
                  onClick={() => setShowGenModal(false)}
                  className="p-1 text-on-surface-variant hover:text-on-surface rounded hover:bg-surface-container-highest transition-colors"
                  title="Close preview"
                >
                  <span className="material-symbols-outlined text-[22px]">close</span>
                </button>
              </div>
            </div>

            {/* Modal Image Viewport */}
            <div className="flex-1 overflow-auto p-4 flex items-center justify-center bg-black/70 min-h-[300px]">
              <img
                src={genThumb}
                alt="Full size generated preview"
                className="max-w-full max-h-[80vh] object-contain rounded-lg shadow-2xl border border-outline-variant/30"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
