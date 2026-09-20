import React, { useState, useEffect, useRef } from 'react';
import { Project, CharacterActor, WorkflowStage, ActorConstraint, MotionSegment, DialogueScene } from '../../types';
import { ThreeStage, TransformMode } from '../viewport/ThreeStage';
import { KimodoService } from '../../services/kimodoService';
import { ActorConstraintsPanel } from '../acting/ActorConstraintsPanel';
import { ActorRigPosingPanel } from '../acting/ActorRigPosingPanel';
import { MultiActorTimeline } from '../acting/MultiActorTimeline';
import { loadOfficialSOMARig, sampleActorPose, sampleActorRootMotion } from '../../services/somaSkeleton';
import { DialoguePanel } from '../acting/DialoguePanel';
import { buildActorSegments } from '../../services/dialogueScript';
import { useDialogueAudioSync } from '../../services/dialogueService';

interface ActingSetupViewProps {
  currentProject: Project;
  onUpdateProject: (updated: Project) => void;
  onNavigateStage?: (stage: WorkflowStage) => void;
}

export const DEFAULT_INITIAL_ACTORS: CharacterActor[] = [
  {
    id: 'actor_soma_alpha',
    name: 'SOMA',
    characterType: 'soma',
    avatar: '🏃',
    color: '#00ffcc',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    currentAnimation: 'Walk Forward',
    motionPrompt: 'walks forward steadily with natural arm sway',
    duration: 4.0,
    trajectory: KimodoService.generateTrajectory('straight', 4.0, [0, 0, 0], 1.0),
  },
  {
    id: 'actor_g1_unit',
    name: 'Unit G1',
    characterType: 'g1',
    avatar: '🤖',
    color: '#ff9500',
    position: [2.0, 0, -1.0],
    rotation: [0, -0.4, 0],
    scale: [1, 1, 1],
    currentAnimation: 'Wave & Greet',
    motionPrompt: 'stands, raises right hand high and waves warmly to the camera',
    duration: 3.0,
    trajectory: KimodoService.generateTrajectory('inplace', 3.0, [2.0, 0, -1.0], 1.0),
  },
];

const PRESET_ACTOR_COLORS = [
  '#00ffcc', '#af52de', '#ff9500', '#ff2d55', '#34c759',
  '#007aff', '#ffd60a', '#ff375f', '#32363d', '#e5e5ea',
];

const PRESET_AVATARS = ['🏃', '🤖', '🥷', '🦸', '💃', '🧟', '👤', '🦾'];

export const ActingSetupView: React.FC<ActingSetupViewProps> = ({
  currentProject,
  onUpdateProject,
  onNavigateStage,
}) => {
  // Synchronize actors from project or default
  const characters: CharacterActor[] = (currentProject.characters && currentProject.characters.length > 0)
    ? currentProject.characters
    : DEFAULT_INITIAL_ACTORS;

  const [selectedActorId, setSelectedActorId] = useState<string>(characters[0]?.id || 'actor_soma_alpha');
  const [transformMode, setTransformMode] = useState<TransformMode>('translate');
  const [rotationSnapAngle, setRotationSnapAngle] = useState<'10deg' | 'free'>('10deg');
  const [motionPrompt, setMotionPrompt] = useState<string>('walks forward 4 steps, stops and waves to camera');
  const [durationSec, setDurationSec] = useState<number>(4.0);
  const [speedMultiplier, setSpeedMultiplier] = useState<number>(1.0);
  const [trajectoryMode, setTrajectoryMode] = useState<'straight' | 'arc' | 'circle' | 'inplace'>('straight');
  const [showTrajectories, setShowTrajectories] = useState<boolean>(true);
  // Kimodo's "Make Smooth Path": send the viewport trajectory as a dense
  // root2d constraint instead of sparse destination waypoints.
  const [useSmoothPath, setUseSmoothPath] = useState<boolean>(false);
  const [showSegments, setShowSegments] = useState<boolean>(false);
  // Frames of overlap blended between segments. Kimodo's default is 5, which
  // carries momentum across the boundary -- good for continuity, bad when the
  // next segment needs a different kind of motion. Measured on a walk->stand
  // pair: 5 frames carries 6.81 m into the "stand" segment, 1 frame carries
  // 3.47 m.
  const [transitionFrames, setTransitionFrames] = useState<number>(5);
  const [renderMode, setRenderMode] = useState<'mesh' | 'skeleton' | 'hybrid'>('mesh');
  const [showViserEmbed, setShowViserEmbed] = useState<boolean>(false);
  const [inspectorPanel, setInspectorPanel] = useState<'rig' | 'constraints' | 'dialogue' | null>('rig');
  const [showActorEditModal, setShowActorEditModal] = useState<boolean>(false);

  // Timeline playback state
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [timelineSec, setTimelineSec] = useState<number>(0);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1.0);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [errorText, setErrorText] = useState<string | null>(null);

  const selectedActor = characters.find((c) => c.id === selectedActorId) || characters[0];
  const isPosing = !!selectedActor && !!selectedActor.activeRigMode && selectedActor.activeRigMode !== 'off';
  const dialogue = currentProject.dialogue;
  // The clip an actor will generate is its multi-text sequence when it has one, so the timeline has
  // to span that too -- otherwise you cannot scrub to (or constrain) the second half of the take.
  const actorSpan = (c: CharacterActor) =>
    Math.max(
      c.duration || 4.0,
      (c.motionSegments || []).reduce((n, sg) => n + (sg.duration || 0), 0),
      ...(c.keyframePoses || []).map((k) => k.endTime ?? k.time)
    );
  const maxDuration = Math.max(5.0, dialogue?.duration || 0, ...characters.map(actorSpan));

  // Async work (dialogue voice/motion generation) must build on the latest project, not the one
  // captured when it started, or its saves would undo edits made while it ran.
  const projectRef = useRef(currentProject);
  projectRef.current = currentProject;

  useDialogueAudioSync(dialogue?.audioUrl, isPlaying, timelineSec, playbackSpeed);

  const [isGeneratingDialogueMotion, setIsGeneratingDialogueMotion] = useState(false);

  const handleDialogueChange = (scene: DialogueScene) => {
    onUpdateProject({ ...projectRef.current, dialogue: scene });
  };

  /** Writes each cast actor's talk/listen sequence, covering the whole scene. */
  const applyDialogueSegments = (scene: DialogueScene): Project => {
    const latest = projectRef.current;
    const duration = scene.duration || Math.max(...scene.lines.map((l) => l.end)) + 1;
    const chars = (latest.characters && latest.characters.length > 0 ? latest.characters : characters).map((c) => {
      const member = scene.cast.find((m) => m.actorId === c.id);
      return member ? { ...c, motionSegments: buildActorSegments(scene, member.speaker, duration) } : c;
    });
    // Always store the actors explicitly: a project still showing the built-in defaults has none saved.
    const next = { ...latest, dialogue: scene, characters: chars };
    onUpdateProject(next);
    projectRef.current = next;
    return next;
  };

  const handleApplyDialogue = (scene: DialogueScene) => {
    applyDialogueSegments(scene);
    setShowSegments(true);
    setStatusText('✓ Actor timelines filled from the dialogue. Adjust any segment, then generate motion.');
    setTimeout(() => setStatusText(null), 4000);
  };

  const handleGenerateDialogueMotion = async (scene: DialogueScene) => {
    applyDialogueSegments(scene);
    const cast = scene.cast.filter((m) => m.actorId);
    setIsGeneratingDialogueMotion(true);
    setIsGenerating(true);
    setErrorText(null);
    try {
      for (let i = 0; i < cast.length; i++) {
        const actor = (projectRef.current.characters || []).find((c) => c.id === cast[i].actorId);
        if (!actor?.motionSegments?.length) continue;
        setStatusText(`Generating ${actor.name}'s acting (${i + 1}/${cast.length})...`);
        const sceneLength = actor.motionSegments.reduce((n, sg) => n + sg.duration, 0);
        // Keep the actor's pose constraints and waypoints, timed against the whole scene.
        const enabledConstraints = (actor.constraints || []).filter((c) => c.enabled);
        if (actor.keyframePoses && actor.keyframePoses.length > 0) await loadOfficialSOMARig();
        const compiled =
          enabledConstraints.length > 0 || (actor.keyframePoses && actor.keyframePoses.length > 0)
            ? KimodoService.compileKimodoConstraints(enabledConstraints, sceneLength, actor.position, 30, actor.keyframePoses, {
                actorRotationY: actor.rotation?.[1] || 0,
                rootOrigin: actor.motionData?.root?.[0] as [number, number, number] | undefined,
              })
            : [];
        const res = await KimodoService.generateMotion(
          {
            prompt: actor.motionSegments[0].prompt,
            durationSeconds: sceneLength,
            actorId: actor.id,
            trajectoryMode: 'inplace',
            speed: 1.0,
            startPosition: actor.position,
            actorRotationY: actor.rotation?.[1] || 0,
            segments: actor.motionSegments.map((sg) => ({ prompt: sg.prompt, duration: sg.duration })),
            numTransitionFrames: transitionFrames,
            constraints: compiled.length > 0 ? compiled : undefined,
          },
          (st) => setStatusText(`${actor.name} (${i + 1}/${cast.length}): ${st}`)
        );
        const latest = projectRef.current;
        const next = {
          ...latest,
          characters: (latest.characters || []).map((c) =>
            c.id === actor.id
              ? {
                  ...c,
                  motionPrompt: `Dialogue: ${cast[i].speaker}`,
                  currentAnimation: res.animationName,
                  duration: res.duration,
                  trajectory: res.trajectory,
                  motionData: res.motionData,
                  bvhUrl: res.bvhUrl,
                  customBoneRotations: {},
                  ikTargets: undefined,
                  customPoseTime: undefined,
                  activeRigMode: 'off' as const,
                }
              : c
          ),
        };
        onUpdateProject(next);
        projectRef.current = next;
      }
      setTimelineSec(0);
      setIsPlaying(true);
      setStatusText('✓ Dialogue scene acted out. Playing from the start.');
      setTimeout(() => setStatusText(null), 4000);
    } catch (e: any) {
      console.error('Dialogue motion generation failed:', e);
      setErrorText(e.message || 'Kimodo generation encountered an issue.');
      setStatusText(null);
    } finally {
      setIsGenerating(false);
      setIsGeneratingDialogueMotion(false);
    }
  };

  // Update complete actor object (including rig mode, keyframes, poses)
  const handleUpdateActor = (updatedActor: CharacterActor) => {
    const updated = characters.map((c) => (c.id === updatedActor.id ? updatedActor : c));
    onUpdateProject({ ...currentProject, characters: updated });
  };

  // --- Multi-text: a sequence of prompts Kimodo renders as ONE continuous
  // motion with a per-segment frame budget, blended across the boundaries.
  const segments = selectedActor?.motionSegments || [];
  /** The sequence column is out of flow, so both it and the stack beside it test the same flag. */
  const segmentsColumnOpen = segments.length > 0 && showSegments;
  const segmentsTotal = segments.reduce((n, sg) => n + (sg.duration || 0), 0);

  const setSegments = (next: MotionSegment[]) => {
    if (!selectedActor) return;
    handleUpdateActor({ ...selectedActor, motionSegments: next });
  };

  const handleAddSegment = () => {
    if (!selectedActor) return;
    // Seed the first two from the single prompt so the split is a starting
    // point rather than an empty form.
    const seeded: MotionSegment[] =
      segments.length === 0
        ? [
            { id: `seg_${Date.now()}`, prompt: motionPrompt || 'walks forward', duration: durationSec },
            { id: `seg_${Date.now() + 1}`, prompt: '', duration: 2.0 },
          ]
        : [...segments, { id: `seg_${Date.now()}`, prompt: '', duration: 2.0 }];
    setSegments(seeded);
    setShowSegments(true);
  };

  const handleUpdateSegment = (id: string, patch: Partial<MotionSegment>) =>
    setSegments(segments.map((sg) => (sg.id === id ? { ...sg, ...patch } : sg)));

  const handleDeleteSegment = (id: string) => setSegments(segments.filter((sg) => sg.id !== id));

  const handleMoveSegment = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= segments.length) return;
    const next = [...segments];
    [next[index], next[to]] = [next[to], next[index]];
    setSegments(next);
  };

  // Update constraints for a given actor and persist in project
  const handleUpdateConstraints = (actorId: string, constraints: ActorConstraint[]) => {
    const destWithPrompt = constraints.find(
      (c) => c.enabled && c.type === 'destination' && c.destination?.prompt?.trim()
    );
    const updated = characters.map((c) => {
      if (c.id === actorId) {
        return {
          ...c,
          constraints,
          ...(destWithPrompt?.destination?.prompt ? { motionPrompt: destWithPrompt.destination.prompt } : {}),
        };
      }
      return c;
    });
    if (destWithPrompt?.destination?.prompt && actorId === selectedActorId) {
      setMotionPrompt(destWithPrompt.destination.prompt);
    }
    onUpdateProject({ ...currentProject, characters: updated });
  };

  // Update actor properties (name, color, avatar, etc.)
  const handleUpdateActorProps = (
    actorId: string,
    updates: Partial<Pick<CharacterActor, 'name' | 'color' | 'avatar' | 'motionSegments'>>
  ) => {
    const updated = characters.map((c) => {
      if (c.id === actorId) {
        return { ...c, ...updates };
      }
      return c;
    });
    onUpdateProject({ ...currentProject, characters: updated });
  };

  // Initialize actors on first mount if empty
  useEffect(() => {
    if (!currentProject.characters || currentProject.characters.length === 0) {
      onUpdateProject({
        ...currentProject,
        characters: DEFAULT_INITIAL_ACTORS,
      });
    }
  }, []);

  // Update prompt when selected actor changes
  useEffect(() => {
    if (selectedActor) {
      if (selectedActor.motionPrompt) setMotionPrompt(selectedActor.motionPrompt);
      if (selectedActor.duration) setDurationSec(selectedActor.duration);
    }
  }, [selectedActorId]);

  // Kimodo generation is slow enough (tens of seconds) that a spinner alone
  // reads as a hang. Count up so the wait is visibly progressing.
  useEffect(() => {
    if (!isGenerating) return;
    setElapsedSec(0);
    const startedAt = Date.now();
    const id = window.setInterval(() => {
      setElapsedSec((Date.now() - startedAt) / 1000);
    }, 100);
    return () => window.clearInterval(id);
  }, [isGenerating]);

  // Master Timeline Animation Loop
  const lastTimeRef = useRef<number>(performance.now());
  useEffect(() => {
    let animFrame: number;
    const updateTimeline = (now: number) => {
      const dt = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;

      if (isPlaying) {
        setTimelineSec((prev) => {
          const next = prev + dt * playbackSpeed;
          return next >= maxDuration ? 0 : next;
        });
      }
      animFrame = requestAnimationFrame(updateTimeline);
    };
    animFrame = requestAnimationFrame(updateTimeline);
    return () => cancelAnimationFrame(animFrame);
  }, [isPlaying, maxDuration, playbackSpeed]);

  // Keyboard Shortcuts (Space for Play/Pause, W/E/R for Transforms)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setIsPlaying((p) => !p);
      } else if (e.key.toLowerCase() === 'w') {
        setTransformMode('translate');
      } else if (e.key.toLowerCase() === 'e') {
        setTransformMode('rotate');
      } else if (e.key.toLowerCase() === 'r') {
        setTransformMode('scale');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Handle Actor Transform Updates from 3D Viewport
  const handleUpdateActorTransform = (
    id: string,
    position: [number, number, number],
    rotation: [number, number, number],
    scale: [number, number, number]
  ) => {
    const updated = characters.map((c) => {
      if (c.id === id) {
        // Regenerate trajectory based on new starting position
        const traj = KimodoService.generateTrajectory(
          trajectoryMode,
          c.duration || 4.0,
          position,
          speedMultiplier
        );
        return { ...c, position, rotation, scale, trajectory: traj };
      }
      return c;
    });
    onUpdateProject({ ...currentProject, characters: updated });
  };

  // Generate Motion with Kimodo AI
  const handleGenerateMotion = async (
    overridePrompt?: string,
    overrideConstraints?: ActorConstraint[]
  ) => {
    if (!selectedActor) return;
    const constraintsToUse = overrideConstraints || selectedActor.constraints || [];
    const activeDestConstraint = constraintsToUse.find(
      (c) => c.enabled && c.type === 'destination' && c.destination?.prompt?.trim()
    );

    let promptToUse = (overridePrompt || motionPrompt).trim();
    if (!overridePrompt && (!promptToUse || promptToUse === 'walks forward steadily with natural arm sway')) {
      if (activeDestConstraint?.destination?.prompt?.trim()) {
        promptToUse = activeDestConstraint.destination.prompt.trim();
        setMotionPrompt(promptToUse);
      }
    }
    if (!promptToUse) return;

    if (overridePrompt) {
      setMotionPrompt(overridePrompt);
    }

    setIsGenerating(true);
    setErrorText(null);

    try {
      // Everything that can throw now lives inside the try, so `finally` always
      // clears the generating flag. Previously a throw out here left the button
      // stuck on "generating" with no error surfaced and no request sent.
      // buildFullBodyAxisAngle needs the rig's rest pose to fill untouched
      // joints; the load is cached so this is a no-op once the viewport mounted.
      if (selectedActor.keyframePoses && selectedActor.keyframePoses.length > 0) {
        await loadOfficialSOMARig();
      }

      // The clip length is the multi-text sequence when there is one. Compiling against the single-
      // prompt slider put every constraint past its value (4s by default) on that slider's last frame.
      const activeSegments = segments.filter((sg) => sg.prompt.trim() && sg.duration > 0);
      const clipDuration =
        activeSegments.length > 0 ? activeSegments.reduce((n, sg) => n + sg.duration, 0) : durationSec;

      const compiledConstraints = KimodoService.compileKimodoConstraints(
        constraintsToUse,
        clipDuration,
        selectedActor.position,
        30,
        selectedActor.keyframePoses,
        {
          actorRotationY: selectedActor.rotation?.[1] || 0,
          rootOrigin: selectedActor.motionData?.root?.[0] as [number, number, number] | undefined,
          densePath:
            useSmoothPath && selectedActor.trajectory && selectedActor.trajectory.length >= 2
              ? selectedActor.trajectory
              : undefined,
        }
      );

      // The compiled list is heterogeneous: 'root2d' entries carry
      // frame_indices, 'keyframe_poses' entries carry keyframes. Reading
      // [0].frame_indices.length blindly threw whenever an actor had pose
      // keyframes but no destination waypoint.
      const waypointCount = compiledConstraints
        .filter((c: any) => c?.type === 'root2d')
        .reduce((n: number, c: any) => n + (c.frame_indices?.length || 0), 0);
      const poseKeyCount = compiledConstraints
        .filter((c: any) => c?.type && c.type !== 'root2d')
        .reduce((n: number, c: any) => n + (c.frame_indices?.length || 0), 0);

      const isDense = compiledConstraints.some(
        (c: any) => c?.type === 'root2d' && (c.frame_indices?.length || 0) > 8
      );

        const conditioning = [
        isDense
          ? 'smooth root path'
          : waypointCount > 0
          ? `${waypointCount} waypoint${waypointCount === 1 ? '' : 's'}`
          : null,
        poseKeyCount > 0 ? `${poseKeyCount} pose constraint${poseKeyCount === 1 ? '' : 's'}` : null,
      ].filter(Boolean);

      setStatusText(
        conditioning.length > 0
          ? `Synthesizing neural motion conditioned on ${conditioning.join(' + ')}...`
          : 'Synthesizing motion with NVIDIA Kimodo Stage on Hugging Face GPU...'
      );

      const res = await KimodoService.generateMotion(
        {
          prompt: promptToUse,
          durationSeconds: clipDuration,
          actorId: selectedActor.id,
          trajectoryMode,
          speed: speedMultiplier,
          startPosition: selectedActor.position,
          actorRotationY: selectedActor.rotation?.[1] || 0,
          segments: activeSegments.map((sg) => ({ prompt: sg.prompt, duration: sg.duration })),
          numTransitionFrames: transitionFrames,
          constraints: compiledConstraints.length > 0 ? compiledConstraints : undefined,
        },
        (s) => setStatusText(s)
      );

      // Build on the latest project: generation takes a while, and this handler's closure is from when
      // it started (e.g. still in editing mode). Pose edits are cleared so the new motion shows as
      // generated; the constraints stay for the next round.
      const latest = projectRef.current;
      const latestChars = latest.characters && latest.characters.length > 0 ? latest.characters : characters;
      const updated = latestChars.map((c) => {
        if (c.id === selectedActor.id) {
          return {
            ...c,
            motionPrompt: promptToUse,
            currentAnimation: res.animationName,
            duration: res.duration,
            trajectory: res.trajectory,
            motionData: res.motionData,
            bvhUrl: res.bvhUrl,
            customBoneRotations: {},
            ikTargets: undefined,
            customPoseTime: undefined,
            activeRigMode: 'off' as const,
          };
        }
        return c;
      });

      onUpdateProject({ ...latest, characters: updated });
      setIsPlaying(true);
      setTimelineSec(0);
      setStatusText(`✓ True Kimodo Neural Motion applied to ${selectedActor.name}`);
      setTimeout(() => setStatusText(null), 4000);
    } catch (e: any) {
      console.error('Kimodo generation failed:', e);
      setErrorText(e.message || 'Kimodo generation encountered an issue.');
      setStatusText(null);
    } finally {
      setIsGenerating(false);
    }
  };

  /**
   * "Continue from last frame": generate the NEXT section starting from the pose the current take
   * ends on, and append it. The end pose goes in as a full-body constraint at frame 0, which is how
   * Kimodo is told where to start; the new section's ground track is then joined onto the old one.
   */
  const handleContinueFromLastFrame = async () => {
    const actor = selectedActor;
    const md = actor?.motionData;
    if (!actor || !md || !md.rotations?.length) return;
    const prompt = motionPrompt.trim();
    if (!prompt) {
      setErrorText('Write what happens next in the prompt box, then press Continue.');
      return;
    }

    setIsGenerating(true);
    setErrorText(null);
    try {
      await loadOfficialSOMARig();
      const takeLength = md.duration || actor.duration || 4;
      const endPose = sampleActorPose({ ...actor, customBoneRotations: {}, customPoseTime: undefined }, takeLength);
      const endRoot = sampleActorRootMotion(actor, takeLength);
      if (!endPose) throw new Error('Could not read the pose at the end of this take.');

      // The new section starts at its own origin, so only the hip HEIGHT carries over.
      const startConstraint = KimodoService.compileKimodoConstraints([], durationSec, actor.position, 30, [
        {
          time: 0,
          boneRotations: endPose,
          rootMotion: [0, endRoot ? endRoot[1] : 0, 0] as [number, number, number],
          constraintKinds: ['fullbody'],
        },
      ]);

      setStatusText(`Continuing ${actor.name} from the last frame (+${durationSec}s)...`);
      const res = await KimodoService.generateMotion(
        {
          prompt,
          durationSeconds: durationSec,
          actorId: actor.id,
          trajectoryMode: 'inplace',
          speed: speedMultiplier,
          startPosition: actor.position,
          actorRotationY: actor.rotation?.[1] || 0,
          numTransitionFrames: transitionFrames,
          constraints: startConstraint.length > 0 ? startConstraint : undefined,
        },
        (st) => setStatusText(st)
      );
      if (!res.motionData) throw new Error('Kimodo returned no motion to append.');

      const merged = KimodoService.appendMotion(md, res.motionData);
      const latest = projectRef.current;
      const chars = (latest.characters && latest.characters.length > 0 ? latest.characters : characters).map((c) =>
        c.id === actor.id
          ? {
              ...c,
              motionData: merged,
              duration: merged.duration,
              trajectory: merged.trajectory,
              bvhUrl: undefined,
              motionPrompt: merged.prompt || prompt,
              // The new section is its own block on the multi-text row.
              motionSegments: [
                ...(c.motionSegments && c.motionSegments.length > 0
                  ? c.motionSegments
                  : [{ id: `seg_base_${Date.now()}`, prompt: c.motionPrompt || 'base motion', duration: takeLength }]),
                { id: `seg_cont_${Date.now()}`, prompt, duration: res.duration },
              ],
              customBoneRotations: {},
              ikTargets: undefined,
              customPoseTime: undefined,
              activeRigMode: 'off' as const,
            }
          : c
      );
      onUpdateProject({ ...latest, characters: chars });
      setTimelineSec(takeLength);
      setIsPlaying(true);
      setStatusText(`✓ Added ${res.duration.toFixed(1)}s — ${actor.name}'s take is now ${merged.duration.toFixed(1)}s`);
      setTimeout(() => setStatusText(null), 4000);
    } catch (e: any) {
      console.error('Continue from last frame failed:', e);
      setErrorText(e.message || 'Could not continue the take.');
      setStatusText(null);
    } finally {
      setIsGenerating(false);
    }
  };

  // Always call the newest generate handler (the panel may call it right after an actor update).
  const handleGenerateMotionRef = useRef(handleGenerateMotion);
  handleGenerateMotionRef.current = handleGenerateMotion;

  // Add New Actor to Scene
  const handleAddActor = (type: 'soma' | 'g1') => {
    const count = characters.length + 1;
    const isSoma = type === 'soma';
    const newActor: CharacterActor = {
      id: `actor_${type}_${Date.now()}`,
      name: isSoma ? `SOMA ${count}` : `G1 ${count}`,
      characterType: type,
      avatar: isSoma ? '🏃' : '🤖',
      color: isSoma ? '#00ffcc' : '#ff9500',
      position: [(Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 4],
      rotation: [0, (Math.random() - 0.5) * Math.PI, 0],
      scale: [1, 1, 1],
      currentAnimation: 'Walk Forward',
      motionPrompt: 'walks forward steadily with natural arm sway',
      duration: 4.0,
      trajectory: KimodoService.generateTrajectory('straight', 4.0, [0, 0, 0], 1.0),
    };

    const updated = [...characters, newActor];
    onUpdateProject({ ...currentProject, characters: updated });
    setSelectedActorId(newActor.id);
  };

  // Remove Selected Actor
  const handleDeleteActor = (id: string) => {
    if (characters.length <= 1) {
      alert('Must keep at least one character on stage.');
      return;
    }
    const updated = characters.filter((c) => c.id !== id);
    onUpdateProject({ ...currentProject, characters: updated });
    if (selectedActorId === id) {
      setSelectedActorId(updated[0].id);
    }
  };

  const assets = currentProject.scenes || [];

  return (
    <div className="relative w-full h-[calc(100vh-61px)] overflow-hidden bg-background flex flex-col">
      {/* Viewport Area */}
      <div className="flex-1 min-h-0 relative w-full flex">
        {/* Main 3D Three.js Virtual Stage */}
        <div className="flex-1 relative w-full h-full">
          <ThreeStage
            assets={assets}
            selectedAssetId={null}
            pointLights={currentProject.pointLights}
            characters={characters.map((c) => ({ ...c, renderMode }))}
            // While posing (FK/IK), the actor the Rig panel edits is always selected in the viewport.
            // The panel falls back to the first actor when nothing is selected, so without this it
            // could be in FK/IK mode on an actor whose handles weren't drawn at all.
            selectedActorId={isPosing ? selectedActor.id : selectedActorId}
            transformMode={transformMode}
            rotationSnap={rotationSnapAngle === '10deg' ? (10 * Math.PI) / 180 : null}
            lightIntensity={currentProject.lightIntensity}
            stageSpecularity={currentProject.stageSpecularity}
            environmentPreset={currentProject.environmentPreset}
            onSelectActor={(id) => {
              // A click on empty space or on the set used to deselect the actor mid-pose, which
              // hid every FK/IK handle while the Rig panel still showed the pose mode.
              if (!id && isPosing) return;
              setSelectedActorId(id || '');
            }}
            onUpdateActorTransform={handleUpdateActorTransform}
            onUpdateActor={handleUpdateActor}
            onSelectJoint={(jointIndex) =>
              selectedActor && handleUpdateActor({ ...selectedActor, selectedJointIndex: jointIndex })
            }
            onSelectIkEffector={(effector) =>
              selectedActor && handleUpdateActor({ ...selectedActor, selectedIkEffector: effector })
            }
            currentTimelineTime={timelineSec}
            isPlaying={isPlaying}
            showTrajectories={showTrajectories}
            panoramaUrl={currentProject.panoramaUrl}
            panoramaRotation={currentProject.panoramaRotation || 0}
            showPanorama={currentProject.showPanorama}
            splatUrl={currentProject.splatUrl}
          />

          {/* Status Toast */}
          {statusText && (
            <div className="absolute top-md left-1/2 -translate-x-1/2 z-40 bg-surface-container/95 border border-primary/40 px-lg py-sm rounded-xl backdrop-blur-xl shadow-2xl flex items-center gap-md animate-fadeIn">
              <span className={`material-symbols-outlined text-primary text-[20px] ${isGenerating ? 'animate-spin' : ''}`}>
                {isGenerating ? 'progress_activity' : 'check_circle'}
              </span>
              <span className="font-label-caps text-xs text-primary tracking-wider uppercase font-medium">
                {statusText}
              </span>
              {isGenerating && (
                <span
                  className="font-mono text-xs text-on-surface-variant tabular-nums border-l border-outline-variant/40 pl-md"
                  title="Kimodo runs on a Hugging Face GPU Space; cold containers take longer."
                >
                  {elapsedSec.toFixed(1)}s
                </span>
              )}
            </div>
          )}

          {/* Error / Cold-Start Alert Banner */}
          {errorText && (
            <div className="absolute top-md left-1/2 -translate-x-1/2 z-40 bg-surface-container-highest/95 border border-amber-500/60 px-lg py-sm rounded-xl backdrop-blur-xl shadow-2xl flex items-center gap-md max-w-xl animate-fadeIn">
              <span className="material-symbols-outlined text-amber-400 text-[22px] shrink-0">
                {errorText.toLowerCase().includes('stage') || errorText.toLowerCase().includes('booting') || errorText.toLowerCase().includes('building') ? 'hourglass_top' : 'warning'}
              </span>
              <div className="flex flex-col gap-[2px] flex-1">
                <span className="text-xs font-semibold text-amber-300 tracking-wide font-label-caps">
                  {errorText.toLowerCase().includes('stage') || errorText.toLowerCase().includes('booting') || errorText.toLowerCase().includes('building')
                    ? 'KIMODO GPU CONTAINER STARTING UP'
                    : 'MOTION GENERATION NOTE'}
                </span>
                <span className="text-[11px] text-on-surface-variant leading-relaxed font-mono">
                  {errorText}
                </span>
              </div>
              <div className="flex items-center gap-xs shrink-0">
                <button
                  onClick={() => handleGenerateMotion()}
                  className="bg-amber-500/20 hover:bg-amber-500 text-amber-200 hover:text-black border border-amber-500/40 px-sm py-[3px] rounded-lg text-xs font-label-caps transition-all cursor-pointer font-medium"
                >
                  RETRY
                </button>
                <button
                  onClick={() => setErrorText(null)}
                  className="text-on-surface-variant hover:text-on-surface p-xs rounded-lg cursor-pointer"
                  title="Dismiss"
                >
                  <span className="material-symbols-outlined text-[18px]">close</span>
                </button>
              </div>
            </div>
          )}

          {/* Top Left Floating Bar: Actor Roster & Transform Controls */}
          <div className="absolute top-md left-md z-30 flex flex-col gap-xs">
            {/* Actor Roster Selector */}
            <div className="bg-surface-container/90 border border-outline-variant/40 p-xs rounded-xl backdrop-blur-xl flex items-center gap-xs shadow-2xl">
              {characters.map((act) => (
                <button
                  key={act.id}
                  onClick={() => setSelectedActorId(act.id)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-label-caps tracking-wide transition-all cursor-pointer flex items-center gap-1.5 ${
                    selectedActorId === act.id
                      ? 'bg-primary text-background font-medium shadow-md'
                      : 'text-on-surface-variant hover:text-primary hover:bg-surface-variant'
                  }`}
                >
                  <span className="text-xs">{act.avatar || '🏃'}</span>
                  <span>{act.name}</span>
                </button>
              ))}

              {/* Add Actor Button */}
              <div className="flex items-center gap-[2px] ml-xs border-l border-outline-variant/30 pl-xs">
                <button
                  onClick={() => handleAddActor('soma')}
                  title="Add SOMA Character"
                  className="px-sm py-xs text-[11px] font-label-caps text-on-surface-variant hover:text-primary hover:bg-surface-variant rounded flex items-center gap-[2px] cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[14px]">add</span>
                  +SOMA
                </button>
                <button
                  onClick={() => handleAddActor('g1')}
                  title="Add Unit G1 Robot"
                  className="px-sm py-xs text-[11px] font-label-caps text-on-surface-variant hover:text-primary hover:bg-surface-variant rounded flex items-center gap-[2px] cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[14px]">add</span>
                  +G1
                </button>
              </div>

              {/* Actor Appearance & Rename Button */}
              {selectedActor && (
                <div className="relative ml-xs border-l border-outline-variant/30 pl-xs">
                  <button
                    onClick={() => setShowActorEditModal(!showActorEditModal)}
                    title="Rename Actor & Change Mesh Material Color"
                    className={`px-sm py-xs text-[11px] font-label-caps rounded-lg transition-all flex items-center gap-1.5 cursor-pointer border ${
                      showActorEditModal
                        ? 'bg-primary text-background border-primary font-medium shadow-md'
                        : 'border-outline-variant/30 text-on-surface-variant hover:text-primary hover:bg-surface-variant'
                    }`}
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full border border-white/40 shadow-sm"
                      style={{ backgroundColor: selectedActor.color || '#00ffcc' }}
                    />
                    <span className="material-symbols-outlined text-[14px]">palette</span>
                    <span>STYLE</span>
                  </button>

                  {/* Actor Appearance & Color Popover */}
                  {showActorEditModal && (
                    <div className="absolute top-9 left-0 z-50 bg-surface-container-high/95 border border-outline-variant/40 p-md rounded-2xl shadow-2xl backdrop-blur-2xl flex flex-col gap-sm w-72 animate-fadeIn text-on-surface">
                      <div className="flex items-center justify-between border-b border-outline-variant/20 pb-xs">
                        <span className="font-label-caps text-xs font-semibold text-primary flex items-center gap-1">
                          <span className="material-symbols-outlined text-[16px]">tune</span>
                          ACTOR PROPERTIES
                        </span>
                        <button
                          onClick={() => setShowActorEditModal(false)}
                          className="p-0.5 text-on-surface-variant hover:text-primary rounded cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-[16px]">close</span>
                        </button>
                      </div>

                      {/* 1. Rename Actor */}
                      <div className="flex flex-col gap-1">
                        <span className="text-[10px] font-label-caps text-on-surface-variant">
                          ACTOR NAME:
                        </span>
                        <input
                          type="text"
                          value={selectedActor.name}
                          onChange={(e) =>
                            handleUpdateActorProps(selectedActor.id, { name: e.target.value })
                          }
                          placeholder="e.g. SOMA Hero, Cyber Agent..."
                          className="w-full bg-surface-container border border-outline-variant/40 rounded-lg px-2 py-1 text-xs text-primary font-medium focus:outline-none focus:border-primary"
                        />
                      </div>

                      {/* 2. Mesh Material Color */}
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-label-caps text-on-surface-variant">
                            MESH MATERIAL COLOR:
                          </span>
                          <span className="text-[10px] font-mono text-primary uppercase">
                            {selectedActor.color || '#00ffcc'}
                          </span>
                        </div>
                        <div className="grid grid-cols-5 gap-1.5 pt-0.5">
                          {PRESET_ACTOR_COLORS.map((hex) => (
                            <button
                              key={hex}
                              type="button"
                              onClick={() => handleUpdateActorProps(selectedActor.id, { color: hex })}
                              className={`h-7 rounded-lg border transition-transform hover:scale-110 cursor-pointer flex items-center justify-center ${
                                selectedActor.color === hex
                                  ? 'border-white ring-2 ring-primary shadow-lg scale-105'
                                  : 'border-black/30 hover:border-white/40'
                              }`}
                              style={{ backgroundColor: hex }}
                            >
                              {selectedActor.color === hex && (
                                <span className="material-symbols-outlined text-white text-[14px] drop-shadow">
                                  check
                                </span>
                              )}
                            </button>
                          ))}
                        </div>
                        <div className="flex items-center justify-between pt-1 border-t border-outline-variant/15 text-[11px] mt-1">
                          <span className="text-[10px] text-on-surface-variant font-label-caps">
                            CUSTOM HEX:
                          </span>
                          <div className="flex items-center gap-1">
                            <input
                              type="color"
                              value={selectedActor.color || '#00ffcc'}
                              onChange={(e) =>
                                handleUpdateActorProps(selectedActor.id, { color: e.target.value })
                              }
                              className="w-6 h-6 bg-transparent border-0 rounded cursor-pointer"
                            />
                            <input
                              type="text"
                              value={selectedActor.color || '#00ffcc'}
                              onChange={(e) =>
                                handleUpdateActorProps(selectedActor.id, { color: e.target.value })
                              }
                              className="w-16 bg-surface-container border border-outline-variant/30 rounded px-1 text-[10px] font-mono text-primary text-center"
                            />
                          </div>
                        </div>
                      </div>

                      {/* 3. Avatar Emoji */}
                      <div className="flex flex-col gap-1">
                        <span className="text-[10px] font-label-caps text-on-surface-variant">
                          AVATAR ICON:
                        </span>
                        <div className="grid grid-cols-8 gap-1">
                          {PRESET_AVATARS.map((av) => (
                            <button
                              key={av}
                              type="button"
                              onClick={() => handleUpdateActorProps(selectedActor.id, { avatar: av })}
                              className={`h-7 rounded-lg bg-surface-container hover:bg-surface-variant flex items-center justify-center text-sm cursor-pointer border transition-transform hover:scale-110 ${
                                selectedActor.avatar === av
                                  ? 'border-primary bg-primary/10 shadow-sm'
                                  : 'border-outline-variant/30'
                              }`}
                            >
                              {av}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Transform Mode Selector & Trajectory Toggle */}
            <div className="bg-surface-container/90 border border-outline-variant/40 p-xs rounded-xl backdrop-blur-xl flex items-center gap-xs shadow-xl w-fit">
              <button
                onClick={() => setTransformMode('translate')}
                title="Move (W)"
                className={`p-xs rounded-lg transition-colors cursor-pointer ${
                  transformMode === 'translate' ? 'bg-primary text-background font-medium' : 'text-on-surface-variant hover:text-primary'
                }`}
              >
                <span className="material-symbols-outlined text-[18px]">open_with</span>
              </button>
              <button
                onClick={() => setTransformMode('rotate')}
                title="Rotate (E)"
                className={`p-xs rounded-lg transition-colors cursor-pointer ${
                  transformMode === 'rotate' ? 'bg-primary text-background font-medium' : 'text-on-surface-variant hover:text-primary'
                }`}
              >
                <span className="material-symbols-outlined text-[18px]">rotate_90_degrees_ccw</span>
              </button>
              <button
                onClick={() => setTransformMode('scale')}
                title="Scale (R)"
                className={`p-xs rounded-lg transition-colors cursor-pointer ${
                  transformMode === 'scale' ? 'bg-primary text-background font-medium' : 'text-on-surface-variant hover:text-primary'
                }`}
              >
                <span className="material-symbols-outlined text-[18px]">aspect_ratio</span>
              </button>

              <div className="h-4 w-[1px] bg-outline-variant/40 mx-xs" />

              {/* Rotation Snap Mode Toggle (10° Snap vs Free Rotation) */}
              <div className="flex items-center gap-[2px] bg-surface-container-low p-[2px] rounded-lg">
                <button
                  onClick={() => {
                    setRotationSnapAngle('10deg');
                    if (transformMode !== 'rotate') setTransformMode('rotate');
                  }}
                  title="10° Incremental Snap Rotation"
                  className={`px-xs py-[2px] text-[10px] font-label-caps rounded cursor-pointer ${
                    rotationSnapAngle === '10deg'
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/40 font-semibold'
                      : 'text-on-surface-variant hover:text-primary'
                  }`}
                >
                  10° SNAP
                </button>
                <button
                  onClick={() => {
                    setRotationSnapAngle('free');
                    if (transformMode !== 'rotate') setTransformMode('rotate');
                  }}
                  title="Free Continuous Smooth Rotation"
                  className={`px-xs py-[2px] text-[10px] font-label-caps rounded cursor-pointer ${
                    rotationSnapAngle === 'free'
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/40 font-semibold'
                      : 'text-on-surface-variant hover:text-primary'
                  }`}
                >
                  FREE
                </button>
              </div>

              <div className="h-4 w-[1px] bg-outline-variant/40 mx-xs" />

              {/* SOMA Display Mode Switcher (Mesh / Skeleton / Hybrid) */}
              <div className="flex items-center gap-[2px] bg-surface-container-low p-[2px] rounded-lg">
                <button
                  onClick={() => setRenderMode('mesh')}
                  title="SOMA Anatomical Human Body Mesh"
                  className={`px-xs py-[2px] text-[10px] font-label-caps rounded cursor-pointer ${
                    renderMode === 'mesh' ? 'bg-primary text-background font-semibold' : 'text-on-surface-variant hover:text-primary'
                  }`}
                >
                  MESH
                </button>
                <button
                  onClick={() => setRenderMode('skeleton')}
                  title="SOMA 24-Joint Biomechanical Skeleton Rig"
                  className={`px-xs py-[2px] text-[10px] font-label-caps rounded cursor-pointer ${
                    renderMode === 'skeleton' ? 'bg-primary text-background font-semibold' : 'text-on-surface-variant hover:text-primary'
                  }`}
                >
                  SKEL
                </button>
                <button
                  onClick={() => setRenderMode('hybrid')}
                  title="SOMA X-Ray Translucent Mesh + Skeleton"
                  className={`px-xs py-[2px] text-[10px] font-label-caps rounded cursor-pointer ${
                    renderMode === 'hybrid' ? 'bg-primary text-background font-semibold' : 'text-on-surface-variant hover:text-primary'
                  }`}
                >
                  HYBRID
                </button>
              </div>

              <div className="h-4 w-[1px] bg-outline-variant/40 mx-xs" />

              <button
                onClick={() => setShowTrajectories(!showTrajectories)}
                title="Toggle 3D Motion Trajectory Spline"
                className={`px-sm py-xs text-[11px] font-label-caps tracking-wider rounded-lg transition-colors flex items-center gap-xs cursor-pointer ${
                  showTrajectories ? 'bg-surface-container-high text-primary font-medium' : 'text-on-surface-variant hover:text-primary'
                }`}
              >
                <span className="material-symbols-outlined text-[15px]">timeline</span>
                PATH
              </button>

              <button
                onClick={() => setUseSmoothPath(!useSmoothPath)}
                title={
                  'Make Smooth Path: send the trajectory spline to Kimodo as a dense root2d ' +
                  'constraint so the generated motion follows it, instead of only hitting sparse waypoints.'
                }
                className={`px-sm py-xs text-[11px] font-label-caps tracking-wider rounded-lg transition-colors flex items-center gap-xs cursor-pointer ${
                  useSmoothPath ? 'bg-primary text-background font-medium' : 'text-on-surface-variant hover:text-primary'
                }`}
              >
                <span className="material-symbols-outlined text-[15px]">route</span>
                SMOOTH PATH
              </button>

              {selectedActor?.motionData && (
                <div className="flex items-center gap-1 bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 px-sm py-[2px] rounded-lg text-[10px] font-label-caps tracking-wider font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  KIMODO DIFFUSION ({selectedActor.motionData.num_frames}F @ {selectedActor.motionData.fps}FPS)
                </div>
              )}

              {characters.length > 1 && (
                <button
                  onClick={() => handleDeleteActor(selectedActorId)}
                  title="Remove Selected Actor"
                  className="p-xs text-error hover:bg-error/10 rounded cursor-pointer ml-xs"
                >
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                </button>
              )}
            </div>
          </div>

          {/* Top Right: Rig & Pose Panel, Constraints Panel & Live Kimodo Viser Engine Toggle */}
          <div className="absolute top-md right-md z-30 flex items-center gap-xs">
            {/* Dialogue Previs Toggle */}
            <button
              onClick={() => setInspectorPanel(inspectorPanel === 'dialogue' ? null : 'dialogue')}
              className={`px-md py-sm rounded-xl font-label-caps text-xs tracking-wider border backdrop-blur-xl flex items-center gap-xs transition-all shadow-xl cursor-pointer ${
                inspectorPanel === 'dialogue'
                  ? 'bg-primary text-background border-primary font-medium'
                  : 'bg-surface-container/90 border-outline-variant/40 text-on-surface-variant hover:text-primary'
              }`}
            >
              <span className="material-symbols-outlined text-[18px]">record_voice_over</span>
              <span>DIALOGUE</span>
              {dialogue && dialogue.lines.length > 0 && (
                <span
                  className={`text-[10px] px-1.5 py-[1px] rounded-full font-mono font-bold ${
                    inspectorPanel === 'dialogue' ? 'bg-black text-primary' : 'bg-primary/20 text-primary'
                  }`}
                >
                  {dialogue.lines.length}
                </span>
              )}
            </button>

            {/* Rig & Pose Toggle */}
            <button
              onClick={() => setInspectorPanel(inspectorPanel === 'rig' ? null : 'rig')}
              className={`px-md py-sm rounded-xl font-label-caps text-xs tracking-wider border backdrop-blur-xl flex items-center gap-xs transition-all shadow-xl cursor-pointer ${
                inspectorPanel === 'rig'
                  ? 'bg-primary text-background border-primary font-medium'
                  : 'bg-surface-container/90 border-outline-variant/40 text-on-surface-variant hover:text-primary'
              }`}
            >
              <span className="material-symbols-outlined text-[18px]">accessibility_new</span>
              <span>3D RIG & POSING</span>
              {selectedActor?.keyframePoses && selectedActor.keyframePoses.length > 0 && (
                <span
                  className={`text-[10px] px-1.5 py-[1px] rounded-full font-mono font-bold ${
                    inspectorPanel === 'rig' ? 'bg-black text-primary' : 'bg-primary/20 text-primary'
                  }`}
                >
                  {selectedActor.keyframePoses.length}
                </span>
              )}
            </button>

            {/* Constraints Toggle */}
            <button
              onClick={() => setInspectorPanel(inspectorPanel === 'constraints' ? null : 'constraints')}
              className={`px-md py-sm rounded-xl font-label-caps text-xs tracking-wider border backdrop-blur-xl flex items-center gap-xs transition-all shadow-xl cursor-pointer ${
                inspectorPanel === 'constraints'
                  ? 'bg-primary text-background border-primary font-medium'
                  : 'bg-surface-container/90 border-outline-variant/40 text-on-surface-variant hover:text-primary'
              }`}
            >
              <span className="material-symbols-outlined text-[18px]">rule_settings</span>
              <span>CONSTRAINTS</span>
              {selectedActor?.constraints && selectedActor.constraints.filter((c) => c.enabled).length > 0 && (
                <span
                  className={`text-[10px] px-1.5 py-[1px] rounded-full font-mono font-bold ${
                    inspectorPanel === 'constraints' ? 'bg-black text-primary' : 'bg-primary/20 text-primary'
                  }`}
                >
                  {selectedActor.constraints.filter((c) => c.enabled).length}
                </span>
              )}
            </button>

            <button
              onClick={() => setShowViserEmbed(!showViserEmbed)}
              className={`px-md py-sm rounded-xl font-label-caps text-xs tracking-wider border backdrop-blur-xl flex items-center gap-xs transition-all shadow-xl cursor-pointer ${
                showViserEmbed
                  ? 'bg-primary text-background border-primary font-medium'
                  : 'bg-surface-container/90 border-outline-variant/40 text-on-surface-variant hover:text-primary'
              }`}
            >
              <span className="material-symbols-outlined text-[18px]">sports_esports</span>
              {showViserEmbed ? 'HIDE VISER' : 'LIVE KIMODO VISER'}
            </button>
          </div>

          {/* Floating Inspector Panel: 3D Rig & Pose Editor */}
          {inspectorPanel === 'rig' && selectedActor && (
            // Inspector panels are fixed to the window: the viewport they float over shrinks when the
            // timeline/multi-text rows grow, which pushed them behind the timeline with no way to scroll.
            <div className="fixed top-[128px] right-4 bottom-4 z-50 w-80 flex flex-col animate-fadeIn">
              <ActorRigPosingPanel
                actor={selectedActor}
                currentTimelineTime={timelineSec}
                onUpdateActor={handleUpdateActor}
                onJumpToTime={(t) => setTimelineSec(t)}
                onPause={() => setIsPlaying(false)}
                onRegenerate={() => handleGenerateMotionRef.current()}
                isGenerating={isGenerating}
              />
            </div>
          )}

          {/* Floating Inspector Panel: Dialogue Previs */}
          {inspectorPanel === 'dialogue' && (
            // Fixed to the window, not the viewport: the viewport shrinks to a sliver when the
            // multi-text row is open, which collapsed this panel to just its title bar.
            <div className="fixed top-[128px] right-4 bottom-4 z-50 flex animate-fadeIn">
              <DialoguePanel
                scene={dialogue}
                characters={characters}
                timelineSec={timelineSec}
                isGeneratingMotion={isGeneratingDialogueMotion}
                onChange={handleDialogueChange}
                onSeek={(t) => setTimelineSec(t)}
                onApplyToActors={handleApplyDialogue}
                onGenerateMotion={handleGenerateDialogueMotion}
                onClose={() => setInspectorPanel(null)}
              />
            </div>
          )}

          {/* Floating Inspector Panel: Actor Constraints */}
          {inspectorPanel === 'constraints' && selectedActor && (
            <div className="fixed top-[128px] right-4 bottom-4 z-50 flex flex-col animate-fadeIn">
              <ActorConstraintsPanel
                actor={selectedActor}
                allActors={characters}
                currentTimelineTime={timelineSec}
                maxDuration={maxDuration}
                isGenerating={isGenerating}
                onGenerateWithConstraint={(prompt, constraints) =>
                  handleGenerateMotion(prompt, constraints)
                }
                onUpdateConstraints={(updatedConstraints) =>
                  handleUpdateConstraints(selectedActor.id, updatedConstraints)
                }
                onClose={() => setInspectorPanel(null)}
              />
            </div>
          )}
        </div>

        {/* Optional Embedded Live NVIDIA Kimodo Viser 3D Stage Side-by-Side */}
        {showViserEmbed && (
          <div className="w-[45%] h-full border-l border-outline-variant/40 bg-surface-container-lowest relative z-20 flex flex-col">
            <div className="p-xs bg-surface-container flex items-center justify-between border-b border-outline-variant/30">
              <span className="font-label-caps text-xs text-primary font-medium flex items-center gap-xs">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                NVIDIA KIMODO VISER CLOUD ENGINE (:7860)
              </span>
              <button
                onClick={() => setShowViserEmbed(false)}
                className="p-xs text-on-surface-variant hover:text-primary rounded cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>
            <iframe
              src="https://dariushh-kimodo-virtual-stage.hf.space"
              title="Kimodo Virtual Stage Viser View"
              className="flex-1 w-full h-full border-none"
              allow="accelerometer; camera; gyroscope; microphone"
            />
          </div>
        )}
      </div>

      {/* Bottom Director Choreographer & Timeline Panel */}
      <div className="w-full shrink-0 bg-surface-container border-t border-outline-variant/30 p-md z-30 flex items-stretch relative">
        {/* Multi-text sequence, in the bottom bar's own left margin.
            It used to be a full-width row stacked ABOVE the prompt, so opening it grew this panel
            by ~190px and stole that height from the 3D viewport -- exactly when you were trying to
            watch the motion you were describing. As a column it takes width from the timeline,
            which scrolls horizontally anyway, and the viewport never moves.

            It is absolutely positioned on purpose: as a flex child its own content set the panel's
            height, so a fifth or sixth segment grew the bar and ate the viewport again. Out of flow,
            the panel is sized by the timeline alone and the list simply scrolls. */}
        {segmentsColumnOpen && (
          <div className="absolute left-md top-md bottom-md w-[260px] xl:w-[300px] 2xl:w-[340px] min-h-0 bg-surface-container-low border border-outline-variant/40 rounded-xl p-sm flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-1 px-0.5">
              <span
                className="text-[10px] font-label-caps tracking-wider text-on-surface-variant uppercase flex items-center gap-1 min-w-0"
                title="A sequence of prompts rendered as one continuous take"
              >
                <span className="material-symbols-outlined text-[14px] text-primary shrink-0">segment</span>
                <span className="truncate">Multi-Text &middot; {segmentsTotal.toFixed(1)}s</span>
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                <label
                  className="flex items-center gap-1 text-[10px] font-mono text-on-surface-variant"
                  title="Frames blended between segments. Lower values let the next segment change character (e.g. stop walking); higher values keep motion continuous."
                >
                  blend
                  <input
                    type="number"
                    min={1}
                    max={15}
                    step={1}
                    value={transitionFrames}
                    onChange={(e) =>
                      setTransitionFrames(Math.max(1, Math.min(15, parseInt(e.target.value) || 1)))
                    }
                    className="w-9 bg-surface-container border border-outline-variant/30 rounded px-1 py-[1px] text-[10px] font-mono text-on-surface focus:outline-none focus:border-primary"
                  />
                  f
                </label>
                <button
                  onClick={handleAddSegment}
                  title="Add a segment"
                  className="text-primary hover:text-white transition-colors leading-none"
                >
                  <span className="material-symbols-outlined text-[16px]">add</span>
                </button>
                <button
                  onClick={() => setShowSegments(false)}
                  title="Hide the sequence"
                  className="text-on-surface-variant hover:text-on-surface transition-colors leading-none"
                >
                  <span className="material-symbols-outlined text-[16px]">close</span>
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar space-y-1.5 pr-0.5">
              {segments.map((sg, i) => (
                <div
                  key={sg.id}
                  className="bg-surface-container border border-outline-variant/30 rounded-lg p-1.5 space-y-1"
                >
                  <div className="flex items-start gap-1">
                    <span className="text-[10px] font-mono text-on-surface-variant w-4 pt-1.5 text-right shrink-0">
                      {i + 1}.
                    </span>
                    <input
                      type="text"
                      value={sg.prompt}
                      onChange={(e) => handleUpdateSegment(sg.id, { prompt: e.target.value })}
                      placeholder={i === 0 ? 'stands up from the chair' : i === 1 ? 'walks two steps forward' : 'talks and gestures'}
                      className="flex-1 min-w-0 bg-surface-container-low border border-outline-variant/30 rounded-lg px-sm py-1 text-xs text-on-surface focus:outline-none focus:border-primary placeholder:text-on-surface-variant/40"
                    />
                  </div>
                  <div className="flex items-center justify-end gap-1 pl-5">
                    <input
                      type="number"
                      min={0.5}
                      max={20}
                      step={0.5}
                      value={sg.duration}
                      onChange={(e) =>
                        handleUpdateSegment(sg.id, { duration: Math.max(0.5, parseFloat(e.target.value) || 0.5) })
                      }
                      className="w-14 bg-surface-container-low border border-outline-variant/30 rounded-lg px-1.5 py-[2px] text-xs font-mono text-on-surface focus:outline-none focus:border-primary"
                    />
                    <span className="text-[10px] font-mono text-on-surface-variant mr-1">s</span>
                    <button
                      onClick={() => handleMoveSegment(i, -1)}
                      disabled={i === 0}
                      className="text-on-surface-variant hover:text-primary disabled:opacity-25 disabled:hover:text-on-surface-variant transition-colors leading-none"
                      title="Move earlier in the sequence"
                    >
                      <span className="material-symbols-outlined text-[15px]">keyboard_arrow_up</span>
                    </button>
                    <button
                      onClick={() => handleMoveSegment(i, 1)}
                      disabled={i === segments.length - 1}
                      className="text-on-surface-variant hover:text-primary disabled:opacity-25 disabled:hover:text-on-surface-variant transition-colors leading-none"
                      title="Move later in the sequence"
                    >
                      <span className="material-symbols-outlined text-[15px]">keyboard_arrow_down</span>
                    </button>
                    <button
                      onClick={() => handleDeleteSegment(sg.id)}
                      className="text-on-surface-variant hover:text-error transition-colors leading-none"
                      title="Remove segment"
                    >
                      <span className="material-symbols-outlined text-[15px]">close</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <p
              className="text-[9px] text-on-surface-variant/70 italic px-0.5 truncate shrink-0"
              title="One continuous take. Keyframes and waypoints still apply across the whole sequence."
            >
              One continuous take &middot; keys still apply
            </p>
          </div>
        )}

        {/* Everything else keeps its own vertical stack beside the column, clearing it by 4px. */}
        <div
          className={`flex-1 min-w-0 flex flex-col gap-sm ${
            segmentsColumnOpen ? 'ml-[264px] xl:ml-[304px] 2xl:ml-[344px]' : ''
          }`}
        >
        {/* Row 1: Natural Language Prompt Input + Controls.
            Wraps rather than clipping: every control after the prompt is shrink-0, so on a narrower
            window (or with the sequence column open) the row would otherwise push GENERATE MOTION
            off the screen edge. The prompt keeps a usable minimum width instead of collapsing to
            an empty square. */}
        <div
          className={`flex flex-wrap items-center gap-sm max-w-6xl w-full ${
            segmentsColumnOpen ? 'mr-auto' : 'mx-auto'
          }`}
        >
          <div className="flex-1 min-w-[160px] bg-surface-container-low border border-outline-variant/40 rounded-xl flex items-center px-md py-xs focus-within:border-primary transition-all shadow-inner">
            <span className="material-symbols-outlined text-[20px] text-primary mr-sm">
              directions_run
            </span>
            <input
              type="text"
              value={motionPrompt}
              onChange={(e) => setMotionPrompt(e.target.value)}
              placeholder="Describe character motion in natural language (e.g. walks 4 steps, stops and waves)..."
              className="w-full bg-transparent border-none text-primary text-sm focus:outline-none placeholder:text-on-surface-variant/40 py-xs"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleGenerateMotion();
              }}
            />
          </div>

          {/* Multi-text toggle */}
          <button
            onClick={() => (segments.length === 0 ? handleAddSegment() : setShowSegments(!showSegments))}
            title="Multi-text: a sequence of prompts rendered as one continuous motion"
            className={`px-sm py-xs rounded-xl text-[11px] font-label-caps tracking-wider border transition-colors flex items-center gap-xs cursor-pointer shrink-0 ${
              segments.length > 0
                ? 'bg-primary/15 border-primary text-primary font-medium'
                : 'bg-surface-container-low border-outline-variant/40 text-on-surface-variant hover:text-primary'
            }`}
          >
            <span className="material-symbols-outlined text-[15px]">segment</span>
            {segments.length > 0 ? `${segments.length} SEGMENTS` : 'MULTI-TEXT'}
          </button>

          {/* Trajectory Pattern Dropdown */}
          <select
            value={trajectoryMode}
            onChange={(e) => setTrajectoryMode(e.target.value as any)}
            className="bg-surface-container-low border border-outline-variant/40 text-primary text-xs font-label-caps rounded-xl px-md py-sm focus:outline-none focus:border-primary cursor-pointer"
          >
            <option value="straight">Straight Path</option>
            <option value="arc">90° Arc Turn</option>
            <option value="circle">360° Circle Patrol</option>
            <option value="inplace">In-Place Motion</option>
          </select>

          {/* Duration Slider */}
          <div className="flex items-center gap-xs bg-surface-container-low border border-outline-variant/40 px-md py-xs rounded-xl">
            <span className="font-label-caps text-[10px] text-on-surface-variant tracking-wider">
              DUR:
            </span>
            <input
              type="range"
              min="2"
              max="12"
              step="0.5"
              value={durationSec}
              onChange={(e) => setDurationSec(parseFloat(e.target.value))}
              className="w-16 accent-primary h-1 cursor-pointer"
            />
            <span className="font-label-caps text-xs text-primary w-6 font-mono">
              {durationSec}s
            </span>
          </div>

          {/* Stride Speed Multiplier */}
          <div className="flex items-center gap-xs bg-surface-container-low border border-outline-variant/40 px-sm py-xs rounded-xl">
            <span className="font-label-caps text-[10px] text-on-surface-variant tracking-wider">
              SPD:
            </span>
            <select
              value={speedMultiplier}
              onChange={(e) => setSpeedMultiplier(parseFloat(e.target.value))}
              className="bg-transparent border-none text-primary text-xs font-mono focus:outline-none cursor-pointer"
            >
              <option value="0.75" className="bg-surface-container">0.75x</option>
              <option value="1.0" className="bg-surface-container">1.0x</option>
              <option value="1.25" className="bg-surface-container">1.25x</option>
              <option value="1.5" className="bg-surface-container">1.5x</option>
            </select>
          </div>

          {/* Continue the existing take from its last frame */}
          {selectedActor?.motionData?.rotations?.length ? (
            <button
              onClick={handleContinueFromLastFrame}
              disabled={isGenerating}
              title="Generate the next section starting from the pose this take ends on, and add it to the end"
              className="bg-surface-container-low border border-primary/60 text-primary font-label-caps text-label-caps px-md py-sm rounded-xl hover:bg-primary/10 transition-all font-semibold shrink-0 flex items-center gap-xs cursor-pointer disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[18px]">playlist_add</span>
              {`CONTINUE +${durationSec}s`}
            </button>
          ) : null}

          {/* Kimodo AI Generate Action Button */}
          <button
            onClick={() => handleGenerateMotion()}
            disabled={isGenerating}
            className="bg-primary text-background font-label-caps text-label-caps px-lg py-sm rounded-xl hover:bg-white/90 transition-all font-semibold shrink-0 flex items-center gap-xs cursor-pointer disabled:opacity-50 shadow-lg"
          >
            <span className={`material-symbols-outlined text-[18px] ${isGenerating ? 'animate-spin' : ''}`}>
              {isGenerating ? 'progress_activity' : 'auto_fix_high'}
            </span>
            {isGenerating ? `KIMODO GENERATING... ${elapsedSec.toFixed(0)}s` : 'GENERATE MOTION'}
          </button>
        </div>

        {/* Multi-Actor Timeline Sequencer with Duration Visualization */}
        <MultiActorTimeline
          characters={characters}
          selectedActorId={selectedActorId}
          timelineSec={timelineSec}
          maxDuration={maxDuration}
          isPlaying={isPlaying}
          playbackSpeed={playbackSpeed}
          onSelectActor={(id) => setSelectedActorId(id)}
          onSeek={(t) => setTimelineSec(t)}
          onTogglePlay={() => setIsPlaying(!isPlaying)}
          onResetTime={() => setTimelineSec(0)}
          onChangePlaybackSpeed={(spd) => setPlaybackSpeed(spd)}
          onAddActor={(type) => handleAddActor(type)}
          onNavigateStage={onNavigateStage}
          onUpdateActorProps={handleUpdateActorProps}
          dialogue={dialogue}
          alignLeft={segmentsColumnOpen}
        />
        </div>
      </div>
    </div>
  );
};
