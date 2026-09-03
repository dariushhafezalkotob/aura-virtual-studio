export interface MotionGenerationParams {
  prompt: string;
  durationSeconds?: number;
  actorId?: string;
}

export class KimodoService {
  /**
   * Generates character motion animation from natural language text
   */
  static async generateMotion(
    params: MotionGenerationParams,
    onStatus?: (statusText: string) => void
  ): Promise<{ bvhUrl?: string; animationName: string }> {
    try {
      if (onStatus) onStatus('Connecting to Kimodo Motion Engine...');

      const response = await fetch('/api/generate-motion', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: params.prompt,
          actorId: params.actorId,
        }),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Server returned error ${response.status}`);
      }

      const result = await response.json();
      if (onStatus) onStatus('Animation successfully generated');

      return {
        bvhUrl: result.bvhUrl,
        animationName: result.animationName || params.prompt,
      };
    } catch (err: any) {
      console.warn('Kimodo generation status:', err);
      return {
        animationName: params.prompt,
      };
    }
  }
}
