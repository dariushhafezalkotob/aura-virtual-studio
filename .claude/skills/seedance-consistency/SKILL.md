---
name: seedance-consistency
description: Writes consistent multi-beat Seedance 2.5 video prompts (LOCK / REFS / TIMELINE structure). Use when the user wants a Seedance video prompt from a story, script, scene or Pantilt take; asks how to keep identity, light and look stable across a clip; or when designing Pantilt features that compile a take (camera keyframes, actor multi-text segments, dialogue) into a video-model prompt. For a prompt driven by an existing previz VIDEO file, use the installed `seedance-previz-prompt` skill instead; this one is for prompts built from story, cast references and scene data.
---

# Seedance consistency prompts

Source: Marin Method's free "Seedance 2.5 Consistency Template Pack" (Notion, read 2026-09-30:
https://gifted-sheet-ca8.notion.site/SEEDANCE-2-5-FREE-PROMPTS-Consistency-Template-Pack-3aff410c093280e0b291ff65e030e1e8).
Written up here in our own words, with notes where it agrees or disagrees with what the Pantilt owner has
tested on Seedream (memory note `previs-render-prompt-technique`).

The fixed-template-with-[SLOTS] method (and the character-sheet template) lives in the
`prompt-slot-templates` skill. This skill covers the video side of the pack.

The pack's idea for video: a video model drifts when every beat restates the world. So you split the prompt into what
**never changes** (stated once), **who/what the references are** (stated once), and **what happens when**
(short timed beats). That split is the whole method.

## 1. Video prompt: three blocks

### LOCK — holds for the whole clip, written once
| Line | What goes in it |
|---|---|
| Look | aspect ratio, one film anchor (e.g. "cinematic film tone, 35mm"), colour grade |
| Light | key source, its direction, its quality. **The pack calls this the highest-impact line.** Spend words here. |
| Air | clean, haze, fog or rain. Pick one. |
| Rig | locked tripod, gimbal or handheld. **Only one** for the whole clip. |
| Audio | diegetic sound effects only, no music, plus room tone |
| Guard | keep faces consistent, no identity drift, no bent limbs, no jitter, no temporal flicker |
| Suffix | clarity, natural colour, stable picture, no ghosting. See the caveats below before copying it. |

### REFS — one line per uploaded image
- Tag every reference with **the uploaded file's own name** (`@Simon`, `@MarketStall`), never a generic `@image1`,
  and use exactly that tag everywhere the reference appears in the prompt.
- Person: role plus identity markers (age, hair, wardrobe, one accessory).
- Other refs: what it is (vehicle, prop or environment) and what it is for.
- Each reference has one job. Two references must never claim the same thing (the installed previz skill says the same).

### TIMELINE — 2-second beats, up to 30 s
Each beat is `start–end s  Shot: <one action>. Camera: <one move>. <SFX>.`
- **One action and one camera move per beat.** Keep them separate and never stack two moves in a beat.
- Each beat **carries motion from the previous one** (the run continues, the turn completes), so the
  clip reads as one take instead of a series of resets.
- 0–2, 2–4 … 27–30 s is 15 beats for a full 30 s clip.

### Limits
- Seedance 2.5: 30 s native, **≤ 4,700 characters** per prompt (the pack's cap). 2.0 is ~15 s.
- One prompt = one clip.

## 2. Story → prompt (the pack's second template)
Give the model: the uploaded refs (by name), the story in plain prose, the LOCK/REFS/TIMELINE template
above, "one complete 30-second prompt for one clip", the tagging rule, and the 4,700-character cap.
The story in prose supplies the beats. The template forces them into 2 s units with one move each.

## 3. Character sheet
See the `prompt-slot-templates` skill for the Pantilt version of the pack's sheet template.

## Caveats from Pantilt's own testing (these override the pack)
- **"Sharp clarity, no blur"** fights our lens work. Renders use physical depth of field on purpose.
  Say "stable picture, no ghosting" and leave focus to the depth-of-field line and the layout image.
- **"Photorealistic 8k, ultra detailed"** and other spec-sheet words did nothing in the owner's tests.
  They cost characters and add nothing.
- **"Natural colors"** in the suffix can fight a Look's grade. When a Look is chosen, the grade wins,
  so drop that word.
- **Skin:** in the sheet prompt, "natural skin texture" is right. Never write soft, smooth or creamy skin.
  Ask for pores, fine lines and uneven tone instead (the REAL_SKIN finding).
- The character sheet's white studio light **did not leak** into Seedream renders in our tests, so the
  sheet format is safe to reuse as `CharacterActor.referenceSheetUrl`.
- **Stand-in colours are markers, not wardrobe.** Still true for video: say so in REFS.

## How it maps onto Pantilt (ideas, not built)
| Pack block | Where Pantilt already has the data |
|---|---|
| Look / grade | the take's Look (Grade paragraph + reference picture) and `packageShortLine` (camera package) |
| Light | Scene Design light intensity + environment preset; the Gemini shot-writer's light line |
| Rig | could be derived from the take: stabilizer amount + keyframe jitter → tripod / gimbal / handheld |
| REFS | cast `referenceSheetUrl` per actor, the Look picture, a future "set master" render |
| TIMELINE camera moves | `CameraTake` keyframes, bucketed into 2 s windows and named (push, pan, tilt, arc, static) |
| TIMELINE actions | actor multi-text segments (prompt + duration) and constraints |
| Audio / SFX | dialogue lines with start/end times; everything else room tone |
| Character sheet | MAKE SHEET in the Cast section, see `prompt-slot-templates` |

Any such feature follows the standing rules: the provider call runs on the server
(`all-api-calls-must-be-server-side`), and nothing in `main` changes until the owner asks.
