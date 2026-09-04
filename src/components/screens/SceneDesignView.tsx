import React, { useState, useRef } from 'react';
import { Project, SceneAsset, AI3DEngine, AssetCategory } from '../../types';
import { TrellisService, GenerationProgress } from '../../services/trellisService';
import {
  ThreeStage,
  TransformMode,
  LightingEnvironmentPreset,
} from '../viewport/ThreeStage';
import { RoomBakeStudio } from '../roombake/RoomBakeStudio';

interface SceneDesignViewProps {
  currentProject: Project;
  onUpdateProject: (project: Project) => void;
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
  const [lightIntensity] = useState<number>(2.4);
  const [environmentPreset, setEnvironmentPreset] = useState<LightingEnvironmentPreset>('studio');
  const [showGrid, setShowGrid] = useState<boolean>(true);

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
  const [generatedPreviewImage, setGeneratedPreviewImage] = useState<string | null>(null);
  const [generatedPreviewPrompt, setGeneratedPreviewPrompt] = useState<string>('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const panoInputRef = useRef<HTMLInputElement>(null);

  const assets = currentProject.scenes || [];
  const selectedAsset = assets.find((a) => a.id === selectedAssetId) || null;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedImageFile(file);
      setSelectedImageUrl(URL.createObjectURL(file));
      setShowImagePicker(false);
    }
  };

  const handlePanoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
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
  const handleDirectSplatUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
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

      const result = await TrellisService.generate3D(
        {
          engine: engineToUse,
          category: selectedCategory,
          imageFile: imgFile || undefined,
          imageUrl: imgUrl || undefined,
          prompt: promptToUse,
        },
        (p: GenerationProgress) => setProgress(p)
      );

      const newAsset: SceneAsset = {
        id: `asset_${Date.now()}`,
        name: promptToUse.trim() || (engineToUse === 'hunyuan3d' ? 'Hunyuan 3D (Textured)' : 'TRELLIS 3D Object'),
        glbUrl: result.glbUrl,
        previewUrl: result.videoUrl,
        position: [assets.length * 1.5, 0, 0],
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
      if (!data.success || !data.imageBase64) {
        throw new Error(data.error || 'Failed to generate image');
      }
      setGeneratedPreviewImage(data.imageBase64);
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
      const existingIdx = (currentProject.scenes || []).findIndex(
        (a) => a.category === 'environment' && (a.id.startsWith('roombake_') || a.name.includes('Room'))
      );

      const newAsset: SceneAsset = {
        id: existingIdx >= 0 ? currentProject.scenes![existingIdx].id : `roombake_${Date.now()}`,
        name: assetData.name || 'AI Baked Room Environment',
        category: 'environment',
        glbUrl: assetData.glbUrl,
        position: existingIdx >= 0 ? currentProject.scenes![existingIdx].position : [0, 0, 0],
        rotation: existingIdx >= 0 ? currentProject.scenes![existingIdx].rotation : [0, 0, 0],
        scale: existingIdx >= 0 ? currentProject.scenes![existingIdx].scale : [1, 1, 1],
        createdAt: new Date().toISOString(),
      };

      let updatedScenes: SceneAsset[];
      if (existingIdx >= 0) {
        updatedScenes = [...(currentProject.scenes || [])];
        updatedScenes[existingIdx] = newAsset;
      } else {
        updatedScenes = [...(currentProject.scenes || []), newAsset];
      }

      onUpdateProject({
        ...currentProject,
        scenes: updatedScenes,
      });
      setSelectedAssetId(newAsset.id);
    }
  };

  const handleUpdateAssetTransform = (
    id: string,
    position: [number, number, number],
    rotation: [number, number, number],
    scale: [number, number, number]
  ) => {
    const updated = {
      ...currentProject,
      scenes: assets.map((a) =>
        a.id === id ? { ...a, position, rotation, scale } : a
      ),
    };
    onUpdateProject(updated);
  };

  const handleDeleteAsset = (id: string) => {
    const updated = {
      ...currentProject,
      scenes: assets.filter((a) => a.id !== id),
    };
    if (selectedAssetId === id) setSelectedAssetId(null);
    onUpdateProject(updated);
  };

  return (
    <div className="flex-1 flex flex-col h-full w-full min-h-0 bg-background relative overflow-hidden select-none">
      {/* Top Controls Bar */}
      <div className="h-[48px] border-b border-outline-variant/30 px-md flex items-center justify-between z-10 bg-surface-container/60 backdrop-blur-md shrink-0">
        {/* Transform Tools */}
        <div className="flex items-center gap-xs bg-surface-container-high/60 p-[2px] rounded-lg border border-outline-variant/30">
          <button
            onClick={() => setTransformMode('translate')}
            className={`flex items-center gap-xs px-sm py-[4px] rounded text-[11px] font-label-caps transition-all cursor-pointer ${
              transformMode === 'translate'
                ? 'bg-primary text-surface-container-lowest shadow font-semibold'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
            title="Translate (W)"
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

        {/* Viewport & 360 / 3DGS World Toggles */}
        <div className="flex items-center gap-sm">
          {/* RoomBake AI Texture Studio Button */}
          <button
            onClick={() => setShowRoomBakeStudio(true)}
            className="flex items-center gap-xs px-sm py-[4px] rounded-lg text-[11px] font-label-caps font-bold transition-all border cursor-pointer bg-surface-container-high/60 text-cyan-400 border-cyan-400/40 hover:bg-cyan-400/20"
            title="RoomBake: Projective 3D Texture Baking Harness (Gemini / OpenAI)"
          >
            <span className="material-symbols-outlined text-[16px]">brush</span>
            ROOMBAKE (AI TEXTURE)
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
            {splatUrl ? 'HUNYUAN 3DGS (ACTIVE)' : 'HUNYUAN WORLD (3DGS)'}
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

          {/* Hugging Face Token Auth Button */}
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

          {/* Gemini API Key Auth Button */}
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
        </div>
      </div>

      {/* 3D WebGL Viewport */}
      <div className="flex-1 w-full h-full relative min-h-0 overflow-hidden">
        <ThreeStage
          assets={assets}
          selectedAssetId={selectedAssetId}
          transformMode={transformMode}
          lightIntensity={lightIntensity}
          environmentPreset={environmentPreset}
          panoramaUrl={panoramaUrl}
          panoramaRotation={panoramaRotation}
          showPanorama={showPanorama}
          splatUrl={splatUrl}
          onSelectAsset={setSelectedAssetId}
          onUpdateAssetTransform={handleUpdateAssetTransform}
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
            <div className="flex flex-col gap-xs pt-xs border-t border-outline-variant/20">
              <button
                onClick={() => setShowRoomBakeStudio(true)}
                className="w-full font-label-caps text-[10px] text-cyan-400 border border-cyan-400/40 bg-cyan-400/10 hover:bg-cyan-400/20 py-[4px] rounded transition-colors cursor-pointer flex items-center justify-center gap-1 font-semibold"
                title="Bake custom high-resolution AI textures onto this model with Gemini in RoomBake Studio"
              >
                <span className="material-symbols-outlined text-[14px]">brush</span>
                PAINT / BAKE TEXTURE (ROOMBAKE)
              </button>
              <button
                onClick={() => handleDeleteAsset(selectedAsset.id)}
                className="w-full font-label-caps text-[10px] text-error hover:bg-error/10 py-[3px] rounded transition-colors cursor-pointer"
              >
                REMOVE OBJECT
              </button>
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

          {/* Generated Reference Image Preview & Accept Card */}
          {generatedPreviewImage && (
            <div className="bg-surface-container-high/90 border-2 border-primary/60 p-md rounded-2xl flex flex-col sm:flex-row gap-md items-center shadow-2xl animate-fade-in">
              <div className="relative w-44 h-44 rounded-xl overflow-hidden border border-primary/50 shadow-lg shrink-0 bg-background/50 flex items-center justify-center">
                <img
                  src={generatedPreviewImage}
                  alt="Generated Reference"
                  className="w-full h-full object-cover"
                />
                <div className="absolute top-1.5 left-1.5 bg-primary text-background font-label-caps text-[9px] font-bold px-2 py-[2px] rounded-full shadow-md flex items-center gap-1">
                  <span className="material-symbols-outlined text-[12px]">auto_awesome</span>
                  GEMINI 3.1 FLASH LITE
                </div>
              </div>
              <div className="flex-1 flex flex-col justify-between h-full gap-sm w-full">
                <div>
                  <div className="flex items-center gap-xs text-primary font-label-caps text-xs font-bold">
                    <span className="material-symbols-outlined text-[18px]">verified</span>
                    AI REFERENCE IMAGE READY
                  </div>
                  <p className="text-xs text-on-surface-variant font-medium mt-1 line-clamp-3 italic bg-surface-container-low/60 p-xs rounded-lg border border-outline-variant/30">
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
                      title="Hunyuan3D-2 outputs clean high-poly geometry (shape only on ZeroGPU; can be painted in RoomBake)"
                    >
                      <span className="material-symbols-outlined text-[18px]">view_in_ar</span>
                      ✓ SEND TO HUNYUAN (SHAPE ONLY)
                    </button>
                  </div>
                  <p className="text-[10px] text-on-surface-variant/80 text-center font-sans mt-[2px]">
                    ✨ <strong>TRELLIS</strong> outputs full colors and textures directly. <strong>Hunyuan 3D</strong> outputs clean geometry (paint with RoomBake).
                  </p>
                  <div className="flex gap-xs mt-1">
                    <button
                      onClick={handleAcceptReferenceOnly}
                      className="flex-1 text-on-surface hover:text-primary bg-surface-container hover:bg-surface-container-high border border-outline-variant/50 font-label-caps text-[10px] font-semibold py-1.5 px-sm rounded-lg transition-colors cursor-pointer text-center"
                    >
                      Accept as Reference Only
                    </button>
                    <button
                      onClick={() => setGeneratedPreviewImage(null)}
                      className="text-on-surface-variant hover:text-error bg-surface-container hover:bg-surface-container-high border border-outline-variant/50 font-label-caps text-[10px] py-1.5 px-sm rounded-lg transition-colors cursor-pointer"
                    >
                      ↺ Regenerate
                    </button>
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

      {/* RoomBake AI Texture Studio Modal */}
      <RoomBakeStudio
        isOpen={showRoomBakeStudio}
        onClose={() => setShowRoomBakeStudio(false)}
        onAddSceneAsset={handleAddRoomBakeAsset}
      />
    </div>
  );
};
