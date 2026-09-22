---
name: h3-story-director
description: |
  Create, revise, diagnose, and adapt short-form stories into MiniMax H3-native StoryBeats and compact Shot Sequences for H3Mise. Use when an auto-generated episode feels flat, procedural, repetitive, causally weak, or difficult for H3 to execute. Owns Story -> causal beats -> H3 adaptation -> Shot Sequence. Does not own final single-shot camera choreography, detailed performance mechanics, prompt compilation, rendering, Take review, or post-production.
compatibility: Designed for H3Mise and MiniMax H3.
---

# H3 Story Director

Use this Skill as the **story-and-sequence decision layer** for H3Mise.

Core rule:

> **Story quality first. H3 feasibility second. A production shot must pass both.**

The Skill should improve what gets filmed, not merely make the writing sound more cinematic.

## Runtime References

Load only what the active task needs:

- Story creation / repair / diagnosis: read `references/story-writing-core.md`.
- Story or continuity verification: add `references/story-state-engine.md`.
- Converting approved beats into H3-executable production choices: read `references/h3-adaptation-rules.md`.
- Building or revising a multi-shot sequence: add `references/sequence-directing.md`.
- Before final handoff, or when a result feels flat / repetitive / overbuilt: run `references/story-shot-critic.md`.

Do not load every reference by default when one is sufficient.

## Scope

Use for:

- original H3 short-film or episode planning;
- revising weak or generic auto-generated stories;
- turning prose / outlines into H3-native StoryBeats;
- converting approved beats into the minimum useful Shot Sequence;
- removing procedural or redundant shots;
- adapting difficult visible actions without losing their dramatic function;
- checking causality, payoff, state continuity, shot necessity, and H3 production risk.

Do not use for:

- detailed direction of one approved shot;
- camera-path design inside one shot;
- body-mechanics choreography;
- final H3 prompt writing;
- rendering;
- Take selection / repair;
- professional screenplay formatting;
- professional 3D / mocap / skeleton / NLE workflows.

For an approved shot, hand off to the existing single-shot H3 direction stack such as:

```text
h3-micro-cinematic-director
h3-performance-director
h3-shot-pattern-library
```

## MiniMax H3 Production Contract

Default assumption:

```text
one H3 generation
=
one continuous shot
=
one primary visible event
```

A shot may contain anticipation, action, follow-through, and recovery, but should not secretly contain multiple scenes, hard cuts, time jumps, or unrelated objectives.

Do not show every physical process merely because it happened in the prose.

Prefer:

```text
Shot A: MISE notices the last film reel.
CUT
Shot B: MISE is already carrying the reel into the corridor.
```

when the pickup process itself carries no suspense, evidence, comedy, danger, relationship change, or payoff.

When a difficult action is dramatically important, preserve the dramatic function and adapt the production strategy instead of deleting the event.

## Workflow

### STEP 0: Freeze Project Truth

Read the current H3Mise project facts that matter:

- premise / story;
- duration and aspect ratio when known;
- existing StoryBeats and Shots;
- Entity / CharacterState / important prop state;
- user-locked ending, tone, dialogue, platform, or production constraints;
- provider / H3 mode limits when relevant.

Project data outranks assumptions.

Do not replace locked assets, states, selected Takes, or approved story facts merely to simplify the rewrite.

### STEP 1: Story Pass

Read `references/story-writing-core.md`.

Build or repair:

```text
want
-> why now
-> resistance
-> action
-> consequence
-> changed strategy
-> choice / cost
-> payoff
```

Story meaning should have visible carriers whenever practical.

Do not plan Shots yet.

### STEP 2: Story State Check

For substantial story work, read `references/story-state-engine.md`.

Verify:

- character knowledge;
- relationships;
- goals;
- consequential prop state;
- beat entry / exit state;
- NarrativeState continuity;
- planned visible state.

Do not confuse planned VisualContinuity with actual generated continuity from a Selected Take.

### STEP 3: Story Critic

Run the story portion of `references/story-shot-critic.md`.

Find the earliest consequential problem:

- broken causality;
- passive protagonist;
- obvious unused solution;
- flat pressure;
- missing strategy shift;
- weak payoff;
- generated neatness.

Repair upstream before proceeding.

### STEP 4: H3 Adaptation

Read `references/h3-adaptation-rules.md`.

For each meaningful visible event choose:

```text
DIRECT
ELIDE
SPLIT
REFERENCE-ASSIST
UNRESOLVED
```

Do not make the prompt longer to solve a structural production problem.

Use H3 risk only as a warning:

```text
LOW / MEDIUM / HIGH
```

A HIGH-risk shot may still be correct when the action itself carries the drama.

### STEP 5: Shot Sequence

Read `references/sequence-directing.md`.

Create the minimum useful sequence.

Each proposed Shot should define:

```text
Shot ID
Story Beat
Shot Function
Dramatic Purpose
Entry State
Primary Visible Event
Exit State
Approx Duration
Screen Direction / Continuity Need
Reference Need
H3 Risk
Adaptation Note
```

Do not fully direct the camera or performance here.

### STEP 6: Shot Critic

Run the shot portion of `references/story-shot-critic.md`.

Mandatory deletion test:

> If this shot is removed and the next shot starts from its exit state, what real narrative, emotional, informational, spatial, or causal loss occurs?

Delete / merge shots whose answer is only:

- we no longer see the walk;
- we miss the reach / pickup / turn;
- the transition feels less complete;
- it gives another angle;
- it feels more cinematic.

Also reject:

- repeated shot functions without progression;
- hidden montage inside one shot;
- H3-overloaded actions;
- continuity resets;
- references without a specific job.

### STEP 7: Handoff

When the sequence passes, hand each shot to the downstream H3 director.

Use a compact contract:

```yaml
shot:
  id:
  story_beat:
  function:
  dramatic_purpose:
  entry_state:
  primary_visible_event:
  exit_state:
  approximate_duration:
  continuity:
    screen_direction:
    required_visible_state:
  references:
    required_roles:
  h3_risk:
  adaptation_note:
```

The downstream single-shot layer owns:

- detailed blocking;
- camera geometry;
- dominant camera behavior;
- detailed performance;
- anticipation / action / follow-through / recovery;
- final DirectorPlan detail;
- final reference binding choice;
- prompt compilation.

Do not duplicate those responsibilities here.

## H3Mise State Rules

Use existing H3Mise concepts instead of a second continuity model.

### NarrativeState

Story truth: knowledge, relationships, dramatic state, goals, commitments, and story consequences.

### Planned VisualContinuity

Visible state required for production: CharacterState, costume, held items, damage, location, time/weather, prop state, facing, screen direction, etc.

### Actual VisualContinuity

Only a reviewed Selected Take can establish actual generated visual continuity.

Never rewrite story truth to match an accidental generated drift.

### Assets

A temporary state is usually not a new Entity.

Prefer:

```text
MISE + state: holding reel
```

over separate entities for every pose or temporary prop state.

## Agent Integration

When actively driving H3Mise:

- treat H3Mise project data as canonical;
- use existing delegated prepare/apply actions when they match the task;
- do not bypass server validation by writing project rows directly;
- do not start paid storyboard or video generation simply because the story was approved;
- storyboard images remain planning artifacts until explicitly promoted to ReferenceBinding roles;
- never overwrite a Take;
- do not infer actual continuity from the plan;
- if the current provider cannot express a required production mode, mark the strategy unresolved or choose an honestly equivalent supported alternative.

## Output Modes

### New Story / Episode

Return:

- concise premise;
- causal StoryBeat plan;
- compact Shot Sequence;
- H3 risk / adaptation notes only where useful.

### Story Repair

Return:

- earliest story weakness;
- repaired causal spine;
- changed beats;
- unresolved assumptions.

### Existing Beats -> Shots

Preserve approved story unless it fails a real gate.

Return:

- minimum Shot Sequence;
- deliberately elided processes;
- continuity handoff;
- H3 risks.

### Diagnose Weak Auto-Generated Episode

Prioritize:

1. causal weakness;
2. passive protagonist;
3. weak pressure / reversal;
4. procedural beats;
5. repetitive shots;
6. H3-overloaded action;
7. weak payoff.

Return the smallest upstream repair that fixes the downstream sequence.

## Final Gates

### Story Gate

- protagonist action materially drives events;
- why-now is clear;
- resistance is real;
- important decisions survive the obvious-alternative test;
- major beats create state changes;
- the ending grows from prior action / setup / choice;
- the story can be understood without director commentary.

### H3 Gate

- each shot is one clear continuous event by default;
- no hidden montage or accidental multi-shot prompt;
- fragile processes are DIRECT / ELIDE / SPLIT / REFERENCE-ASSIST / UNRESOLVED intentionally;
- every shot has usable entry and exit state;
- continuity needs are explicit;
- HIGH-risk shots have a concrete adaptation plan;
- no shot exists only for coverage;
- the sequence is ready for downstream single-shot direction.

If either gate fails, return to the earliest broken decision.

## Guiding Principles

> **Tell the story through consequential visible change.**

> **Show what matters; skip what merely connects it.**

> **Do not make H3 perform a difficult process when a clean state transition tells the same story better.**

> **Do not simplify away the one action that actually carries the drama.**

> **Every shot must earn its generation cost.**
