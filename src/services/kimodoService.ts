import { MotionData } from '../types';

export interface MotionGenerationParams {
  prompt: string;
  durationSeconds?: number;
  actorId?: string;
  trajectoryMode?: 'straight' | 'arc' | 'circle' | 'inplace';
  speed?: number;
  seed?: number;
  startPosition?: [number, number, number];
}

export interface MotionPreset {
  id: string;
  name: string;
  category: 'Locomotion' | 'Gestures' | 'Emotes' | 'Action';
  icon: string;
  prompt: string;
  defaultDuration: number;
  trajectoryMode: 'straight' | 'arc' | 'circle' | 'inplace';
  description: string;
}

export const MOTION_PRESETS: MotionPreset[] = [
  {
    id: 'walk_forward',
    name: 'Walk Forward',
    category: 'Locomotion',
    icon: 'directions_walk',
    prompt: 'walks forward steadily with natural arm sway',
    defaultDuration: 4.0,
    trajectoryMode: 'straight',
    description: 'Natural pacing forward with continuous stride cycle',
  },
  {
    id: 'run_sprint',
    name: 'Jog Sprint',
    category: 'Locomotion',
    icon: 'sprint',
    prompt: 'jogs forward swiftly with dynamic athletic stride',
    defaultDuration: 3.5,
    trajectoryMode: 'straight',
    description: 'High energy sprint with forward torso lean',
  },
  {
    id: 'wave_greet',
    name: 'Wave & Greet',
    category: 'Gestures',
    icon: 'waving_hand',
    prompt: 'stands, raises right hand high and waves warmly to the camera',
    defaultDuration: 3.0,
    trajectoryMode: 'inplace',
    description: 'Friendly right-hand waving gesture with subtle head nod',
  },
  {
    id: 'look_around',
    name: 'Look Around',
    category: 'Emotes',
    icon: 'visibility',
    prompt: 'stands alert, scans the surroundings left and right inquisitively',
    defaultDuration: 4.5,
    trajectoryMode: 'inplace',
    description: 'Observant neck and torso panning scanning the stage',
  },
  {
    id: 'idle_breathe',
    name: 'Heroic Idle',
    category: 'Emotes',
    icon: 'self_improvement',
    prompt: 'stands in balanced stance with subtle deep breathing and micro-weight shifts',
    defaultDuration: 5.0,
    trajectoryMode: 'inplace',
    description: 'Natural idle pose with rhythmic chest expansion',
  },
  {
    id: 'martial_arts',
    name: 'Martial Combo',
    category: 'Action',
    icon: 'sports_martial_arts',
    prompt: 'executes a balanced martial arts kick followed by a defensive stance',
    defaultDuration: 4.0,
    trajectoryMode: 'inplace',
    description: 'Dynamic combat martial strike with high leg kick',
  },
  {
    id: 'dance_groove',
    name: 'Dance Groove',
    category: 'Action',
    icon: 'music_note',
    prompt: 'dances with energetic hip sway, arm waves and rhythmic footwork',
    defaultDuration: 5.0,
    trajectoryMode: 'inplace',
    description: 'Rhythmic full-body groove with undulating arms',
  },
  {
    id: 'talk_gesture',
    name: 'Talk & Explain',
    category: 'Gestures',
    icon: 'record_voice_over',
    prompt: 'talks expressively while gesturing with both hands',
    defaultDuration: 4.0,
    trajectoryMode: 'inplace',
    description: 'Conversational acting with alternating hand emphasis',
  },
  {
    id: 'circle_patrol',
    name: 'Circle Patrol',
    category: 'Locomotion',
    icon: 'rotate_right',
    prompt: 'walks along a curved circular perimeter inspecting the stage',
    defaultDuration: 6.0,
    trajectoryMode: 'circle',
    description: 'Smooth 360-degree circular orbit walk trajectory',
  },
];

export class KimodoService {
  /**
   * Generates a 3D trajectory path (waypoints) based on trajectory mode, duration and starting point
   */
  static generateTrajectory(
    mode: 'straight' | 'arc' | 'circle' | 'inplace',
    duration: number = 4.0,
    startPos: [number, number, number] = [0, 0, 0],
    speed: number = 1.0
  ): [number, number, number][] {
    const points: [number, number, number][] = [];
    const numSamples = Math.max(10, Math.floor(duration * 15));
    const [sx, sy, sz] = startPos;

    if (mode === 'inplace') {
      for (let i = 0; i <= numSamples; i++) {
        points.push([sx, sy, sz]);
      }
      return points;
    }

    if (mode === 'straight') {
      const distance = duration * 0.8 * speed;
      for (let i = 0; i <= numSamples; i++) {
        const t = i / numSamples;
        points.push([sx, sy, sz - distance * t]);
      }
      return points;
    }

    if (mode === 'arc') {
      const radius = 2.5 * speed;
      for (let i = 0; i <= numSamples; i++) {
        const t = i / numSamples;
        const angle = t * (Math.PI / 2); // 90 deg turn
        points.push([
          sx + radius * (1 - Math.cos(angle)),
          sy,
          sz - radius * Math.sin(angle)
        ]);
      }
      return points;
    }

    if (mode === 'circle') {
      const radius = 2.2 * speed;
      for (let i = 0; i <= numSamples; i++) {
        const t = i / numSamples;
        const angle = t * (Math.PI * 2);
        points.push([
          sx + radius * Math.sin(angle),
          sy,
          sz - radius * (1 - Math.cos(angle))
        ]);
      }
      return points;
    }

    return points;
  }

  /**
   * Generates character motion animation from natural language text using Kimodo
   */
  static async generateMotion(
    params: MotionGenerationParams,
    onStatus?: (statusText: string) => void
  ): Promise<{
    bvhUrl?: string;
    bvhString?: string;
    animationName: string;
    duration: number;
    trajectory: [number, number, number][];
    trajectoryMode: 'straight' | 'arc' | 'circle' | 'inplace';
    motionData?: MotionData;
  }> {
    const prompt = params.prompt.trim();
    const duration = params.durationSeconds || 4.0;
    const startPos = params.startPosition || [0, 0, 0];

    // Infer trajectory mode from prompt if not explicitly specified
    let trajectoryMode: 'straight' | 'arc' | 'circle' | 'inplace' = params.trajectoryMode || 'inplace';
    const lower = prompt.toLowerCase();
    if (lower.includes('walk') || lower.includes('run') || lower.includes('step') || lower.includes('jog') || lower.includes('pace')) {
      if (lower.includes('circle') || lower.includes('around') || lower.includes('orbit')) {
        trajectoryMode = 'circle';
      } else if (lower.includes('turn') || lower.includes('curve') || lower.includes('arc')) {
        trajectoryMode = 'arc';
      } else {
        trajectoryMode = 'straight';
      }
    }

    const trajectory = this.generateTrajectory(trajectoryMode, duration, startPos, params.speed || 1.0);

    try {
      if (onStatus) onStatus('Synthesizing neural motion diffusion with NVIDIA Kimodo Stage...');

      const response = await fetch('/api/generate-motion', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: prompt,
          duration: duration,
          actorId: params.actorId,
          seed: params.seed,
          diffusion_steps: 50,
          trajectoryMode,
        }),
      });

      if (response.ok) {
        const result = await response.json();
        let bvhUrl = result.bvhUrl;
        if (!bvhUrl && result.bvh) {
          const blob = new Blob([result.bvh], { type: 'text/plain' });
          bvhUrl = URL.createObjectURL(blob);
        }

        let motionData: MotionData | undefined = undefined;
        let finalTrajectory = trajectory;

        // Check if real Kimodo frame data is present
        if (result.rotations && Array.isArray(result.rotations) && result.rotations.length > 0) {
          const rootPts: [number, number, number][] = (result.root || []).map((r: number[]) => [
            (r[0] || 0) + startPos[0],
            (r[1] || 0) + startPos[1],
            (r[2] || 0) + startPos[2],
          ]);

          motionData = {
            fps: result.fps || 30,
            duration: result.duration || duration,
            num_frames: result.num_frames || result.rotations.length,
            root: result.root || [],
            rotations: result.rotations,
            trajectory: rootPts.length > 0 ? rootPts : trajectory,
            bvh: result.bvh,
            prompt,
          };

          if (rootPts.length >= 2) {
            finalTrajectory = rootPts;
          }
        }

        if (onStatus) onStatus('✓ NVIDIA Kimodo neural motion diffusion received successfully!');
        return {
          bvhUrl,
          bvhString: result.bvh,
          animationName: result.animationName || prompt,
          duration: result.duration || duration,
          trajectory: finalTrajectory,
          trajectoryMode,
          motionData,
        };
      } else {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || errJson.detail || `Kimodo server returned ${response.status}`);
      }
    } catch (err: any) {
      console.warn('Kimodo generation error:', err);
      throw err;
    }
  }
}
