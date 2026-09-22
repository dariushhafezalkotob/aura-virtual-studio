import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Project,
  SceneAsset,
  AI3DEngine,
  AssetCategory,
  WorkflowStage,
  SavedStageTemplate,
  StagePointLight,
} from '../../types';
import { TrellisService, GenerationProgress } from '../../services/trellisService';
import {
  ThreeStage,
  TransformMode,
  LightingEnvironmentPreset,
} from '../viewport/ThreeStage';
import { RoomBakeStudio } from '../roombake/RoomBakeStudio';
import { PRIMITIVE_DEFS, PrimitiveKind, createPrimitiveAssetUrl } from '../../services/primitiveAssets';
import {
  TRELLIS_QUALITY_PRESETS,
  TrellisQuality,
  getTrellisQualityPreset,
  loadTrellisQuality,
  saveTrellisQuality,
} from '../../services/trellisQuality';
import {
  loadStageTemplates,
  saveStageTemplate,
  deleteStageTemplate,
  exportStageToFile,
  importStageFromFile,
  uploadAssetToDisk,
} from '../../services/storageService';
import { savePendingBake, listPendingBakes, deletePendingBake } from '../../services/pendingBakes';

interface SceneDesignViewProps {
  currentProject: Project;
  onUpdateProject: (project: Project) => void;
  onNavigateStage?: (stage: WorkflowStage) => void;
}

const PROP_PRESETS = [
  {
    name: 'Sci-Fi Film Camera',
    url: 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=400&q=80',
  },
  {
    name: 'Cyberpunk Drone',
    url: 'https://images.unsplash.com/photo-1527977966376-1c8408f9f108?auto=format&fit=crop&w=400&q=80',
  },
  {
    name: 'Medieval Magic Book',
    url: 'https://huggingface.co/spaces/trellis-community/TRELLIS/resolve/main/assets/example_image/typical_misc_magicbook.png',
  },
  {
    name: 'Crystal Mineral',
    url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=400&q=80',
  },
  {
    name: 'Futuristic Robot',
    url: 'https://images.unsplash.com/photo-1485827404703-89b55fcc595e?auto=format&fit=crop&w=400&q=80',
  },
  {
    name: 'Vintage Lantern',
    url: 'https://images.unsplash.com/photo-1513519245088-0e12902e5a38?auto=format&fit=crop&w=400&q=80',
  },
];

const PANORAMA_360_PRESETS = [
  {
    name: 'Cyberpunk City Skyline (360°)',
    url: 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/2294472375_24a3b8ef46_o.jpg',
    thumbnail: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=400&q=80',
  },
  {
    name: 'Sunset Sky & Horizon (360°)',
    url: 'https://threejs.org/examples/textures/kandao3.jpg',
    thumbnail: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=400&q=80',
  },
  {
    name: 'Virtual Film Studio (360°)',
    url: 'https://threejs.org/examples/textures/equirectangular.png',
    thumbnail: 'https://images.unsplash.com/photo-1598899134739-24c46f58b8c0?auto=format&fit=crop&w=400&q=80',
  },
];

export const SceneDesignView: React.FC<SceneDesignViewProps> = ({
  currentProject,
  onUpdateProject,
  onNavigateStage,
}) => {
  const [selectedEngine, setSelectedEngine] = useState<AI3DEngine>('trellis');
  const [selectedCategory] = useState<AssetCategory>('prop');
  const [prompt, setPrompt] = useState('');
  const [selectedImageUrl, setSelectedImageUrl] = useState<string | null>(null);
  const [selectedImageFile, setSelectedImageFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [showImagePicker, setShowImagePicker] = useState(false);
  const [showPanoramaModal, setShowPanoramaModal] = useState(false);
  const [showHunyuanWorldModal, setShowHunyuanWorldModal] = useState(false);
  const [showRoomBakeStudio, setShowRoomBakeStudio] = useState(false);
  const [trellisQuality, setTrellisQuality] = useState<TrellisQuality>(() => loadTrellisQuality());
  const [showPrimitiveMenu, setShowPrimitiveMenu] = useState(false);

  // When the server holds the API keys nobody needs to paste their own, so those buttons go away.
  // Until it does they have to stay, or there would be no way to generate anything at all.
  const [serverKeys, setServerKeys] = useState<{ gemini: boolean; hf: boolean }>({ gemini: false, hf: false });

  useEffect(() => {
    let active = true;
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (active && data?.serverKeys) setServerKeys(data.serverKeys);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const [addingPrimitive, setAddingPrimitive] = useState<PrimitiveKind | null>(null);

  // Stage Saving & Stage Library State
  const [saveToast, setSaveToast] = useState<string | null>(null);
  const [showStageLibraryModal, setShowStageLibraryModal] = useState<boolean>(false);
  const [stageLibrary, setStageLibrary] = useState<SavedStageTemplate[]>([]);
  const [isSavingStage, setIsSavingStage] = useState<boolean>(false);
  const stageImportInputRef = useRef<HTMLInputElement>(null);

  // Naming belongs to saving, so SAVE STAGE opens this and the Load dialog no longer carries it.
  const [showSaveStageModal, setShowSaveStageModal] = useState<boolean>(false);
  const [stageSaveName, setStageSaveName] = useState<string>('');
  const [saveProgress, setSaveProgress] = useState<string | null>(null);

  // Baked models that are in the scene but not on the server yet. The id is the scene asset's id.
  const [pendingBakeIds, setPendingBakeIds] = useState<string[]>([]);
  const viewportCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Read inside effects and async saves so they always act on the current project rather than
  // whatever it was when the callback was created.
  const projectRef = useRef(currentProject);
  useEffect(() => {
    projectRef.current = currentProject;
  }, [currentProject]);

  // A bake parked in IndexedDB survives a reload, but its blob: URL does not - that is an address
  // into a page that no longer exists. Mint fresh URLs for the parked bytes on the way back in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const parked = await listPendingBakes();
      if (cancelled || parked.length === 0) return;

      setPendingBakeIds(parked.map((b) => b.id));

      const project = projectRef.current;
      let touched = false;
      const scenes = (project.scenes || []).map((asset) => {
        const bake = parked.find((b) => b.id === asset.id);
        if (!bake || !asset.glbUrl?.startsWith('blob:')) return asset;
        touched = true;
        return { ...asset, glbUrl: URL.createObjectURL(bake.blob) };
      });
      if (touched) onUpdateProject({ ...project, scenes });
    })();
    return () => {
      cancelled = true;
    };
    // Once, on the way in. Later adds register themselves in handleAddRoomBakeAsset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Closing the tab with a bake that only exists in this browser is worth a word of warning.
  useEffect(() => {
    if (pendingBakeIds.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pendingBakeIds.length]);

  // Load stage templates from disk / local storage on mount and when modal opens
  const refreshStageLibrary = useCallback(async () => {
    try {
      const templates = await loadStageTemplates();
      if (templates && templates.length > 0) {
        setStageLibrary(templates);
      }
    } catch (err) {
      console.warn('Failed to load stage templates:', err);
    }
  }, []);

  useEffect(() => {
    refreshStageLibrary();
  }, [refreshStageLibrary]);

  useEffect(() => {
    if (showStageLibraryModal) {
      refreshStageLibrary();
    }
  }, [showStageLibraryModal, refreshStageLibrary]);

  // 360 AI Generator State
  const [isGenerating360, setIsGenerating360] = useState(false);
  const [ai360Prompt, setAi360Prompt] = useState('');
  const [ai360ImageFile, setAi360ImageFile] = useState<File | null>(null);
  const [ai360ImagePreview, setAi360ImagePreview] = useState<string | null>(null);
  const ai360FileInputRef = useRef<HTMLInputElement>(null);

  // HunyuanWorld 3DGS Reconstruction State
  const [isReconstructingWorld, setIsReconstructingWorld] = useState(false);
  const [worldFiles, setWorldFiles] = useState<File[]>([]);
  const [worldPreviews, setWorldPreviews] = useState<string[]>([]);
  const worldFileInputRef = useRef<HTMLInputElement>(null);
  const directSplatInputRef = useRef<HTMLInputElement>(null);

  // Viewport Settings
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [transformMode, setTransformMode] = useState<TransformMode>('translate');
  const [rotationSnapAngle, setRotationSnapAngle] = useState<'10deg' | 'free'>('10deg');
  const [lightIntensity, setLightIntensity] = useState<number>(1.0);
  const [stageSpecularity, setStageSpecularity] = useState<number>(
    currentProject.stageSpecularity !== undefined ? currentProject.stageSpecularity : 0.15
  );
  const [environmentPreset, setEnvironmentPreset] = useState<LightingEnvironmentPreset>('studio');
  const [showGrid, setShowGrid] = useState<boolean>(true);

  // High-Performance Point Lights State (Physical Decay, Zero Shadow Map Overhead)
  const [pointLights, setPointLights] = useState<StagePointLight[]>(currentProject.pointLights || []);
  const [selectedPointLightId, setSelectedPointLightId] = useState<string | null>(null);
  const [showPointLightsPanel, setShowPointLightsPanel] = useState<boolean>(false);

  useEffect(() => {
    if (currentProject.stageSpecularity !== undefined) {
      setStageSpecularity(currentProject.stageSpecularity);
    }
  }, [currentProject.id]);

  useEffect(() => {
    if (currentProject.pointLights) {
      setPointLights(currentProject.pointLights);
    }
  }, [currentProject.id]);

  // Undo / Redo History Stack for Scene Assets (Transforms, Additions, Deletions)
  const undoStackRef = useRef<SceneAsset[][]>([]);
  const redoStackRef = useRef<SceneAsset[][]>([]);
  const currentAssetsRef = useRef<SceneAsset[]>(currentProject.scenes || []);
  currentAssetsRef.current = currentProject.scenes || [];
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const pushUndoSnapshot = useCallback(() => {
    const snapshot = JSON.parse(JSON.stringify(currentAssetsRef.current));
    undoStackRef.current.push(snapshot);
    if (undoStackRef.current.length > 50) {
      undoStackRef.current.shift();
    }
    redoStackRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }, []);

  const handleUndo = useCallback(() => {
    if (undoStackRef.current.length === 0) return;

    const prevScenes = undoStackRef.current.pop()!;
    const currentSnapshot = JSON.parse(JSON.stringify(currentAssetsRef.current));
    redoStackRef.current.push(currentSnapshot);

    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);

    onUpdateProject({
      ...currentProject,
      scenes: prevScenes,
    });
  }, [currentProject, onUpdateProject]);

  const handleRedo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;

    const nextScenes = redoStackRef.current.pop()!;
    const currentSnapshot = JSON.parse(JSON.stringify(currentAssetsRef.current));
    undoStackRef.current.push(currentSnapshot);

    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);

    onUpdateProject({
      ...currentProject,
      scenes: nextScenes,
    });
  }, [currentProject, onUpdateProject]);



  // 360 & 3DGS World State
  const [panoramaUrl, setPanoramaUrl] = useState<string | null>(currentProject.panoramaUrl || null);
  const [panoramaRotation, setPanoramaRotation] = useState<number>(0);
  const [showPanorama, setShowPanorama] = useState<boolean>(true);
  const [splatUrl, setSplatUrl] = useState<string | null>(currentProject.splatUrl || null);
  const [showHfTokenModal, setShowHfTokenModal] = useState<boolean>(false);
  const [hfTokenInput, setHfTokenInput] = useState<string>(localStorage.getItem('hf_token') || '');
  const [geminiApiKey, setGeminiApiKey] = useState<string>(
    localStorage.getItem('gemini_api_key') || localStorage.getItem('roombake_gemini_key') || ''
  );
  const [showGeminiKeyModal, setShowGeminiKeyModal] = useState<boolean>(false);
  const [geminiKeyInput, setGeminiKeyInput] = useState<string>(
    localStorage.getItem('gemini_api_key') || localStorage.getItem('roombake_gemini_key') || ''
  );
  const [aiImagePrompt, setAiImagePrompt] = useState<string>('');
  const [isGeneratingAiImage, setIsGeneratingAiImage] = useState<boolean>(false);
  const [generatedPreviewImages, setGeneratedPreviewImages] = useState<string[]>([]);
  const [selectedPreviewImageIndex, setSelectedPreviewImageIndex] = useState<number>(0);
  const [generatedPreviewImage, setGeneratedPreviewImage] = useState<string | null>(null);
  const [generatedPreviewPrompt, setGeneratedPreviewPrompt] = useState<string>('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const panoInputRef = useRef<HTMLInputElement>(null);

  const assets = currentProject.scenes || [];
  const selectedAsset = assets.find((a) => a.id === selectedAssetId) || null;
  const selectedPointLight = pointLights.find((l) => l.id === selectedPointLightId) || null;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedImageFile(file);
      setSelectedImageUrl(URL.createObjectURL(file));
      setShowImagePicker(false);
    }
  };

  const handlePanoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const diskUrl = await uploadAssetToDisk(file, `pano_${Date.now()}_${file.name}`);
      const url = diskUrl || URL.createObjectURL(file);
      setPanoramaUrl(url);
      setShowPanorama(true);
      onUpdateProject({
        ...currentProject,
        panoramaUrl: url,
      });
      setShowPanoramaModal(false);
    }
  };

  const handleSelectPresetPanorama = (url: string) => {
    setPanoramaUrl(url);
    setShowPanorama(true);
    onUpdateProject({
      ...currentProject,
      panoramaUrl: url,
    });
    setShowPanoramaModal(false);
  };

  const handleAi360FileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setAi360ImageFile(file);
      setAi360ImagePreview(URL.createObjectURL(file));
    }
  };

  // Direct .ply / .splat 3DGS file upload
  const handleDirectSplatUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const diskUrl = await uploadAssetToDisk(file, `splat_${Date.now()}_${file.name}`);
      const url = diskUrl || URL.createObjectURL(file);
      setSplatUrl(url);
      onUpdateProject({
        ...currentProject,
        splatUrl: url,
      });
      setShowHunyuanWorldModal(false);
    }
  };

  // HunyuanWorld Multi-View / Video 3D Scene Reconstruction
  const handleWorldFilesUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      setWorldFiles(files);
      setWorldPreviews(files.map((f) => URL.createObjectURL(f)));
    }
  };

  const handleReconstructHunyuanWorld = async () => {
    if (worldFiles.length === 0) {
      alert('Please upload 2-16 room photos or a sweeping camera video.');
      return;
    }

    try {
      setIsReconstructingWorld(true);
      setProgress({
        stageMessage: 'HunyuanWorld 2.0: Predicting 3D Gaussian Splats & World Depth on ZeroGPU...',
        status: 'sampling',
      });

      const base64Files = await Promise.all(
        worldFiles.map(
          (f) =>
            new Promise<string>((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result as string);
              reader.readAsDataURL(f);
            })
        )
      );

      const res = await fetch('/api/reconstruct-hunyuan-world', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: base64Files }),
      });

      const data = await res.json();
      if (!data.success || (!data.gaussianPlyUrl && !data.worldMeshGlbUrl)) {
        throw new Error(data.error || 'Failed to reconstruct 3D scene.');
      }

      if (data.gaussianPlyUrl) {
        setSplatUrl(data.gaussianPlyUrl);
      }

      let updatedScenes = [...assets];
      if (data.worldMeshGlbUrl) {
        const newEnvAsset: SceneAsset = {
          id: `world_${Date.now()}`,
          name: 'HunyuanWorld 3D Scene',
          glbUrl: data.worldMeshGlbUrl,
          splatUrl: data.gaussianPlyUrl,
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          category: 'environment',
          createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        };
        updatedScenes = [...assets, newEnvAsset];
        setSelectedAssetId(newEnvAsset.id);
      }

      onUpdateProject({
        ...currentProject,
        scenes: updatedScenes,
        splatUrl: data.gaussianPlyUrl || currentProject.splatUrl,
      });

      setProgress({
        stageMessage: 'Walkable 3D Gaussian Splatting Scene Successfully Reconstructed!',
        status: 'completed',
      });

      setTimeout(() => {
        setProgress(null);
        setIsReconstructingWorld(false);
        setShowHunyuanWorldModal(false);
      }, 2500);
    } catch (err: any) {
      console.error(err);
      alert(`HunyuanWorld Error: ${err.message || err}`);
      setProgress(null);
      setIsReconstructingWorld(false);
    }
  };

  const handleGenerate360 = async () => {
    if (!ai360ImageFile && !ai360Prompt.trim()) {
      alert('Please upload a photo or enter a scene prompt to generate a 360° Panorama.');
      return;
    }

    try {
      setIsGenerating360(true);
      setProgress({
        stageMessage: 'Step 1: AI Outpainting 360° Equirectangular Sphere on ZeroGPU...',
        status: 'sampling',
      });

      let imageBase64: string | undefined = undefined;
      if (ai360ImageFile) {
        imageBase64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(ai360ImageFile);
        });
      }

      const res = await fetch('/api/generate-360-from-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64,
          prompt: ai360Prompt.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!data.success || !data.panoramaUrl) {
        throw new Error(data.error || 'Failed to generate 360 panorama');
      }

      setPanoramaUrl(data.panoramaUrl);
      setShowPanorama(true);

      let updatedScenes = [...assets];
      if (data.glbUrl) {
        const newEnvAsset: SceneAsset = {
          id: `env_${Date.now()}`,
          name: ai360Prompt.trim() || '3D AI World Scene',
          glbUrl: data.glbUrl,
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [3.5, 3.5, 3.5],
          category: 'environment',
          createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        };
        updatedScenes = [...assets, newEnvAsset];
        setSelectedAssetId(newEnvAsset.id);
      }

      onUpdateProject({
        ...currentProject,
        scenes: updatedScenes,
        panoramaUrl: data.panoramaUrl,
      });

      setProgress({
        stageMessage: '360° Panoramic World & 3D Scene Mesh Successfully Created!',
        status: 'completed',
      });

      setTimeout(() => {
        setProgress(null);
        setIsGenerating360(false);
        setShowPanoramaModal(false);
      }, 2500);
    } catch (err: any) {
      console.error(err);
      alert(`360 Generation Error: ${err.message || err}`);
      setProgress(null);
      setIsGenerating360(false);
    }
  };

  const executeGenerate3D = async (
    customImage?: { file?: File | null; url?: string | null },
    customEngine?: AI3DEngine,
    customPrompt?: string
  ) => {
    const imgFile = customImage !== undefined ? customImage.file : selectedImageFile;
    const imgUrl = customImage !== undefined ? customImage.url : selectedImageUrl;
    const engineToUse = customEngine || selectedEngine;
    const promptToUse = customPrompt !== undefined ? customPrompt : prompt;

    if (!imgFile && !imgUrl) {
      setShowImagePicker(true);
      return;
    }

    try {
      setProgress({
        stageMessage: `Initializing ${engineToUse === 'hunyuan3d' ? 'Hunyuan3D-2' : 'TRELLIS'} AI Generation...`,
        status: 'connecting',
      });

      // Mesh detail / texture size only apply to TRELLIS; Hunyuan3D has its own fixed pipeline.
      const quality = getTrellisQualityPreset(trellisQuality);
      const result = await TrellisService.generate3D(
        {
          engine: engineToUse,
          category: selectedCategory,
          imageFile: imgFile || undefined,
          imageUrl: imgUrl || undefined,
          prompt: promptToUse,
          ...(engineToUse === 'trellis'
            ? {
                ssSteps: quality.ssSteps,
                slatSteps: quality.slatSteps,
                simplify: quality.simplify,
                textureSize: quality.textureSize,
              }
            : {}),
        },
        (p: GenerationProgress) => setProgress(p)
      );

      const newAsset: SceneAsset = {
        id: `asset_${Date.now()}`,
        name: promptToUse.trim() || (engineToUse === 'hunyuan3d' ? 'Hunyuan 3D (Textured)' : 'TRELLIS 3D Object'),
        glbUrl: result.glbUrl,
        previewUrl: result.videoUrl,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        prompt: promptToUse,
        engine: engineToUse,
        category: selectedCategory,
        createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      const updatedProject = {
        ...currentProject,
        scenes: [...assets, newAsset],
      };

      onUpdateProject(updatedProject);
      setSelectedAssetId(newAsset.id);
      setTimeout(() => setProgress(null), 3000);
    } catch (err: any) {
      console.error(err);
      alert(`Generation error: ${err.message || err}`);
      setProgress(null);
    }
  };

  const handleGenerate = () => {
    executeGenerate3D();
  };

  const handleGenerateImage = async () => {
    if (!aiImagePrompt.trim()) {
      alert('Please enter a description for the image you want to generate.');
      return;
    }
    try {
      setIsGeneratingAiImage(true);
      const res = await fetch('/api/generate-image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(geminiApiKey ? { 'x-gemini-key': geminiApiKey } : {}),
        },
        body: JSON.stringify({
          prompt: aiImagePrompt.trim(),
          apiKey: geminiApiKey || undefined,
          model: 'gemini-3.1-flash-lite-image',
        }),
      });
      const data = await res.json();
      if (!data.success || (!data.imageBase64 && (!data.images || data.images.length === 0))) {
        throw new Error(data.error || 'Failed to generate image');
      }
      const imgs: string[] = data.images && data.images.length > 0 ? data.images : [data.imageBase64];
      setGeneratedPreviewImages(imgs);
      setSelectedPreviewImageIndex(0);
      setGeneratedPreviewImage(imgs[0]);
      setGeneratedPreviewPrompt(aiImagePrompt.trim());
    } catch (err: any) {
      console.error(err);
      alert(`Image Generation Error: ${err.message || err}`);
    } finally {
      setIsGeneratingAiImage(false);
    }
  };

  const handleAcceptAndSendToHunyuan = () => {
    if (!generatedPreviewImage) return;
    const imgUrl = generatedPreviewImage;
    const pText = generatedPreviewPrompt || aiImagePrompt;
    setSelectedEngine('hunyuan3d');
    setSelectedImageUrl(imgUrl);
    setSelectedImageFile(null);
    setPrompt(pText);
    setShowImagePicker(false);
    setGeneratedPreviewImage(null);
    executeGenerate3D({ url: imgUrl }, 'hunyuan3d', pText);
  };

  const handleAcceptAndSendToTrellis = () => {
    if (!generatedPreviewImage) return;
    const imgUrl = generatedPreviewImage;
    const pText = generatedPreviewPrompt || aiImagePrompt;
    setSelectedEngine('trellis');
    setSelectedImageUrl(imgUrl);
    setSelectedImageFile(null);
    setPrompt(pText);
    setShowImagePicker(false);
    setGeneratedPreviewImage(null);
    executeGenerate3D({ url: imgUrl }, 'trellis', pText);
  };

  const handleAcceptReferenceOnly = () => {
    if (!generatedPreviewImage) return;
    setSelectedImageUrl(generatedPreviewImage);
    setSelectedImageFile(null);
    setPrompt(generatedPreviewPrompt || aiImagePrompt);
    setShowImagePicker(false);
    setGeneratedPreviewImage(null);
  };

  const handleAddRoomBakeAsset = (assetData: { name: string; glbUrl?: string; modelBlob?: Blob }) => {
    if (assetData.glbUrl) {
      // RoomBake no longer uploads, so the model arrives as bytes held in this browser. Park a
      // copy locally straight away - that write is instant and survives a reload - and remember
      // that it owes the server an upload at save time.
      const registerPending = (assetId: string) => {
        if (!assetData.modelBlob || !assetData.glbUrl?.startsWith('blob:')) return;
        savePendingBake(assetId, assetData.name, assetData.modelBlob);
        setPendingBakeIds((prev) => (prev.includes(assetId) ? prev : [...prev, assetId]));
      };

      const existingIdx = (currentProject.scenes || []).findIndex(
        (a) =>
          (selectedAssetId && a.id === selectedAssetId) ||
          (a.category === 'environment' && (a.id.startsWith('roombake_') || a.name.includes('Room')))
      );
      const existingAsset = existingIdx >= 0 ? currentProject.scenes![existingIdx] : null;

      const newAsset: SceneAsset = {
        id: existingAsset ? existingAsset.id : `roombake_${Date.now()}`,
        name: assetData.name || (existingAsset ? existingAsset.name : 'AI Baked Room Environment'),
        category: existingAsset ? existingAsset.category : 'environment',
        glbUrl: assetData.glbUrl,
        position: existingAsset ? existingAsset.position : [0, 0, 0],
        rotation: existingAsset ? existingAsset.rotation : [0, 0, 0],
        scale: existingAsset ? existingAsset.scale : [1, 1, 1],
        createdAt: new Date().toISOString(),
      };

      let updatedScenes: SceneAsset[];
      if (existingIdx >= 0) {
        updatedScenes = [...(currentProject.scenes || [])];
        updatedScenes[existingIdx] = newAsset;
      } else {
        updatedScenes = [...(currentProject.scenes || []), newAsset];
      }

      registerPending(newAsset.id);
      onUpdateProject({
        ...currentProject,
        scenes: updatedScenes,
      });
      setSelectedAssetId(newAsset.id);
    }
  };

  /**
   * Primitives are saved as ordinary GLB assets rather than a special asset kind, so the
   * gizmo, the object inspector and RoomBake all work on them with no extra cases.
   */
  const handleAddPrimitive = async (kind: PrimitiveKind) => {
    setShowPrimitiveMenu(false);
    if (addingPrimitive) return;
    try {
      setAddingPrimitive(kind);
      const glbUrl = await createPrimitiveAssetUrl(kind);
      const def = PRIMITIVE_DEFS.find((p) => p.kind === kind);
      const label = def?.label || kind;
      const sameKindCount = assets.filter((a) => a.id.startsWith(`primitive_${kind}_`)).length;

      pushUndoSnapshot();

      const newAsset: SceneAsset = {
        id: `primitive_${kind}_${Date.now()}`,
        name: sameKindCount > 0 ? `${label} ${sameKindCount + 1}` : label,
        glbUrl,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        category: 'prop',
        createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      onUpdateProject({
        ...currentProject,
        scenes: [...assets, newAsset],
      });
      setSelectedAssetId(newAsset.id);
    } catch (err: any) {
      console.error(err);
      alert(`Could not add the ${kind}: ${err.message || err}`);
    } finally {
      setAddingPrimitive(null);
    }
  };

  const handleUpdateAssetTransform = (
    id: string,
    position: [number, number, number],
    rotation: [number, number, number],
    scale: [number, number, number]
  ) => {
    // Check if the transform actually changed to avoid redundant history
    const existingAsset = assets.find((a) => a.id === id);
    if (
      existingAsset &&
      existingAsset.position[0] === position[0] &&
      existingAsset.position[1] === position[1] &&
      existingAsset.position[2] === position[2] &&
      existingAsset.rotation[0] === rotation[0] &&
      existingAsset.rotation[1] === rotation[1] &&
      existingAsset.rotation[2] === rotation[2] &&
      existingAsset.scale[0] === scale[0] &&
      existingAsset.scale[1] === scale[1] &&
      existingAsset.scale[2] === scale[2]
    ) {
      return;
    }

    pushUndoSnapshot();

    const updated = {
      ...currentProject,
      scenes: assets.map((a) =>
        a.id === id ? { ...a, position, rotation, scale } : a
      ),
    };
    onUpdateProject(updated);
  };

  const handleDeleteAsset = (id: string) => {
    pushUndoSnapshot();
    const updated = {
      ...currentProject,
      scenes: assets.filter((a) => a.id !== id),
    };
    if (selectedAssetId === id) setSelectedAssetId(null);
    onUpdateProject(updated);
  };

  const handleDuplicateAsset = (idToDup?: string | null) => {
    const targetId = idToDup || selectedAssetId;
    const asset = assets.find((a) => a.id === targetId);
    if (!asset) return;

    pushUndoSnapshot();

    const dup: SceneAsset = {
      ...JSON.parse(JSON.stringify(asset)),
      id: `asset_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: `${asset.name} (Copy)`,
      position: [asset.position[0] + 0.5, asset.position[1], asset.position[2] + 0.5],
    };

    const updated = {
      ...currentProject,
      scenes: [...assets, dup],
    };

    onUpdateProject(updated);
    setSelectedAssetId(dup.id);
    setSelectedPointLightId(null);
  };

  // ----------------------------------------------------
  // High-Performance Point Lights Handlers (Physical Decay)
  // ----------------------------------------------------

  const updatePointLightsAndProject = (newLights: StagePointLight[]) => {
    setPointLights(newLights);
    onUpdateProject({
      ...currentProject,
      pointLights: newLights,
    });
  };

  const handleAddPointLight = () => {
    const count = pointLights.length + 1;
    const newLight: StagePointLight = {
      id: `ptlight_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: `Point Light ${count}`,
      color: '#fff4e5', // warm tungsten by default
      intensity: 2.5,
      distance: 15,
      decay: 2.0,
      position: [0, 2.5, 0],
      enabled: true,
    };
    const updated = [...pointLights, newLight];
    updatePointLightsAndProject(updated);
    setSelectedPointLightId(newLight.id);
    setSelectedAssetId(null);
    setShowPointLightsPanel(true);
  };

  const handleUpdatePointLight = (id: string, updates: Partial<StagePointLight>) => {
    const updated = pointLights.map((l) => (l.id === id ? { ...l, ...updates } : l));
    updatePointLightsAndProject(updated);
  };

  const handleUpdatePointLightPosition = (id: string, pos: [number, number, number]) => {
    const updated = pointLights.map((l) => (l.id === id ? { ...l, position: pos } : l));
    updatePointLightsAndProject(updated);
  };

  const handleDeletePointLight = (id: string) => {
    const updated = pointLights.filter((l) => l.id !== id);
    updatePointLightsAndProject(updated);
    if (selectedPointLightId === id) setSelectedPointLightId(null);
  };

  const handleDuplicatePointLight = (light: StagePointLight) => {
    const dup: StagePointLight = {
      ...JSON.parse(JSON.stringify(light)),
      id: `ptlight_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: `${light.name} (Copy)`,
      position: [light.position[0] + 0.8, light.position[1], light.position[2] + 0.8],
    };
    const updated = [...pointLights, dup];
    updatePointLightsAndProject(updated);
    setSelectedPointLightId(dup.id);
    setSelectedAssetId(null);
  };

  // Global Keyboard Shortcuts for Undo (Ctrl+Z / Cmd+Z), Redo (Ctrl+Y / Cmd+Shift+Z), Duplicate (Ctrl+D / Cmd+D), Delete (Del / Backspace)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if user is typing inside text inputs/textareas
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
          target.isContentEditable)
      ) {
        return;
      }

      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      // Undo: Cmd+Z (Mac) or Ctrl+Z without Shift
      if (isCmdOrCtrl && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      }
      // Redo: Cmd+Shift+Z (Mac) or Ctrl+Shift+Z or Ctrl+Y / Cmd+Y
      else if (isCmdOrCtrl && ((key === 'z' && e.shiftKey) || key === 'y')) {
        e.preventDefault();
        handleRedo();
      }
      // Duplicate Object or Point Light: Cmd+D / Ctrl+D
      else if (isCmdOrCtrl && key === 'd') {
        if (selectedAssetId) {
          e.preventDefault();
          handleDuplicateAsset(selectedAssetId);
        } else if (selectedPointLightId) {
          e.preventDefault();
          const light = pointLights.find((l) => l.id === selectedPointLightId);
          if (light) handleDuplicatePointLight(light);
        }
      }
      // Delete Object or Point Light: Delete or Backspace
      else if (!isCmdOrCtrl && (key === 'delete' || key === 'backspace')) {
        if (selectedAssetId) {
          e.preventDefault();
          handleDeleteAsset(selectedAssetId);
        } else if (selectedPointLightId) {
          e.preventDefault();
          handleDeletePointLight(selectedPointLightId);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    handleUndo,
    handleRedo,
    selectedAssetId,
    selectedPointLightId,
    pointLights,
    assets,
    currentProject,
  ]);

  // ----------------------------------------------------
  // Stage Persistence & Reusable Stage Library Handlers
  // ----------------------------------------------------

  /**
   * A picture of the stage as it looks right now, for the Stage Library card. The viewport canvas
   * keeps its drawing buffer (ThreeStage sets preserveDrawingBuffer), so it can be read directly.
   * JPEG at 480x270: a thumbnail has no business being a megabyte on this connection.
   */
  const captureStageThumbnail = (): string | undefined => {
    const canvas = viewportCanvasRef.current;
    if (!canvas || !canvas.width || !canvas.height) return undefined;
    try {
      const out = document.createElement('canvas');
      out.width = 480;
      out.height = 270;
      const ctx = out.getContext('2d', { alpha: false });
      if (!ctx) return undefined;

      // Centre-crop to 16:9 so the thumbnail is not squashed by the viewport's own shape.
      const srcAspect = canvas.width / canvas.height;
      const target = 16 / 9;
      let sx = 0, sy = 0, sw = canvas.width, sh = canvas.height;
      if (srcAspect > target) {
        sw = canvas.height * target;
        sx = (canvas.width - sw) / 2;
      } else {
        sh = canvas.width / target;
        sy = (canvas.height - sh) / 2;
      }

      ctx.fillStyle = '#0a0c10';
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
      return out.toDataURL('image/jpeg', 0.82);
    } catch (err) {
      console.warn('Could not capture a stage thumbnail:', err);
      return undefined;
    }
  };

  /**
   * Sends up any baked model that is still only in this browser, and returns the scene with its
   * blob: URLs replaced by permanent ones. This is where the wait now happens - deliberately, at
   * a moment the user chose - instead of when the model was added.
   */
  const uploadPendingBakes = async (scenes: SceneAsset[]): Promise<SceneAsset[]> => {
    const parked = await listPendingBakes();
    if (parked.length === 0) return scenes;

    const uploaded = new Map<string, string>();
    let done = 0;
    for (const bake of parked) {
      // Skip anything that is no longer in the scene: the object was deleted before saving.
      if (!scenes.some((a) => a.id === bake.id)) {
        await deletePendingBake(bake.id);
        continue;
      }
      done += 1;
      const mb = (bake.blob.size / (1024 * 1024)).toFixed(1);
      setSaveProgress(`Uploading baked model ${done} of ${parked.length} (${mb} MB)…`);

      const url = await uploadAssetToDisk(bake.blob, `${bake.id}.glb`);
      if (url) {
        uploaded.set(bake.id, url);
        await deletePendingBake(bake.id);
      } else {
        console.warn(`[stage save] upload failed for ${bake.id}; it stays parked locally.`);
      }
    }

    setSaveProgress(null);
    setPendingBakeIds((prev) => prev.filter((id) => !uploaded.has(id)));
    if (uploaded.size === 0) return scenes;
    return scenes.map((a) => (uploaded.has(a.id) ? { ...a, glbUrl: uploaded.get(a.id)! } : a));
  };

  const handleSaveStage = async (nameOverride?: string) => {
    setIsSavingStage(true);
    // The thumbnail is taken before anything else, so it shows the stage the user is looking at.
    const thumbnail = captureStageThumbnail() || currentProject.thumbnail;

    // Baked models go up now, and the scene keeps the permanent URLs they come back with.
    const savedScenes = await uploadPendingBakes(assets);

    const updatedProject: Project = {
      ...currentProject,
      scenes: savedScenes,
      panoramaUrl: panoramaUrl || undefined,
      panoramaRotation: panoramaRotation || 0,
      splatUrl: splatUrl || undefined,
      stageSpecularity,
      pointLights: JSON.parse(JSON.stringify(pointLights)),
      thumbnail,
      modified: 'Just now',
    };
    onUpdateProject(updatedProject);

    // Also sync this stage into the Stage Library so it appears in "LOAD STAGES".
    //
    // The id carries the name, so saving under a new name creates a new preset and saving under
    // an existing one overwrites it. Keying on the project alone would mean a project could only
    // ever have one stage, which is what the old "Save Current" button existed to get around.
    const stageName = (nameOverride || currentProject.name || 'Current Stage').trim();
    const nameKey = stageName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const stageTemplate: SavedStageTemplate = {
      id: `stage_proj_${currentProject.id}_${nameKey}`,
      name: stageName,
      createdAt: new Date().toISOString(),
      scenes: JSON.parse(JSON.stringify(savedScenes)),
      panoramaUrl: panoramaUrl || undefined,
      panoramaRotation: panoramaRotation || 0,
      splatUrl: splatUrl || undefined,
      environmentPreset,
      lightIntensity,
      stageSpecularity,
      pointLights: JSON.parse(JSON.stringify(pointLights)),
      thumbnail,
    };

    try {
      const updatedLib = await saveStageTemplate(stageTemplate);
      setStageLibrary(updatedLib);
    } catch (err) {
      console.warn('Failed to sync to stage library:', err);
    }

    const lightMsg = pointLights.length > 0 ? ` + ${pointLights.length} point light${pointLights.length === 1 ? '' : 's'}` : '';
    setSaveToast(`✓ Stage "${stageName}" saved to disk & library (${assets.length} object${assets.length === 1 ? '' : 's'}${lightMsg})`);
    setTimeout(() => {
      setSaveToast(null);
      setIsSavingStage(false);
    }, 3500);
  };

  const handleLoadStageTemplate = (template: SavedStageTemplate) => {
    pushUndoSnapshot();
    setPanoramaUrl(template.panoramaUrl || null);
    setPanoramaRotation(template.panoramaRotation || 0);
    setSplatUrl(template.splatUrl || null);
    if (template.environmentPreset) {
      setEnvironmentPreset(template.environmentPreset as any);
    }
    if (template.lightIntensity !== undefined) {
      setLightIntensity(template.lightIntensity);
    }
    if (template.stageSpecularity !== undefined) {
      setStageSpecularity(template.stageSpecularity);
    }
    if (template.pointLights) {
      setPointLights(template.pointLights);
    } else {
      setPointLights([]);
    }

    onUpdateProject({
      ...currentProject,
      scenes: template.scenes || [],
      panoramaUrl: template.panoramaUrl || undefined,
      panoramaRotation: template.panoramaRotation || 0,
      splatUrl: template.splatUrl || undefined,
      stageSpecularity: template.stageSpecularity,
      pointLights: template.pointLights || [],
      modified: 'Just now',
    });

    setShowStageLibraryModal(false);
    const lightCount = template.pointLights?.length || 0;
    const lightDesc = lightCount > 0 ? `, ${lightCount} point light${lightCount === 1 ? '' : 's'}` : '';
    setSaveToast(`✓ Loaded stage "${template.name}" (${template.scenes?.length || 0} objects${lightDesc})`);
    setTimeout(() => setSaveToast(null), 3500);
  };

  const handleDeleteStageTemplate = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm('Delete this saved stage from your library?')) {
      const updated = await deleteStageTemplate(id);
      setStageLibrary(updated);
    }
  };

  const handleExportStage = (template: SavedStageTemplate, e: React.MouseEvent) => {
    e.stopPropagation();
    exportStageToFile(template);
  };

  const handleImportStageFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const imported = await importStageFromFile(file);
      const updated = await saveStageTemplate(imported);
      setStageLibrary(updated);
      setSaveToast(`✓ Imported stage "${imported.name}" into library`);
      setTimeout(() => setSaveToast(null), 3500);
    } catch (err: any) {
      alert('Failed to import stage JSON file: ' + err.message);
    } finally {
      if (e.target) e.target.value = '';
    }
  };

  const handleProceedToActing = () => {
    handleSaveStage();
    if (onNavigateStage) {
      onNavigateStage('stage2_acting');
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full w-full min-h-0 bg-background relative overflow-hidden select-none">
      {/* Top Controls Bar */}
      <div className="h-[48px] border-b border-outline-variant/30 px-md flex items-center justify-between z-10 bg-surface-container/60 backdrop-blur-md shrink-0">
        {/* Transform & History Tools */}
        <div className="flex items-center gap-xs">
          {/* Transform Tools */}
          <div className="flex items-center gap-xs bg-surface-container-high/60 p-[2px] rounded-lg border border-outline-variant/30">
            <button
              onClick={() => setTransformMode('translate')}
              className={`flex items-center gap-xs px-sm py-[4px] rounded text-[11px] font-label-caps transition-all cursor-pointer ${
                transformMode === 'translate'
                  ? 'bg-primary text-surface-container-lowest shadow font-semibold'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
              title="Translate / Move (W)"
            >
              <span className="material-symbols-outlined text-[14px]">open_with</span>
              MOVE
            </button>
            <button
              onClick={() => setTransformMode('rotate')}
              className={`flex items-center gap-xs px-sm py-[4px] rounded text-[11px] font-label-caps transition-all cursor-pointer ${
                transformMode === 'rotate'
                  ? 'bg-primary text-surface-container-lowest shadow font-semibold'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
              title="Rotate (E)"
            >
              <span className="material-symbols-outlined text-[14px]">sync</span>
              ROTATE
            </button>
            <button
              onClick={() => setTransformMode('scale')}
              className={`flex items-center gap-xs px-sm py-[4px] rounded text-[11px] font-label-caps transition-all cursor-pointer ${
                transformMode === 'scale'
                  ? 'bg-primary text-surface-container-lowest shadow font-semibold'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
              title="Scale (R)"
            >
              <span className="material-symbols-outlined text-[14px]">aspect_ratio</span>
              SCALE
            </button>
          </div>

          {/* Rotation Snap Mode Toggle (10° Snap vs Free Rotation) */}
          <div className="flex items-center bg-surface-container-high/60 p-[2px] rounded-lg border border-outline-variant/30 text-[11px]">
            <button
              onClick={() => {
                setRotationSnapAngle('10deg');
                if (transformMode !== 'rotate') setTransformMode('rotate');
              }}
              className={`flex items-center gap-1 px-2 py-[4px] rounded font-label-caps font-semibold transition-all cursor-pointer ${
                rotationSnapAngle === '10deg'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/40 shadow-sm'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
              title="10° Incremental Snap Rotation"
            >
              <span className="material-symbols-outlined text-[13px]">straighten</span>
              10° SNAP
            </button>
            <button
              onClick={() => {
                setRotationSnapAngle('free');
                if (transformMode !== 'rotate') setTransformMode('rotate');
              }}
              className={`flex items-center gap-1 px-2 py-[4px] rounded font-label-caps font-semibold transition-all cursor-pointer ${
                rotationSnapAngle === 'free'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/40 shadow-sm'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
              title="Free Continuous Smooth Rotation"
            >
              <span className="material-symbols-outlined text-[13px]">all_inclusive</span>
              FREE
            </button>
          </div>

          {/* Undo / Redo History Controls */}
          <div className="flex items-center gap-[2px] bg-surface-container-high/60 p-[2px] rounded-lg border border-outline-variant/30">
            <button
              onClick={handleUndo}
              disabled={!canUndo}
              className={`flex items-center gap-xs px-xs py-[4px] rounded text-[11px] font-label-caps transition-all ${
                canUndo
                  ? 'text-on-surface hover:text-primary hover:bg-surface-container-highest cursor-pointer font-medium'
                  : 'text-on-surface-variant/30 cursor-not-allowed'
              }`}
              title="Undo Move, Rotate, Scale (Ctrl+Z / ⌘Z)"
            >
              <span className="material-symbols-outlined text-[15px]">undo</span>
              UNDO
            </button>
            <button
              onClick={handleRedo}
              disabled={!canRedo}
              className={`flex items-center gap-xs px-xs py-[4px] rounded text-[11px] font-label-caps transition-all ${
                canRedo
                  ? 'text-on-surface hover:text-primary hover:bg-surface-container-highest cursor-pointer font-medium'
                  : 'text-on-surface-variant/30 cursor-not-allowed'
              }`}
              title="Redo Move, Rotate, Scale (Ctrl+Y / ⌘⇧Z)"
            >
              <span className="material-symbols-outlined text-[15px]">redo</span>
              REDO
            </button>
          </div>
        </div>

        {/* Viewport & 360 / 3DGS World Toggles */}
        <div className="flex items-center gap-sm">
          {/* Primitive Objects (Box / Plane / ...) — plain GLB assets RoomBake can texture */}
          <div className="relative">
            <button
              onClick={() => setShowPrimitiveMenu((v) => !v)}
              disabled={!!addingPrimitive}
              className={`flex items-center gap-xs px-sm py-[4px] rounded-lg text-[11px] font-label-caps font-bold transition-all border cursor-pointer ${
                showPrimitiveMenu
                  ? 'bg-primary text-background border-primary shadow'
                  : 'bg-surface-container-high/60 text-primary border-primary/40 hover:bg-primary/20'
              } ${addingPrimitive ? 'opacity-60 cursor-wait' : ''}`}
              title="Add a plain box, plane or other primitive you can texture with RoomBake"
            >
              <span className="material-symbols-outlined text-[16px]">deployed_code</span>
              {addingPrimitive ? 'ADDING…' : 'PRIMITIVES'}
            </button>

            {showPrimitiveMenu && (
              <>
                {/* click-away catcher */}
                <div className="fixed inset-0 z-30" onClick={() => setShowPrimitiveMenu(false)} />
                <div className="absolute top-full left-0 mt-xs z-40 w-60 bg-surface-container border border-outline-variant/50 rounded-lg shadow-xl p-xs">
                  {PRIMITIVE_DEFS.map((def) => (
                    <button
                      key={def.kind}
                      onClick={() => handleAddPrimitive(def.kind)}
                      className="w-full flex items-center gap-sm px-sm py-xs rounded-md hover:bg-surface-container-highest transition-colors text-left cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[18px] text-primary">{def.icon}</span>
                      <span className="flex flex-col">
                        <span className="text-[12px] text-on-surface font-medium">{def.label}</span>
                        <span className="text-[10px] text-on-surface-variant">{def.hint}</span>
                      </span>
                    </button>
                  ))}
                  <div className="px-sm pt-xs pb-[2px] text-[10px] text-on-surface-variant border-t border-outline-variant/30 mt-xs">
                    Select one, then open ROOMBAKE to texture it.
                  </div>
                </div>
              </>
            )}
          </div>

          {/* RoomBake AI Texture Studio Button */}
          <button
            onClick={() => setShowRoomBakeStudio(true)}
            className="flex items-center gap-xs px-sm py-[4px] rounded-lg text-[11px] font-label-caps font-bold transition-all border cursor-pointer bg-surface-container-high/60 text-cyan-400 border-cyan-400/40 hover:bg-cyan-400/20"
            title="RoomBake: Projective 3D Texture Baking Harness (Gemini / OpenAI)"
          >
            <span className="material-symbols-outlined text-[16px]">brush</span>
            ROOMBAKE
          </button>

          {/* HunyuanWorld 3DGS Scene Button */}
          <button
            onClick={() => setShowHunyuanWorldModal(true)}
            className={`flex items-center gap-xs px-sm py-[4px] rounded-lg text-[11px] font-label-caps font-bold transition-all border cursor-pointer ${
              splatUrl
                ? 'bg-primary text-background border-primary shadow'
                : 'bg-surface-container-high/60 text-primary border-primary/40 hover:bg-primary/20'
            }`}
          >
            <span className="material-symbols-outlined text-[16px]">domain</span>
            {splatUrl ? 'WORLD 3DGS (ACTIVE)' : 'WORLD (3DGS)'}
          </button>

          {/* 360 Panorama Controls */}
          <div className="flex items-center gap-xs bg-surface-container-high/60 px-sm py-[2px] rounded-lg border border-outline-variant/30">
            <button
              onClick={() => setShowPanoramaModal(true)}
              className="flex items-center gap-xs text-[11px] font-label-caps text-on-surface hover:text-primary transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px]">360</span>
              {panoramaUrl ? '360° SKYBOX (ACTIVE)' : '360° SKYBOX'}
            </button>
            {panoramaUrl && (
              <>
                <div className="w-[1px] h-3 bg-outline-variant/30 mx-[2px]" />
                <button
                  onClick={() => setShowPanorama(!showPanorama)}
                  className={`p-[2px] rounded text-[12px] cursor-pointer ${
                    showPanorama ? 'text-primary' : 'text-on-surface-variant'
                  }`}
                  title={showPanorama ? 'Hide 360 Dome' : 'Show 360 Dome'}
                >
                  <span className="material-symbols-outlined text-[14px]">
                    {showPanorama ? 'visibility' : 'visibility_off'}
                  </span>
                </button>
              </>
            )}
          </div>

          {/* Point Lights Studio Toggle */}
          <button
            onClick={() => {
              setShowPointLightsPanel(!showPointLightsPanel);
              if (!showPointLightsPanel && pointLights.length > 0 && !selectedPointLightId) {
                setSelectedPointLightId(pointLights[0].id);
              }
            }}
            className={`flex items-center gap-xs px-sm py-[4px] rounded-lg text-[11px] font-label-caps font-semibold transition-all border cursor-pointer ${
              showPointLightsPanel || pointLights.length > 0
                ? 'bg-amber-400/15 text-amber-300 border-amber-400/50 shadow-sm'
                : 'bg-surface-container-high/60 text-on-surface-variant border-outline-variant/40 hover:text-on-surface'
            }`}
            title="Stage Point Lights with Physical Inverse-Square Falloff"
          >
            <span className="material-symbols-outlined text-[16px] text-amber-400">light</span>
            <span>POINT LIGHTS</span>
            {pointLights.length > 0 && (
              <span className="px-1.5 py-[1px] rounded-full bg-amber-400/30 text-amber-200 text-[9px] font-mono font-bold">
                {pointLights.length}
              </span>
            )}
          </button>

          {/* Hugging Face Token Auth Button */}
          {!serverKeys.hf && (
            <button
              onClick={() => setShowHfTokenModal(true)}
              className={`flex items-center gap-xs px-sm py-[4px] rounded-lg text-[11px] font-label-caps font-semibold transition-all border cursor-pointer ${
                hfTokenInput
                  ? 'bg-amber-400/10 text-amber-400 border-amber-400/40 hover:bg-amber-400/20'
                  : 'bg-surface-container-high/60 text-on-surface-variant border-outline-variant/40 hover:text-on-surface'
              }`}
              title="Hugging Face API Token for ZeroGPU quota"
            >
              <span className="material-symbols-outlined text-[16px]">key</span>
              {hfTokenInput ? 'HF TOKEN (SAVED)' : 'HF TOKEN'}
            </button>
          )}

          {/* Gemini API Key Auth Button */}
          {!serverKeys.gemini && (
            <button
              onClick={() => setShowGeminiKeyModal(true)}
              className={`flex items-center gap-xs px-sm py-[4px] rounded-lg text-[11px] font-label-caps font-semibold transition-all border cursor-pointer ${
                geminiApiKey
                  ? 'bg-emerald-400/10 text-emerald-400 border-emerald-400/40 hover:bg-emerald-400/20'
                  : 'bg-surface-container-high/60 text-on-surface-variant border-outline-variant/40 hover:text-on-surface'
              }`}
              title="Google Gemini API Key for AI Image & Multimodal Generation"
            >
              <span className="material-symbols-outlined text-[16px]">psychology</span>
              {geminiApiKey ? 'GEMINI API (ACTIVE)' : 'GEMINI API'}
            </button>
          )}
          {/* Lighting Mode Presets */}
          <div className="flex items-center gap-xs bg-surface-container-high/60 p-[2px] rounded-lg border border-outline-variant/30">
            {(['studio', 'city', 'sunset', 'dawn', 'park'] as LightingEnvironmentPreset[]).map(
              (preset) => (
                <button
                  key={preset}
                  onClick={() => setEnvironmentPreset(preset)}
                  className={`px-xs py-[2px] rounded text-[10px] font-label-caps uppercase transition-colors cursor-pointer ${
                    environmentPreset === preset
                      ? 'bg-primary/20 text-primary font-semibold border border-primary/40'
                      : 'text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  {preset}
                </button>
              )
            )}
          </div>

          {/* Stage Light Intensity Slider */}
          <div
            className="flex items-center gap-xs bg-surface-container-high/60 px-2 py-[3px] rounded-lg border border-outline-variant/30"
            title="Stage Ambient & Key Light Intensity"
          >
            <span className="material-symbols-outlined text-[15px] text-amber-400">light_mode</span>
            <input
              type="range"
              min={0.1}
              max={3.0}
              step={0.05}
              value={lightIntensity}
              onChange={(e) => setLightIntensity(parseFloat(e.target.value))}
              className="w-16 h-1 bg-surface-variant rounded-lg appearance-none cursor-pointer accent-amber-400"
            />
            <span className="text-[10px] font-mono font-medium text-on-surface-variant w-7 text-right">
              {lightIntensity.toFixed(1)}x
            </span>
          </div>

          {/* Stage Specularity & Glossiness Control */}
          <div
            className="flex items-center gap-xs bg-surface-container-high/60 px-2 py-[3px] rounded-lg border border-outline-variant/30"
            title="Stage Specularity & Glossiness (0% = Matte/Diffuse with no shiny plastic highlights, 100% = Full Gloss)"
          >
            <span className="material-symbols-outlined text-[15px] text-cyan-400">tonality</span>
            <input
              type="range"
              min={0.0}
              max={1.0}
              step={0.05}
              value={stageSpecularity}
              onChange={(e) => setStageSpecularity(parseFloat(e.target.value))}
              className="w-16 h-1 bg-surface-variant rounded-lg appearance-none cursor-pointer accent-cyan-400"
            />
            <span className="text-[10px] font-mono font-medium text-on-surface-variant w-8 text-right">
              {Math.round(stageSpecularity * 100)}%
            </span>
          </div>


          {/* Grid Toggle */}
          <button
            onClick={() => setShowGrid(!showGrid)}
            className={`p-[4px] rounded border border-outline-variant/30 cursor-pointer ${
              showGrid ? 'text-primary bg-surface-container-high/60' : 'text-on-surface-variant'
            }`}
            title="Toggle Floor Grid"
          >
            <span className="material-symbols-outlined text-[16px]">grid_on</span>
          </button>

          <div className="h-4 w-px bg-outline-variant/30 mx-[2px]" />

          {/* Save Stage Button */}
          <button
            onClick={() => {
              setStageSaveName(currentProject.name || 'Current Stage');
              setShowSaveStageModal(true);
            }}
            disabled={isSavingStage}
            className="flex items-center gap-1 px-sm py-[4px] bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 border border-emerald-500/40 rounded-lg text-[11px] font-label-caps transition-all cursor-pointer shadow-sm active:scale-95 disabled:opacity-50"
            title="Name and save this stage, uploading any baked models"
          >
            <span className="material-symbols-outlined text-[15px]">
              {isSavingStage ? 'sync' : 'save'}
            </span>
            <span>{isSavingStage ? 'SAVING...' : 'SAVE STAGE'}</span>
          </button>

          {/* Stage Library / Presets Modal Button */}
          <button
            onClick={() => setShowStageLibraryModal(true)}
            className="flex items-center gap-1 px-sm py-[4px] bg-surface-container-high/70 hover:bg-surface-container-highest text-on-surface-variant hover:text-on-surface border border-outline-variant/40 rounded-lg text-[11px] font-label-caps transition-all cursor-pointer shadow-sm"
            title="Open Load Stages & Stage Library"
          >
            <span className="material-symbols-outlined text-[15px] text-amber-400">folder_open</span>
            <span>LOAD STAGES</span>
            {stageLibrary.length > 0 && (
              <span className="ml-0.5 px-1 rounded-full bg-amber-500/20 text-amber-300 text-[9px] font-mono font-bold">
                {stageLibrary.length}
              </span>
            )}
          </button>

          {/* Proceed to Acting Setup */}
          {onNavigateStage && (
            <button
              onClick={handleProceedToActing}
              className="flex items-center gap-1 px-sm py-[4px] bg-primary/20 hover:bg-primary/30 text-primary border border-primary/40 rounded-lg text-[11px] font-label-caps font-bold transition-all cursor-pointer shadow-sm"
              title="Save current stage and proceed to Stage 02: Acting Setup"
            >
              <span>ACTING</span>
              <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
            </button>
          )}
        </div>
      </div>

      {/* 3D WebGL Viewport */}
      <div className="flex-1 w-full h-full relative min-h-0 overflow-hidden">
        {/* Floating Save / Load Confirmation Banner */}
        {saveToast && (
          <div className="absolute top-sm left-1/2 -translate-x-1/2 bg-emerald-500/90 text-white font-medium px-md py-xs rounded-full shadow-2xl backdrop-blur-md flex items-center gap-xs text-xs z-30 animate-in fade-in slide-in-from-top-2 duration-200 border border-emerald-400/50">
            <span className="material-symbols-outlined text-[16px]">check_circle</span>
            <span>{saveToast}</span>
          </div>
        )}

        {/* An upload on a slow link takes minutes, so say what is happening rather than freeze. */}
        {saveProgress && (
          <div className="absolute top-sm left-1/2 -translate-x-1/2 bg-surface-container-high/95 text-on-surface px-md py-xs rounded-full shadow-2xl backdrop-blur-md flex items-center gap-xs text-xs z-30 border border-outline-variant animate-in fade-in slide-in-from-top-2 duration-200">
            <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>
            <span>{saveProgress}</span>
          </div>
        )}

        <ThreeStage
          onCanvasReady={(canvas) => {
            viewportCanvasRef.current = canvas;
          }}
          assets={assets}
          selectedAssetId={selectedAssetId}
          pointLights={pointLights}
          selectedPointLightId={selectedPointLightId}
          transformMode={transformMode}
          rotationSnap={rotationSnapAngle === '10deg' ? (10 * Math.PI) / 180 : null}
          lightIntensity={lightIntensity}
          stageSpecularity={stageSpecularity}
          environmentPreset={environmentPreset}
          panoramaUrl={panoramaUrl}
          panoramaRotation={panoramaRotation}
          showPanorama={showPanorama}
          splatUrl={splatUrl}
          onSelectAsset={(id) => {
            setSelectedAssetId(id);
            if (id) setSelectedPointLightId(null);
          }}
          onSelectPointLight={(id) => {
            setSelectedPointLightId(id);
            if (id) setSelectedAssetId(null);
          }}
          onUpdateAssetTransform={handleUpdateAssetTransform}
          onUpdatePointLightPosition={handleUpdatePointLightPosition}
          showGrid={showGrid}
        />

        {/* Floating Active 360 Panorama Rotation Widget */}
        {panoramaUrl && showPanorama && (
          <div className="absolute top-sm left-sm bg-surface-container/80 backdrop-blur-md border border-outline-variant/40 p-xs px-sm rounded-lg flex items-center gap-sm text-[11px] font-label-caps text-on-surface-variant z-20">
            <span className="material-symbols-outlined text-primary text-[14px]">rotate_right</span>
            <span>360° ROTATION:</span>
            <input
              type="range"
              min={0}
              max={Math.PI * 2}
              step={0.05}
              value={panoramaRotation}
              onChange={(e) => setPanoramaRotation(parseFloat(e.target.value))}
              className="w-20 accent-primary cursor-pointer"
            />
          </div>
        )}

        {/* Floating Point Lights Studio Panel */}
        {showPointLightsPanel && (
          <div className="absolute top-sm left-sm w-[260px] bg-surface-container/90 backdrop-blur-md border border-outline-variant/40 p-sm rounded-xl flex flex-col gap-xs z-20 shadow-2xl animate-in fade-in slide-in-from-left-2 duration-150">
            <div className="flex justify-between items-center pb-xs border-b border-outline-variant/20">
              <div className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px] text-amber-400">light</span>
                <span className="font-label-caps text-[11px] text-amber-300 font-bold uppercase tracking-wider">
                  Stage Point Lights
                </span>
              </div>
              <button
                onClick={() => setShowPointLightsPanel(false)}
                className="text-on-surface-variant hover:text-on-surface text-[12px] cursor-pointer p-0.5"
                title="Close Panel"
              >
                ✕
              </button>
            </div>

            <p className="text-[10px] text-on-surface-variant/80 leading-tight">
              High-performance point lights with real-world physical inverse-square decay.
            </p>

            {/* Lights List */}
            <div className="max-h-48 overflow-y-auto space-y-1 my-1 pr-1 custom-scrollbar">
              {pointLights.length === 0 ? (
                <div className="text-center py-3 text-[11px] text-on-surface-variant/60">
                  No point lights added yet.
                </div>
              ) : (
                pointLights.map((light, idx) => {
                  const isSelected = light.id === selectedPointLightId;
                  return (
                    <div
                      key={light.id}
                      onClick={() => {
                        setSelectedPointLightId(light.id);
                        setSelectedAssetId(null);
                      }}
                      className={`flex items-center justify-between px-2 py-1.5 rounded-lg text-[11px] font-medium cursor-pointer transition-all border ${
                        isSelected
                          ? 'bg-amber-400/20 border-amber-400/60 text-on-surface shadow-sm'
                          : 'bg-surface-container-high/40 border-outline-variant/20 text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {/* Enabled / Disabled Bulb Toggle */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleUpdatePointLight(light.id, { enabled: light.enabled === false ? true : false });
                          }}
                          className={`p-0.5 rounded cursor-pointer ${
                            light.enabled !== false ? 'text-amber-400 hover:text-amber-300' : 'text-on-surface-variant/30 hover:text-on-surface-variant'
                          }`}
                          title={light.enabled !== false ? 'Disable light' : 'Enable light'}
                        >
                          <span className="material-symbols-outlined text-[15px]">
                            {light.enabled !== false ? 'wb_incandescent' : 'lightbulb'}
                          </span>
                        </button>
                        {/* Color preview circle */}
                        <div
                          className="w-3 h-3 rounded-full border border-white/20 shrink-0"
                          style={{ backgroundColor: light.color || '#fff4e5' }}
                        />
                        <span className="truncate font-label-caps text-[10px]">
                          {light.name || `Point Light ${idx + 1}`}
                        </span>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDuplicatePointLight(light);
                          }}
                          className="text-on-surface-variant hover:text-primary p-0.5 cursor-pointer"
                          title="Duplicate light"
                        >
                          <span className="material-symbols-outlined text-[13px]">content_copy</span>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeletePointLight(light.id);
                          }}
                          className="text-on-surface-variant hover:text-error p-0.5 cursor-pointer"
                          title="Delete light"
                        >
                          <span className="material-symbols-outlined text-[13px]">delete</span>
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Add Light Button */}
            <button
              onClick={handleAddPointLight}
              className="w-full font-label-caps text-[10px] text-amber-300 bg-amber-400/15 hover:bg-amber-400/25 border border-amber-400/40 py-1.5 rounded-lg transition-colors cursor-pointer flex items-center justify-center gap-1 font-bold shadow-sm"
            >
              <span className="material-symbols-outlined text-[15px]">add</span>
              ADD POINT LIGHT
            </button>
          </div>
        )}

        {/* Selected Point Light Inspector */}
        {selectedPointLight && (
          <div className="absolute top-sm right-sm w-[260px] bg-surface-container/90 backdrop-blur-md border border-amber-400/40 p-sm rounded-xl flex flex-col gap-xs z-20 shadow-2xl animate-in fade-in slide-in-from-right-2 duration-150">
            <div className="flex justify-between items-center pb-xs border-b border-outline-variant/20">
              <div className="flex items-center gap-1 min-w-0">
                <span className="material-symbols-outlined text-[15px] text-amber-400">wb_incandescent</span>
                <span className="font-label-caps text-[10px] text-amber-300 tracking-widest uppercase font-semibold truncate">
                  {selectedPointLight.name}
                </span>
              </div>
              <button
                onClick={() => setSelectedPointLightId(null)}
                className="text-on-surface-variant hover:text-on-surface text-[12px] cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Light Name Input */}
            <div className="flex items-center gap-1 text-[10px]">
              <span className="text-on-surface-variant w-12 shrink-0">Name:</span>
              <input
                type="text"
                value={selectedPointLight.name}
                onChange={(e) => handleUpdatePointLight(selectedPointLight.id, { name: e.target.value })}
                className="flex-1 bg-surface-container-high px-1.5 py-0.5 rounded border border-outline-variant/40 text-on-surface text-[10px] font-medium"
              />
            </div>

            {/* Position Display */}
            <div className="text-[10px] text-on-surface-variant font-mono flex items-center justify-between">
              <span>POS:</span>
              <span>
                [{selectedPointLight.position.map((v) => v.toFixed(2)).join(', ')}]
              </span>
            </div>

            {/* Color Picker & Quick Kelvin / Gel Presets */}
            <div className="space-y-1 pt-1 border-t border-outline-variant/20">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-on-surface-variant flex items-center gap-1">
                  <span className="material-symbols-outlined text-[13px] text-amber-400">palette</span>
                  Light Color
                </span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="color"
                    value={selectedPointLight.color || '#fff4e5'}
                    onChange={(e) => handleUpdatePointLight(selectedPointLight.id, { color: e.target.value })}
                    className="w-5 h-5 rounded cursor-pointer border-0 bg-transparent"
                  />
                  <span className="font-mono text-[9px] text-on-surface-variant">
                    {selectedPointLight.color || '#fff4e5'}
                  </span>
                </div>
              </div>

              {/* Quick Kelvin & Gel Presets */}
              <div className="flex items-center gap-1 flex-wrap">
                {[
                  { label: 'Candle', color: '#ff9329' },
                  { label: 'Tungsten', color: '#ffb469' },
                  { label: 'Halogen', color: '#ffd1a4' },
                  { label: 'Daylight', color: '#ffffff' },
                  { label: 'Sky', color: '#d4e5ff' },
                  { label: 'Cyan', color: '#00f0ff' },
                  { label: 'Magenta', color: '#ff007f' },
                  { label: 'Gold', color: '#ffaa00' },
                ].map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => handleUpdatePointLight(selectedPointLight.id, { color: preset.color })}
                    className={`px-1.5 py-0.5 rounded text-[8px] font-mono uppercase cursor-pointer border transition-colors ${
                      (selectedPointLight.color || '').toLowerCase() === preset.color.toLowerCase()
                        ? 'border-white font-bold shadow'
                        : 'border-outline-variant/30 text-on-surface-variant hover:text-on-surface'
                    }`}
                    style={{ backgroundColor: `${preset.color}25` }}
                    title={`${preset.label} (${preset.color})`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Intensity Slider */}
            <div className="flex items-center justify-between text-[10px] font-mono pt-1 border-t border-outline-variant/20">
              <span className="text-on-surface-variant flex items-center gap-1">
                <span className="material-symbols-outlined text-[13px] text-amber-400">light_mode</span>
                Intensity
              </span>
              <div className="flex items-center gap-1.5">
                <input
                  type="range"
                  min={0.1}
                  max={20.0}
                  step={0.1}
                  value={selectedPointLight.intensity ?? 2.5}
                  onChange={(e) => handleUpdatePointLight(selectedPointLight.id, { intensity: parseFloat(e.target.value) })}
                  className="w-16 accent-amber-400 cursor-pointer h-1"
                />
                <span className="text-amber-300 font-bold w-8 text-right">
                  {(selectedPointLight.intensity ?? 2.5).toFixed(1)}
                </span>
              </div>
            </div>

            {/* Cutoff Radius / Distance */}
            <div className="flex items-center justify-between text-[10px] font-mono pt-1 border-t border-outline-variant/20">
              <span className="text-on-surface-variant flex items-center gap-1" title="Maximum light reach / cutoff radius in meters">
                <span className="material-symbols-outlined text-[13px] text-amber-400">radio_button_unchecked</span>
                Radius (m)
              </span>
              <div className="flex items-center gap-1.5">
                <input
                  type="range"
                  min={1}
                  max={50}
                  step={0.5}
                  value={selectedPointLight.distance ?? 15}
                  onChange={(e) => handleUpdatePointLight(selectedPointLight.id, { distance: parseFloat(e.target.value) })}
                  className="w-16 accent-amber-400 cursor-pointer h-1"
                />
                <span className="text-amber-300 font-bold w-8 text-right">
                  {(selectedPointLight.distance ?? 15).toFixed(0)}m
                </span>
              </div>
            </div>

            {/* Physical Decay / Falloff */}
            <div className="flex items-center justify-between text-[10px] font-mono pt-1 border-t border-outline-variant/20">
              <span className="text-on-surface-variant flex items-center gap-1" title="Physical falloff rate (2.0 is physical inverse-square law)">
                <span className="material-symbols-outlined text-[13px] text-cyan-400">gradient</span>
                Decay
              </span>
              <div className="flex items-center gap-1.5">
                <input
                  type="range"
                  min={0.0}
                  max={4.0}
                  step={0.1}
                  value={selectedPointLight.decay ?? 2.0}
                  onChange={(e) => handleUpdatePointLight(selectedPointLight.id, { decay: parseFloat(e.target.value) })}
                  className="w-16 accent-cyan-400 cursor-pointer h-1"
                />
                <span className="text-cyan-300 font-bold w-12 text-right">
                  {(selectedPointLight.decay ?? 2.0) === 2 ? '2.0 (Phys)' : (selectedPointLight.decay ?? 2.0).toFixed(1)}
                </span>
              </div>
            </div>

            {/* Duplicate & Delete Light Buttons */}
            <div className="flex items-center gap-1.5 pt-1.5 border-t border-outline-variant/20">
              <button
                type="button"
                onClick={() => handleDuplicatePointLight(selectedPointLight)}
                className="flex-1 font-label-caps text-[9px] text-on-surface-variant hover:text-on-surface bg-surface-container-high/50 hover:bg-surface-container-highest py-[4px] rounded transition-colors cursor-pointer flex items-center justify-center gap-1 border border-outline-variant/30"
              >
                <span className="material-symbols-outlined text-[13px]">content_copy</span>
                DUPLICATE
              </button>
              <button
                type="button"
                onClick={() => handleDeletePointLight(selectedPointLight.id)}
                className="flex-1 font-label-caps text-[9px] text-error hover:bg-error/10 py-[4px] rounded transition-colors cursor-pointer flex items-center justify-center gap-1 border border-error/30"
              >
                <span className="material-symbols-outlined text-[13px]">delete</span>
                REMOVE
              </button>
            </div>
          </div>
        )}

        {/* Selected Object Inspector */}
        {selectedAsset && (
          <div className="absolute top-sm right-sm w-[240px] bg-surface-container/90 backdrop-blur-md border border-outline-variant/40 p-sm rounded-xl flex flex-col gap-xs z-20 shadow-xl">
            <div className="flex justify-between items-center pb-xs border-b border-outline-variant/20">
              <span className="font-label-caps text-[10px] text-primary tracking-widest uppercase font-semibold truncate">
                {selectedAsset.name}
              </span>
              <button
                onClick={() => setSelectedAssetId(null)}
                className="text-on-surface-variant hover:text-on-surface text-[12px] cursor-pointer"
              >
                ✕
              </button>
            </div>
            <div className="text-[10px] text-on-surface-variant font-mono space-y-[2px]">
              <div>POS: {selectedAsset.position.map((v) => v.toFixed(2)).join(', ')}</div>
              <div>ROT: {selectedAsset.rotation.map((v) => v.toFixed(2)).join(', ')}</div>
              <div>SCL: {selectedAsset.scale.map((v) => v.toFixed(2)).join(', ')}</div>
            </div>

            {/* Per-Object Specularity / Matte Control */}
            <div className="flex items-center justify-between text-[10px] font-mono pt-1 border-t border-outline-variant/20">
              <span className="text-on-surface-variant flex items-center gap-1">
                <span className="material-symbols-outlined text-[13px] text-cyan-400">tonality</span>
                Specularity
              </span>
              <div className="flex items-center gap-1.5">
                <input
                  type="range"
                  min={0.0}
                  max={1.0}
                  step={0.05}
                  value={selectedAsset.specularity !== undefined ? selectedAsset.specularity : stageSpecularity}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    const updated = assets.map((a) => (a.id === selectedAsset.id ? { ...a, specularity: val } : a));
                    onUpdateProject({ ...currentProject, scenes: updated });
                  }}
                  className="w-16 accent-cyan-400 cursor-pointer h-1"
                />
                <span className="text-cyan-300 font-bold w-7 text-right">
                  {Math.round((selectedAsset.specularity !== undefined ? selectedAsset.specularity : stageSpecularity) * 100)}%
                </span>
              </div>
            </div>

            {/* Per-Object Texture Glow / Self-Illumination (Emissive Boost for Night Windows / Neon) */}
            <div className="flex items-center justify-between text-[10px] font-mono pt-1 border-t border-outline-variant/20" title="Enhance baked texture lighting, windows, and glowing elements">
              <span className="text-on-surface-variant flex items-center gap-1">
                <span className="material-symbols-outlined text-[13px] text-amber-400">flare</span>
                Texture Glow
              </span>
              <div className="flex items-center gap-1.5">
                <input
                  type="range"
                  min={0.0}
                  max={1.5}
                  step={0.05}
                  value={selectedAsset.emissiveBoost !== undefined ? selectedAsset.emissiveBoost : 0.35}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    const updated = assets.map((a) => (a.id === selectedAsset.id ? { ...a, emissiveBoost: val } : a));
                    onUpdateProject({ ...currentProject, scenes: updated });
                  }}
                  className="w-16 accent-amber-400 cursor-pointer h-1"
                />
                <span className="text-amber-300 font-bold w-7 text-right">
                  {Math.round((selectedAsset.emissiveBoost !== undefined ? selectedAsset.emissiveBoost : 0.35) * 100)}%
                </span>
              </div>
            </div>

            <button
              onClick={() =>
                handleUpdateAssetTransform(
                  selectedAsset.id,
                  [0, 0, 0],
                  [0, 0, 0],
                  [1, 1, 1]
                )
              }
              className="font-label-caps text-[9px] text-on-surface-variant hover:text-on-surface bg-surface-container-high/50 hover:bg-surface-container-highest py-[3px] rounded transition-colors cursor-pointer flex items-center justify-center gap-1 border border-outline-variant/30"
              title="Reset Position to (0,0,0), Rotation to (0,0,0), and Scale to (1,1,1) [Undoable with Ctrl+Z]"
            >
              <span className="material-symbols-outlined text-[13px]">restart_alt</span>
              RESET TRANSFORM (ORIGIN)
            </button>
            <div className="flex flex-col gap-xs pt-xs border-t border-outline-variant/20">
              <button
                onClick={() => setShowRoomBakeStudio(true)}
                className="w-full font-label-caps text-[10px] text-cyan-400 border border-cyan-400/40 bg-cyan-400/10 hover:bg-cyan-400/20 py-[4px] rounded transition-colors cursor-pointer flex items-center justify-center gap-1 font-semibold"
                title="Bake custom high-resolution AI textures onto this model with Gemini in RoomBake Studio"
              >
                <span className="material-symbols-outlined text-[14px]">brush</span>
                PAINT / BAKE TEXTURE (ROOMBAKE)
              </button>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleDuplicateAsset(selectedAsset.id)}
                  className="flex-1 font-label-caps text-[10px] text-primary border border-primary/40 bg-primary/10 hover:bg-primary/20 py-[4px] rounded transition-colors cursor-pointer flex items-center justify-center gap-1 font-semibold shadow-sm"
                  title="Duplicate this object (Ctrl+D / ⌘D)"
                >
                  <span className="material-symbols-outlined text-[14px]">content_copy</span>
                  DUPLICATE
                </button>
                <button
                  type="button"
                  onClick={() => handleDeleteAsset(selectedAsset.id)}
                  className="flex-1 font-label-caps text-[10px] text-error border border-error/30 hover:bg-error/10 py-[4px] rounded transition-colors cursor-pointer flex items-center justify-center gap-1"
                  title="Remove this object from the scene (Delete / Backspace)"
                >
                  <span className="material-symbols-outlined text-[14px]">delete</span>
                  REMOVE
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Floating AI Generation Control Panel */}
      <div className="absolute bottom-md left-1/2 -translate-x-1/2 w-full max-w-4xl px-md z-30 flex flex-col items-center">
        {/* Progress HUD */}
        {progress && (
          <div className="w-full mb-xs bg-surface-container/90 backdrop-blur-md border border-primary/40 px-md py-xs rounded-lg flex items-center justify-between shadow-xl">
            <div className="flex items-center gap-xs">
              <span className="material-symbols-outlined text-primary text-[16px] animate-spin">
                progress_activity
              </span>
              <span className="font-label-caps text-[11px] text-primary tracking-widest uppercase">
                {progress.stageMessage}
              </span>
            </div>
            {progress.progressPercent !== undefined && (
              <span className="font-label-caps text-[10px] text-on-surface-variant">
                {progress.progressPercent}%
              </span>
            )}
          </div>
        )}

        {/* Input Bar */}
        <div className="w-full bg-surface-container-high/90 backdrop-blur-xl border border-outline-variant/60 p-xs rounded-xl shadow-2xl flex items-center justify-between gap-sm">
          {/* Dual Engine Selector Switch */}
          <div className="flex items-center bg-surface-container/80 p-[2px] rounded-lg border border-outline-variant/30 shrink-0">
            <button
              onClick={() => setSelectedEngine('trellis')}
              className={`px-sm py-xs rounded text-[10px] font-label-caps transition-all cursor-pointer ${
                selectedEngine === 'trellis'
                  ? 'bg-primary text-background font-bold shadow'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
              title="TRELLIS: Generates full-color PBR textured 3D models"
            >
              TRELLIS (TEXTURED)
            </button>
            <button
              onClick={() => setSelectedEngine('hunyuan3d')}
              className={`px-sm py-xs rounded text-[10px] font-label-caps transition-all cursor-pointer ${
                selectedEngine === 'hunyuan3d'
                  ? 'bg-primary text-background font-bold shadow'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
              title="Hunyuan3D-2: Geometry Mesh (Shape Only on ZeroGPU)"
            >
              HUNYUAN 3D (SHAPE)
            </button>
          </div>

          {/* Mesh quality — TRELLIS only; Hunyuan3D runs its own fixed pipeline */}
          {selectedEngine === 'trellis' && (
            <div
              className="flex items-center bg-surface-container/80 p-[2px] rounded-lg border border-outline-variant/30 shrink-0"
              title="How much mesh detail and texture resolution TRELLIS keeps. Higher settings take longer on the GPU."
            >
              <span className="px-xs text-[9px] font-label-caps text-on-surface-variant/70 tracking-wider">
                QUALITY
              </span>
              {TRELLIS_QUALITY_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => {
                    setTrellisQuality(preset.id);
                    saveTrellisQuality(preset.id);
                  }}
                  className={`px-sm py-xs rounded text-[10px] font-label-caps transition-all cursor-pointer ${
                    trellisQuality === preset.id
                      ? 'bg-primary text-background font-bold shadow'
                      : 'text-on-surface-variant hover:text-on-surface'
                  }`}
                  title={`${preset.description} (${preset.costHint}) — mesh simplify ${preset.simplify}, ${preset.textureSize}px texture, ${preset.ssSteps} sampling steps`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}

          {/* Reference Image Button & Preview */}
          <div className="flex-1 flex items-center justify-center px-xs">
            {selectedImageUrl ? (
              <div className="flex items-center gap-sm bg-surface-container-low/80 border border-outline-variant/40 px-sm py-[4px] rounded-lg">
                <div className="relative group shrink-0">
                  <img
                    src={selectedImageUrl}
                    alt="Reference"
                    className="w-8 h-8 rounded object-cover border border-primary/60 shadow-sm"
                  />
                  <button
                    onClick={() => {
                      setSelectedImageUrl(null);
                      setSelectedImageFile(null);
                    }}
                    className="absolute -top-1.5 -right-1.5 bg-surface-container-lowest text-error hover:bg-error hover:text-white text-[10px] w-4 h-4 rounded-full flex items-center justify-center border border-outline-variant cursor-pointer transition-colors shadow"
                    title="Clear Image"
                  >
                    ✕
                  </button>
                </div>
                <button
                  onClick={() => setShowImagePicker(true)}
                  className="text-[11px] font-label-caps text-on-surface hover:text-primary transition-colors flex items-center gap-1 cursor-pointer font-semibold"
                >
                  <span className="material-symbols-outlined text-[15px]">change_circle</span>
                  CHANGE IMAGE
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowImagePicker(true)}
                className="flex items-center justify-center gap-xs py-1.5 px-md rounded-lg text-[11px] font-label-caps font-semibold text-primary/90 hover:text-primary bg-primary/10 hover:bg-primary/20 border border-primary/30 transition-all cursor-pointer shadow-sm"
              >
                <span className="material-symbols-outlined text-[16px]">add_photo_alternate</span>
                SELECT / UPLOAD / GENERATE IMAGE
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileUpload}
            />
          </div>

          {/* Generate 3D Model Button */}
          <button
            onClick={handleGenerate}
            disabled={(!selectedImageUrl && !selectedImageFile) || (progress !== null && progress.status !== 'completed' && progress.status !== 'error')}
            className="bg-primary text-background hover:bg-primary/90 font-label-caps text-[11px] px-md py-[10px] rounded-lg transition-all flex items-center gap-xs shrink-0 whitespace-nowrap cursor-pointer disabled:opacity-50 font-bold shadow"
          >
            <span className="material-symbols-outlined text-[14px]">auto_awesome</span>
            GENERATE 3D MODEL
          </button>
        </div>

        {/* Secondary Navigation Links */}
        <div className="flex items-center gap-md mt-xs text-[11px] font-label-caps text-on-surface-variant">
          <button
            onClick={() => setShowHunyuanWorldModal(true)}
            className="flex items-center gap-xs text-primary hover:underline cursor-pointer font-bold"
          >
            <span className="material-symbols-outlined text-[14px]">domain</span>
            🏛️ HunyuanWorld 3D Scene Reconstruction (3DGS)
          </button>
          <div className="w-[1px] h-3 bg-outline-variant/30" />
          <button
            onClick={() => setShowPanoramaModal(true)}
            className="flex items-center gap-xs hover:text-on-surface cursor-pointer font-medium"
          >
            <span className="material-symbols-outlined text-[14px]">360</span>
            360° AI Skybox
          </button>
          <div className="w-[1px] h-3 bg-outline-variant/30" />
          <button
            onClick={() => setShowImagePicker(true)}
            className="flex items-center gap-xs hover:text-on-surface cursor-pointer"
          >
            <span className="material-symbols-outlined text-[14px]">image</span>
            Sample Prop Presets
          </button>
        </div>
      </div>

      {/* HunyuanWorld 3D Scene Reconstruction Modal */}
      {showHunyuanWorldModal && (
        <div className="absolute inset-0 bg-background/80 backdrop-blur-md z-50 flex items-center justify-center p-md animate-fade-in">
          <div className="w-full max-w-2xl bg-surface-container border border-outline-variant/50 p-lg shadow-2xl rounded-2xl flex flex-col gap-md max-h-[85vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="flex justify-between items-center pb-sm border-b border-outline-variant/20">
              <div className="flex items-center gap-xs">
                <span className="material-symbols-outlined text-primary text-[22px]">domain</span>
                <span className="font-label-caps text-xs text-primary tracking-widest uppercase font-semibold">
                  TENCENT HUNYUANWORLD 2.0 (3D GAUSSIAN SPLATTING SCENE)
                </span>
              </div>
              <button
                onClick={() => setShowHunyuanWorldModal(false)}
                className="text-on-surface-variant hover:text-primary cursor-pointer text-sm"
              >
                ✕
              </button>
            </div>

            {/* Description Card */}
            <div className="bg-surface-container-high/60 border border-primary/30 p-md rounded-xl flex flex-col gap-xs text-[11px] text-on-surface-variant">
              <span className="font-semibold text-primary font-label-caps tracking-wider flex items-center gap-xs">
                <span className="material-symbols-outlined text-[16px]">view_in_ar</span>
                TRUE VOLUMETRIC 3D GAUSSIAN SCENE RECONSTRUCTION
              </span>
              <p>
                Upload multiple photos (4–16 photos) of your room/environment from different angles or a short video walkthrough. HunyuanWorld (WorldMirror 2.0) will synthesize millions of 3D Gaussian Splats for a fully walkable scene.
              </p>
            </div>

            {/* Upload Area */}
            <div
              onClick={() => worldFileInputRef.current?.click()}
              className="border-2 border-dashed border-outline-variant/60 hover:border-primary p-lg rounded-xl flex flex-col items-center justify-center cursor-pointer transition-colors bg-surface-container/50"
            >
              <span className="material-symbols-outlined text-[32px] text-primary mb-xs">add_photo_alternate</span>
              <span className="font-label-caps text-[11px] font-bold text-on-surface">
                {worldFiles.length > 0 ? `${worldFiles.length} SCENE FILES SELECTED` : 'SELECT ROOM PHOTOS OR VIDEO'}
              </span>
              <span className="text-[10px] text-on-surface-variant mt-[2px]">
                Supports PNG, JPG, MP4, MOV (Multiple angles recommended)
              </span>
              <input
                ref={worldFileInputRef}
                type="file"
                multiple
                accept="image/*,video/*"
                className="hidden"
                onChange={handleWorldFilesUpload}
              />
            </div>

            {/* Image Previews */}
            {worldPreviews.length > 0 && (
              <div className="grid grid-cols-4 sm:grid-cols-6 gap-xs max-h-32 overflow-y-auto p-xs bg-surface-container-lowest/50 rounded-lg">
                {worldPreviews.map((p, idx) => (
                  <div key={idx} className="aspect-square rounded overflow-hidden border border-outline-variant/40">
                    <img src={p} alt={`preview_${idx}`} className="w-full h-full object-cover" />
                  </div>
                ))}
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex items-center justify-between pt-sm border-t border-outline-variant/20">
              <button
                onClick={() => directSplatInputRef.current?.click()}
                className="font-label-caps text-[10px] text-on-surface-variant hover:text-on-surface border border-outline-variant px-sm py-xs rounded flex items-center gap-xs cursor-pointer"
              >
                <span className="material-symbols-outlined text-[14px]">file_upload</span>
                DIRECT UPLOAD .PLY / .SPLAT
              </button>
              <input
                ref={directSplatInputRef}
                type="file"
                accept=".ply,.splat"
                className="hidden"
                onChange={handleDirectSplatUpload}
              />

              <button
                onClick={handleReconstructHunyuanWorld}
                disabled={isReconstructingWorld || worldFiles.length === 0}
                className="bg-primary text-background font-label-caps text-[11px] font-bold px-md py-[8px] rounded-lg hover:bg-primary/90 transition-all flex items-center gap-xs cursor-pointer disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
                {isReconstructingWorld ? 'RECONSTRUCTING 3D WORLD...' : '🚀 RECONSTRUCT 3DGS SCENE'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 360° World Panorama Generator & Picker Modal */}
      {showPanoramaModal && (
        <div className="absolute inset-0 bg-background/80 backdrop-blur-md z-50 flex items-center justify-center p-md animate-fade-in">
          <div className="w-full max-w-2xl bg-surface-container border border-outline-variant/50 p-lg shadow-2xl rounded-2xl flex flex-col gap-md max-h-[85vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="flex justify-between items-center pb-sm border-b border-outline-variant/20">
              <div className="flex items-center gap-xs">
                <span className="material-symbols-outlined text-primary text-[22px]">360</span>
                <span className="font-label-caps text-xs text-primary tracking-widest uppercase font-semibold">
                  360° AI SKYBOX & PANORAMIC WORLDS
                </span>
              </div>
              <button
                onClick={() => setShowPanoramaModal(false)}
                className="text-on-surface-variant hover:text-primary cursor-pointer text-sm"
              >
                ✕
              </button>
            </div>

            {/* AI Image-to-360 / Text-to-360 Section */}
            <div className="bg-surface-container-high/60 border border-primary/30 p-md rounded-xl flex flex-col gap-sm">
              <div className="flex items-center justify-between">
                <span className="font-label-caps text-[11px] text-primary tracking-wider font-semibold flex items-center gap-xs">
                  <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
                  GENERATE 360° PANORAMA SKYBOX (FROM PHOTO / PROMPT)
                </span>
                <span className="text-[10px] text-on-surface-variant font-mono">ZeroGPU</span>
              </div>

              <div className="flex gap-sm items-center">
                {/* Single Image Upload / Preview */}
                <div
                  onClick={() => ai360FileInputRef.current?.click()}
                  className="w-20 h-14 border border-dashed border-outline-variant/60 rounded-lg flex flex-col items-center justify-center cursor-pointer hover:border-primary transition-colors relative overflow-hidden shrink-0 bg-surface-container"
                >
                  {ai360ImagePreview ? (
                    <img src={ai360ImagePreview} alt="Preview" className="w-full h-full object-cover" />
                  ) : (
                    <>
                      <span className="material-symbols-outlined text-[18px] text-on-surface-variant">add_photo_alternate</span>
                      <span className="text-[8px] font-label-caps text-on-surface-variant mt-[1px]">ADD PHOTO</span>
                    </>
                  )}
                </div>
                <input
                  ref={ai360FileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleAi360FileUpload}
                />

                {/* Prompt Input */}
                <div className="flex-1 flex flex-col gap-xs">
                  <input
                    type="text"
                    value={ai360Prompt}
                    onChange={(e) => setAi360Prompt(e.target.value)}
                    placeholder="Describe the 360° world (e.g., 'cyberpunk film studio stage, neon lights, 8k')..."
                    className="w-full bg-surface-container border border-outline-variant/40 rounded-lg text-xs text-on-surface px-sm py-[7px] focus:outline-none focus:border-primary font-sans"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleGenerate360();
                    }}
                  />
                </div>

                {/* Generate 360 Button */}
                <button
                  onClick={handleGenerate360}
                  disabled={isGenerating360}
                  className="bg-primary text-background font-label-caps text-[11px] font-bold px-md py-[8px] rounded-lg hover:bg-primary/90 transition-all flex items-center gap-xs cursor-pointer disabled:opacity-50 shrink-0"
                >
                  <span className="material-symbols-outlined text-[14px]">auto_awesome</span>
                  {isGenerating360 ? 'EXPANDING 360°...' : 'GENERATE 360°'}
                </button>
              </div>
            </div>

            {/* Presets Grid */}
            <div>
              <span className="font-label-caps text-[10px] text-on-surface-variant tracking-wider uppercase mb-xs block">
                OR SELECT PHOTOREALISTIC 360° PRESET
              </span>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-sm">
                {PANORAMA_360_PRESETS.map((pano, idx) => (
                  <div
                    key={idx}
                    onClick={() => handleSelectPresetPanorama(pano.url)}
                    className={`aspect-video rounded-lg border overflow-hidden cursor-pointer transition-all relative group flex flex-col justify-end p-xs ${
                      panoramaUrl === pano.url && showPanorama
                        ? 'border-primary ring-2 ring-primary/40'
                        : 'border-outline-variant/30 hover:border-primary/60'
                    }`}
                  >
                    <img src={pano.thumbnail} alt={pano.name} className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform" />
                    <div className="absolute inset-0 bg-gradient-to-t from-background/90 via-background/20 to-transparent" />
                    <span className="relative z-10 font-label-caps text-[10px] text-on-surface font-medium truncate">
                      {pano.name}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Custom 360 Upload from disk */}
            <div className="flex justify-between items-center pt-sm border-t border-outline-variant/20">
              <span className="text-[11px] text-on-surface-variant">
                Already have a 360° Equirectangular image file?
              </span>
              <button
                onClick={() => panoInputRef.current?.click()}
                className="font-label-caps text-[10px] border border-outline-variant text-on-surface px-md py-xs rounded-lg hover:bg-surface-variant cursor-pointer flex items-center gap-xs"
              >
                <span className="material-symbols-outlined text-[14px]">upload</span>
                UPLOAD 360° FILE
              </button>
              <input
                ref={panoInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handlePanoUpload}
              />
            </div>
          </div>
        </div>
      )}

      {/* Reference Image Picker & AI Generator Modal */}
      {showImagePicker && (
        <div className="absolute bottom-[120px] left-1/2 -translate-x-1/2 w-full max-w-3xl bg-surface-container border border-outline-variant/60 p-lg shadow-2xl rounded-2xl z-40 backdrop-blur-xl animate-fade-in flex flex-col gap-md max-h-[85vh] overflow-y-auto">
          <div className="flex justify-between items-center pb-xs border-b border-outline-variant/30">
            <span className="font-label-caps text-[11px] text-primary tracking-widest uppercase font-bold flex items-center gap-xs">
              <span className="material-symbols-outlined text-[16px]">add_photo_alternate</span>
              SELECT, UPLOAD OR GENERATE REFERENCE IMAGE
            </span>
            <button
              onClick={() => setShowImagePicker(false)}
              className="text-on-surface-variant hover:text-primary cursor-pointer text-sm font-bold"
            >
              ✕
            </button>
          </div>

          {/* Generated Reference Image Preview & 4-Candidate Selector Card */}
          {generatedPreviewImage && (
            <div className="bg-surface-container-high/95 border-2 border-primary/60 p-md rounded-2xl flex flex-col gap-md shadow-2xl animate-fade-in">
              <div className="flex items-center justify-between border-b border-outline-variant/30 pb-xs">
                <div className="flex items-center gap-xs text-primary font-label-caps text-xs font-bold">
                  <span className="material-symbols-outlined text-[18px]">collections</span>
                  4 AI REFERENCE CANDIDATES — CHOOSE YOUR PREFERRED SHAPE & ANGLE
                </div>
                <span className="text-[10px] font-mono text-on-surface-variant font-medium">
                  Active: #{selectedPreviewImageIndex + 1} of {generatedPreviewImages.length || 1}
                </span>
              </div>

              {/* 4 Candidate Thumbnails Grid */}
              {generatedPreviewImages.length > 1 && (
                <div className="grid grid-cols-4 gap-2">
                  {generatedPreviewImages.map((img, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        setSelectedPreviewImageIndex(idx);
                        setGeneratedPreviewImage(img);
                      }}
                      className={`relative aspect-square rounded-xl overflow-hidden border-2 transition-all cursor-pointer group bg-background/50 ${
                        selectedPreviewImageIndex === idx
                          ? 'border-primary ring-2 ring-primary/50 scale-[1.03] shadow-lg shadow-primary/20'
                          : 'border-outline-variant/40 hover:border-outline-variant opacity-70 hover:opacity-100 hover:scale-[1.01]'
                      }`}
                    >
                      <img src={img} alt={`Candidate ${idx + 1}`} className="w-full h-full object-cover" />
                      <div className={`absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md text-[9px] font-bold font-mono shadow ${
                        selectedPreviewImageIndex === idx ? 'bg-primary text-background' : 'bg-black/70 text-white'
                      }`}>
                        #{idx + 1}
                      </div>
                      {selectedPreviewImageIndex === idx && (
                        <div className="absolute top-1.5 right-1.5 bg-primary text-background rounded-full w-4 h-4 flex items-center justify-center shadow">
                          <span className="material-symbols-outlined text-[12px] font-bold">check</span>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {/* Active Large Preview & Actions */}
              <div className="flex flex-col sm:flex-row gap-md items-center">
                <div className="relative w-44 h-44 rounded-xl overflow-hidden border border-primary/50 shadow-lg shrink-0 bg-background/50 flex items-center justify-center">
                  <img
                    src={generatedPreviewImage}
                    alt="Selected Reference Candidate"
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute top-1.5 left-1.5 bg-primary text-background font-label-caps text-[9px] font-bold px-2 py-[2px] rounded-full shadow-md flex items-center gap-1">
                    <span className="material-symbols-outlined text-[12px]">auto_awesome</span>
                    GEMINI 3.1 #{selectedPreviewImageIndex + 1}
                  </div>
                </div>
                <div className="flex-1 flex flex-col justify-between h-full gap-sm w-full">
                  <div>
                    <div className="flex items-center gap-xs text-primary font-label-caps text-xs font-bold">
                      <span className="material-symbols-outlined text-[18px]">verified</span>
                      SELECTED CANDIDATE READY FOR 3D MESH RECONSTRUCTION
                    </div>
                    <p className="text-xs text-on-surface-variant font-medium mt-1 line-clamp-2 italic bg-surface-container-low/60 p-xs rounded-lg border border-outline-variant/30">
                      "{generatedPreviewPrompt}"
                    </p>
                  </div>
                  <div className="flex flex-col gap-xs pt-xs border-t border-outline-variant/20">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-xs">
                      <button
                        onClick={handleAcceptAndSendToTrellis}
                        className="bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 text-slate-950 font-label-caps text-xs font-bold py-2.5 px-sm rounded-xl transition-all flex items-center justify-center gap-xs cursor-pointer shadow-lg hover:scale-[1.01]"
                        title="TRELLIS extracts full-color PBR materials and textures into the 3D model"
                      >
                        <span className="material-symbols-outlined text-[18px]">palette</span>
                        ✓ SEND TO TRELLIS (COLOR & TEXTURE)
                      </button>
                      <button
                        onClick={handleAcceptAndSendToHunyuan}
                        className="bg-surface-container-highest hover:bg-surface-container-high border border-outline-variant/60 text-on-surface font-label-caps text-xs font-semibold py-2.5 px-sm rounded-xl transition-all flex items-center justify-center gap-xs cursor-pointer shadow hover:scale-[1.01]"
                        title="Hunyuan3D-2 outputs clean high-poly geometry"
                      >
                        <span className="material-symbols-outlined text-[18px]">view_in_ar</span>
                        ✓ SEND TO HUNYUAN (SHAPE ONLY)
                      </button>
                    </div>
                    <p className="text-[10px] text-on-surface-variant/80 text-center font-sans mt-[2px]">
                      ✨ <strong>TRELLIS</strong> outputs full colors & textures. <strong>Hunyuan 3D</strong> outputs clean geometry.
                    </p>
                    <div className="flex gap-xs mt-1">
                      <button
                        onClick={handleAcceptReferenceOnly}
                        className="flex-1 text-on-surface hover:text-primary bg-surface-container hover:bg-surface-container-high border border-outline-variant/50 font-label-caps text-[10px] font-semibold py-1.5 px-sm rounded-lg transition-colors cursor-pointer text-center"
                      >
                        Accept as Reference Only
                      </button>
                      <button
                        onClick={() => {
                          setGeneratedPreviewImage(null);
                          setGeneratedPreviewImages([]);
                        }}
                        className="text-on-surface-variant hover:text-error bg-surface-container hover:bg-surface-container-high border border-outline-variant/50 font-label-caps text-[10px] py-1.5 px-sm rounded-lg transition-colors cursor-pointer"
                      >
                        ↺ Regenerate (4 New)
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 1. AI Image Generator Input & Button (Spacious Multi-line Textarea) */}
          <div className="bg-surface-container-low p-md rounded-xl border border-outline-variant/40 flex flex-col gap-sm shadow-inner">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-xs text-[11px] font-label-caps text-primary font-bold">
                <span className="material-symbols-outlined text-[18px]">auto_awesome</span>
                GENERATE REFERENCE IMAGE (GEMINI-3.1-FLASH-LITE)
              </div>
              <div className="flex items-center gap-xs">
                <button
                  type="button"
                  onClick={() => setShowGeminiKeyModal(true)}
                  className="text-[10px] font-label-caps text-emerald-400 hover:text-emerald-300 transition-colors flex items-center gap-[2px] cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[12px]">key</span>
                  {geminiApiKey ? 'Gemini Key: Active' : 'Configure Gemini Key'}
                </button>
                <span className="text-on-surface-variant/40 text-[10px]">·</span>
                <span className="text-[10px] text-on-surface-variant font-mono">
                  Enter to generate
                </span>
              </div>
            </div>

            <textarea
              value={aiImagePrompt}
              onChange={(e) => setAiImagePrompt(e.target.value)}
              placeholder="Describe your desired 3D prop (e.g. 'An ornate medieval treasure chest with bronze engravings, heavy iron padlock, weathered dark oak wood, isolated on solid black background, no floor, 8k octane render')..."
              rows={3}
              className="w-full bg-surface-container border border-outline-variant/50 p-sm text-xs text-on-surface placeholder:text-on-surface-variant/40 rounded-xl focus:outline-none focus:border-primary font-sans resize-none leading-relaxed shadow-sm transition-colors"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleGenerateImage();
                }
              }}
            />

            <div className="flex flex-wrap items-center justify-between gap-sm pt-xs">
              {/* Quick style inspiration tags */}
              <div className="flex items-center gap-xs flex-wrap">
                <span className="text-[10px] font-label-caps text-on-surface-variant/70 mr-1">Quick Ideas:</span>
                {[
                  'Vintage Wooden Chair',
                  'Sci-Fi Robot Drone',
                  'Medieval Chest',
                  'Cyberpunk Terminal',
                  'Crystal Lantern',
                  'Ancient Stone Idol'
                ].map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setAiImagePrompt(tag)}
                    className="text-[10px] font-label-caps bg-surface-container hover:bg-surface-container-high text-on-surface-variant hover:text-primary px-sm py-[2px] rounded-full border border-outline-variant/30 transition-colors cursor-pointer"
                  >
                    + {tag}
                  </button>
                ))}
              </div>

              <button
                onClick={handleGenerateImage}
                disabled={isGeneratingAiImage || !aiImagePrompt.trim()}
                className="bg-primary hover:bg-primary/90 text-surface-container-lowest font-label-caps text-[12px] font-bold px-lg py-sm rounded-xl transition-all flex items-center gap-xs cursor-pointer disabled:opacity-50 shrink-0 shadow-md ml-auto"
              >
                {isGeneratingAiImage ? (
                  <>
                    <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>
                    GENERATING REFERENCE IMAGE...
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
                    GENERATE IMAGE
                  </>
                )}
              </button>
            </div>
          </div>

          {/* 2. Sample Presets */}
          <div>
            <span className="font-label-caps text-[10px] text-on-surface-variant tracking-wider block mb-xs">
              OR CHOOSE SAMPLE PRESET
            </span>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-sm">
              {PROP_PRESETS.map((item, idx) => (
                <div
                  key={idx}
                  onClick={() => {
                    setSelectedImageUrl(item.url);
                    setSelectedImageFile(null);
                    setPrompt(item.name);
                    setShowImagePicker(false);
                  }}
                  className="aspect-square rounded-lg border border-outline-variant/30 overflow-hidden hover:border-primary cursor-pointer transition-colors relative group shadow-sm"
                >
                  <img src={item.url} alt={item.name} className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center p-xs text-center text-[10px] text-primary font-label-caps">
                    {item.name}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 3. Upload from Computer */}
          <div className="flex justify-between items-center pt-xs border-t border-outline-variant/30">
            <span className="text-[11px] text-on-surface-variant">
              Have your own photo or concept art?
            </span>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="font-label-caps text-[11px] text-primary border border-outline-variant px-md py-xs rounded-lg hover:bg-surface-variant cursor-pointer flex items-center gap-xs font-semibold"
            >
              <span className="material-symbols-outlined text-[16px]">upload_file</span>
              UPLOAD FROM COMPUTER
            </button>
          </div>
        </div>
      )}

      {/* Hugging Face Token Settings Modal */}
      {showHfTokenModal && (
        <div className="fixed inset-0 z-50 bg-surface-container-lowest/80 backdrop-blur-md flex items-center justify-center p-md animate-fade-in">
          <div className="w-full max-w-md bg-surface-container-high border border-outline-variant/60 rounded-2xl p-lg shadow-2xl flex flex-col gap-md">
            <div className="flex items-center justify-between pb-xs border-b border-outline-variant/30">
              <div className="flex items-center gap-xs">
                <span className="material-symbols-outlined text-primary text-[20px]">key</span>
                <span className="font-headline-sm text-sm text-primary font-bold tracking-wide uppercase">
                  Hugging Face API Token
                </span>
              </div>
              <button
                onClick={() => setShowHfTokenModal(false)}
                className="text-on-surface-variant hover:text-on-surface cursor-pointer"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-on-surface-variant leading-relaxed">
              Your ZeroGPU spaces run faster and have higher compute quotas when authenticated with your Hugging Face Access Token.
            </p>

            <div className="flex flex-col gap-xs">
              <label className="text-[11px] font-label-caps text-on-surface-variant">
                HF User Access Token (Read / Write)
              </label>
              <input
                type="password"
                value={hfTokenInput}
                onChange={(e) => setHfTokenInput(e.target.value)}
                placeholder="hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                className="w-full bg-surface-container-low border border-outline-variant px-sm py-xs rounded-lg text-xs text-on-surface font-mono outline-none focus:border-primary"
              />
              <span className="text-[10px] text-on-surface-variant/70">
                Get your token from{' '}
                <a
                  href="https://huggingface.co/settings/tokens"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline hover:text-primary/80"
                >
                  huggingface.co/settings/tokens
                </a>
              </span>
            </div>

            <div className="flex justify-end gap-sm pt-xs border-t border-outline-variant/30">
              <button
                onClick={() => {
                  localStorage.removeItem('hf_token');
                  setHfTokenInput('');
                  setShowHfTokenModal(false);
                }}
                className="px-sm py-xs text-xs text-error hover:bg-error/10 rounded font-label-caps cursor-pointer"
              >
                Clear Token
              </button>
              <button
                onClick={() => {
                  if (hfTokenInput.trim()) {
                    localStorage.setItem('hf_token', hfTokenInput.trim());
                  } else {
                    localStorage.removeItem('hf_token');
                  }
                  setShowHfTokenModal(false);
                }}
                className="px-md py-xs text-xs bg-primary text-surface-container-lowest font-bold rounded-lg hover:bg-primary/90 transition-colors font-label-caps cursor-pointer shadow"
              >
                Save Token
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Gemini API Key Settings Modal */}
      {showGeminiKeyModal && (
        <div className="fixed inset-0 z-50 bg-surface-container-lowest/80 backdrop-blur-md flex items-center justify-center p-md animate-fade-in">
          <div className="w-full max-w-md bg-surface-container-high border border-outline-variant/60 rounded-2xl p-lg shadow-2xl flex flex-col gap-md">
            <div className="flex items-center justify-between pb-xs border-b border-outline-variant/30">
              <div className="flex items-center gap-xs">
                <span className="material-symbols-outlined text-primary text-[20px]">psychology</span>
                <span className="font-headline-sm text-sm text-primary font-bold tracking-wide uppercase">
                  Google Gemini API Key
                </span>
              </div>
              <button
                onClick={() => setShowGeminiKeyModal(false)}
                className="text-on-surface-variant hover:text-on-surface cursor-pointer"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-on-surface-variant leading-relaxed">
              Used for <strong>Gemini-3.1-flash-lite-image</strong> reference generation and <strong>RoomBake</strong> 3D projective texture painting.
            </p>

            <div className="flex flex-col gap-xs">
              <label className="text-[11px] font-label-caps text-on-surface-variant">
                Gemini API Key (Google AI Studio)
              </label>
              <input
                type="password"
                value={geminiKeyInput}
                onChange={(e) => setGeminiKeyInput(e.target.value)}
                placeholder="AIzaSy..."
                className="w-full bg-surface-container-low border border-outline-variant px-sm py-xs rounded-lg text-xs text-on-surface font-mono outline-none focus:border-primary"
              />
              <span className="text-[10px] text-on-surface-variant/70">
                Get your free key from{' '}
                <a
                  href="https://aistudio.google.com/app/apikey"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline hover:text-primary/80"
                >
                  aistudio.google.com/app/apikey
                </a>
              </span>
            </div>

            <div className="flex justify-end gap-sm pt-xs border-t border-outline-variant/30">
              <button
                onClick={() => {
                  localStorage.removeItem('gemini_api_key');
                  localStorage.removeItem('roombake_gemini_key');
                  setGeminiKeyInput('');
                  setGeminiApiKey('');
                  setShowGeminiKeyModal(false);
                }}
                className="px-sm py-xs text-xs text-error hover:bg-error/10 rounded font-label-caps cursor-pointer"
              >
                Clear Key
              </button>
              <button
                onClick={() => {
                  const k = geminiKeyInput.trim();
                  if (k) {
                    localStorage.setItem('gemini_api_key', k);
                    localStorage.setItem('roombake_gemini_key', k);
                    setGeminiApiKey(k);
                  } else {
                    localStorage.removeItem('gemini_api_key');
                    localStorage.removeItem('roombake_gemini_key');
                    setGeminiApiKey('');
                  }
                  setShowGeminiKeyModal(false);
                }}
                className="px-md py-xs text-xs bg-primary text-surface-container-lowest font-bold rounded-lg hover:bg-primary/90 transition-colors font-label-caps cursor-pointer shadow"
              >
                Save Key
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden file input for importing stage templates */}
      <input
        type="file"
        ref={stageImportInputRef}
        onChange={handleImportStageFile}
        accept=".json"
        className="hidden"
      />

      {/* Stage Library & Presets Modal */}
      {/* Save Stage: naming lives here, with the save it belongs to. */}
      {showSaveStageModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-md">
          <div className="w-full max-w-md bg-surface-container-low border border-outline-variant rounded-xl shadow-2xl overflow-hidden">
            <div className="flex items-center gap-sm p-md border-b border-outline-variant/40">
              <span className="material-symbols-outlined text-emerald-400 text-2xl">save</span>
              <div>
                <h3 className="font-heading font-bold text-base text-on-surface">Save Stage</h3>
                <p className="text-[11px] text-on-surface-variant">
                  Give it a name. A picture of the viewport is saved with it.
                </p>
              </div>
            </div>

            <div className="p-md flex flex-col gap-sm">
              <label className="text-[11px] font-label-caps text-on-surface-variant">Stage name</label>
              <input
                type="text"
                autoFocus
                value={stageSaveName}
                onChange={(e) => setStageSaveName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && stageSaveName.trim()) {
                    setShowSaveStageModal(false);
                    handleSaveStage(stageSaveName.trim());
                  }
                  if (e.key === 'Escape') setShowSaveStageModal(false);
                }}
                placeholder="e.g. Bar - night dressing"
                className="w-full bg-surface-container-low border border-outline-variant px-sm py-2 rounded-lg text-sm text-on-surface outline-none focus:border-primary"
              />

              {pendingBakeIds.length > 0 && (
                <div className="flex items-start gap-xs p-sm bg-amber-500/10 border border-amber-500/30 rounded-lg">
                  <span className="material-symbols-outlined text-amber-400 text-[16px] mt-[1px]">cloud_upload</span>
                  <p className="text-[11px] text-on-surface-variant leading-snug">
                    {pendingBakeIds.length} baked model{pendingBakeIds.length === 1 ? '' : 's'} will be
                    uploaded now. On a slow connection this can take a while — the stage is saved
                    when it finishes.
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-xs p-md border-t border-outline-variant/40">
              <button
                onClick={() => setShowSaveStageModal(false)}
                className="px-md py-1.5 text-xs text-on-surface-variant hover:text-on-surface font-label-caps cursor-pointer"
              >
                Cancel
              </button>
              <button
                disabled={!stageSaveName.trim()}
                onClick={() => {
                  setShowSaveStageModal(false);
                  handleSaveStage(stageSaveName.trim());
                }}
                className="flex items-center gap-1 px-md py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/40 rounded-lg text-xs font-label-caps transition-all cursor-pointer disabled:opacity-40"
              >
                <span className="material-symbols-outlined text-[15px]">save</span>
                <span>Save Stage</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {showStageLibraryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-md animate-in fade-in duration-150">
          <div className="bg-surface-container border border-outline-variant/60 rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
            {/* Modal Header */}
            <div className="px-lg py-md border-b border-outline-variant/30 flex items-center justify-between bg-surface-container-high/40">
              <div className="flex items-center gap-sm">
                <span className="material-symbols-outlined text-amber-400 text-2xl">folder_open</span>
                <div>
                  <h3 className="font-heading font-bold text-base text-on-surface">Load Stages & Presets Library</h3>
                  <p className="text-[11px] text-on-surface-variant">
                    Load saved stages, switch between project environments, or save & export reusable stage templates
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowStageLibraryModal(false)}
                className="p-1 rounded-lg hover:bg-surface-container-highest text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-xl">close</span>
              </button>
            </div>

            {/* Naming and saving moved to the SAVE STAGE button, where they belong. What is left
                here is importing a stage from a file, which is a load-side action. */}
            <div className="p-md bg-surface-container-lowest/50 border-b border-outline-variant/20 flex flex-col sm:flex-row items-center gap-sm">
              <p className="flex-1 w-full text-[11px] text-on-surface-variant">
                To save the stage you are working on, close this and use{' '}
                <span className="text-emerald-400 font-label-caps">SAVE STAGE</span> — it asks for a
                name and takes a thumbnail.
              </p>
              <div className="flex items-center gap-xs w-full sm:w-auto shrink-0">
                <button
                  onClick={() => stageImportInputRef.current?.click()}
                  className="flex-1 sm:flex-none flex items-center justify-center gap-1 px-sm py-1.5 bg-surface-container-high hover:bg-surface-container-highest text-on-surface border border-outline-variant/40 text-xs rounded-lg transition-all font-label-caps cursor-pointer"
                  title="Import Stage from .json"
                >
                  <span className="material-symbols-outlined text-[15px]">upload_file</span>
                  <span>Import</span>
                </button>
              </div>
            </div>

            {/* Stage Presets List */}
            <div className="flex-1 overflow-y-auto p-md space-y-sm min-h-[220px]">
              <div className="flex items-center justify-between text-[11px] font-label-caps text-on-surface-variant px-1">
                <span>AVAILABLE STAGES ({stageLibrary.length})</span>
                <span>Actions</span>
              </div>

              {stageLibrary.length === 0 ? (
                <div className="py-12 text-center text-on-surface-variant/70 flex flex-col items-center gap-xs">
                  <span className="material-symbols-outlined text-4xl text-outline-variant">landscape</span>
                  <p className="text-xs">No saved stage presets found.</p>
                  <p className="text-[11px]">Save your current stage scene design above to use it across any project!</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-sm">
                  {stageLibrary.map((stage) => {
                    const isCurrentProj =
                      stage.id === `stage_proj_${currentProject.id}` ||
                      stage.name.toLowerCase() === currentProject.name.toLowerCase();

                    return (
                      <div
                        key={stage.id}
                        className={`p-sm rounded-xl border transition-all flex items-center justify-between gap-md group ${
                          isCurrentProj
                            ? 'bg-primary/5 border-primary/40 hover:border-primary/70'
                            : 'bg-surface-container-low hover:bg-surface-container border-outline-variant/30 hover:border-outline-variant/60'
                        }`}
                      >
                        {/* Stage Info */}
                        <div className="flex items-center gap-sm min-w-0">
                          <div className={`w-10 h-10 rounded-lg border flex items-center justify-center shrink-0 ${
                            isCurrentProj
                              ? 'bg-primary/20 border-primary/40 text-primary'
                              : 'bg-surface-container-high border-outline-variant/30 text-on-surface-variant'
                          }`}>
                            <span className="material-symbols-outlined text-xl">view_in_ar</span>
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-xs">
                              <h4 className="text-xs font-bold text-on-surface truncate">{stage.name}</h4>
                              {isCurrentProj && (
                                <span className="px-1.5 py-0.5 rounded bg-primary/20 text-primary border border-primary/40 text-[9px] font-mono font-bold tracking-wider">
                                  CURRENT PROJECT
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-on-surface-variant flex-wrap">
                              <span className="font-mono">
                                {stage.scenes?.length || 0} object{(stage.scenes?.length || 0) === 1 ? '' : 's'}
                              </span>
                              <span>•</span>
                              <span className="capitalize">{stage.environmentPreset || 'Studio'} light</span>
                              {stage.panoramaUrl && (
                                <>
                                  <span>•</span>
                                  <span className="text-amber-400">360° Skybox</span>
                                </>
                              )}
                              {stage.splatUrl && (
                                <>
                                  <span>•</span>
                                  <span className="text-purple-400">3DGS Splat</span>
                                </>
                              )}
                              <span>•</span>
                              <span>{new Date(stage.createdAt).toLocaleDateString()}</span>
                            </div>
                          </div>
                        </div>

                        {/* Action Buttons */}
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => handleLoadStageTemplate(stage)}
                            className="flex items-center gap-1 px-sm py-1 bg-primary text-surface-container-lowest hover:bg-primary/90 rounded-lg text-xs font-label-caps font-bold transition-all cursor-pointer shadow-sm active:scale-95"
                            title="Load this stage into the current scene"
                          >
                            <span className="material-symbols-outlined text-[14px]">file_open</span>
                            <span>LOAD STAGE</span>
                          </button>
                          <button
                            onClick={(e) => handleExportStage(stage, e)}
                            className="p-1 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high rounded-lg transition-colors cursor-pointer"
                            title="Export stage as JSON"
                          >
                            <span className="material-symbols-outlined text-[16px]">download</span>
                          </button>
                          <button
                            onClick={(e) => handleDeleteStageTemplate(stage.id, e)}
                            className="p-1 text-on-surface-variant hover:text-error hover:bg-error/10 rounded-lg transition-colors cursor-pointer"
                            title="Delete stage preset"
                          >
                            <span className="material-symbols-outlined text-[16px]">delete</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-lg py-xs border-t border-outline-variant/30 bg-surface-container-high/30 flex justify-between items-center text-[10px] text-on-surface-variant">
              <span>Saved stages persist in local file storage (<code>./data/stages.json</code>)</span>
              <button
                onClick={() => setShowStageLibraryModal(false)}
                className="px-sm py-1 hover:bg-surface-container-highest rounded text-xs font-label-caps cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RoomBake AI Texture Studio Modal */}
      <RoomBakeStudio
        isOpen={showRoomBakeStudio}
        onClose={() => setShowRoomBakeStudio(false)}
        onAddSceneAsset={handleAddRoomBakeAsset}
        targetAsset={
          selectedAsset ||
          assets.find((a) => a.category === 'environment' || a.name.toLowerCase().includes('room')) ||
          null
        }
      />
    </div>
  );
};
