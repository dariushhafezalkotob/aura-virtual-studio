import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  CharacterActor,
  ActorKeyframePose,
  RigMode,
  IkEffectorType,
  KeyframeConstraintKind,
  KEYFRAME_CONSTRAINT_KINDS,
} from '../../types';
import {
  SOMA,
  composeRestOffset,
  sampleActorPose,
  sampleActorRootMotion,
  getLiveActorPose,
  liveEditAppliesAt,
  poseSourceOf,
  samePoseSource,
} from '../../services/somaSkeleton';

export interface ActorRigPosingPanelProps {
  actor: CharacterActor;
  currentTimelineTime: number;
  onUpdateActor: (updatedActor: CharacterActor) => void;
  onJumpToTime?: (time: number) => void;
  /** Editing works on a still frame, so entering editing mode pauses playback. */
  onPause?: () => void;
  /** Regenerate this actor's motion with its constraints (the last step of the Kimodo workflow). */
  onRegenerate?: () => void;
  isGenerating?: boolean;
}

export interface PosePreset {
  id: string;
  name: string;
  icon: string;
  category: string;
  description: string;
  /**
   * Quaternion OFFSETS from each bone's rest orientation, not absolute local
   * rotations. Applying these as absolute values discarded the rest pose baked
   * into the skeleton, which threw limbs to arbitrary angles.
   */
  boneRotations: Record<number, [number, number, number, number]>;
}

export const POSE_PRESETS: Record<string, PosePreset> = {
  t_pose: {
    id: 't_pose',
    name: 'Rest Pose',
    icon: 'accessibility_new',
    category: 'Standard',
    description: 'Clears all limb rotations back to the rig rest pose',
    boneRotations: {
      [SOMA.leftShoulder]: [0, 0, 0, 1],
      [SOMA.leftArm]: [0, 0, 0, 1],
      [SOMA.leftForeArm]: [0, 0, 0, 1],
      [SOMA.leftHand]: [0, 0, 0, 1],
      [SOMA.rightShoulder]: [0, 0, 0, 1],
      [SOMA.rightArm]: [0, 0, 0, 1],
      [SOMA.rightForeArm]: [0, 0, 0, 1],
      [SOMA.rightHand]: [0, 0, 0, 1],
      [SOMA.leftLeg]: [0, 0, 0, 1],
      [SOMA.leftShin]: [0, 0, 0, 1],
      [SOMA.leftFoot]: [0, 0, 0, 1],
      [SOMA.rightLeg]: [0, 0, 0, 1],
      [SOMA.rightShin]: [0, 0, 0, 1],
      [SOMA.rightFoot]: [0, 0, 0, 1],
    },
  },
  heroic_idle: {
    id: 'heroic_idle',
    name: 'Heroic Idle',
    icon: 'self_improvement',
    category: 'Standing',
    description: 'Balanced standing pose with relaxed arms',
    boneRotations: {
      [SOMA.leftArm]: [0.05, 0.02, -0.15, 0.98],
      [SOMA.leftForeArm]: [0.1, 0.2, -0.05, 0.97],
      [SOMA.rightArm]: [0.05, -0.02, 0.15, 0.98],
      [SOMA.rightForeArm]: [0.1, -0.2, 0.05, 0.97],
      [SOMA.chest]: [0.02, 0, 0, 0.999],
    },
  },
  crossed_arms: {
    id: 'crossed_arms',
    name: 'Crossed Arms',
    icon: 'front_hand',
    category: 'Upper Body',
    description: 'Confident arms folded across chest',
    boneRotations: {
      [SOMA.leftShoulder]: [0.05, 0.1, -0.1, 0.98],
      [SOMA.leftArm]: [0.3, 0.2, -0.3, 0.88],
      [SOMA.leftForeArm]: [0.1, 0.7, -0.2, 0.68],
      [SOMA.rightShoulder]: [0.05, -0.1, 0.1, 0.98],
      [SOMA.rightArm]: [0.35, -0.2, 0.3, 0.86],
      [SOMA.rightForeArm]: [-0.1, -0.7, 0.2, 0.68],
      [SOMA.chest]: [0.03, 0, 0, 0.999],
    },
  },
  hands_on_hips: {
    id: 'hands_on_hips',
    name: 'Hands On Hips',
    icon: 'pan_tool_alt',
    category: 'Standing',
    description: 'Authoritative stance with palms on waist',
    boneRotations: {
      [SOMA.leftArm]: [-0.15, -0.1, -0.4, 0.89],
      [SOMA.leftForeArm]: [0.05, 0.65, -0.25, 0.71],
      [SOMA.rightArm]: [-0.15, 0.1, 0.4, 0.89],
      [SOMA.rightForeArm]: [-0.05, -0.65, 0.25, 0.71],
      [SOMA.leftLeg]: [0.05, 0, -0.08, 0.99],
      [SOMA.rightLeg]: [0.05, 0, 0.08, 0.99],
    },
  },
  point_forward: {
    id: 'point_forward',
    name: 'Point Forward',
    icon: 'touch_app',
    category: 'Gestures',
    description: 'Right arm fully extended pointing forward',
    boneRotations: {
      [SOMA.rightArm]: [0.65, -0.1, 0.15, 0.73],
      [SOMA.rightForeArm]: [0.0, 0.0, 0.0, 1.0],
      [SOMA.rightHand]: [-0.1, 0.0, 0.0, 0.99],
      [SOMA.leftArm]: [0.05, 0.0, -0.15, 0.98],
      [SOMA.head]: [0.05, 0.1, 0, 0.99],
    },
  },
  wave_hello: {
    id: 'wave_hello',
    name: 'Wave Hello',
    icon: 'waving_hand',
    category: 'Gestures',
    description: 'Right hand raised high in friendly wave',
    boneRotations: {
      [SOMA.rightArm]: [0.75, 0.2, 0.45, 0.43],
      [SOMA.rightForeArm]: [-0.2, -0.3, 0.5, 0.78],
      [SOMA.rightHand]: [0.0, 0.3, 0.0, 0.95],
      [SOMA.head]: [0.05, -0.1, 0, 0.99],
    },
  },
  reach_forward: {
    id: 'reach_forward',
    name: 'Reach Out',
    icon: 'pan_tool',
    category: 'Gestures',
    description: 'Both arms extended reaching forward',
    boneRotations: {
      [SOMA.leftArm]: [0.55, 0.1, -0.15, 0.81],
      [SOMA.leftForeArm]: [0.1, 0.1, 0.0, 0.99],
      [SOMA.rightArm]: [0.55, -0.1, 0.15, 0.81],
      [SOMA.rightForeArm]: [0.1, -0.1, 0.0, 0.99],
    },
  },
  martial_guard: {
    id: 'martial_guard',
    name: 'Martial Stance',
    icon: 'sports_martial_arts',
    category: 'Action',
    description: 'Defensive combat stance with raised fists',
    boneRotations: {
      [SOMA.leftArm]: [0.55, 0.15, -0.25, 0.77],
      [SOMA.leftForeArm]: [0.15, 0.85, -0.1, 0.48],
      [SOMA.rightArm]: [0.55, -0.15, 0.25, 0.77],
      [SOMA.rightForeArm]: [-0.15, -0.85, 0.1, 0.48],
      [SOMA.leftLeg]: [0.25, 0.1, -0.1, 0.95],
      [SOMA.leftShin]: [-0.4, 0, 0, 0.91],
      [SOMA.rightLeg]: [-0.2, -0.1, 0.1, 0.97],
      [SOMA.rightShin]: [-0.3, 0, 0, 0.95],
    },
  },
  deep_crouch: {
    id: 'deep_crouch',
    name: 'Crouch Stance',
    icon: 'downhill_skiing',
    category: 'Action',
    description: 'Low center of gravity crouching posture',
    boneRotations: {
      [SOMA.leftLeg]: [-0.7, 0, 0, 0.71],
      [SOMA.leftShin]: [1.1, 0, 0, 0.45],
      [SOMA.leftFoot]: [-0.4, 0, 0, 0.91],
      [SOMA.rightLeg]: [-0.7, 0, 0, 0.71],
      [SOMA.rightShin]: [1.1, 0, 0, 0.45],
      [SOMA.rightFoot]: [-0.4, 0, 0, 0.91],
      [SOMA.spine1]: [0.3, 0, 0, 0.95],
      [SOMA.chest]: [0.2, 0, 0, 0.97],
    },
  },
};

export const MAJOR_BONES = [
  { index: SOMA.head, name: 'Head', icon: 'face', group: 'Head & Neck' },
  { index: SOMA.neck1, name: 'Neck', icon: 'account_box', group: 'Head & Neck' },
  { index: SOMA.chest, name: 'Chest', icon: 'shield', group: 'Torso' },
  { index: SOMA.spine1, name: 'Spine', icon: 'view_agenda', group: 'Torso' },
  { index: SOMA.hips, name: 'Pelvis (Root)', icon: 'crop_square', group: 'Torso' },
  { index: SOMA.leftShoulder, name: 'L Shoulder', icon: 'accessibility', group: 'Left Arm' },
  { index: SOMA.leftArm, name: 'L Upper Arm', icon: 'sports_handball', group: 'Left Arm' },
  { index: SOMA.leftForeArm, name: 'L Forearm', icon: 'fitness_center', group: 'Left Arm' },
  { index: SOMA.leftHand, name: 'L Hand', icon: 'pan_tool', group: 'Left Arm' },
  { index: SOMA.rightShoulder, name: 'R Shoulder', icon: 'accessibility', group: 'Right Arm' },
  { index: SOMA.rightArm, name: 'R Upper Arm', icon: 'sports_handball', group: 'Right Arm' },
  { index: SOMA.rightForeArm, name: 'R Forearm', icon: 'fitness_center', group: 'Right Arm' },
  { index: SOMA.rightHand, name: 'R Hand', icon: 'pan_tool', group: 'Right Arm' },
  { index: SOMA.leftLeg, name: 'L Hip / Thigh', icon: 'roller_skating', group: 'Left Leg' },
  { index: SOMA.leftShin, name: 'L Knee / Shin', icon: 'airline_seat_legroom_reduced', group: 'Left Leg' },
  { index: SOMA.leftFoot, name: 'L Foot / Ankle', icon: 'snowshoeing', group: 'Left Leg' },
  { index: SOMA.rightLeg, name: 'R Hip / Thigh', icon: 'roller_skating', group: 'Right Leg' },
  { index: SOMA.rightShin, name: 'R Knee / Shin', icon: 'airline_seat_legroom_reduced', group: 'Right Leg' },
  { index: SOMA.rightFoot, name: 'R Foot / Ankle', icon: 'snowshoeing', group: 'Right Leg' },
];

export const IK_EFFECTORS: { id: IkEffectorType; name: string; icon: string; color: string }[] = [
  { id: 'hips', name: 'Hip Root (Body COG)', icon: 'crop_square', color: '#ffd60a' },
  { id: 'leftHand', name: 'Left Hand (Wrist IK)', icon: 'pan_tool', color: '#00ffcc' },
  { id: 'rightHand', name: 'Right Hand (Wrist IK)', icon: 'pan_tool', color: '#00ffcc' },
  { id: 'leftFoot', name: 'Left Foot (Ankle IK)', icon: 'snowshoeing', color: '#ff9500' },
  { id: 'rightFoot', name: 'Right Foot (Ankle IK)', icon: 'snowshoeing', color: '#ff9500' },
  { id: 'lookAt', name: 'Look-At Target (Head IK)', icon: 'visibility', color: '#af52de' },
];

export const ActorRigPosingPanel: React.FC<ActorRigPosingPanelProps> = ({
  actor,
  currentTimelineTime,
  onUpdateActor,
  onJumpToTime,
  onPause,
  onRegenerate,
  isGenerating = false,
}) => {
  const [activeTab, setActiveTab] = useState<'rig' | 'presets' | 'keyframes'>('rig');
  const rigMode = actor.activeRigMode || 'off';
  const selectedJoint = actor.selectedJointIndex ?? SOMA.head;
  const selectedEffector = actor.selectedIkEffector || 'rightHand';
  const keyframes = useMemo(() => actor.keyframePoses || [], [actor.keyframePoses]);

  // Check if there is an exact or near keyframe at current time
  const currentKeyframe = useMemo(() => {
    return keyframes.find((k) => Math.abs(k.time - currentTimelineTime) < 0.15);
  }, [keyframes, currentTimelineTime]);

  // ===========================================================================
  // Kimodo editing workflow: enter editing mode on a frame -> pose -> the pose becomes (or updates)
  // a constraint at that frame -> exit editing mode -> regenerate so the motion meets the constraints.
  // ===========================================================================
  const isEditing = rigMode !== 'off';
  const hasMotion = !!(actor.motionData && actor.motionData.rotations && actor.motionData.rotations.length > 0);
  const actorRef = useRef(actor);
  actorRef.current = actor;

  /** Pose shown for the actor right now, if the viewport has drawn the current edit state. */
  const liveHere = () => {
    const a = actorRef.current;
    const live = getLiveActorPose(a.id);
    return live && samePoseSource(live.source, poseSourceOf(a)) && Math.abs(live.time - currentTimelineTime) < 0.02
      ? live
      : null;
  };

  const handleEnterEditing = () => {
    onPause?.();
    onUpdateActor({ ...actor, activeRigMode: 'fk', renderMode: 'hybrid' });
  };

  const hasUnsavedEdit =
    liveEditAppliesAt(actor, currentTimelineTime) &&
    !currentKeyframe &&
    (Object.keys(actor.customBoneRotations || {}).length > 0 || Object.keys(actor.ikTargets || {}).length > 0);

  const handleExitEditing = (thenRegenerate = false) => {
    if (
      hasUnsavedEdit &&
      !window.confirm('This pose edit is not saved as a constraint yet and will be discarded. Exit editing anyway?')
    ) {
      return;
    }
    // Drop the live edit so the viewport shows the generated motion again; constraints hold the edits.
    onUpdateActor({
      ...actor,
      activeRigMode: 'off',
      renderMode: 'mesh',
      customBoneRotations: {},
      ikTargets: undefined,
      customPoseTime: undefined,
    });
    snappedKeyRef.current = null;
    if (thenRegenerate) setTimeout(() => onRegenerate?.(), 0);
  };

  /** Load a constraint's pose into the editor (Kimodo's "Snap to Constraint"). */
  const snapToConstraint = (kf: ActorKeyframePose, extra: Partial<CharacterActor> = {}) => {
    snappedKeyRef.current = `${kf.id}@${kf.time}`;
    onUpdateActor({
      ...actorRef.current,
      customBoneRotations: { ...(kf.boneRotations || {}) },
      ikTargets: kf.ikTargets?.hips ? { hips: kf.ikTargets.hips } : undefined,
      customPoseTime: kf.time,
      // IK handles are re-seeded from the snapped pose when IK is entered again.
      activeRigMode: actorRef.current.activeRigMode === 'ik' ? 'fk' : actorRef.current.activeRigMode,
      ...extra,
    });
  };

  // Landing on a constraint while editing shows the constraint's pose, so edits adjust IT rather
  // than overwriting it with the generated pose at that frame.
  const snappedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isEditing || !currentKeyframe) {
      if (!currentKeyframe) snappedKeyRef.current = null;
      return;
    }
    const tag = `${currentKeyframe.id}@${currentKeyframe.time}`;
    if (snappedKeyRef.current === tag) return;
    snapToConstraint(currentKeyframe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, currentKeyframe?.id, currentKeyframe?.time]);

  // Editing at a frame that has a constraint updates that constraint (as in Kimodo's demo).
  useEffect(() => {
    if (!isEditing || !currentKeyframe) return;
    if (snappedKeyRef.current !== `${currentKeyframe.id}@${currentKeyframe.time}`) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = () => {
      const live = liveHere();
      if (!live) {
        if (tries++ < 10) timer = setTimeout(attempt, 50);
        return;
      }
      const a = actorRef.current;
      const keys = a.keyframePoses || [];
      const key = keys.find((k) => k.id === currentKeyframe.id);
      if (!key) return;
      const same =
        JSON.stringify(key.boneRotations) === JSON.stringify(live.rotations) &&
        JSON.stringify(key.ikTargets?.hips) === JSON.stringify(live.hips);
      if (same) return;
      onUpdateActor({
        ...a,
        keyframePoses: keys.map((k) =>
          k.id === key.id ? { ...k, boneRotations: { ...live.rotations }, ikTargets: { hips: live.hips } } : k
        ),
      });
    };
    timer = setTimeout(attempt, 50);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor.customBoneRotations, actor.ikTargets]);

  /** Add a constraint of this kind at the current frame, using the pose on screen. */
  const handleAddConstraint = (kind: KeyframeConstraintKind) => {
    if (currentKeyframe) {
      const kinds = currentKeyframe.constraintKinds?.length ? currentKeyframe.constraintKinds : ['fullbody'];
      if (kinds.includes(kind)) return;
      handleToggleKind(currentKeyframe.id, kind);
      return;
    }
    handleAddOrUpdateKeyframe([kind]);
  };

  /** Kimodo's "Reset Constraint": put the generated pose back into the constraint at this frame. */
  const handleResetConstraint = () => {
    if (!currentKeyframe) return;
    const base = { ...actor, customBoneRotations: {}, ikTargets: undefined, customPoseTime: undefined };
    const generated = sampleActorPose({ ...base, keyframePoses: hasMotion ? base.keyframePoses : [] }, currentKeyframe.time);
    const updatedKey = { ...currentKeyframe, boneRotations: generated || {}, ikTargets: {} };
    const keys = keyframes.map((k) => (k.id === currentKeyframe.id ? updatedKey : k));
    snapToConstraint(updatedKey, { keyframePoses: keys });
  };

  const handleSetRigMode = (mode: RigMode) => {
    onUpdateActor({
      ...actor,
      activeRigMode: mode,
      renderMode: mode !== 'off' ? 'hybrid' : 'mesh',
    });
  };

  const handleSelectJoint = (index: number) => {
    onUpdateActor({
      ...actor,
      selectedJointIndex: index,
      activeRigMode: 'fk',
    });
  };

  const handleSelectEffector = (eff: IkEffectorType) => {
    onUpdateActor({
      ...actor,
      selectedIkEffector: eff,
      activeRigMode: 'ik',
    });
  };

  const handleApplyPreset = (presetKey: keyof typeof POSE_PRESETS) => {
    const preset = POSE_PRESETS[presetKey];
    if (!preset) return;

    const resolved: Record<number, [number, number, number, number]> = {};
    for (const [idxStr, offset] of Object.entries(preset.boneRotations)) {
      const idx = Number(idxStr);
      resolved[idx] = composeRestOffset(idx, offset);
    }

    const editHere = liveEditAppliesAt(actor, currentTimelineTime);
    onUpdateActor({
      ...actor,
      customBoneRotations: {
        // Don't carry an edit made at another time into this pose.
        ...(editHere ? actor.customBoneRotations || {} : {}),
        ...resolved,
      },
      ikTargets: editHere ? actor.ikTargets : undefined,
      customPoseTime: currentTimelineTime,
      activeRigMode: 'fk',
    });
  };

  const handleAddOrUpdateKeyframe = (kinds?: KeyframeConstraintKind[]) => {
    const roundedTime = parseFloat(currentTimelineTime.toFixed(2));

    // Snapshot every joint as currently posed -- generated motion, keyframe
    // blend, plus your edits -- not just the handful of bones touched. A key
    // holding only the edited bones becomes a 'fullbody' constraint whose other
    // 70-odd joints default to REST, which rips the actor out of the animation.
    // Prefer the pose the viewport is showing right now: it includes IK results and the hip offset,
    // which sampling the data misses, so a key made in IK came back looking different.
    const live = getLiveActorPose(actor.id);
    // Only if drawn from this exact actor state and time; otherwise fall back to sampling.
    const liveHere = live && samePoseSource(live.source, poseSourceOf(actor)) && Math.abs(live.time - currentTimelineTime) < 0.02 ? live : null;
    const fullPose = liveHere ? { ...liveHere.rotations } : sampleActorPose(actor, roundedTime);
    // Where the hips actually are in the generated take at this instant, not
    // where the actor is parked in the scene.
    const rootMotion = sampleActorRootMotion(actor, roundedTime);

    const newKey: ActorKeyframePose = {
      id: currentKeyframe ? currentKeyframe.id : `kf_${Date.now()}`,
      time: roundedTime,
      boneRotations: fullPose || (actor.customBoneRotations ? { ...actor.customBoneRotations } : {}),
      // Limb goals are already baked into boneRotations; keep only the hip offset, which rotations
      // can't express (Kimodo reads its height, and key playback blends it).
      ikTargets: liveHere
        ? { hips: liveHere.hips }
        : liveEditAppliesAt(actor, roundedTime) && actor.ikTargets?.hips
        ? { hips: actor.ikTargets.hips }
        : {},
      rootPosition: [...actor.position],
      rootMotion: rootMotion || undefined,
      poseName: `Pose @ ${roundedTime}s`,
      constraintKinds: kinds || currentKeyframe?.constraintKinds || ['fullbody'],
    };

    const updatedKeys = keyframes.filter((k) => k.id !== newKey.id);
    updatedKeys.push(newKey);
    updatedKeys.sort((a, b) => a.time - b.time);

    snappedKeyRef.current = `${newKey.id}@${newKey.time}`;
    onUpdateActor({
      ...actor,
      keyframePoses: updatedKeys,
      customPoseTime: roundedTime,
      // motionData is deliberately kept. The reference workflow is
      // generate -> scrub -> pose -> key -> regenerate, so the take you are
      // keying against has to survive being keyed.
    });
  };

  const handleToggleKind = (id: string, kind: KeyframeConstraintKind) => {
    const updated = keyframes.map((k) => {
      if (k.id !== id) return k;
      const current = k.constraintKinds && k.constraintKinds.length > 0 ? k.constraintKinds : ['fullbody'];
      const next = current.includes(kind)
        ? current.filter((c) => c !== kind)
        : [...current, kind];
      // 'fullbody' already pins every joint, so pairing it with a limb is
      // redundant; picking one clears the other.
      const resolved =
        kind === 'fullbody'
          ? (next.includes('fullbody') ? ['fullbody'] : [])
          : next.filter((c) => c !== 'fullbody');
      return {
        ...k,
        constraintKinds: (resolved.length > 0 ? resolved : ['fullbody']) as KeyframeConstraintKind[],
      };
    });
    onUpdateActor({ ...actor, keyframePoses: updated });
  };

  const handleLoadKeyframe = (kf: ActorKeyframePose) => {
    // Load the key's own pose for editing and pin the edit to its time, so the
    // viewport shows that key rather than whatever was authored most recently.
    onUpdateActor({
      ...actor,
      customBoneRotations: { ...(kf.boneRotations || {}) },
      ikTargets: { ...(kf.ikTargets || {}) },
      customPoseTime: kf.time,
    });
    onJumpToTime?.(kf.time);
  };

  const handleDeleteKeyframe = (id: string) => {
    const updated = keyframes.filter((k) => k.id !== id);
    onUpdateActor({
      ...actor,
      keyframePoses: updated,
    });
  };

  const handleClearAllKeys = () => {
    onUpdateActor({
      ...actor,
      keyframePoses: [],
      customBoneRotations: {},
    });
  };

  const handleResetPose = () => {
    onUpdateActor({
      ...actor,
      customBoneRotations: {},
      ikTargets: {},
    });
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface-container/60 backdrop-blur-md rounded-2xl border border-outline-variant/30 overflow-hidden select-none">
      {/* Top Header & Rig Mode Switcher */}
      <div className="p-3 border-b border-outline-variant/30 flex items-center justify-between gap-2 bg-surface-container-high/40">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-[20px]">accessibility_new</span>
          <div>
            <h3 className="font-heading font-semibold text-xs text-on-surface">3D Rig & Pose Editor</h3>
            <p className="text-[10px] text-on-surface-variant/80 font-mono">
              {actor.name} • t = {currentTimelineTime.toFixed(2)}s
            </p>
          </div>
        </div>

        {/* Editing mode: FK / IK while editing, otherwise a single Enter button */}
        {isEditing ? (
          <div className="flex items-center gap-1">
            <div className="flex bg-surface-container-highest p-0.5 rounded-lg border border-outline-variant/40 text-[11px] font-mono">
              {(['fk', 'ik'] as RigMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => handleSetRigMode(m)}
                  className={`px-2 py-1 rounded-md transition-all flex items-center gap-1 ${
                    rigMode === m ? 'bg-primary text-background font-bold shadow-sm' : 'text-on-surface-variant hover:text-on-surface'
                  }`}
                  title={m === 'fk' ? 'Rotate joints (click a joint on the skeleton)' : 'Drag hand, foot, hip or gaze goals'}
                >
                  <span className="material-symbols-outlined text-[14px]">{m === 'fk' ? 'rotate_right' : 'open_with'}</span>
                  <span>{m.toUpperCase()}</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => handleExitEditing()}
              className="px-2 py-1 rounded-lg border border-outline-variant/40 text-[11px] font-mono text-on-surface-variant hover:text-on-surface"
              title="Exit editing mode"
            >
              Exit
            </button>
          </div>
        ) : (
          <button
            onClick={handleEnterEditing}
            className="px-2.5 py-1.5 rounded-lg bg-primary text-background text-[11px] font-mono font-bold flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-[14px]">edit</span>
            Enter Editing
          </button>
        )}
      </div>

      {/* Sub Tabs */}
      <div className="flex border-b border-outline-variant/30 text-[11px] font-mono bg-surface-container/40">
        <button
          onClick={() => setActiveTab('rig')}
          className={`flex-1 py-2 text-center border-b-2 transition-all flex items-center justify-center gap-1 ${
            activeTab === 'rig'
              ? 'border-primary text-primary font-bold bg-primary/5'
              : 'border-transparent text-on-surface-variant hover:text-on-surface'
          }`}
        >
          <span className="material-symbols-outlined text-[14px]">smart_toy</span>
          <span>{rigMode === 'ik' ? 'IK Effectors' : 'FK Joints'}</span>
        </button>
        <button
          onClick={() => setActiveTab('presets')}
          className={`flex-1 py-2 text-center border-b-2 transition-all flex items-center justify-center gap-1 ${
            activeTab === 'presets'
              ? 'border-primary text-primary font-bold bg-primary/5'
              : 'border-transparent text-on-surface-variant hover:text-on-surface'
          }`}
        >
          <span className="material-symbols-outlined text-[14px]">category</span>
          <span>Pose Library</span>
        </button>
        <button
          onClick={() => setActiveTab('keyframes')}
          className={`flex-1 py-2 text-center border-b-2 transition-all flex items-center justify-center gap-1 ${
            activeTab === 'keyframes'
              ? 'border-primary text-primary font-bold bg-primary/5'
              : 'border-transparent text-on-surface-variant hover:text-on-surface'
          }`}
        >
          <span className="material-symbols-outlined text-[14px]">keyframes</span>
          <span>Keys ({keyframes.length})</span>
        </button>
      </div>

      {/* Main Tab Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar">
        {/* TAB 1: RIG CONTROLS (FK & IK) */}
        {activeTab === 'rig' && (
          <div className="space-y-3">
            {isEditing && (
              <div
                className={`p-2.5 rounded-xl border space-y-2 ${
                  currentKeyframe ? 'bg-primary/10 border-primary/50' : 'bg-surface-container-highest/40 border-outline-variant/30'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-mono font-bold text-on-surface flex items-center gap-1">
                    <span className="material-symbols-outlined text-[15px] text-primary">
                      {currentKeyframe ? 'diamond' : 'add_diamond'}
                    </span>
                    {currentKeyframe
                      ? `Constraint @ ${currentKeyframe.time.toFixed(2)}s`
                      : `No constraint @ ${currentTimelineTime.toFixed(2)}s`}
                  </span>
                  {currentKeyframe && (
                    <span className="text-[9px] font-mono text-primary">edits save to it</span>
                  )}
                </div>

                <div className="flex flex-wrap gap-1">
                  {KEYFRAME_CONSTRAINT_KINDS.map((k) => {
                    const kinds = currentKeyframe
                      ? currentKeyframe.constraintKinds?.length
                        ? currentKeyframe.constraintKinds
                        : ['fullbody']
                      : [];
                    const active = kinds.includes(k.id);
                    return (
                      <button
                        key={k.id}
                        onClick={() => (currentKeyframe ? handleToggleKind(currentKeyframe.id, k.id) : handleAddConstraint(k.id))}
                        title={
                          currentKeyframe
                            ? `Toggle the ${k.label} constraint on this frame`
                            : `Add a ${k.label} constraint here using the pose on screen`
                        }
                        className={`px-2 py-1 rounded-md text-[10px] font-mono border flex items-center gap-1 transition-all ${
                          active
                            ? 'bg-primary text-background border-primary font-bold'
                            : 'bg-surface-container-highest/60 border-outline-variant/40 text-on-surface hover:border-primary/60'
                        }`}
                      >
                        {!currentKeyframe && <span className="material-symbols-outlined text-[12px]">add</span>}
                        {k.label}
                      </button>
                    );
                  })}
                </div>

                {currentKeyframe ? (
                  <div className="flex gap-1">
                    <button
                      onClick={() => snapToConstraint(currentKeyframe)}
                      className="flex-1 py-1 rounded-md text-[10px] font-mono border border-outline-variant/40 hover:text-primary"
                      title="Show the constraint's pose (e.g. if the generated motion doesn't match it)"
                    >
                      Snap to constraint
                    </button>
                    <button
                      onClick={handleResetConstraint}
                      disabled={!hasMotion}
                      className="flex-1 py-1 rounded-md text-[10px] font-mono border border-outline-variant/40 hover:text-primary disabled:opacity-40"
                      title="Put the generated motion's pose back into this constraint"
                    >
                      Reset to generated
                    </button>
                    <button
                      onClick={() => handleDeleteKeyframe(currentKeyframe.id)}
                      className="px-2 py-1 rounded-md text-[10px] font-mono border border-outline-variant/40 hover:text-error"
                      title="Delete this constraint"
                    >
                      <span className="material-symbols-outlined text-[13px]">delete</span>
                    </button>
                  </div>
                ) : (
                  <p className="text-[10px] text-on-surface-variant/90">
                    Pose the character, then add a constraint above. Scrub to another frame to constrain it too.
                    {hasUnsavedEdit && <span className="text-amber-300"> Unsaved pose edit on this frame.</span>}
                  </p>
                )}
              </div>
            )}

            {!isEditing ? (
              <div className="p-3 rounded-xl bg-surface-container-highest/40 border border-outline-variant/30 space-y-2">
                <p className="text-xs text-on-surface font-medium flex items-center gap-1">
                  <span className="material-symbols-outlined text-primary text-[18px]">tune</span>
                  Edit the motion with constraints
                </p>
                <ol className="text-[11px] text-on-surface-variant list-decimal pl-4 space-y-0.5">
                  <li>{hasMotion ? 'Scrub to the frame you want to change.' : 'Generate a base motion first (optional), then scrub to a frame.'}</li>
                  <li>
                    <span className="font-bold text-primary">Enter Editing</span>: the skeleton appears. Click a joint to rotate
                    it (FK) or drag hand/foot goals (IK).
                  </li>
                  <li>Add a Full Body / hand / foot constraint at that frame. Repeat on other frames.</li>
                  <li>
                    <span className="font-bold text-primary">Exit &amp; Regenerate</span>: Kimodo makes a new motion that meets the
                    constraints.
                  </li>
                </ol>
              </div>
                        ) : rigMode === 'ik' ? (
              /* IK Effector Picker */
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-mono text-on-surface-variant uppercase tracking-wider">
                    Select IK Target Effector:
                  </span>
                  <span className="text-[10px] font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                    Two-Bone Analytical IK
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-1.5">
                  {IK_EFFECTORS.map((eff) => (
                    <button
                      key={eff.id}
                      onClick={() => handleSelectEffector(eff.id)}
                      className={`p-2 rounded-xl text-left font-mono text-xs flex items-center justify-between border transition-all ${
                        selectedEffector === eff.id
                          ? 'bg-primary/15 border-primary text-primary font-bold shadow-sm'
                          : 'bg-surface-container-highest/50 border-outline-variant/30 text-on-surface hover:bg-surface-container-highest'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-[16px] text-primary">{eff.icon}</span>
                        <span>{eff.name}</span>
                      </div>
                      {selectedEffector === eff.id && (
                        <span className="material-symbols-outlined text-primary text-[14px]">check_circle</span>
                      )}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-on-surface-variant/80 italic pt-1">
                  Drag the 3D translation gizmo on the viewport effector to flex the limbs realistically.
                  The <span className="font-bold text-[#ffd60a] not-italic">Hip Root</span> ring moves the whole
                  body while the hands and feet stay planted &mdash; drop it to crouch, slide it to shift weight.
                  To rotate the pelvis instead, switch to <span className="font-bold text-primary not-italic">FK</span>{' '}
                  and pick <span className="font-mono not-italic">Pelvis (Root)</span>.
                </p>
              </div>
            ) : (
              /* FK Bone Joint Picker */
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-mono text-on-surface-variant uppercase tracking-wider">
                    Select Bone to Rotate:
                  </span>
                  <span className="text-[10px] font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                    SOMA 77-Bone Skeleton
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {MAJOR_BONES.map((b) => (
                    <button
                      key={b.index}
                      onClick={() => handleSelectJoint(b.index)}
                      className={`p-2 rounded-xl text-left font-mono text-[11px] flex items-center justify-between border transition-all ${
                        selectedJoint === b.index
                          ? 'bg-primary/15 border-primary text-primary font-bold shadow-sm'
                          : 'bg-surface-container-highest/40 border-outline-variant/30 text-on-surface hover:bg-surface-container-highest'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 truncate">
                        <span className="material-symbols-outlined text-[14px] text-primary">{b.icon}</span>
                        <span className="truncate">{b.name}</span>
                      </div>
                      <span className="text-[9px] text-on-surface-variant/60 font-mono">#{b.index}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: POSE PRESETS */}
        {activeTab === 'presets' && (
          <div className="space-y-2">
            <span className="text-[11px] font-mono text-on-surface-variant uppercase tracking-wider">
              Quick Humanoid Poses:
            </span>
            <div className="grid grid-cols-1 gap-2">
              {Object.entries(POSE_PRESETS).map(([key, p]) => (
                <button
                  key={key}
                  onClick={() => handleApplyPreset(key as keyof typeof POSE_PRESETS)}
                  className="p-2.5 rounded-xl bg-surface-container-highest/40 hover:bg-surface-container-highest border border-outline-variant/30 hover:border-primary/50 text-left flex items-center justify-between group transition-all"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary group-hover:scale-105 transition-transform">
                      <span className="material-symbols-outlined text-[18px]">{p.icon}</span>
                    </div>
                    <div>
                      <h4 className="text-xs font-heading font-semibold text-on-surface group-hover:text-primary transition-colors">
                        {p.name}
                      </h4>
                      <p className="text-[10px] text-on-surface-variant">{p.description}</p>
                    </div>
                  </div>
                  <span className="material-symbols-outlined text-[16px] text-on-surface-variant group-hover:text-primary transition-colors">
                    play_arrow
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* TAB 3: KEYFRAME TIMELINE TRACK */}
        {activeTab === 'keyframes' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono text-on-surface-variant uppercase tracking-wider">
                Timeline Pose Keys:
              </span>
              {keyframes.length > 0 && (
                <button
                  onClick={handleClearAllKeys}
                  className="text-[10px] font-mono text-error hover:underline flex items-center gap-0.5"
                >
                  <span className="material-symbols-outlined text-[12px]">delete_sweep</span>
                  <span>Clear All</span>
                </button>
              )}
            </div>

            {keyframes.length === 0 ? (
              <div className="p-4 rounded-xl bg-surface-container-highest/30 border border-outline-variant/30 text-center space-y-1">
                <span className="material-symbols-outlined text-on-surface-variant text-[24px]">timer</span>
                <p className="text-xs text-on-surface font-medium">No Keyframe Poses on Timeline</p>
                <p className="text-[10px] text-on-surface-variant">
                  Pose the character and click <span className="font-bold text-primary">"+ Set Keyframe"</span> below to
                  place a key on the timeline!
                </p>
              </div>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto custom-scrollbar">
                {keyframes.map((kf, i) => {
                  const isCurrent = Math.abs(kf.time - currentTimelineTime) < 0.15;
                  return (
                    <div
                      key={kf.id}
                      className={`p-2 rounded-xl flex flex-col gap-1 border text-xs font-mono transition-all ${
                        isCurrent
                          ? 'bg-primary/15 border-primary text-primary font-bold shadow-sm'
                          : 'bg-surface-container-highest/40 border-outline-variant/30 text-on-surface hover:bg-surface-container-highest'
                      }`}
                    >
                      <div className="flex items-center justify-between w-full">
                      <button
                        onClick={() => handleLoadKeyframe(kf)}
                        className="flex items-center gap-2 flex-1 text-left"
                      >
                        <span className="material-symbols-outlined text-primary text-[14px]">diamond</span>
                        <span>Key #{i + 1}</span>
                        <span className="text-[10px] text-on-surface-variant bg-surface-container-highest px-1.5 py-0.5 rounded">
                          {kf.time.toFixed(2)}s
                        </span>
                      </button>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleLoadKeyframe(kf)}
                          className="p-1 text-on-surface-variant hover:text-primary transition-colors"
                          title="Jump to keyframe"
                        >
                          <span className="material-symbols-outlined text-[14px]">directions_run</span>
                        </button>
                        <button
                          onClick={() => handleDeleteKeyframe(kf.id)}
                          className="p-1 text-on-surface-variant hover:text-error transition-colors"
                          title="Delete keyframe"
                        >
                          <span className="material-symbols-outlined text-[14px]">close</span>
                        </button>
                      </div>
                      </div>

                    {/* Which Kimodo constraint this key sends */}
                    <div className="flex flex-wrap items-center gap-1 pl-1 pb-1">
                      <span className="text-[9px] font-mono text-on-surface-variant/70 uppercase tracking-wider pr-0.5">
                        Pins:
                      </span>
                      {KEYFRAME_CONSTRAINT_KINDS.map((k) => {
                        const active = (kf.constraintKinds || ['fullbody']).includes(k.id);
                        return (
                          <button
                            key={k.id}
                            onClick={() => handleToggleKind(kf.id, k.id)}
                            title={
                              k.id === 'fullbody'
                                ? 'Constrain every joint at this frame (Kimodo "fullbody")'
                                : `Constrain only the ${k.label} and hips, leaving the rest of the body free (Kimodo "${k.id}")`
                            }
                            className={`px-1.5 py-[1px] rounded-md text-[9px] font-mono border transition-all ${
                              active
                                ? 'bg-primary/20 border-primary/60 text-primary font-bold'
                                : 'bg-surface-container-highest/40 border-outline-variant/30 text-on-surface-variant hover:text-on-surface'
                            }`}
                          >
                            {k.label}
                          </button>
                        );
                      })}
                    </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom bar: editing workflow actions */}
      <div className="p-3 border-t border-outline-variant/30 bg-surface-container-high/40 flex items-center justify-between gap-2">
        {isEditing ? (
          <>
            <button
              onClick={handleResetPose}
              className="px-3 py-2 rounded-xl border border-outline-variant/40 hover:bg-surface-container-highest text-on-surface font-mono text-xs flex items-center gap-1 transition-all"
              title="Clear pose edits on this frame"
            >
              <span className="material-symbols-outlined text-[14px]">restart_alt</span>
              <span>Reset</span>
            </button>
            <button
              onClick={() => handleExitEditing(!!onRegenerate && keyframes.length > 0)}
              disabled={isGenerating}
              className="flex-1 py-2 px-3 rounded-xl bg-primary hover:bg-primary/90 text-background font-mono text-xs font-bold shadow-lg shadow-primary/20 flex items-center justify-center gap-1.5 transition-all disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[16px]">
                {onRegenerate && keyframes.length > 0 ? 'auto_awesome' : 'logout'}
              </span>
              <span>
                {onRegenerate && keyframes.length > 0
                  ? `Exit & Regenerate (${keyframes.length} constraint${keyframes.length === 1 ? '' : 's'})`
                  : 'Exit Editing'}
              </span>
            </button>
          </>
        ) : (
          <>
            <button
              onClick={handleEnterEditing}
              className="px-3 py-2 rounded-xl border border-primary/60 text-primary font-mono text-xs font-bold flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-[14px]">edit</span>
              Enter Editing
            </button>
            {onRegenerate && keyframes.length > 0 && (
              <button
                onClick={onRegenerate}
                disabled={isGenerating}
                className="flex-1 py-2 px-3 rounded-xl bg-primary hover:bg-primary/90 text-background font-mono text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
                {isGenerating ? 'Generating…' : `Regenerate (${keyframes.length})`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};
