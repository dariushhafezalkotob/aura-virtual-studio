import React, { useState, useMemo } from 'react';
import { CharacterActor, ActorKeyframePose, RigMode, IkEffectorType } from '../../types';

export interface ActorRigPosingPanelProps {
  actor: CharacterActor;
  currentTimelineTime: number;
  onUpdateActor: (updatedActor: CharacterActor) => void;
  onJumpToTime?: (time: number) => void;
}

export interface PosePreset {
  id: string;
  name: string;
  icon: string;
  category: string;
  description: string;
  boneRotations: Record<number, [number, number, number, number]>;
}

export const POSE_PRESETS: Record<string, PosePreset> = {
  t_pose: {
    id: 't_pose',
    name: 'T-Pose',
    icon: 'accessibility_new',
    category: 'Standard',
    description: 'Neutral calibration reference pose',
    boneRotations: {
      11: [0, 0, 0, 1],
      12: [0, 0, 0, 1],
      13: [0, 0, 0, 1],
      14: [0, 0, 0, 1],
      39: [0, 0, 0, 1],
      40: [0, 0, 0, 1],
      41: [0, 0, 0, 1],
      42: [0, 0, 0, 1],
      66: [0, 0, 0, 1],
      67: [0, 0, 0, 1],
      68: [0, 0, 0, 1],
      71: [0, 0, 0, 1],
      72: [0, 0, 0, 1],
      73: [0, 0, 0, 1],
    },
  },
  heroic_idle: {
    id: 'heroic_idle',
    name: 'Heroic Idle',
    icon: 'self_improvement',
    category: 'Standing',
    description: 'Balanced standing pose with relaxed arms',
    boneRotations: {
      12: [0.05, 0.02, -0.15, 0.98],
      13: [0.1, 0.2, -0.05, 0.97],
      40: [0.05, -0.02, 0.15, 0.98],
      41: [0.1, -0.2, 0.05, 0.97],
      3: [0.02, 0, 0, 0.999],
    },
  },
  crossed_arms: {
    id: 'crossed_arms',
    name: 'Crossed Arms',
    icon: 'front_hand',
    category: 'Upper Body',
    description: 'Confident arms folded across chest',
    boneRotations: {
      11: [0.05, 0.1, -0.1, 0.98],
      12: [0.3, 0.2, -0.3, 0.88],
      13: [0.1, 0.7, -0.2, 0.68],
      39: [0.05, -0.1, 0.1, 0.98],
      40: [0.35, -0.2, 0.3, 0.86],
      41: [-0.1, -0.7, 0.2, 0.68],
      3: [0.03, 0, 0, 0.999],
    },
  },
  hands_on_hips: {
    id: 'hands_on_hips',
    name: 'Hands On Hips',
    icon: 'pan_tool_alt',
    category: 'Standing',
    description: 'Authoritative stance with palms on waist',
    boneRotations: {
      12: [-0.15, -0.1, -0.4, 0.89],
      13: [0.05, 0.65, -0.25, 0.71],
      40: [-0.15, 0.1, 0.4, 0.89],
      41: [-0.05, -0.65, 0.25, 0.71],
      66: [0.05, 0, -0.08, 0.99],
      71: [0.05, 0, 0.08, 0.99],
    },
  },
  point_forward: {
    id: 'point_forward',
    name: 'Point Forward',
    icon: 'touch_app',
    category: 'Gestures',
    description: 'Right arm fully extended pointing forward',
    boneRotations: {
      40: [0.65, -0.1, 0.15, 0.73],
      41: [0.0, 0.0, 0.0, 1.0],
      42: [-0.1, 0.0, 0.0, 0.99],
      12: [0.05, 0.0, -0.15, 0.98],
      6: [0.05, 0.1, 0, 0.99],
    },
  },
  wave_hello: {
    id: 'wave_hello',
    name: 'Wave Hello',
    icon: 'waving_hand',
    category: 'Gestures',
    description: 'Right hand raised high in friendly wave',
    boneRotations: {
      40: [0.75, 0.2, 0.45, 0.43],
      41: [-0.2, -0.3, 0.5, 0.78],
      42: [0.0, 0.3, 0.0, 0.95],
      6: [0.05, -0.1, 0, 0.99],
    },
  },
  reach_forward: {
    id: 'reach_forward',
    name: 'Reach Out',
    icon: 'pan_tool',
    category: 'Gestures',
    description: 'Both arms extended reaching forward',
    boneRotations: {
      12: [0.55, 0.1, -0.15, 0.81],
      13: [0.1, 0.1, 0.0, 0.99],
      40: [0.55, -0.1, 0.15, 0.81],
      41: [0.1, -0.1, 0.0, 0.99],
    },
  },
  martial_guard: {
    id: 'martial_guard',
    name: 'Martial Stance',
    icon: 'sports_martial_arts',
    category: 'Action',
    description: 'Defensive combat stance with raised fists',
    boneRotations: {
      12: [0.55, 0.15, -0.25, 0.77],
      13: [0.15, 0.85, -0.1, 0.48],
      40: [0.55, -0.15, 0.25, 0.77],
      41: [-0.15, -0.85, 0.1, 0.48],
      66: [0.25, 0.1, -0.1, 0.95],
      67: [-0.4, 0, 0, 0.91],
      71: [-0.2, -0.1, 0.1, 0.97],
      72: [-0.3, 0, 0, 0.95],
    },
  },
  deep_crouch: {
    id: 'deep_crouch',
    name: 'Crouch Stance',
    icon: 'downhill_skiing',
    category: 'Action',
    description: 'Low center of gravity crouching posture',
    boneRotations: {
      66: [-0.7, 0, 0, 0.71],
      67: [1.1, 0, 0, 0.45],
      68: [-0.4, 0, 0, 0.91],
      71: [-0.7, 0, 0, 0.71],
      72: [1.1, 0, 0, 0.45],
      73: [-0.4, 0, 0, 0.91],
      1: [0.3, 0, 0, 0.95],
      3: [0.2, 0, 0, 0.97],
    },
  },
};

export const MAJOR_BONES = [
  { index: 6, name: 'Head', icon: 'face', group: 'Head & Neck' },
  { index: 4, name: 'Neck', icon: 'account_box', group: 'Head & Neck' },
  { index: 3, name: 'Chest', icon: 'shield', group: 'Torso' },
  { index: 1, name: 'Spine', icon: 'view_agenda', group: 'Torso' },
  { index: 0, name: 'Pelvis (Root)', icon: 'crop_square', group: 'Torso' },
  { index: 11, name: 'L Shoulder', icon: 'accessibility', group: 'Left Arm' },
  { index: 12, name: 'L Upper Arm', icon: 'sports_handball', group: 'Left Arm' },
  { index: 13, name: 'L Forearm', icon: 'fitness_center', group: 'Left Arm' },
  { index: 14, name: 'L Hand', icon: 'pan_tool', group: 'Left Arm' },
  { index: 39, name: 'R Shoulder', icon: 'accessibility', group: 'Right Arm' },
  { index: 40, name: 'R Upper Arm', icon: 'sports_handball', group: 'Right Arm' },
  { index: 41, name: 'R Forearm', icon: 'fitness_center', group: 'Right Arm' },
  { index: 42, name: 'R Hand', icon: 'pan_tool', group: 'Right Arm' },
  { index: 66, name: 'L Hip / Thigh', icon: 'roller_skating', group: 'Left Leg' },
  { index: 67, name: 'L Knee / Shin', icon: 'airline_seat_legroom_reduced', group: 'Left Leg' },
  { index: 68, name: 'L Foot / Ankle', icon: 'snowshoeing', group: 'Left Leg' },
  { index: 71, name: 'R Hip / Thigh', icon: 'roller_skating', group: 'Right Leg' },
  { index: 72, name: 'R Knee / Shin', icon: 'airline_seat_legroom_reduced', group: 'Right Leg' },
  { index: 73, name: 'R Foot / Ankle', icon: 'snowshoeing', group: 'Right Leg' },
];

export const IK_EFFECTORS: { id: IkEffectorType; name: string; icon: string; color: string }[] = [
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
}) => {
  const [activeTab, setActiveTab] = useState<'rig' | 'presets' | 'keyframes'>('rig');
  const rigMode = actor.activeRigMode || 'off';
  const selectedJoint = actor.selectedJointIndex ?? 6;
  const selectedEffector = actor.selectedIkEffector || 'rightHand';
  const keyframes = useMemo(() => actor.keyframePoses || [], [actor.keyframePoses]);

  // Check if there is an exact or near keyframe at current time
  const currentKeyframe = useMemo(() => {
    return keyframes.find((k) => Math.abs(k.time - currentTimelineTime) < 0.15);
  }, [keyframes, currentTimelineTime]);

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

    onUpdateActor({
      ...actor,
      customBoneRotations: {
        ...(actor.customBoneRotations || {}),
        ...preset.boneRotations,
      },
      activeRigMode: 'fk',
    });
  };

  const handleAddOrUpdateKeyframe = () => {
    const roundedTime = parseFloat(currentTimelineTime.toFixed(2));
    const newKey: ActorKeyframePose = {
      id: currentKeyframe ? currentKeyframe.id : `kf_${Date.now()}`,
      time: roundedTime,
      boneRotations: actor.customBoneRotations ? { ...actor.customBoneRotations } : {},
      ikTargets: actor.ikTargets ? { ...actor.ikTargets } : {},
      rootPosition: [...actor.position],
      poseName: `Pose @ ${roundedTime}s`,
    };

    const updatedKeys = keyframes.filter((k) => k.id !== newKey.id);
    updatedKeys.push(newKey);
    updatedKeys.sort((a, b) => a.time - b.time);

    onUpdateActor({
      ...actor,
      keyframePoses: updatedKeys,
    });
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
    <div className="flex flex-col h-full bg-surface-container/60 backdrop-blur-md rounded-2xl border border-outline-variant/30 overflow-hidden select-none">
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

        {/* Mode Selector */}
        <div className="flex bg-surface-container-highest p-0.5 rounded-lg border border-outline-variant/40 text-[11px] font-mono">
          <button
            onClick={() => handleSetRigMode('fk')}
            className={`px-2 py-1 rounded-md transition-all flex items-center gap-1 ${
              rigMode === 'fk'
                ? 'bg-primary text-background font-bold shadow-sm'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
            title="Forward Kinematics: Rotate individual bones directly"
          >
            <span className="material-symbols-outlined text-[14px]">rotate_right</span>
            <span>FK</span>
          </button>
          <button
            onClick={() => handleSetRigMode('ik')}
            className={`px-2 py-1 rounded-md transition-all flex items-center gap-1 ${
              rigMode === 'ik'
                ? 'bg-primary text-background font-bold shadow-sm'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
            title="Inverse Kinematics: Drag hand, foot, or look-at targets"
          >
            <span className="material-symbols-outlined text-[14px]">open_with</span>
            <span>IK</span>
          </button>
          <button
            onClick={() => handleSetRigMode('off')}
            className={`px-2 py-1 rounded-md transition-all flex items-center gap-1 ${
              rigMode === 'off'
                ? 'bg-surface-variant text-on-surface font-semibold'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
            title="Disable gizmos and view motion animation"
          >
            <span>Off</span>
          </button>
        </div>
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
            {rigMode === 'off' ? (
              <div className="p-4 rounded-xl bg-surface-container-highest/40 border border-outline-variant/30 text-center space-y-2">
                <span className="material-symbols-outlined text-primary text-[28px]">info</span>
                <p className="text-xs text-on-surface font-medium">Rigging Gizmos are currently Off</p>
                <p className="text-[11px] text-on-surface-variant">
                  Select <span className="font-bold text-primary">FK</span> to rotate bone joints or{' '}
                  <span className="font-bold text-primary">IK</span> to drag hand/foot goals in 3D.
                </p>
                <div className="flex justify-center gap-2 pt-2">
                  <button
                    onClick={() => handleSetRigMode('fk')}
                    className="px-3 py-1.5 rounded-lg bg-primary text-background font-mono text-xs font-bold shadow-md hover:bg-primary/90 transition-all"
                  >
                    Enable FK Mode
                  </button>
                  <button
                    onClick={() => handleSetRigMode('ik')}
                    className="px-3 py-1.5 rounded-lg bg-surface-container-highest text-on-surface font-mono text-xs font-bold border border-outline-variant/40 hover:bg-surface-variant transition-all"
                  >
                    Enable IK Mode
                  </button>
                </div>
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
                      className={`p-2 rounded-xl flex items-center justify-between border text-xs font-mono transition-all ${
                        isCurrent
                          ? 'bg-primary/15 border-primary text-primary font-bold shadow-sm'
                          : 'bg-surface-container-highest/40 border-outline-variant/30 text-on-surface hover:bg-surface-container-highest'
                      }`}
                    >
                      <button
                        onClick={() => onJumpToTime?.(kf.time)}
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
                          onClick={() => onJumpToTime?.(kf.time)}
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
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Sticky Action Bar: Set Keyframe & Reset */}
      <div className="p-3 border-t border-outline-variant/30 bg-surface-container-high/40 flex items-center justify-between gap-2">
        <button
          onClick={handleResetPose}
          className="px-3 py-2 rounded-xl border border-outline-variant/40 hover:bg-surface-container-highest text-on-surface font-mono text-xs flex items-center gap-1 transition-all"
          title="Reset bone rotations to neutral rest pose"
        >
          <span className="material-symbols-outlined text-[14px]">restart_alt</span>
          <span>Reset</span>
        </button>

        <button
          onClick={handleAddOrUpdateKeyframe}
          className="flex-1 py-2 px-3 rounded-xl bg-primary hover:bg-primary/90 text-background font-mono text-xs font-bold shadow-lg shadow-primary/20 flex items-center justify-center gap-1.5 transition-all"
        >
          <span className="material-symbols-outlined text-[16px]">
            {currentKeyframe ? 'sync' : 'add_circle'}
          </span>
          <span>
            {currentKeyframe
              ? `Update Key @ ${currentTimelineTime.toFixed(2)}s`
              : `+ Set Key @ ${currentTimelineTime.toFixed(2)}s`}
          </span>
        </button>
      </div>
    </div>
  );
};
