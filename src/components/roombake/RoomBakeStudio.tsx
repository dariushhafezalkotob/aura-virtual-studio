import React, { useEffect, useRef, useState, useCallback } from 'react';
import { RoomBakeEngine, ViewPoint } from '../../services/roombakeEngine';
import { generateTexture } from '../../services/roombakeAiService';
import { UVInspectorModal } from './UVInspectorModal';
import * as THREE from 'three';

interface RoomBakeStudioProps {
  isOpen: boolean;
  onClose: () => void;
  onAddSceneAsset?: (assetData: { name: string; glbUrl?: string; modelBlob?: Blob }) => void;
}

export const RoomBakeStudio: React.FC<RoomBakeStudioProps> = ({
  isOpen,
  onClose,
  onAddSceneAsset,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<RoomBakeEngine | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // UI State
  const [logs, setLogs] = useState<{ text: string; type: 'info' | 'ok' | 'err' }[]>([]);
  const [coverage, setCoverage] = useState(0);
  const [bakesCount, setBakesCount] = useState(0);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [modelName, setModelName] = useState('Default Room (6.0m × 3.0m × 8.0m)');
  const [showUVModal, setShowUVModal] = useState(false);

  // Views
  const [views, setViews] = useState<ViewPoint[]>([]);
  const [selectedViewIdx, setSelectedViewIdx] = useState(1);

  // Geometry / UV Mode
  const [uvMode, setUvMode] = useState<'smart' | 'box' | 'model' | 'auto'>('smart');

  // Conditioning Maps
  const [depthThumb, setDepthThumb] = useState<string | null>(null);
  const [normalThumb, setNormalThumb] = useState<string | null>(null);
  const [maskThumb, setMaskThumb] = useState<string | null>(null);
  const [atlasThumb, setAtlasThumb] = useState<string | null>(null);
  const [genThumb, setGenThumb] = useState<string | null>(null);

  // AI Provider & Settings
  const [provider, setProvider] = useState<'gemini' | 'openai' | 'mock' | 'normals'>('gemini');
  const [geminiModel, setGeminiModel] = useState('gemini-2.5-flash-image');
  const [openaiModel, setOpenaiModel] = useState('dall-e-3');
  const [geminiKey, setGeminiKey] = useState(localStorage.getItem('roombake_gemini_key') || '');
  const [openaiKey, setOpenaiKey] = useState(localStorage.getItem('roombake_openai_key') || '');
  const [stylePrompt, setStylePrompt] = useState('modern architectural interior with light oak parquet flooring, warm diffused studio lighting, smooth white plaster walls, and subtle wooden acoustic slatted paneling');
  const [sendCond, setSendCond] = useState(true);

  // Baking Shader Parameters
  const [weightPow, setWeightPow] = useState(2.0);
  const [minNdotV, setMinNdotV] = useState(0.15);
  const [bias, setBias] = useState(0.02);
  const [feather, setFeather] = useState(0.06);
  const [blend, setBlend] = useState(0.15);
  const [occlude, setOcclude] = useState(true);

  // Progress & Execution State
  const [isGenerating, setIsGenerating] = useState(false);
  const [autoBakeProgress, setAutoBakeProgress] = useState<{ current: number; total: number } | null>(null);

  // Collapsible Sections
  const [openSections, setOpenSections] = useState({
    geo: true,
    views: true,
    cond: true,
    ai: true,
    bake: true,
    export: true,
  });

  const toggleSection = (key: keyof typeof openSections) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const addLog = useCallback((text: string, type: 'info' | 'ok' | 'err' = 'info') => {
    setLogs((prev) => [...prev.slice(-100), { text, type }]);
  }, []);

  const updateThumbs = useCallback(() => {
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

  // Initialize Engine
  useEffect(() => {
    if (!isOpen || !canvasRef.current) return;

    const engine = new RoomBakeEngine(canvasRef.current);
    engineRef.current = engine;
    setViews(engine.views);
    setModelName(engine.state.modelName);

    addLog('RoomBake projective texture baking engine initialized.', 'ok');

    // Initial Conditioning pass
    const view = engine.views[1] || engine.views[0];
    if (view) {
      engine.renderConditioning(view);
      updateThumbs();
    }

    // Animation Loop
    let animId: number;
    const renderLoop = () => {
      engine.render();
      animId = requestAnimationFrame(renderLoop);
    };
    animId = requestAnimationFrame(renderLoop);

    // Mouse Orbit & WASD Walk Controls
    let dragging = false;
    let lx = 0, ly = 0;
    const canvas = canvasRef.current;

    const onPointerDown = (e: PointerEvent) => {
      dragging = true;
      lx = e.clientX;
      ly = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    const onPointerUp = (e: PointerEvent) => {
      dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      engine.orbit.yaw -= (e.clientX - lx) * 0.005;
      engine.orbit.pitch -= (e.clientY - ly) * 0.005;
      engine.orbit.pitch = Math.max(-1.5, Math.min(1.5, engine.orbit.pitch));
      lx = e.clientX;
      ly = e.clientY;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      engine.orbit.dist = Math.max(
        0.01,
        Math.min(40, engine.orbit.dist * (1 + Math.sign(e.deltaY) * 0.15) + (e.deltaY > 0 ? 0.05 : 0))
      );
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;
      const step = 0.35;
      const fwd = new THREE.Vector3(Math.sin(engine.orbit.yaw), 0, Math.cos(engine.orbit.yaw));
      const rgt = new THREE.Vector3(fwd.z, 0, -fwd.x);
      const k = e.key.toLowerCase();
      if (k === 'w') engine.orbit.target.addScaledVector(fwd, step);
      if (k === 's') engine.orbit.target.addScaledVector(fwd, -step);
      if (k === 'a') engine.orbit.target.addScaledVector(rgt, -step);
      if (k === 'd') engine.orbit.target.addScaledVector(rgt, step);
      if (k === 'q') engine.orbit.target.y -= step;
      if (k === 'e') engine.orbit.target.y += step;
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);

    return () => {
      cancelAnimationFrame(animId);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      engine.dispose();
      engineRef.current = null;
    };
  }, [isOpen, addLog, updateThumbs]);

  const handleSelectView = (idx: number) => {
    setSelectedViewIdx(idx);
    const engine = engineRef.current;
    if (!engine) return;
    const view = engine.views[idx];
    if (view) {
      engine.renderConditioning(view);
      updateThumbs();
      addLog(`Selected View: ${view.name}`, 'info');
    }
  };

  const handleCustomModelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const engine = engineRef.current;
    if (!file || !engine) return;

    try {
      addLog(`Importing 3D Model: ${file.name}...`, 'info');
      await engine.loadCustomModel(file, uvMode);
      setViews(engine.views);
      setModelName(engine.state.modelName);
      setSelectedViewIdx(1);
      if (engine.views[1]) engine.renderConditioning(engine.views[1]);
      updateThumbs();
      addLog(`Model "${file.name}" imported with ${uvMode.toUpperCase()} UV layout!`, 'ok');
    } catch (err: any) {
      addLog(`Model load error: ${err.message}`, 'err');
    }
  };

  const handleResetDefaultRoom = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.buildDefaultRoom();
    setViews(engine.views);
    setModelName(engine.state.modelName);
    setSelectedViewIdx(1);
    if (engine.views[1]) engine.renderConditioning(engine.views[1]);
    updateThumbs();
    addLog('Reset to procedural 3D box architecture.', 'ok');
  };

  const handleGenerateAndBakeSingle = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const view = engine.views[selectedViewIdx];
    if (!view) return;

    setIsGenerating(true);
    addLog(`Synthesizing texture for view: ${view.name}...`, 'info');

    try {
      // 1. Refresh conditioning maps
      engine.renderConditioning(view);
      const initCanvas = engine.state.bakes > 0 ? engine.renderInitFromAtlas(view) : null;

      // 2. Multimodal AI Generation
      const genCanvas = await generateTexture({
        provider,
        model: provider === 'gemini' ? geminiModel : openaiModel,
        prompt: stylePrompt,
        style: stylePrompt,
        apiKey: provider === 'gemini' ? geminiKey : openaiKey,
        sendCond,
        images: {
          depth: engine.cond.depth,
          normal: engine.cond.normal,
          mask: engine.cond.mask,
          base: initCanvas,
        },
      });

      setGenThumb(genCanvas.toDataURL());

      // 3. Projective Bake
      const texture = new THREE.CanvasTexture(genCanvas);
      texture.colorSpace = THREE.NoColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;

      engine.bake(view, texture, {
        uWeightPow: weightPow,
        uMinNdotV: minNdotV,
        uBias: bias,
        uFeather: feather,
        uBlend: blend,
        uOcclude: occlude ? 1.0 : 0.0,
      });

      updateThumbs();
      addLog(`Baked "${view.name}" successfully! Total bakes: ${engine.state.bakes}`, 'ok');
    } catch (err: any) {
      addLog(`Generation/Bake error: ${err.message}`, 'err');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRunEveryView = async () => {
    const engine = engineRef.current;
    if (!engine) return;

    // Filter out panorama for AI generation (perspective wall/floor/ceiling views only)
    const perspectiveViews = engine.views
      .map((v, i) => ({ view: v, index: i }))
      .filter((v) => v.view.type !== 'pano');

    if (perspectiveViews.length === 0) return;

    setIsGenerating(true);
    setAutoBakeProgress({ current: 0, total: perspectiveViews.length });
    addLog(`Starting automated progressive multi-view baking across ${perspectiveViews.length} viewpoints...`, 'info');

    try {
      for (let i = 0; i < perspectiveViews.length; i++) {
        const { view, index } = perspectiveViews[i];
        setSelectedViewIdx(index);
        setAutoBakeProgress({ current: i + 1, total: perspectiveViews.length });
        addLog(`[Pass ${i + 1}/${perspectiveViews.length}] Baking ${view.name}...`, 'info');

        engine.renderConditioning(view);
        const initCanvas = engine.state.bakes > 0 ? engine.renderInitFromAtlas(view) : null;

        const genCanvas = await generateTexture({
          provider,
          model: provider === 'gemini' ? geminiModel : openaiModel,
          prompt: stylePrompt,
          style: stylePrompt,
          apiKey: provider === 'gemini' ? geminiKey : openaiKey,
          sendCond,
          images: {
            depth: engine.cond.depth,
            normal: engine.cond.normal,
            mask: engine.cond.mask,
            base: initCanvas,
          },
        });

        const texture = new THREE.CanvasTexture(genCanvas);
        texture.colorSpace = THREE.NoColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;

        engine.bake(view, texture, {
          uWeightPow: weightPow,
          uMinNdotV: minNdotV,
          uBias: bias,
          uFeather: feather,
          uBlend: blend,
          uOcclude: occlude ? 1.0 : 0.0,
        });

        updateThumbs();
      }
      addLog('All camera perspectives synthesized and projectively baked into UV space!', 'ok');
    } catch (err: any) {
      addLog(`Auto-bake error: ${err.message}`, 'err');
    } finally {
      setIsGenerating(false);
      setAutoBakeProgress(null);
    }
  };

  const handleExportGLB = async () => {
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

  const handleAddToActiveScene = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      addLog('Exporting baked room into active Virtual Stage...', 'info');
      const glbBuffer = await engine.exportBakedGLB();
      const blob = new Blob([glbBuffer], { type: 'model/gltf-binary' });
      const glbUrl = URL.createObjectURL(blob);

      if (onAddSceneAsset) {
        onAddSceneAsset({
          name: 'AI Baked Room Environment',
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

  const downloadCanvasImage = (canvasDataUrl: string | null, filename: string) => {
    if (!canvasDataUrl) return;
    const link = document.createElement('a');
    link.download = filename;
    link.href = canvasDataUrl;
    link.click();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface-container-lowest text-on-surface overflow-hidden animate-fade-in font-sans">
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
            PROJECTIVE MULTIMODAL TEXTURE HARNESS
          </span>
          <span className="text-xs font-mono text-on-surface-variant/80 hidden md:inline">
            {modelName}
          </span>
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

      {/* Main Studio Body: Viewport on Left, Control Rail on Right */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left Side: 3D Viewport & Status Strip */}
        <div className="flex-1 flex flex-col min-w-0 bg-black/80 relative">
          {/* 3D Canvas Area */}
          <div className="flex-1 relative min-h-0">
            <canvas ref={canvasRef} className="w-full h-full block cursor-grab active:cursor-grabbing" />

            {/* Viewport Overlay Controls Guide */}
            <div className="absolute top-4 left-4 pointer-events-none bg-surface-container-low/80 backdrop-blur-md border border-outline-variant/30 px-3 py-2 rounded text-[11px] font-mono text-on-surface-variant flex flex-col gap-1 shadow-md">
              <span className="text-primary font-semibold">VIEWPORT CONTROLS</span>
              <span>• Left Drag: Orbit Look-Around</span>
              <span>• Scroll Wheel: Dolly Camera Distance</span>
              <span>• WASD / QE: Walk / Elevate Target</span>
            </div>

            {/* Progress Badge */}
            {autoBakeProgress && (
              <div className="absolute top-4 right-4 bg-primary/20 backdrop-blur-md border border-primary px-4 py-2 rounded text-primary text-xs font-mono flex items-center gap-3 animate-pulse">
                <span className="material-symbols-outlined animate-spin text-[18px]">sync</span>
                Auto-Baking Views: {autoBakeProgress.current} / {autoBakeProgress.total}
              </div>
            )}
          </div>

          {/* Bottom Status & Conditioning Strip */}
          <div className="h-44 border-t border-surface-container-highest bg-surface-container-low grid grid-cols-12 gap-px shrink-0">
            {/* Atlas Thumbnail & Coverage Meter */}
            <div className="col-span-3 p-3 flex flex-col justify-between bg-surface-container/40 border-r border-surface-container-highest">
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-[10px] uppercase text-on-surface-variant tracking-wider font-semibold">
                  TEXTURE ATLAS
                </span>
                <span className="font-mono text-[10px] text-primary font-medium">
                  {(coverage * 100).toFixed(1)}% COVERED
                </span>
              </div>
              <div className="flex items-center gap-3">
                <div
                  onClick={() => downloadCanvasImage(atlasThumb, 'baked-texture-atlas.png')}
                  className="w-20 h-20 bg-surface-container-lowest border border-outline-variant/50 rounded overflow-hidden cursor-pointer hover:border-primary transition-colors shrink-0 flex items-center justify-center relative group"
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
                <div className="flex-1 flex flex-col justify-center gap-1.5">
                  <div className="w-full h-2 bg-surface-container-highest rounded-full overflow-hidden border border-outline-variant/30">
                    <div
                      className="h-full bg-gradient-to-r from-primary to-amber-400 transition-all duration-300"
                      style={{ width: `${Math.min(100, coverage * 100)}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-mono text-on-surface-variant">
                    {bakesCount} view{bakesCount === 1 ? '' : 's'} accumulated
                  </span>
                </div>
              </div>
            </div>

            {/* Conditioning Thumbnails */}
            <div className="col-span-4 p-3 bg-surface-container/40 border-r border-surface-container-highest flex flex-col justify-between">
              <span className="font-mono text-[10px] uppercase text-on-surface-variant tracking-wider font-semibold">
                CONDITIONING PASSES (CLICK TO SAVE)
              </span>
              <div className="grid grid-cols-3 gap-2">
                <div
                  onClick={() => downloadCanvasImage(depthThumb, 'conditioning-depth.png')}
                  className="flex flex-col gap-1 cursor-pointer group"
                >
                  <div className="h-16 bg-surface-container-lowest border border-outline-variant/50 rounded overflow-hidden flex items-center justify-center group-hover:border-primary transition-colors">
                    {depthThumb && <img src={depthThumb} alt="Depth" className="w-full h-full object-cover" />}
                  </div>
                  <span className="font-mono text-[9px] text-center text-on-surface-variant">DEPTH</span>
                </div>

                <div
                  onClick={() => downloadCanvasImage(normalThumb, 'conditioning-normal.png')}
                  className="flex flex-col gap-1 cursor-pointer group"
                >
                  <div className="h-16 bg-surface-container-lowest border border-outline-variant/50 rounded overflow-hidden flex items-center justify-center group-hover:border-primary transition-colors">
                    {normalThumb && <img src={normalThumb} alt="Normal" className="w-full h-full object-cover" />}
                  </div>
                  <span className="font-mono text-[9px] text-center text-on-surface-variant">NORMAL</span>
                </div>

                <div
                  onClick={() => downloadCanvasImage(maskThumb, 'conditioning-mask.png')}
                  className="flex flex-col gap-1 cursor-pointer group"
                >
                  <div className="h-16 bg-surface-container-lowest border border-outline-variant/50 rounded overflow-hidden flex items-center justify-center group-hover:border-primary transition-colors">
                    {maskThumb && <img src={maskThumb} alt="Mask" className="w-full h-full object-cover" />}
                  </div>
                  <span className="font-mono text-[9px] text-center text-on-surface-variant">INPAINT MASK</span>
                </div>
              </div>
            </div>

            {/* Live Terminal Log */}
            <div className="col-span-5 p-3 bg-surface-container-lowest flex flex-col justify-between overflow-hidden">
              <span className="font-mono text-[10px] uppercase text-on-surface-variant tracking-wider font-semibold mb-1">
                SYSTEM LOGS
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
              </div>
            </div>
          </div>
        </div>

        {/* Right Side: Control Rail */}
        <div className="w-96 border-l border-surface-container-highest bg-surface-container-low flex flex-col overflow-y-auto select-none shrink-0 divide-y divide-surface-container-highest">
          {/* Section 00: Geometry & UV Mode */}
          <div className="p-4 flex flex-col gap-3">
            <div
              onClick={() => toggleSection('geo')}
              className="flex items-center justify-between cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-primary font-bold">00</span>
                <span className="text-xs font-semibold uppercase tracking-wider text-on-surface">
                  GEOMETRY & UV MODE
                </span>
              </div>
              <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
                {openSections.geo ? 'expand_less' : 'expand_more'}
              </span>
            </div>

            {openSections.geo && (
              <div className="flex flex-col gap-3 pt-1 animate-fade-in">
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleResetDefaultRoom}
                    className="flex-1 py-1.5 px-3 bg-surface-container border border-outline-variant text-xs text-on-surface hover:bg-surface-container-high transition-colors"
                  >
                    Default Room
                  </button>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-1 py-1.5 px-3 bg-surface-container border border-outline-variant text-xs text-on-surface hover:bg-surface-container-high transition-colors flex items-center justify-center gap-1.5"
                  >
                    <span className="material-symbols-outlined text-[16px]">upload_file</span>
                    Import 3D Model
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".obj,.glb,.gltf"
                    onChange={handleCustomModelUpload}
                    className="hidden"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[11px] font-mono text-on-surface-variant uppercase">
                    UV Unwrapping Strategy:
                  </label>
                  <select
                    value={uvMode}
                    onChange={(e) => setUvMode(e.target.value as any)}
                    className="w-full bg-surface-container border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface rounded outline-none focus:border-primary"
                  >
                    <option value="smart">Smart Coplanar Island (Zero Overlap)</option>
                    <option value="box">6-Way Box Projection</option>
                    <option value="model">Preserve Model UVs</option>
                  </select>
                </div>

                <button
                  onClick={() => setShowUVModal(true)}
                  className="w-full py-1.5 px-3 bg-surface-container-high border border-primary/40 text-primary text-xs font-medium hover:bg-primary/10 transition-colors flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-[16px]">grid_4x4</span>
                  Inspect UV Layout & Wireframe
                </button>
              </div>
            )}
          </div>

          {/* Section 01: Views */}
          <div className="p-4 flex flex-col gap-3">
            <div
              onClick={() => toggleSection('views')}
              className="flex items-center justify-between cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-primary font-bold">01</span>
                <span className="text-xs font-semibold uppercase tracking-wider text-on-surface">
                  CAMERA VIEWPOINT
                </span>
              </div>
              <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
                {openSections.views ? 'expand_less' : 'expand_more'}
              </span>
            </div>

            {openSections.views && (
              <div className="flex flex-col gap-2 pt-1 animate-fade-in">
                <select
                  value={selectedViewIdx}
                  onChange={(e) => handleSelectView(parseInt(e.target.value, 10))}
                  className="w-full bg-surface-container border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface rounded outline-none focus:border-primary font-mono"
                >
                  {views.map((v, i) => (
                    <option key={i} value={i}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Section 02: Conditioning */}
          <div className="p-4 flex flex-col gap-3">
            <div
              onClick={() => toggleSection('cond')}
              className="flex items-center justify-between cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-primary font-bold">02</span>
                <span className="text-xs font-semibold uppercase tracking-wider text-on-surface">
                  CONDITIONING PASSES
                </span>
              </div>
              <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
                {openSections.cond ? 'expand_less' : 'expand_more'}
              </span>
            </div>

            {openSections.cond && (
              <div className="flex flex-col gap-3 pt-1 animate-fade-in text-xs font-mono text-on-surface-variant">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={sendCond}
                    onChange={(e) => setSendCond(e.target.checked)}
                    className="accent-primary"
                  />
                  Send Depth & Normal Conditioning to AI
                </label>
              </div>
            )}
          </div>

          {/* Section 03: AI Generation */}
          <div className="p-4 flex flex-col gap-3">
            <div
              onClick={() => toggleSection('ai')}
              className="flex items-center justify-between cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-primary font-bold">03</span>
                <span className="text-xs font-semibold uppercase tracking-wider text-on-surface">
                  MULTIMODAL AI GENERATOR
                </span>
              </div>
              <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
                {openSections.ai ? 'expand_less' : 'expand_more'}
              </span>
            </div>

            {openSections.ai && (
              <div className="flex flex-col gap-3 pt-1 animate-fade-in">
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] font-mono text-on-surface-variant uppercase">
                    AI Provider:
                  </label>
                  <select
                    value={provider}
                    onChange={(e) => setProvider(e.target.value as any)}
                    className="w-full bg-surface-container border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface rounded outline-none focus:border-primary"
                  >
                    <option value="gemini">Google Gemini (Vision API)</option>
                    <option value="openai">OpenAI (DALL·E 3)</option>
                    <option value="mock">Mock Color Test (Zero-Cost)</option>
                    <option value="normals">Normal Map Pass</option>
                  </select>
                </div>

                {provider === 'gemini' && (
                  <>
                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-mono text-on-surface-variant uppercase">
                        Gemini Model:
                      </label>
                      <select
                        value={geminiModel}
                        onChange={(e) => setGeminiModel(e.target.value)}
                        className="w-full bg-surface-container border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface rounded outline-none focus:border-primary font-mono"
                      >
                        <option value="gemini-2.5-flash-image">gemini-2.5-flash-image</option>
                        <option value="gemini-3.1-flash-lite-image">gemini-3.1-flash-lite-image</option>
                        <option value="imagen-3.0-generate-002">imagen-3.0-generate-002</option>
                      </select>
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-mono text-on-surface-variant uppercase">
                        Gemini API Key:
                      </label>
                      <input
                        type="password"
                        placeholder="AI Studio API Key"
                        value={geminiKey}
                        onChange={(e) => setGeminiKey(e.target.value)}
                        className="w-full bg-surface-container border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface rounded outline-none focus:border-primary font-mono"
                      />
                    </div>
                  </>
                )}

                {provider === 'openai' && (
                  <>
                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-mono text-on-surface-variant uppercase">
                        OpenAI Model:
                      </label>
                      <select
                        value={openaiModel}
                        onChange={(e) => setOpenaiModel(e.target.value)}
                        className="w-full bg-surface-container border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface rounded outline-none focus:border-primary font-mono"
                      >
                        <option value="dall-e-3">dall-e-3</option>
                        <option value="chatgpt-image-latest">chatgpt-image-latest</option>
                      </select>
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-mono text-on-surface-variant uppercase">
                        OpenAI API Key:
                      </label>
                      <input
                        type="password"
                        placeholder="sk-..."
                        value={openaiKey}
                        onChange={(e) => setOpenaiKey(e.target.value)}
                        className="w-full bg-surface-container border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface rounded outline-none focus:border-primary font-mono"
                      />
                    </div>
                  </>
                )}

                <div className="flex flex-col gap-1">
                  <label className="text-[11px] font-mono text-on-surface-variant uppercase">
                    Architectural Style & Materials:
                  </label>
                  <textarea
                    rows={3}
                    value={stylePrompt}
                    onChange={(e) => setStylePrompt(e.target.value)}
                    className="w-full bg-surface-container border border-outline-variant p-2 text-xs text-on-surface rounded outline-none focus:border-primary font-mono resize-y"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Section 04: Projective Bake */}
          <div className="p-4 flex flex-col gap-3">
            <div
              onClick={() => toggleSection('bake')}
              className="flex items-center justify-between cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-primary font-bold">04</span>
                <span className="text-xs font-semibold uppercase tracking-wider text-on-surface">
                  PROJECTIVE BAKE ENGINE
                </span>
              </div>
              <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
                {openSections.bake ? 'expand_less' : 'expand_more'}
              </span>
            </div>

            {openSections.bake && (
              <div className="flex flex-col gap-3 pt-1 animate-fade-in">
                {genThumb && (
                  <div className="flex items-center gap-3 p-2 bg-surface-container rounded border border-outline-variant/40">
                    <img src={genThumb} alt="Generated Texture" className="w-12 h-12 rounded object-cover border border-primary/50" />
                    <div className="flex flex-col">
                      <span className="text-[11px] font-medium text-primary font-mono">Last Generated Image</span>
                      <span className="text-[10px] text-on-surface-variant font-mono">Projected into UV Atlas</span>
                    </div>
                  </div>
                )}

                <button
                  disabled={isGenerating}
                  onClick={handleGenerateAndBakeSingle}
                  className="w-full py-2.5 px-4 bg-primary text-on-primary font-medium text-xs tracking-wider uppercase rounded hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-primary/20"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    {isGenerating ? 'hourglass_top' : 'auto_fix_high'}
                  </span>
                  {isGenerating ? 'Synthesizing...' : 'Generate & Bake This View'}
                </button>

                <button
                  disabled={isGenerating}
                  onClick={handleRunEveryView}
                  className="w-full py-2 px-4 bg-surface-container-high border border-primary/50 text-primary font-medium text-xs tracking-wider uppercase rounded hover:bg-primary/10 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-[18px]">motion_photos_auto</span>
                  ⚡ Run Every View (Auto-Bake All)
                </button>

                {/* Shader Sliders */}
                <div className="flex flex-col gap-2 text-[11px] font-mono text-on-surface-variant pt-2 border-t border-surface-container-highest">
                  <div className="flex justify-between">
                    <span>Weight Power</span>
                    <span>{weightPow.toFixed(1)}</span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="5.0"
                    step="0.1"
                    value={weightPow}
                    onChange={(e) => setWeightPow(parseFloat(e.target.value))}
                    className="accent-primary"
                  />

                  <div className="flex justify-between">
                    <span>Grazing Angle Rejection (minNdotV)</span>
                    <span>{minNdotV.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min="0.01"
                    max="0.5"
                    step="0.01"
                    value={minNdotV}
                    onChange={(e) => setMinNdotV(parseFloat(e.target.value))}
                    className="accent-primary"
                  />

                  <div className="flex justify-between">
                    <span>Occlusion Depth Bias</span>
                    <span>{bias.toFixed(3)}</span>
                  </div>
                  <input
                    type="range"
                    min="0.001"
                    max="0.1"
                    step="0.005"
                    value={bias}
                    onChange={(e) => setBias(parseFloat(e.target.value))}
                    className="accent-primary"
                  />

                  <div className="flex justify-between">
                    <span>Edge Feathering</span>
                    <span>{feather.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min="0.0"
                    max="0.2"
                    step="0.01"
                    value={feather}
                    onChange={(e) => setFeather(parseFloat(e.target.value))}
                    className="accent-primary"
                  />

                  <div className="flex justify-between">
                    <span>Crossfade Blend</span>
                    <span>{blend.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min="0.0"
                    max="0.5"
                    step="0.01"
                    value={blend}
                    onChange={(e) => setBlend(parseFloat(e.target.value))}
                    className="accent-primary"
                  />

                  <label className="flex items-center gap-2 cursor-pointer select-none pt-1">
                    <input
                      type="checkbox"
                      checked={occlude}
                      onChange={(e) => setOcclude(e.target.checked)}
                      className="accent-primary"
                    />
                    Enable Depth Occlusion Culling
                  </label>
                </div>

                <div className="flex items-center gap-2 pt-1">
                  <button
                    disabled={!hasSnapshot || isGenerating}
                    onClick={() => {
                      if (engineRef.current?.undoBake()) updateThumbs();
                    }}
                    className="flex-1 py-1.5 bg-surface-container border border-outline-variant text-[11px] text-on-surface-variant hover:text-on-surface disabled:opacity-40 transition-colors"
                  >
                    Undo Last Bake
                  </button>
                  <button
                    disabled={isGenerating}
                    onClick={() => {
                      engineRef.current?.clearBake();
                      updateThumbs();
                    }}
                    className="flex-1 py-1.5 bg-surface-container border border-outline-variant text-[11px] text-red-400 hover:bg-red-500/10 transition-colors"
                  >
                    Clear Atlas
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Section 05: Export */}
          <div className="p-4 flex flex-col gap-3">
            <div
              onClick={() => toggleSection('export')}
              className="flex items-center justify-between cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-primary font-bold">05</span>
                <span className="text-xs font-semibold uppercase tracking-wider text-on-surface">
                  EXPORT & DOWNLOAD
                </span>
              </div>
              <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
                {openSections.export ? 'expand_less' : 'expand_more'}
              </span>
            </div>

            {openSections.export && (
              <div className="flex flex-col gap-2 pt-1 animate-fade-in">
                <button
                  onClick={handleExportGLB}
                  className="w-full py-2 px-3 bg-surface-container border border-outline-variant text-xs text-on-surface hover:bg-surface-container-high transition-colors flex items-center justify-center gap-2 font-mono"
                >
                  <span className="material-symbols-outlined text-[16px]">file_download</span>
                  Download room-baked.glb
                </button>
                <button
                  onClick={() => downloadCanvasImage(atlasThumb, 'baked-texture-atlas.png')}
                  className="w-full py-2 px-3 bg-surface-container border border-outline-variant text-xs text-on-surface hover:bg-surface-container-high transition-colors flex items-center justify-center gap-2 font-mono"
                >
                  <span className="material-symbols-outlined text-[16px]">image</span>
                  Download Texture Atlas PNG
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* UV Inspector Modal */}
      <UVInspectorModal
        engine={engineRef.current}
        isOpen={showUVModal}
        onClose={() => setShowUVModal(false)}
      />
    </div>
  );
};
