import { MotionData, ActorConstraint } from '../types';
import { buildFullBodyAxisAngle, getRestHipHeight, getRestHipsLocal } from './somaSkeleton';

export interface MotionGenerationParams {
  prompt: string;
  durationSeconds?: number;
  actorId?: string;
  trajectoryMode?: 'straight' | 'arc' | 'circle' | 'inplace';
  speed?: number;
  seed?: number;
  startPosition?: [number, number, number];
  /** Actor's Y rotation in the scene; Kimodo motion is expressed in this frame. */
  actorRotationY?: number;
  constraints?: any[];
  /** Multi-text sequence; when present it replaces the single prompt. */
  segments?: { prompt: string; duration: number }[];
  /** Frames blended between consecutive segments (Kimodo default 5). */
  numTransitionFrames?: number;
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

/**
 * Kimodo works in the actor's own frame: generated root offsets are applied to
 * the body group, which sits inside the actor's rotated root group. So motion
 * space is actor-LOCAL, while scene waypoints and trajectories are world.
 *
 * Ignoring the actor's Y rotation makes the two disagree by exactly that angle
 * -- the waypoint marker renders in one place and the actor walks to another.
 * New actors are seeded with a random Y rotation, so this is the common case,
 * not the edge case.
 */
export function worldToActorLocalXZ(
  dx: number,
  dz: number,
  actorRotationY: number
): [number, number] {
  const c = Math.cos(actorRotationY);
  const s = Math.sin(actorRotationY);
  return [c * dx - s * dz, s * dx + c * dz];
}

export function actorLocalToWorldXZ(
  lx: number,
  lz: number,
  actorRotationY: number
): [number, number] {
  const c = Math.cos(actorRotationY);
  const s = Math.sin(actorRotationY);
  return [c * lx + s * lz, -s * lx + c * lz];
}

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
    const activeSegments = (params.segments || []).filter((s) => s.prompt.trim() && s.duration > 0);
    // With a multi-text sequence the clip length IS the segments, so the
    // trajectory and the returned take must be sized from their sum rather than
    // the single-prompt duration control.
    const duration =
      activeSegments.length > 0
        ? activeSegments.reduce((n, s) => n + s.duration, 0)
        : params.durationSeconds || 4.0;
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

      const segments = activeSegments;

      const reqBody = JSON.stringify({
        prompt: prompt,
        duration: duration,
        ...(segments.length > 0
          ? {
              segments: segments.map((s) => ({ prompt: s.prompt.trim(), duration: s.duration })),
              num_transition_frames: params.numTransitionFrames ?? 5,
            }
          : {}),
        actorId: params.actorId,
        seed: params.seed,
        diffusion_steps: 50,
        trajectoryMode,
        constraints: params.constraints || undefined,
      });

      let response: Response;
      try {
        response = await fetch('/api/generate-motion', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: reqBody,
        });

        // If local proxy failed with 500/502/504, try direct Hugging Face Space endpoint
        if (!response.ok && response.status >= 500) {
          console.warn(`[KimodoService] Local proxy returned ${response.status}. Falling back directly to Hugging Face Space...`);
          if (onStatus) onStatus('Connecting directly to NVIDIA Kimodo Virtual Stage on Hugging Face...');
          response = await fetch('https://dariushh-kimodo-virtual-stage.hf.space/api/generate-motion', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: reqBody,
          });
        }
      } catch (proxyErr) {
        console.warn('[KimodoService] Local proxy network error. Falling back directly to Hugging Face Space...', proxyErr);
        if (onStatus) onStatus('Connecting directly to NVIDIA Kimodo Virtual Stage on Hugging Face...');
        response = await fetch('https://dariushh-kimodo-virtual-stage.hf.space/api/generate-motion', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: reqBody,
        });
      }

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
          // Normalize trajectory root points relative to initial frame so path begins directly at startPos on the floor
          const initR = (result.root && result.root.length > 0) ? result.root[0] : [0, 0, 0];
          // The generated root is in the actor's local frame, while this trajectory
          // line renders in world space outside the actor's rotated group. Without
          // rotating it back, the drawn path and the walking actor diverge by
          // exactly the actor's Y rotation.
          const rootPts: [number, number, number][] = (result.root || []).map((r: number[]) => {
            const [wx, wz] = actorLocalToWorldXZ(
              (r[0] ?? initR[0]) - initR[0],
              (r[2] ?? initR[2]) - initR[2],
              params.actorRotationY || 0
            );
            return [wx + startPos[0], startPos[1], wz + startPos[2]] as [number, number, number];
          });

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
        let errMsg = `Kimodo server returned ${response.status}`;
        try {
          const rawText = await response.text();
          try {
            const errJson = JSON.parse(rawText);
            errMsg = errJson.error || errJson.detail || rawText;
          } catch {
            errMsg = rawText || errMsg;
          }
        } catch (_) {}
        throw new Error(errMsg);
      }
    } catch (err: any) {
      console.warn('Kimodo generation error:', err);
      throw err;
    }
  }

  /**
   * Compiles actor waypoint / destination constraints and keyframe poses into official Kimodo conditioning dictionaries
   */

  /**
   * Joins a freshly generated take onto the end of an existing one ("Continue from last frame").
   *
   * The new take always starts at its own origin, so its ground track is shifted to carry on from
   * where the previous take ended. Hip height stays absolute (Kimodo outputs it that way), and the
   * new take's first frame is dropped: it duplicates the pose it was constrained to.
   */
  static appendMotion(base: MotionData, next: MotionData): MotionData {
    const baseRoot = base.root || [];
    const nextRoot = next.root || [];
    const last = baseRoot[baseRoot.length - 1] || [0, 0, 0];
    const start = nextRoot[0] || [0, 0, 0];

    const shifted: [number, number, number][] = nextRoot
      .slice(1)
      .map((r) => [r[0] - start[0] + last[0], r[1], r[2] - start[2] + last[2]]);

    const baseTraj = base.trajectory || [];
    const nextTraj = next.trajectory || [];
    const lastTraj = baseTraj[baseTraj.length - 1] || [0, 0, 0];
    const startTraj = nextTraj[0] || [0, 0, 0];
    const shiftedTraj: [number, number, number][] = nextTraj
      .slice(1)
      .map((t) => [t[0] - startTraj[0] + lastTraj[0], t[1], t[2] - startTraj[2] + lastTraj[2]]);

    const rotations = [...(base.rotations || []), ...(next.rotations || []).slice(1)];
    const fps = base.fps || next.fps || 30;
    return {
      fps,
      num_frames: rotations.length,
      duration: (base.duration || 0) + (next.duration || 0),
      root: [...baseRoot, ...shifted],
      rotations,
      trajectory: [...baseTraj, ...shiftedTraj],
      // The BVH text belongs to a single take and can't be concatenated meaningfully.
      bvh: undefined,
      prompt: [base.prompt, next.prompt].filter(Boolean).join(' -> '),
    };
  }

  static compileKimodoConstraints(
    constraints: ActorConstraint[],
    durationSeconds: number,
    startPosition: [number, number, number] = [0, 0, 0],
    fps: number = 30,
    keyframePoses?: any[],
    options?: {
      densePath?: [number, number, number][];
      actorRotationY?: number;
      /**
       * Frame 0 of the take's own root track. root2d points are relative to the start of the take,
       * while a key's pelvis is in the take's raw root space, so the two only line up once this is
       * taken off. Kimodo canonicalises the root to (0,0) on frame 0, so it is usually ~zero.
       */
       rootOrigin?: [number, number, number];
    }
  ): any[] {
    const rotY = options?.actorRotationY || 0;
    const toLocal = (wx: number, wz: number): [number, number] =>
      worldToActorLocalXZ(wx - startPosition[0], wz - startPosition[2], rotY);
    const totalFrames = Math.max(15, Math.round(durationSeconds * fps));
    const compiledList: any[] = [];

    // 1. Root 2D: dense path, or sparse destination waypoints
    //
    // Kimodo canonicalises the motion so the smoothed root starts at (0, 0) on
    // frame 0, so every position below is relative to the actor's start.
    const facingConstraints = (constraints || []).filter(
      (c) => c.enabled && c.type === 'facing_direction' && typeof c.facing?.angleDegrees === 'number'
    );

    /** Heading at time t as [cos, sin], from an explicit facing key or the path tangent. */
    const headingAt = (
      timeSec: number,
      fallbackDir: [number, number] | null
    ): [number, number] | null => {
      const explicit = facingConstraints.find((c) => timeSec >= c.startTime && timeSec <= c.endTime);
      if (explicit) {
        const rad = ((explicit.facing!.angleDegrees as number) * Math.PI) / 180 - rotY;
        return [parseFloat(Math.cos(rad).toFixed(4)), parseFloat(Math.sin(rad).toFixed(4))];
      }
      if (!fallbackDir) return null;
      const len = Math.hypot(fallbackDir[0], fallbackDir[1]);
      if (len < 1e-4) return null;
      return [
        parseFloat((fallbackDir[0] / len).toFixed(4)),
        parseFloat((fallbackDir[1] / len).toFixed(4)),
      ];
    };

    const densePath = options?.densePath;

    if (densePath && densePath.length >= 2) {
      // "Make Smooth Path": resample the viewport trajectory spline onto one
      // frame-aligned root2d constraint. Dense root paths are the one dense
      // constraint Kimodo is documented to handle well.
      const frameIndices: number[] = [];
      const smoothRoot2D: [number, number][] = [];
      const headings: [number, number][] = [];
      let headingsComplete = true;

      for (let f = 0; f < totalFrames; f++) {
        const u = totalFrames > 1 ? f / (totalFrames - 1) : 0;
        const idx = Math.min(densePath.length - 1, Math.round(u * (densePath.length - 1)));
        const pt = densePath[idx];
        const nxt = densePath[Math.min(densePath.length - 1, idx + 1)];

        const [lx, lz] = toLocal(pt[0], pt[2]);
        const [nlx, nlz] = toLocal(nxt[0], nxt[2]);

        frameIndices.push(f);
        smoothRoot2D.push([parseFloat(lx.toFixed(4)), parseFloat(lz.toFixed(4))]);

        const h = headingAt(u * durationSeconds, [nlx - lx, nlz - lz]);
        if (h) headings.push(h);
        else headingsComplete = false;
      }

      const entry: any = {
        type: 'root2d',
        frame_indices: frameIndices,
        smooth_root_2d: smoothRoot2D,
      };
      // global_root_heading must be [T, 2] matching frame_indices, or omitted.
      if (headingsComplete && headings.length === frameIndices.length) {
        entry.global_root_heading = headings;
      }
      compiledList.push(entry);
    } else {
      const destConstraints = (constraints || []).filter(
        (c) => c.enabled && c.type === 'destination' && c.destination
      );

      if (destConstraints.length > 0) {
        const points: { fi: number; t: number; pt: [number, number] }[] = [
          { fi: 0, t: 0, pt: [0.0, 0.0] },
        ];

        for (const c of destConstraints) {
          if (!c.destination) continue;
          const arrivalTime = Math.min(durationSeconds, Math.max(0.2, c.endTime));
          const frameIdx = Math.min(totalFrames - 1, Math.max(1, Math.round(arrivalTime * fps)));
          if (points.some((p) => p.fi === frameIdx)) continue;
          const [lx, lz] = toLocal(c.destination.position[0], c.destination.position[2]);
          points.push({
            fi: frameIdx,
            t: arrivalTime,
            pt: [parseFloat(lx.toFixed(3)), parseFloat(lz.toFixed(3))],
          });
        }

        points.sort((a, b) => a.fi - b.fi);

        const headings: [number, number][] = [];
        let headingsComplete = true;
        for (let i = 0; i < points.length; i++) {
          const nxt = points[Math.min(points.length - 1, i + 1)];
          const dir: [number, number] = [nxt.pt[0] - points[i].pt[0], nxt.pt[1] - points[i].pt[1]];
          const h = headingAt(points[i].t, dir);
          if (h) headings.push(h);
          else headingsComplete = false;
        }

        const entry: any = {
          type: 'root2d',
          frame_indices: points.map((p) => p.fi),
          smooth_root_2d: points.map((p) => p.pt),
        };
        if (headingsComplete && headings.length === points.length) {
          entry.global_root_heading = headings;
        }
        compiledList.push(entry);
      }
    }

    // 2. Timeline Keyframe Poses -> Kimodo pose constraints
    //
    // Kimodo's load_constraints_lst does TYPE_TO_CLASS[el['type']], a plain dict
    // lookup over {root2d, fullbody, left-hand, right-hand, left-foot,
    // right-foot, end-effector}. An unknown type raises KeyError, and since the
    // server wraps the whole list in one try/except that silently discards
    // EVERY constraint in the request, waypoints included.
    //
    // Each kind is its own entry with its own frames. 'fullbody' pins every
    // joint; the end-effector kinds pin only that limb plus hips and leave the
    // rest of the body for the model to solve. They all take the same payload:
    // per-joint LOCAL rotations as axis-angle, plus a root position per key.
    // All 77 joints are sent -- kimodo's
    // _convert_constraint_local_rots_to_skeleton does 77 -> 30 itself.
    if (keyframePoses && keyframePoses.length > 0) {
      const restHipY = getRestHipHeight();
      const restHips = getRestHipsLocal();

      const byKind = new Map<
        string,
        { frameIdx: number; localJointsRot: [number, number, number][]; rootPosition: [number, number, number] }[]
      >();

      for (const kf of keyframePoses as any[]) {
        const localJointsRot = buildFullBodyAxisAngle(kf.boneRotations);
        if (!localJointsRot) continue;

        // A constraint past the end of the clip isn't clamped onto the last frame: that would pin a
        // pose at a moment the user never chose. It is simply not sent.
        if ((kf.time || 0) > durationSeconds + 0.05) continue;
        const clamp = (t: number) => Math.min(totalFrames - 1, Math.max(0, Math.round(t * fps)));
        const frameIdx = clamp(kf.time || 0);
        // Interval constraint: the same pose on EVERY frame of the run. Sampling it sparsely (every
        // 3rd frame) left the frames in between unconstrained, and the limb was tugged back at each
        // pinned frame -- visible as a judder, worst on foot constraints.
        const endIdx = kf.endTime && kf.endTime > kf.time ? clamp(kf.endTime) : frameIdx;
        const holdFrames: number[] = [];
        for (let f = frameIdx; f <= endIdx && endIdx > frameIdx; f++) holdFrames.push(f);
        // Where the pelvis is on this frame. A key written with hipsSpace 'root' carries all three
        // axes in exactly this space, so a pelvis the user moved sideways or forward is what gets
        // sent -- that is what pins the actor's position instead of just its height. Older keys only
        // ever had a meaningful height, so their X/Z fall back to the take's own root track.
        //
        // The fallback when there is no take at all is the actor's scene placement, which is static
        // for the whole take -- using it in place of the take's root would pin the character back at
        // the origin on that frame and cancel whatever locomotion was just generated.
        const hips = kf.ikTargets?.hips;
        const hipsRoot = kf.hipsSpace === 'root' && hips ? (hips as [number, number, number]) : null;
        let rootPosition: [number, number, number];
        if (kf.rootMotion) {
          rootPosition = [
            parseFloat((hipsRoot ? hipsRoot[0] : kf.rootMotion[0]).toFixed(4)),
            parseFloat((hips?.[1] ?? kf.rootMotion[1]).toFixed(4)),
            parseFloat((hipsRoot ? hipsRoot[2] : kf.rootMotion[2]).toFixed(4)),
          ];
        } else {
          const kfRoot = kf.rootPosition || startPosition;
          // With no take to anchor to, a root-space pelvis is only an offset from its rest position.
          rootPosition = [
            parseFloat((kfRoot[0] - startPosition[0] + (hipsRoot ? hipsRoot[0] - restHips[0] : 0)).toFixed(4)),
            parseFloat((hips?.[1] ?? restHipY).toFixed(4)),
            parseFloat((kfRoot[2] - startPosition[2] + (hipsRoot ? hipsRoot[2] - restHips[2] : 0)).toFixed(4)),
          ];
        }

        const frames = holdFrames.length > 0 ? holdFrames : [frameIdx];

        const kinds: string[] =
          Array.isArray(kf.constraintKinds) && kf.constraintKinds.length > 0
            ? kf.constraintKinds
            : ['fullbody'];

        for (const kind of kinds) {
          if (!byKind.has(kind)) byKind.set(kind, []);
          for (const f of frames) byKind.get(kind)!.push({ frameIdx: f, localJointsRot, rootPosition });
        }
      }

      for (const [kind, entries] of byKind) {
        // Kimodo indexes frames positionally, so they must be sorted and unique.
        entries.sort((a, b) => a.frameIdx - b.frameIdx);
        const deduped = entries.filter((e, i) => i === 0 || e.frameIdx !== entries[i - 1].frameIdx);
        if (deduped.length === 0) continue;

        compiledList.push({
          type: kind,
          frame_indices: deduped.map((e) => e.frameIdx),
          local_joints_rot: deduped.map((e) => e.localJointsRot),
          root_positions: deduped.map((e) => e.rootPosition),
        });
      }
    }

    // 3. A HELD FULL-BODY POSE ALSO PINS THE GROUND TRACK
    //
    // root_positions inside a pose constraint is only as strong as the pose solve, and in practice
    // the actor still creeps. root2d is Kimodo's dedicated ground-track constraint -- the same one
    // the waypoint path uses -- so a "stand still here" hold is stated in the terms the model
    // actually holds to.
    //
    // Only full-body holds. A held hand or foot during a walk must leave the root free, or the
    // locomotion would be cancelled by the very constraint that was meant to steady one limb.
    // Skipped entirely when the user authored a dense path: that path IS the ground track.
    if (!densePath && keyframePoses && keyframePoses.length > 0) {
      const origin = options?.rootOrigin || [0, 0, 0];
      const clamp = (t: number) => Math.min(totalFrames - 1, Math.max(0, Math.round(t * fps)));
      const holds = new Map<number, [number, number]>();

      for (const kf of keyframePoses as any[]) {
        const kinds: string[] =
          Array.isArray(kf.constraintKinds) && kf.constraintKinds.length > 0 ? kf.constraintKinds : ['fullbody'];
        if (!kinds.includes('fullbody')) continue;
        if (kf.hipsSpace !== 'root' || !kf.ikTargets?.hips) continue;
        if (!(kf.endTime > kf.time)) continue;
        if ((kf.time || 0) > durationSeconds + 0.05) continue;

        const startIdx = clamp(kf.time || 0);
        const endIdx = clamp(Math.min(kf.endTime, durationSeconds));
        const pt: [number, number] = [
          parseFloat((kf.ikTargets.hips[0] - origin[0]).toFixed(4)),
          parseFloat((kf.ikTargets.hips[2] - origin[2]).toFixed(4)),
        ];
        for (let f = startIdx; f <= endIdx; f++) holds.set(f, pt);
      }

      if (holds.size > 0) {
        const existing = compiledList.find((e) => e.type === 'root2d');
        if (existing) {
          // Merge into the waypoint path rather than sending a second, contradictory root2d: the
          // hold wins on its own frames, the waypoints keep the rest.
          const merged = new Map<number, [number, number]>();
          existing.frame_indices.forEach((f: number, i: number) => merged.set(f, existing.smooth_root_2d[i]));
          const addsFrames = [...holds.keys()].some((f) => !merged.has(f));
          for (const [f, pt] of holds) merged.set(f, pt);
          const frames = [...merged.keys()].sort((a, b) => a - b);
          existing.frame_indices = frames;
          existing.smooth_root_2d = frames.map((f) => merged.get(f)!);
          // global_root_heading must line up with frame_indices one for one, and a held frame has
          // no path tangent to take a heading from.
          if (addsFrames) delete existing.global_root_heading;
        } else {
          // Frame 0 anchors the track at the start, which is where Kimodo canonicalises it anyway.
          const frames = [...holds.keys()].sort((a, b) => a - b);
          const withStart = frames[0] === 0 ? frames : [0, ...frames];
          compiledList.push({
            type: 'root2d',
            frame_indices: withStart,
            smooth_root_2d: withStart.map((f) => holds.get(f) ?? [0, 0]),
          });
        }
      }
    }

    return compiledList;
  }
}
