---
name: prompt-slot-templates
description: The owner's preferred way to build generation prompts - a hand-written, tested prompt with named [BRACKET] slots that a vision model fills in from an attached image, leaving every other word unchanged. Use when writing or designing any image/video prompt that depends on a picture (character sheets, actor turnarounds, prop or location sheets, set masters, render prompts), when the user attaches an image and asks for "a prompt for this", when building Pantilt features that generate from a reference image (e.g. MAKE SHEET for a cast member), or when changing how server/api/render.ts assembles its prompt. Holds the Pantilt character-sheet template.
---

# Prompt slot templates

Learned from the character-sheet prompt in Marin Method's "Seedance 2.5 Consistency Template Pack"
(read 2026-09-30, see the `seedance-consistency` skill for the rest of the pack). The owner singled out
this FORM as what they want to reuse across Pantilt features.

## The method

1. Write the prompt once, by hand, from wording that has been **tested and must not change**.
2. Where it depends on this particular subject, leave a **named slot in brackets**:
   `[CHARACTER DESCRIPTION]`, `[OUTFIT DESCRIPTION]`, `[DETAIL 1]`…`[DETAIL 4]`.
3. Give a vision model the template, the image and one line: *fill in this prompt using the attached image*.
   It writes ONLY the slots. Everything around them comes back unchanged.
4. Send the filled prompt to the image/video model together with the same image.

Why it works:
- **Tested wording can't drift.** Asked to "write a prompt", a model rewrites everything and slips in
  its habits (soft skin, 8k, hype words). With slots it can only touch the slots.
- **The words beside a slot are its instructions.** "…wearing [OUTFIT DESCRIPTION], both hands
  empty…" and "four close-ups [DETAIL 1…4]… never the face" keep each rule next to the slot it governs.
- **Numbered slots fix counts.** Four DETAIL slots always give exactly four details.
- **Facts come from the picture**, not from someone typing descriptions.
- **One readable text.** The owner can change a word and test again, and can test it by hand in any
  chat before anything is built. That is how every Pantilt prompt rule so far was found.

## Writing a good template
- Slot names say what goes in them, in capitals. A hint may follow a colon:
  `[OUTFIT: each garment top to bottom with colour and material]`. The hint is for the filler and
  never appears in the output.
- A slot holds facts about THIS subject. Anything true for every subject is fixed text.
- Put each constraint right beside its slot.
- Repeat the one or two things models get wrong most. The pack says "no text / no labels" three times
  on purpose.
- Apply the owner's tested rules to the fixed text (memory `previs-render-prompt-technique`):
  - no spec-sheet words (8k, ultra detailed, hyper-realistic): tested, they do nothing
  - never soft/smooth/creamy skin; ask for pores, fine lines and uneven tone instead (`REAL_SKIN`)
  - film OR digital, never both
  - a stand-in's colour is a marker, never wardrobe

## Template: Pantilt character sheet (draft, NOT yet tested by the owner)
Adapted from the pack's sheet prompt. Its "8k / ultra detailed / hyper realistic" wording was dropped
per the rules above, and the skin line is ours. The pack placed the views as "front centre, side
middle, back right", which is ambiguous, so this draft says left / middle / right. For "face visible in
all views" to be possible, the back view turns the head over the shoulder.

```
Character reference sheet of one real person: [CHARACTER: age, build, face, hair, facial hair, glasses; no clothing, no name].
Full-body turnaround of the same person in three views side by side: front view on the left, side view in the middle, back view on the right with the head turned over the shoulder so the face stays visible in every view.
Wearing [OUTFIT: each garment top to bottom with colour and material, then shoes].
Both hands empty, arms relaxed at the sides.
Bottom-right corner: a 2 by 2 grid of four close-ups showing [DETAIL 1], [DETAIL 2], [DETAIL 3], [DETAIL 4]. Close-ups of clothing, accessories, hands or shoes only, never the face.
Plain white background, even soft studio light, real proportions, a real photograph.
Real, unretouched skin: visible pores, fine lines, uneven tone; no smoothing, no beauty filter.
No text, no labels, no captions, no watermark anywhere.
```
Filler rules: describe only what the photo shows; never guess who the person is; DETAIL slots are
things a costume department would need (a watch, boot laces, a ring, a scarf's knit), never the face.

Pantilt already treats the result as identity only: the render sends the sheet as image N with
"use it only for who they are, not for its lighting, background or pose", and the sheet's white studio
light did not leak in tests (2026-09-29).

## How it would plug into Pantilt (plan, NOT built)
- **Templates live on the server** as plain text with visible slots, one file or collection, not
  spread through code. `server/api/render.ts` today does the same thing implicitly: Gemini fills
  `light`/`place`/`people` (JSON schema in `TEMPLATE_WRITER`) and fixed lines surround them.
- **One filler** (server-side, `geminiText` in `server/lib/gemini.ts` with `json.schema`):
  1. find the slots with a regex like `/\[([A-Z][A-Z0-9 ]*)(?::[^\]]*)?\]/g`
  2. build a JSON schema with one required string per slot name
  3. system prompt = the template with its hints, plus "return only the slot values, no brackets"
  4. substitute the values, then **refuse the result if any `[SLOT` is left**
- **Character sheet feature:** beside ADD SHEET / REPLACE in the render window's Cast section
  (`src/components/camera/TakeRenderPanel.tsx`), a MAKE SHEET button. Upload a photo → the server
  fills the sheet template from it → the image model makes the sheet with the photo attached → the
  result is saved as `CharacterActor.referenceSheetUrl`, the same field ADD SHEET writes. It counts
  one generation against the quota like any other route.
- Open question for the owner: **which image model makes the sheet.** The pack used GPT Image 2,
  which Pantilt has no key for. Seedream 5 Pro Edit (WaveSpeed) is already wired and takes the photo as
  an input image. Test the template by hand there first, the way the render prompt was validated.
- Other templates that fit the same form later: prop sheet, location or set-master sheet, a Look
  reference, and the Seedance video prompt (its LOCK block is fixed text, the beats are slots).
- All provider calls run on the server (`all-api-calls-must-be-server-side`).
