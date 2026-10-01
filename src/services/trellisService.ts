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

  /** Polls a model job until it finishes, reporting its percentage and step along the way. */
  private static async waitForJob(
    jobId: string,
    onProgress?: (progress: GenerationProgress) => void
  ): Promise<{ glbUrl: string; videoUrl?: string; engine?: string; notice?: string }> {
    let failures = 0;
    while (true) {
      await new Promise((r) => setTimeout(r, 1500));
      let job: any;
      try {
        const res = await fetch(`/api/model-jobs/${encodeURIComponent(jobId)}`);
        job = await res.json();
        if (res.status === 404) throw new Error(job.error || 'The server lost track of this generation.');
        if (!res.ok) throw new Error(job.error || `Server returned error ${res.status}`);
        failures = 0;
      } catch (err) {
        // A dropped poll (phone sleeping, VPN hiccup) is not a failed generation; give up only
        // when the server keeps failing to answer.
        if (err instanceof Error && /lost track|not known/.test(err.message)) throw err;
        if (++failures >= 20) throw err;
        continue;
      }
      if (job.status === 'error') throw new Error(job.error || 'Generation failed');
      if (job.status === 'done') return job.result;
      if (onProgress) {
        onProgress({
          status: job.percent >= 62 ? 'extracting' : 'sampling',
          stageMessage: job.label || 'Working',
          progressPercent: job.percent,
        });
      }
    }
  }

  /**
   * Generates a 3D model/environment using selected AI engine (TRELLIS, Hunyuan3D-2.1, or HunyuanWorld Mirror)
   */
  static async generate3D(
    params: TrellisGenerateParams,
    onProgress?: (progress: GenerationProgress) => void
  ): Promise<{ glbUrl: string; videoUrl?: string; engine?: string; notice?: string }> {
    // Messages never name the model doing the work; the server's step labels don't either.
    try {
      if (onProgress) {
        onProgress({ status: 'connecting', stageMessage: 'Starting', progressPercent: 0 });
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
          trellisModel: params.trellisModel,
          resolution: params.resolution,
          faceTarget: params.faceTarget,
        }),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Server returned error ${response.status}`);
      }

      const started = await response.json();
      if (!started.success || !started.jobId) {
        throw new Error(started.error || 'Generation failed');
      }

      // The server runs the generation as a job (a minute or more); ask how it is doing.
      const result = await this.waitForJob(started.jobId, onProgress);

      if (onProgress) {
        onProgress({ status: 'completed', stageMessage: result.notice || 'Model ready', progressPercent: 100 });
      }

      return {
        glbUrl: result.glbUrl,
        videoUrl: result.videoUrl,
        engine: result.engine,
        notice: result.notice,
      };
    } catch (error: any) {
      if (onProgress) {
        onProgress({ status: 'error', stageMessage: error.message || 'Generation failed' });
      }
      throw error;
    }
  }
}
