import React, { useState } from 'react';
import {
  CharacterActor,
  ActorConstraint,
  ConstraintType,
  LookAtTargetType,
  UpperBodyPosePreset,
  FacingTargetType,
  FootGroundingMode,
} from '../../types';

interface ActorConstraintsPanelProps {
  actor: CharacterActor;
  allActors: CharacterActor[];
  currentTimelineTime: number;
  maxDuration: number;
  onUpdateConstraints: (constraints: ActorConstraint[]) => void;
  onClose?: () => void;
  isGenerating?: boolean;
  onGenerateWithConstraint?: (prompt: string, constraints: ActorConstraint[]) => void;
}

const CONSTRAINT_TYPE_META: Record<
  ConstraintType,
  { name: string; icon: string; color: string; desc: string }
> = {
  look_at: {
    name: 'Look-At Target',
    icon: 'visibility',
    color: '#00ffcc',
    desc: 'Neck & head bones track camera, another actor, or 3D point',
  },
  upper_body_lock: {
    name: 'Upper-Body Lock',
    icon: 'accessibility_new',
    color: '#ff9500',
    desc: 'Lock arms & torso into pose presets while walking',
  },
  destination: {
    name: 'Target Destination',
    icon: 'pin_drop',
    color: '#af52de',
    desc: 'Steer trajectory to arrive at floor coordinates',
  },
  facing_direction: {
    name: 'Facing Direction',
    icon: 'explore',
    color: '#30b0c7',
    desc: 'Force character yaw heading towards camera or angle',
  },
  foot_grounding: {
    name: 'Foot Grounding',
    icon: 'do_not_step',
    color: '#34c759',
    desc: 'Firm floor clamping to eliminate foot sliding',
  },
  stance_height: {
    name: 'Stance & Height',
    icon: 'height',
    color: '#ff2d55',
    desc: 'Crouch, creep posture, or tall standing clamp',
  },
};

export const ActorConstraintsPanel: React.FC<ActorConstraintsPanelProps> = ({
  actor,
  allActors,
  currentTimelineTime,
  maxDuration,
  onUpdateConstraints,
  onClose,
  isGenerating = false,
  onGenerateWithConstraint,
}) => {
  const constraints = actor.constraints || [];
  const otherActors = allActors.filter((a) => a.id !== actor.id);
  const [showAddMenu, setShowAddMenu] = useState<boolean>(false);

  // Helper to update a single constraint
  const handleUpdate = (updatedItem: ActorConstraint) => {
    const updated = constraints.map((c) => (c.id === updatedItem.id ? updatedItem : c));
    onUpdateConstraints(updated);
  };

  // Helper to remove a constraint
  const handleRemove = (id: string) => {
    const updated = constraints.filter((c) => c.id !== id);
    onUpdateConstraints(updated);
  };

  // Add new constraint of selected type
  const handleAddConstraint = (type: ConstraintType) => {
    const newId = `c_${type}_${Date.now()}`;
    const baseDuration = actor.duration || maxDuration || 4.0;
    const meta = CONSTRAINT_TYPE_META[type];

    let newConstraint: ActorConstraint = {
      id: newId,
      name: meta.name,
      type,
      enabled: true,
      startTime: Math.max(0, parseFloat((currentTimelineTime).toFixed(1))),
      endTime: Math.min(baseDuration, parseFloat((currentTimelineTime + 2.0).toFixed(1))),
      weight: 1.0,
    };

    if (type === 'look_at') {
      newConstraint.lookAt = {
        targetType: 'camera',
        targetPoint: [0, 1.6, 3.0],
      };
    } else if (type === 'upper_body_lock') {
      newConstraint.upperBody = {
        preset: 'crossed_arms',
        blendFactor: 1.0,
      };
    } else if (type === 'destination') {
      newConstraint.destination = {
        position: [actor.position[0] + 1.5, 0, actor.position[2] + 1.0],
        arrivalRadius: 0.3,
        prompt: 'walks and carries a heavy bag with him',
      };
    } else if (type === 'facing_direction') {
      newConstraint.facing = {
        targetType: 'camera',
        angleDegrees: 0,
      };
    } else if (type === 'foot_grounding') {
      newConstraint.footGrounding = {
        mode: 'both',
        plantThreshold: 0.05,
      };
    } else if (type === 'stance_height') {
      newConstraint.stance = {
        heightOffset: -0.35, // Default crouch
      };
    }

    onUpdateConstraints([...constraints, newConstraint]);
    setShowAddMenu(false);
  };

  // Preset Scenario Loaders
  const handleApplyScenario = (scenarioName: string) => {
    const dur = actor.duration || maxDuration || 4.0;

    if (scenarioName === 'dialogue') {
      // Scenario A: Dialogue & Eye Contact
      const lookAt: ActorConstraint = {
        id: `c_dialogue_look_${Date.now()}`,
        name: 'Eye Contact (Camera)',
        type: 'look_at',
        enabled: true,
        startTime: 0.5,
        endTime: dur,
        weight: 0.9,
        lookAt: { targetType: 'camera' },
      };
      const upperBody: ActorConstraint = {
        id: `c_dialogue_pose_${Date.now() + 1}`,
        name: 'Hands on Hips Stance',
        type: 'upper_body_lock',
        enabled: true,
        startTime: 1.0,
        endTime: dur,
        weight: 0.8,
        upperBody: { preset: 'hands_on_hips' },
      };
      const facing: ActorConstraint = {
        id: `c_dialogue_face_${Date.now() + 2}`,
        name: 'Face Camera',
        type: 'facing_direction',
        enabled: true,
        startTime: 0.8,
        endTime: dur,
        weight: 0.75,
        facing: { targetType: 'camera' },
      };
      onUpdateConstraints([...constraints, lookAt, upperBody, facing]);
    } else if (scenarioName === 'waypoint_pose') {
      // Scenario B: Waypoint Arrival & Salute
      const dest: ActorConstraint = {
        id: `c_dest_${Date.now()}`,
        name: 'Walk to Key Waypoint',
        type: 'destination',
        enabled: true,
        startTime: 0.0,
        endTime: Math.min(2.5, dur * 0.6),
        weight: 1.0,
        destination: {
          position: [actor.position[0] + 2.0, 0, actor.position[2] - 1.5],
          prompt: 'walks purposefully to waypoint',
        },
      };
      const crossed: ActorConstraint = {
        id: `c_crossed_${Date.now() + 1}`,
        name: 'Fold Arms at Mark',
        type: 'upper_body_lock',
        enabled: true,
        startTime: Math.min(2.2, dur * 0.55),
        endTime: dur,
        weight: 0.85,
        upperBody: { preset: 'crossed_arms' },
      };
      const look: ActorConstraint = {
        id: `c_look_${Date.now() + 2}`,
        name: 'Look at Audience',
        type: 'look_at',
        enabled: true,
        startTime: Math.min(2.0, dur * 0.5),
        endTime: dur,
        weight: 0.9,
        lookAt: { targetType: 'camera' },
      };
      onUpdateConstraints([...constraints, dest, crossed, look]);
    } else if (scenarioName === 'stealth') {
      // Scenario C: Stealth Infiltration
      const crouch: ActorConstraint = {
        id: `c_crouch_${Date.now()}`,
        name: 'Low Creep Crouch',
        type: 'stance_height',
        enabled: true,
        startTime: 0.0,
        endTime: dur,
        weight: 1.0,
        stance: { heightOffset: -0.38 },
      };
      const grip: ActorConstraint = {
        id: `c_grip_${Date.now() + 1}`,
        name: 'Two-Hand Defensive Hold',
        type: 'upper_body_lock',
        enabled: true,
        startTime: 0.0,
        endTime: dur,
        weight: 0.85,
        upperBody: { preset: 'holding_prop' },
      };
      onUpdateConstraints([...constraints, crouch, grip]);
    } else if (scenarioName === 'two_actor' && otherActors.length > 0) {
      // Scenario D: Face & Track Other Actor
      const target = otherActors[0];
      const lookActor: ActorConstraint = {
        id: `c_actor_look_${Date.now()}`,
        name: `Track ${target.name}`,
        type: 'look_at',
        enabled: true,
        startTime: 0.0,
        endTime: dur,
        weight: 0.85,
        lookAt: { targetType: 'actor', targetActorId: target.id },
      };
      const faceActor: ActorConstraint = {
        id: `c_actor_face_${Date.now() + 1}`,
        name: `Face ${target.name}`,
        type: 'facing_direction',
        enabled: true,
        startTime: 0.0,
        endTime: dur,
        weight: 0.8,
        facing: { targetType: 'actor', targetActorId: target.id },
      };
      onUpdateConstraints([...constraints, lookActor, faceActor]);
    }
  };

  const activeCount = constraints.filter(
    (c) => c.enabled && currentTimelineTime >= c.startTime && currentTimelineTime <= c.endTime
  ).length;

  return (
    <div className="w-96 max-h-[82vh] bg-surface-container/95 border border-outline-variant/40 rounded-2xl backdrop-blur-2xl shadow-2xl flex flex-col overflow-hidden animate-fadeIn z-40 text-on-surface">
      {/* Panel Header */}
      <div className="p-md bg-surface-container-high/60 border-b border-outline-variant/30 flex items-center justify-between">
        <div className="flex items-center gap-sm">
          <div className="w-8 h-8 rounded-xl bg-primary/15 border border-primary/40 flex items-center justify-center text-base">
            {actor.avatar || '🏃'}
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-xs">
              <span className="font-label-caps text-xs font-semibold tracking-wider text-primary">
                ACTOR CONSTRAINTS
              </span>
              <span className="bg-primary/20 text-primary border border-primary/30 text-[10px] px-xs rounded-full font-mono font-medium">
                {activeCount} ACTIVE
              </span>
            </div>
            <span className="text-[11px] text-on-surface-variant truncate max-w-[180px]">
              {actor.name}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-xs">
          {onClose && (
            <button
              onClick={onClose}
              className="p-xs text-on-surface-variant hover:text-primary rounded-lg transition-colors cursor-pointer"
              title="Close Panel"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          )}
        </div>
      </div>

      {/* Mini Timeline Track Visualizer */}
      <div className="px-md py-xs bg-surface-container-lowest/60 border-b border-outline-variant/20 flex flex-col gap-1">
        <div className="flex items-center justify-between text-[10px] font-mono text-on-surface-variant">
          <span>00:00</span>
          <span className="text-primary font-medium">
            TL: 00:{currentTimelineTime.toFixed(1).padStart(4, '0')}s
          </span>
          <span>00:{maxDuration.toFixed(1).padStart(4, '0')}s</span>
        </div>

        {/* Horizontal Mini Timeline Bar */}
        <div className="w-full h-5 bg-surface-container-highest rounded-lg relative overflow-hidden flex flex-col justify-center px-1">
          {/* Active playhead indicator */}
          <div
            className="absolute top-0 bottom-0 w-[2px] bg-primary z-20 shadow-[0_0_8px_rgba(0,255,204,0.8)]"
            style={{
              left: `${Math.min(100, Math.max(0, (currentTimelineTime / maxDuration) * 100))}%`,
            }}
          />

          {/* Constraint spans */}
          {constraints.map((c, i) => {
            const startPct = Math.min(100, Math.max(0, (c.startTime / maxDuration) * 100));
            const endPct = Math.min(100, Math.max(0, (c.endTime / maxDuration) * 100));
            const widthPct = Math.max(2, endPct - startPct);
            const meta = CONSTRAINT_TYPE_META[c.type];
            const isActive =
              c.enabled && currentTimelineTime >= c.startTime && currentTimelineTime <= c.endTime;

            return (
              <div
                key={c.id}
                title={`${c.name} (${c.startTime}s - ${c.endTime}s)`}
                className={`absolute h-2.5 rounded-sm transition-all text-[8px] font-mono text-black font-semibold truncate px-1 flex items-center ${
                  isActive ? 'opacity-100 shadow-md ring-1 ring-white' : 'opacity-40'
                }`}
                style={{
                  left: `${startPct}%`,
                  width: `${widthPct}%`,
                  backgroundColor: meta.color,
                  top: `${(i % 2) * 9 + 2}px`,
                }}
              >
                {c.name}
              </div>
            );
          })}
        </div>
      </div>

      {/* Quick Scenario Presets */}
      <div className="p-sm bg-surface-container-low/40 border-b border-outline-variant/20 flex flex-col gap-xs">
        <span className="font-label-caps text-[10px] text-on-surface-variant uppercase tracking-wider flex items-center gap-xs">
          <span className="material-symbols-outlined text-[13px] text-amber-400">auto_stories</span>
          DIRECTOR SCENARIO PRESETS:
        </span>
        <div className="grid grid-cols-2 gap-xs">
          <button
            onClick={() => handleApplyScenario('dialogue')}
            className="px-xs py-1 bg-surface-container hover:bg-surface-variant border border-outline-variant/30 rounded-lg text-[10px] font-label-caps tracking-wider text-on-surface-variant hover:text-primary transition-all flex items-center gap-1 cursor-pointer"
            title="Look at camera + hands on hips stance"
          >
            <span className="material-symbols-outlined text-[13px] text-primary">record_voice_over</span>
            Dialogue & Eye Contact
          </button>
          <button
            onClick={() => handleApplyScenario('waypoint_pose')}
            className="px-xs py-1 bg-surface-container hover:bg-surface-variant border border-outline-variant/30 rounded-lg text-[10px] font-label-caps tracking-wider text-on-surface-variant hover:text-primary transition-all flex items-center gap-1 cursor-pointer"
            title="Walk to destination + fold arms"
          >
            <span className="material-symbols-outlined text-[13px] text-purple-400">tour</span>
            Waypoint & Pose
          </button>
          <button
            onClick={() => handleApplyScenario('stealth')}
            className="px-xs py-1 bg-surface-container hover:bg-surface-variant border border-outline-variant/30 rounded-lg text-[10px] font-label-caps tracking-wider text-on-surface-variant hover:text-primary transition-all flex items-center gap-1 cursor-pointer"
            title="Low crouch + defensive grip"
          >
            <span className="material-symbols-outlined text-[13px] text-red-400">psychology_alt</span>
            Stealth Crouch
          </button>
          {otherActors.length > 0 && (
            <button
              onClick={() => handleApplyScenario('two_actor')}
              className="px-xs py-1 bg-surface-container hover:bg-surface-variant border border-outline-variant/30 rounded-lg text-[10px] font-label-caps tracking-wider text-on-surface-variant hover:text-primary transition-all flex items-center gap-1 cursor-pointer"
              title="Track and orient towards other actor"
            >
              <span className="material-symbols-outlined text-[13px] text-cyan-400">group</span>
              Actor Face-to-Face
            </button>
          )}
        </div>
      </div>

      {/* Constraints Scrollable Cards List */}
      <div className="flex-1 overflow-y-auto p-md flex flex-col gap-sm max-h-[440px]">
        {constraints.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-lg text-center gap-xs text-on-surface-variant/60">
            <span className="material-symbols-outlined text-[32px] text-outline-variant">
              rule_settings
            </span>
            <span className="text-xs font-label-caps">NO ACTIVE CONSTRAINTS</span>
            <span className="text-[11px] max-w-[200px]">
              Add kinematic constraints to guide head look-at, poses, or waypoints during acting.
            </span>
          </div>
        ) : (
          constraints.map((c) => {
            const meta = CONSTRAINT_TYPE_META[c.type];
            const isCurrentlyActive =
              c.enabled && currentTimelineTime >= c.startTime && currentTimelineTime <= c.endTime;

            return (
              <div
                key={c.id}
                className={`p-sm rounded-xl border transition-all flex flex-col gap-xs ${
                  isCurrentlyActive
                    ? 'bg-surface-container-high border-primary/50 shadow-md'
                    : c.enabled
                    ? 'bg-surface-container-low border-outline-variant/30 opacity-80'
                    : 'bg-surface-container-lowest border-outline-variant/15 opacity-50'
                }`}
              >
                {/* Card Title Bar */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-xs">
                    <span
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: meta.color }}
                    />
                    <span className="font-label-caps text-xs font-semibold text-primary">
                      {c.name}
                    </span>
                    {isCurrentlyActive && (
                      <span className="text-[9px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-1 rounded-sm font-mono font-medium animate-pulse">
                        LIVE
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-xs">
                    {/* Enable / Disable Toggle */}
                    <button
                      onClick={() => handleUpdate({ ...c, enabled: !c.enabled })}
                      title={c.enabled ? 'Disable Constraint' : 'Enable Constraint'}
                      className={`p-[2px] rounded text-[16px] transition-colors cursor-pointer ${
                        c.enabled ? 'text-primary' : 'text-on-surface-variant/40'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[16px]">
                        {c.enabled ? 'check_box' : 'check_box_outline_blank'}
                      </span>
                    </button>

                    {/* Delete */}
                    <button
                      onClick={() => handleRemove(c.id)}
                      title="Remove Constraint"
                      className="p-[2px] text-on-surface-variant hover:text-error rounded cursor-pointer transition-colors"
                    >
                      <span className="material-symbols-outlined text-[16px]">delete</span>
                    </button>
                  </div>
                </div>

                {/* Timeline Interval Scrubber [startTime, endTime] */}
                <div className="flex items-center justify-between gap-xs bg-surface-container-lowest/80 p-xs rounded-lg border border-outline-variant/20">
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-[10px] text-on-surface-variant">START:</span>
                    <input
                      type="number"
                      min={0}
                      max={c.endTime - 0.1}
                      step={0.1}
                      value={c.startTime}
                      onChange={(e) =>
                        handleUpdate({
                          ...c,
                          startTime: Math.max(0, parseFloat(e.target.value) || 0),
                        })
                      }
                      className="w-12 bg-surface-container border border-outline-variant/30 text-primary text-[11px] font-mono rounded px-1 text-center focus:outline-none focus:border-primary"
                    />
                    <span className="text-[10px] text-on-surface-variant">s</span>
                  </div>

                  <span className="material-symbols-outlined text-[12px] text-outline-variant">
                    arrow_forward
                  </span>

                  <div className="flex items-center gap-1">
                    <span className="font-mono text-[10px] text-on-surface-variant">END:</span>
                    <input
                      type="number"
                      min={c.startTime + 0.1}
                      max={maxDuration}
                      step={0.1}
                      value={c.endTime}
                      onChange={(e) =>
                        handleUpdate({
                          ...c,
                          endTime: Math.min(
                            maxDuration,
                            Math.max(c.startTime + 0.1, parseFloat(e.target.value) || c.startTime + 0.1)
                          ),
                        })
                      }
                      className="w-12 bg-surface-container border border-outline-variant/30 text-primary text-[11px] font-mono rounded px-1 text-center focus:outline-none focus:border-primary"
                    />
                    <span className="text-[10px] text-on-surface-variant">s</span>
                  </div>

                  {/* Weight / Influence */}
                  <div className="flex items-center gap-1 border-l border-outline-variant/30 pl-xs">
                    <span className="font-mono text-[10px] text-on-surface-variant">WT:</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={c.weight}
                      onChange={(e) => handleUpdate({ ...c, weight: parseFloat(e.target.value) })}
                      className="w-12 accent-primary cursor-pointer"
                      title={`Weight: ${(c.weight * 100).toFixed(0)}%`}
                    />
                    <span className="font-mono text-[10px] text-primary w-6">
                      {(c.weight * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>

                {/* Constraint Specific Parameters */}
                {/* 1. Look-At Settings */}
                {c.type === 'look_at' && c.lookAt && (
                  <div className="flex items-center gap-xs text-[11px]">
                    <span className="text-on-surface-variant text-[10px] font-label-caps">
                      TRACK:
                    </span>
                    <select
                      value={c.lookAt.targetType}
                      onChange={(e) =>
                        handleUpdate({
                          ...c,
                          lookAt: { ...c.lookAt!, targetType: e.target.value as LookAtTargetType },
                        })
                      }
                      className="bg-surface-container border border-outline-variant/40 text-primary rounded px-xs py-[2px] font-mono text-[11px] focus:outline-none cursor-pointer"
                    >
                      <option value="camera">Main Camera</option>
                      {otherActors.length > 0 && <option value="actor">Other Actor</option>}
                      <option value="point">3D Point</option>
                    </select>

                    {c.lookAt.targetType === 'actor' && otherActors.length > 0 && (
                      <select
                        value={c.lookAt.targetActorId || otherActors[0]?.id}
                        onChange={(e) =>
                          handleUpdate({
                            ...c,
                            lookAt: { ...c.lookAt!, targetActorId: e.target.value },
                          })
                        }
                        className="bg-surface-container border border-outline-variant/40 text-primary rounded px-xs py-[2px] font-mono text-[11px] focus:outline-none cursor-pointer truncate max-w-[110px]"
                      >
                        {otherActors.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    )}

                    {c.lookAt.targetType === 'point' && (
                      <div className="flex items-center gap-1 font-mono text-[10px]">
                        <span>[</span>
                        <span>{(c.lookAt.targetPoint?.[0] || 0).toFixed(1)},</span>
                        <span>{(c.lookAt.targetPoint?.[1] || 1.6).toFixed(1)},</span>
                        <span>{(c.lookAt.targetPoint?.[2] || 3.0).toFixed(1)}</span>
                        <span>]</span>
                      </div>
                    )}
                  </div>
                )}

                {/* 2. Upper Body Pose Lock Settings */}
                {c.type === 'upper_body_lock' && c.upperBody && (
                  <div className="flex items-center gap-xs text-[11px]">
                    <span className="text-on-surface-variant text-[10px] font-label-caps">
                      POSE:
                    </span>
                    <select
                      value={c.upperBody.preset}
                      onChange={(e) =>
                        handleUpdate({
                          ...c,
                          upperBody: { ...c.upperBody!, preset: e.target.value as UpperBodyPosePreset },
                        })
                      }
                      className="flex-1 bg-surface-container border border-outline-variant/40 text-primary rounded px-xs py-[2px] font-mono text-[11px] focus:outline-none cursor-pointer"
                    >
                      <option value="crossed_arms">Arms Crossed on Chest</option>
                      <option value="hands_on_hips">Hands on Hips</option>
                      <option value="holding_prop">Two-Hand Prop Grip</option>
                      <option value="hands_in_pockets">Hands in Pockets</option>
                      <option value="defensive">Defensive Guard</option>
                    </select>
                  </div>
                )}

                {/* 3. Target Destination Settings */}
                {c.type === 'destination' && c.destination && (
                  <div className="flex flex-col gap-xs text-[11px]">
                    <div className="flex items-center justify-between gap-xs">
                      <span className="text-on-surface-variant text-[10px] font-label-caps">
                        DEST [X, Z]:
                      </span>
                      <div className="flex items-center gap-1 font-mono text-[11px]">
                        <input
                          type="number"
                          step={0.5}
                          value={c.destination.position[0]}
                          onChange={(e) =>
                            handleUpdate({
                              ...c,
                              destination: {
                                ...c.destination!,
                                position: [
                                  parseFloat(e.target.value) || 0,
                                  c.destination!.position[1],
                                  c.destination!.position[2],
                                ],
                              },
                            })
                          }
                          className="w-12 bg-surface-container border border-outline-variant/30 text-primary rounded px-1 text-center"
                        />
                        <span>,</span>
                        <input
                          type="number"
                          step={0.5}
                          value={c.destination.position[2]}
                          onChange={(e) =>
                            handleUpdate({
                              ...c,
                              destination: {
                                ...c.destination!,
                                position: [
                                  c.destination!.position[0],
                                  c.destination!.position[1],
                                  parseFloat(e.target.value) || 0,
                                ],
                              },
                            })
                          }
                          className="w-12 bg-surface-container border border-outline-variant/30 text-primary rounded px-1 text-center"
                        />
                      </div>
                      <button
                        onClick={() =>
                          handleUpdate({
                            ...c,
                            destination: {
                              ...c.destination!,
                              position: [actor.position[0], 0, actor.position[2]],
                            },
                          })
                        }
                        title="Set to Current Actor Position"
                        className="px-1 py-[2px] bg-surface-container hover:bg-surface-variant border border-outline-variant/30 rounded text-[10px] text-on-surface-variant hover:text-primary cursor-pointer font-label-caps"
                      >
                        HERE
                      </button>
                    </div>

                    {/* Custom Acting Motion Prompt for this Waypoint */}
                    <div className="mt-1 flex flex-col gap-1 bg-surface-container-lowest/70 p-xs rounded-lg border border-outline-variant/20">
                      <div className="flex items-center justify-between">
                        <span className="text-on-surface-variant text-[10px] font-label-caps flex items-center gap-1">
                          <span className="material-symbols-outlined text-[13px] text-purple-400">edit_note</span>
                          ACTING MOTION PROMPT:
                        </span>
                        {c.destination.prompt && (
                          <button
                            onClick={() =>
                              handleUpdate({
                                ...c,
                                destination: {
                                  ...c.destination!,
                                  prompt: undefined,
                                },
                              })
                            }
                            className="text-[9px] text-on-surface-variant hover:text-primary cursor-pointer font-label-caps"
                            title="Reset to default prompt"
                          >
                            RESET
                          </button>
                        )}
                      </div>
                      <input
                        type="text"
                        placeholder="e.g. walks and carries a heavy bag with him"
                        value={c.destination.prompt ?? ''}
                        onChange={(e) =>
                          handleUpdate({
                            ...c,
                            destination: {
                              ...c.destination!,
                              prompt: e.target.value,
                            },
                          })
                        }
                        className="bg-surface-container border border-outline-variant/30 text-primary text-xs px-2 py-1 rounded focus:outline-none focus:border-purple-400 font-sans"
                      />

                      {/* Quick Style Inspiration Chips */}
                      <div className="flex items-center gap-1 overflow-x-auto no-scrollbar py-0.5">
                        {[
                          'walks and carries a heavy bag with him',
                          'walks carrying a heavy box in both hands',
                          'cautious stealth walk looking around',
                          'tired dragging limp forward',
                          'hurried nervous rush to the mark',
                          'confident heroic march forward',
                        ].map((samplePrompt, idx) => (
                          <button
                            key={idx}
                            onClick={() =>
                              handleUpdate({
                                ...c,
                                destination: {
                                  ...c.destination!,
                                  prompt: samplePrompt,
                                },
                              })
                            }
                            className="shrink-0 text-[9px] font-label-caps px-1.5 py-0.5 rounded bg-surface-container hover:bg-surface-variant border border-outline-variant/30 text-on-surface-variant hover:text-primary transition-all cursor-pointer truncate max-w-[170px]"
                            title={samplePrompt}
                          >
                            {samplePrompt}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* AI Kimodo Keypoint Motion Generation */}
                    {onGenerateWithConstraint && (
                      <div className="pt-xs mt-xs border-t border-outline-variant/20 flex flex-col gap-1">
                        <button
                          disabled={isGenerating}
                          onClick={() => {
                            const customPrompt = (c.destination!.prompt || '').trim();
                            const prompt = customPrompt.length > 0
                              ? customPrompt
                              : `walks to waypoint at [${c.destination!.position[0].toFixed(1)}, ${c.destination!.position[2].toFixed(1)}]`;
                            onGenerateWithConstraint(prompt, [c]);
                          }}
                          className="w-full py-1.5 px-2 bg-gradient-to-r from-purple-600/30 to-primary/20 hover:from-purple-600/50 hover:to-primary/30 border border-purple-500/40 rounded-lg text-[10px] font-label-caps tracking-wider text-purple-200 hover:text-white flex items-center justify-center gap-1.5 transition-all shadow-sm cursor-pointer disabled:opacity-50"
                        >
                          <span className="material-symbols-outlined text-[14px] text-purple-400">
                            {isGenerating ? 'hourglass_empty' : 'directions_walk'}
                          </span>
                          {isGenerating ? 'SYNTHESIZING DIFFUSION...' : 'GENERATE AI MOTION TO WAYPOINT (KIMODO)'}
                        </button>
                        <span className="text-[9px] text-on-surface-variant/70 italic text-center">
                          Synthesizes genuine neural walking diffusion conditioned on this keypoint in memory
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* 4. Facing Direction Settings */}
                {c.type === 'facing_direction' && c.facing && (
                  <div className="flex items-center gap-xs text-[11px]">
                    <span className="text-on-surface-variant text-[10px] font-label-caps">
                      FACE:
                    </span>
                    <select
                      value={c.facing.targetType}
                      onChange={(e) =>
                        handleUpdate({
                          ...c,
                          facing: { ...c.facing!, targetType: e.target.value as FacingTargetType },
                        })
                      }
                      className="bg-surface-container border border-outline-variant/40 text-primary rounded px-xs py-[2px] font-mono text-[11px] focus:outline-none cursor-pointer"
                    >
                      <option value="camera">Main Camera</option>
                      {otherActors.length > 0 && <option value="actor">Other Actor</option>}
                      <option value="angle">Fixed Angle</option>
                    </select>

                    {c.facing.targetType === 'angle' && (
                      <div className="flex items-center gap-1 font-mono text-[11px]">
                        <input
                          type="number"
                          min={-180}
                          max={180}
                          step={15}
                          value={c.facing.angleDegrees || 0}
                          onChange={(e) =>
                            handleUpdate({
                              ...c,
                              facing: {
                                ...c.facing!,
                                angleDegrees: parseInt(e.target.value, 10) || 0,
                              },
                            })
                          }
                          className="w-12 bg-surface-container border border-outline-variant/30 text-primary rounded px-1 text-center"
                        />
                        <span>°</span>
                      </div>
                    )}
                  </div>
                )}

                {/* 5. Foot Grounding Settings */}
                {c.type === 'foot_grounding' && c.footGrounding && (
                  <div className="flex items-center gap-xs text-[11px]">
                    <span className="text-on-surface-variant text-[10px] font-label-caps">
                      PLANT:
                    </span>
                    <select
                      value={c.footGrounding.mode}
                      onChange={(e) =>
                        handleUpdate({
                          ...c,
                          footGrounding: {
                            ...c.footGrounding!,
                            mode: e.target.value as FootGroundingMode,
                          },
                        })
                      }
                      className="bg-surface-container border border-outline-variant/40 text-primary rounded px-xs py-[2px] font-mono text-[11px] focus:outline-none cursor-pointer"
                    >
                      <option value="both">Both Feet (Zero Slip)</option>
                      <option value="left">Left Foot Pivot</option>
                      <option value="right">Right Foot Pivot</option>
                    </select>
                  </div>
                )}

                {/* 6. Stance & Height Settings */}
                {c.type === 'stance_height' && c.stance && (
                  <div className="flex items-center justify-between gap-xs text-[11px]">
                    <span className="text-on-surface-variant text-[10px] font-label-caps">
                      OFFSET:
                    </span>
                    <input
                      type="range"
                      min={-0.6}
                      max={0.3}
                      step={0.05}
                      value={c.stance.heightOffset}
                      onChange={(e) =>
                        handleUpdate({
                          ...c,
                          stance: { heightOffset: parseFloat(e.target.value) },
                        })
                      }
                      className="w-24 accent-primary cursor-pointer"
                    />
                    <span className="font-mono text-primary text-[11px]">
                      {c.stance.heightOffset >= 0 ? `+${c.stance.heightOffset.toFixed(2)}` : c.stance.heightOffset.toFixed(2)}m
                    </span>
                    <span className="text-[10px] text-on-surface-variant">
                      {c.stance.heightOffset < -0.25
                        ? '(Crouch)'
                        : c.stance.heightOffset < -0.05
                        ? '(Low)'
                        : '(Normal)'}
                    </span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Add Constraint Button & Popover */}
      <div className="p-md bg-surface-container-high/60 border-t border-outline-variant/30 relative">
        <button
          onClick={() => setShowAddMenu(!showAddMenu)}
          className="w-full bg-primary text-background font-label-caps text-xs py-xs rounded-xl font-semibold tracking-wider hover:bg-white/90 transition-all flex items-center justify-center gap-xs cursor-pointer shadow-md"
        >
          <span className="material-symbols-outlined text-[16px]">add_circle</span>
          ADD CONSTRAINT
        </button>

        {showAddMenu && (
          <div className="absolute bottom-full left-md right-md mb-xs bg-surface-container-highest/98 border border-outline-variant/40 rounded-xl p-xs backdrop-blur-2xl shadow-2xl flex flex-col gap-1 z-50 animate-fadeIn">
            {(Object.keys(CONSTRAINT_TYPE_META) as ConstraintType[]).map((type) => {
              const meta = CONSTRAINT_TYPE_META[type];
              return (
                <button
                  key={type}
                  onClick={() => handleAddConstraint(type)}
                  className="px-sm py-xs rounded-lg hover:bg-surface-container-low text-left flex items-start gap-sm transition-all cursor-pointer group"
                >
                  <span
                    className="material-symbols-outlined text-[18px] shrink-0 mt-[2px]"
                    style={{ color: meta.color }}
                  >
                    {meta.icon}
                  </span>
                  <div className="flex flex-col">
                    <span className="font-label-caps text-xs font-medium text-on-surface group-hover:text-primary">
                      {meta.name}
                    </span>
                    <span className="text-[10px] text-on-surface-variant leading-tight">
                      {meta.desc}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
