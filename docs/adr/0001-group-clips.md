# ADR 0001 — Many marks in one clip, before a group clip

**Status:** accepted, September 2026. The group clip is deferred, not rejected.

## Context

A timeline track holds one clip at a time. Two things on screen together can
never share a track, so a graphic made of many pieces takes as many tracks as it
has pieces. In a real edit, a 9-row × 3-column price table put about 37 clips on
screen at once and took the project from 28 video tracks to 44 in one pass. A
referral matrix with its empty seats drawn faintly would have added another
thirty. The timeline became hard for the client to read, and nothing could move
or delete the table as one thing.

## Options

**A. A group clip.** One timeline item holding child layers, each with its own
transform, keyframes and style, drawn by `drawFrame` under the group's
transform. This is how every desktop editor answers it, and it is the most
general answer. It changes the document model, and much of the code assumes a
flat clip:

- `drawFrame`, `clipBox` and `hitTest` would compose transforms, including
  rotation and anchors, and the on-canvas handles would need to address a child;
- keyframes, transitions and `sliceKeyframes` (split, trim, cut) would need to
  work at two levels;
- lint, the fact check, `list_notes`, restyling by role and storyboard compiles
  all walk clips, and would need to walk children;
- every reducer action takes a `ClipRef` of track and clip, and would need a
  child path;
- it needs an interface to open a group, edit a child and close it again.

**B. Richer single clips.** Let one clip carry more:

- `text.reveal`, a keyframable number of lines shown, makes a table column one
  clip whose rows still arrive on their own words;
- a `path` shape kind, SVG path data in the box's own units, draws every empty
  seat and edge of a tree as one clip.

Both are plain numbers and strings on existing clip types, so everything that
reads a clip keeps working. The places that need to know about lines — lint's
overlap and contrast checks, and the fact check's timing — were taught to read a
text clip line by line.

**C. Grouping by tag only.** Stamp every clip one macro call makes with one
`component`, and act on the component: delete it, or move it in time and across
the frame. Cheap, but alone it leaves the track count as it was.

## Decision

B and C together, now:

- **B:** `add_table` is a clip per column plus its headers and rule, and a 9 × 3
  table takes seven tracks. `add_stack` is a clip per card plus three text
  clips. A ghost tree is one path clip.
- **C:** every macro call is one component. `delete_component` and
  `move_component` act on it, and the timeline's clip menu can delete it whole.

A is deferred. It is the right model if pieces of a graphic need independent
styling that a single clip cannot express — a different colour per table row, a
different face per word. It is also the right model once the client needs to
open a graphic and edit one piece by hand, where a column's content is one
string today.

## Consequences

- A person editing a table edits a column's text as lines. A line added by hand
  after the last row has arrived is shown: the reveal keys end on "every line".
- A row's colour is its column's. Highlighting a row puts a card behind it, not
  a colour on its text.
- Any new check that reasons about where text is must read lines, through
  `textLineBoxes`, not the clip's whole box.
- Reopen this when a request needs per-piece styling or editing that B cannot
  express, or when one component routinely needs more than about ten tracks.
