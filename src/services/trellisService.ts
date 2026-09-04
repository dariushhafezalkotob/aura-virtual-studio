import { TrellisGenerateParams } from '../types';

export interface GenerationProgress {
  status: 'idle' | 'connecting' | 'sampling' | 'extracting' | 'completed' | 'error';
  stageMessage: string;
  progressPercent?: number;
}

export class TrellisService {
  /**
   * Helper to convert File or Blob to Base64 data URL
   */
  private static fileToBase64(file: File | Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = (e) => reject(e);
      reader.readAsDataURL(file);
    });
  }

  /**
   * Generates a 3D model/environment using selected AI engine (TRELLIS, Hunyuan3D-2.1, or HunyuanWorld Mirror)
   */
  static async generate3D(
    params: TrellisGenerateParams,
    onProgress?: (progress: GenerationProgress) => void
  ): Promise<{ glbUrl: string; videoUrl?: string; engine?: string }> {
    try {
      let engineName = 'TRELLIS';
      if (params.engine === 'hunyuan_world') {
        engineName = 'HunyuanWorld Mirror (HY-World 2.0)';
      } else if (params.engine === 'hunyuan3d') {
        engineName = 'Hunyuan3D-2.1 (PBR Textures)';
      }

      if (onProgress) {
        onProgress({ status: 'connecting', stageMessage: `Connecting to ${engineName} ZeroGPU Neural Engine...` });
      }

      let imageBase64: string | undefined;
      let validRemoteUrl: string | undefined;

      if (params.imageFile) {
        imageBase64 = await this.fileToBase64(params.imageFile);
      } else if (params.imageUrl) {
        if (params.imageUrl.startsWith('data:')) {
          imageBase64 = params.imageUrl;
        } else if (params.imageUrl.startsWith('blob:')) {
          try {
            const blobRes = await fetch(params.imageUrl);
            const blob = await blobRes.blob();
            imageBase64 = await this.fileToBase64(blob);
          } catch (bErr) {
            console.warn('Failed to convert blob URL to base64:', bErr);
            validRemoteUrl = params.imageUrl;
          }
        } else if (params.imageUrl.startsWith('http://') || params.imageUrl.startsWith('https://')) {
          validRemoteUrl = params.imageUrl;
        } else {
          imageBase64 = params.imageUrl.includes('base64,') ? params.imageUrl : `data:image/png;base64,${params.imageUrl}`;
        }
      }

      if (onProgress) {
        onProgress({
          status: 'sampling',
          stageMessage: params.engine === 'hunyuan_world'
            ? 'Reconstructing 3D World Environment & Volumetric Geometry with HY-World 2.0...'
            : `Synthesizing 3D Geometry & Materials with ${engineName}...`
        });
      }

      const hfToken = localStorage.getItem('hf_token') || localStorage.getItem('roombake_hf_token') || '';
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (hfToken) {
        headers['x-hf-token'] = hfToken;
      }

      const response = await fetch('/api/generate-3d', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          engine: params.engine || 'trellis',
          category: params.category || 'prop',
          imageUrl: validRemoteUrl,
          imageBase64,
          prompt: params.prompt,
          seed: params.seed,
          steps: params.steps,
          ssGuidance: params.ssGuidance,
          ssSteps: params.ssSteps,
          slatGuidance: params.slatGuidance,
          slatSteps: params.slatSteps,
          simplify: params.simplify,
          textureSize: params.textureSize,
        }),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Server returned error ${response.status}`);
      }

      if (onProgress) {
        onProgress({ status: 'extracting', stageMessage: 'Extracting 3D Scene Assets & Shader Maps...' });
      }

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error || 'Generation failed');
      }

      if (onProgress) {
        onProgress({ status: 'completed', stageMessage: `Asset Ready (${engineName})` });
      }

      return {
        glbUrl: result.glbUrl,
        videoUrl: result.videoUrl,
        engine: result.engine,
      };
    } catch (error: any) {
      if (onProgress) {
        onProgress({ status: 'error', stageMessage: error.message || 'Generation failed' });
      }
      throw error;
    }
  }
}
