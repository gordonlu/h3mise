---
name: h3-story-director
description: |
  Turn a story idea, outline, draft episode, or weak auto-generated H3Mise story into a causally coherent,
  visually readable, MiniMax H3-executable story beat plan and shot sequence. Use when the problem is
  "what is worth shooting?", "why does this shot exist?", "how should this story be adapted for H3?",
  or when an agent-generated episode feels flat, repetitive, over-shot, or difficult for MiniMax H3 to execute.
  This Skill owns Story -> causal beats -> H3 adaptation -> Shot Sequence. It does not own final single-shot
  camera choreography, detailed performance direction, H3 prompt compilation, rendering, or post-production.
compatibility: |
  Designed for H3Mise and MiniMax H3. Integrates with H3Mise StoryBeat, Shot, Entity, CharacterState,
  NarrativeState, VisualContinuity, DirectorPlan, ReferenceBinding, Storyboard, and Take concepts.
---

# H3 Story Director

Use this Skill as the **story-and-sequence decision layer** for MiniMax H3 production.

The job is not to sound like a film director. The job is to make better decisions about:

- what happens;
- why it happens now;
- what changes because of it;
- what is worth showing;
- what should be skipped;
- how many H3 shots are actually needed;
- which difficult actions should be reframed instead of forced;
- what state the next shot must inherit.

Core rule:

> **Story quality first. H3 feasibility second. A production shot must pass both.**

A strong story that cannot be expressed reliably as H3 shots is not production-ready.
An easy H3 shot with no dramatic function should not exist.

## Scope

Use this Skill for:

- original H3 short-film or episode planning;
- revising a weak story or episode;
- turning prose or an outline into H3-native story beats;
- converting approved beats into a compact shot sequence;
- reducing repetitive or procedural shots;
- adapting difficult actions without losing their dramatic function;
- checking story causality, payoff, state continuity, shot necessity, and H3 production risk;
- preparing a clean handoff to the single-shot H3 director.

Do not use this Skill for:

- polishing one already-approved shot;
- detailed camera-path design inside one shot;
- detailed body mechanics or performance choreography;
- final H3 prompt writing;
- prompt syntax tuning;
- rendering;
- Take selection or video repair;
- professional screenplay formatting;
- professional 3D, mocap, skeleton, IK/FK, or NLE workflows.

For approved individual shots, hand off to the existing H3 single-shot direction layer such as
`h3-micro-cinematic-director`, `h3-performance-director`, and `h3-shot-pattern-library`.

---

# MiniMax H3 Production Assumptions

Design the story around the medium instead of writing a conventional screenplay first and forcing H3 to imitate it later.

## One H3 Shot = One Clear Continuous Event

Default assumption:

```text
one generation
=
one continuous shot
=
one primary visible event
```

A shot may contain anticipation, action, follow-through, and recovery, but it should not secretly contain several scenes or several unrelated objectives.

Prefer:

```text
MISE crosses the empty corridor while holding the reel,
slows near the elevator,
and stops as the doors open.
```

Avoid overloading one shot with:

```text
walk in
-> inspect poster
-> drop reel
-> pick it up
-> hear a sound
-> turn around
-> run to elevator
-> press button
-> doors open
```

## Show Consequential Change, Not Every Process Step

H3 production does not require every physical transition to be shown.

If a process has no dramatic value, skip it and preserve only the meaningful state transition.

Example:

```text
Shot A:
MISE notices the last film reel.

CUT

Shot B:
MISE is already holding the reel and leaving the projection room.
```

Do not automatically create separate shots for approach, reach, grasp, lift, turn, and walk away unless those actions carry suspense, evidence, comedy, danger, relationship change, or payoff.

## Difficult Generation Must Not Rewrite The Story By Accident

When an action is hard for H3, first identify its dramatic function.

Classify it:

1. **No important function**  
   Skip or compress it.

2. **The result matters more than the process**  
   Cut from the state before to the state after.

3. **The visible action matters, but another coverage can preserve it**  
   Change shot size, angle, staging, or reaction coverage.

4. **The action itself is the dramatic event**  
   Keep it, but simplify the surrounding shot, split the action, or use stronger references.

Useful adaptation tools include:

- first-frame guidance;
- first/last-frame guidance when available;
- clean motion/video reference;
- stable character/scene/prop references;
- cutting to a reaction or result;
- splitting a dense action into two clear shots;
- changing coverage while preserving story meaning.

Never silently replace a consequential action with an easier but dramatically different one.

## Reference Reality

Video reference works best when the useful signal is readable.

Favour references with:

- one clear continuous shot;
- few subjects;
- low background interference;
- readable body motion;
- limited occlusion;
- no unnecessary hard cuts.

Fast movement is not automatically bad. A fast dance or action reference may work well when the subject is clear and the background/camera information is not entangled.

Storyboard images are planning artifacts by default. They become generation references only when explicitly promoted to a ReferenceBinding role.

---

# Required Workflow

## STEP 0: Read The Production Truth

Before rewriting anything, identify what is locked.

Capture only what matters:

- project format and approximate duration;
- aspect ratio if known;
- premise or existing story;
- protagonist and important supporting characters;
- existing Entities and CharacterStates;
- existing scene/prop assets;
- current StoryBeats and Shots when revising an H3Mise project;
- explicit ending, tone, audience, dialogue, or platform constraints;
- current H3 mode/provider limitations when known.

Do not invent missing project facts as if they were approved.
Mark necessary assumptions explicitly.

When operating inside H3Mise, project data is the source of truth.
Do not replace locked assets, states, selected Takes, or user-approved facts merely to make a rewrite easier.

---

## STEP 1: Build The Causal Story Spine

Before shot planning, make the story explainable in plain language.

Internally answer:

```text
Who wants what?
Why must they act now?
What blocks them?
What do they try first?
What happens because of that action?
How does pressure force a different choice?
What changes irreversibly?
What final choice or payoff resolves the dramatic question?
```

The protagonist must materially affect the outcome.

Avoid stories where:

- events happen around the protagonist while they mostly observe;
- coincidence solves the central problem;
- a late object, arrival, message, or rule solves the climax without setup;
- an obvious easier solution is available but ignored only because the plot needs difficulty;
- the ending is merely "the task is finished" with no changed state, meaning, relationship, cost, or payoff.

### Obvious-Alternative Test

For every major decision, ask:

> What would a reasonable character try instead because it is safer, cheaper, faster, easier, or more socially obvious?

If that alternative solves the problem and nothing prevents it, repair the situation or the character decision.

Do not add exposition to defend a broken decision after the fact.

---

## STEP 2: Run The Story Critic

Before creating shots, challenge the story once.

Check:

### Causality

Each important beat should resemble:

```text
prior condition
-> character action or deliberate refusal
-> result
-> state change
-> new necessity / blocked option / new cost
```

If two beats connect only through "and then", rebuild or remove one.

### Pressure

The story needs changing pressure, not merely more activity.

Look for at least one meaningful shift such as:

- a tactic stops working;
- new information changes the option set;
- a relationship changes;
- a resource is lost;
- a deadline becomes real;
- success creates a new cost;
- an expectation is reversed;
- something previously safe becomes unsafe.

### Payoff

The ending should result from prior setup and decisions.
Prefer payoff that changes how an earlier image, object, promise, mistake, or relationship is understood.

### Generated Neatness

Reject drafts where:

- every beat exists only to set up the next one;
- every object has an obvious mechanical payoff;
- every line explains plot or theme;
- everyone behaves efficiently and rationally at all times;
- conflict resolves too cleanly;
- the story feels like a checklist rather than people acting under pressure.

### Visual Story

For each major beat, identify the visible state change.

Good targets include:

- location;
- possession;
- distance between characters;
- posture or commitment;
- access to a place;
- environmental condition;
- relationship/power;
- knowledge revealed through action;
- object state;
- choice made visible.

Prefer visible behavior over abstract internal explanation.

---

## STEP 3: Convert Story Into H3-Native Beats

A StoryBeat is not a shot.

Each beat should contain:

- **dramatic purpose** — why this beat exists;
- **entry state** — relevant narrative and visible state before it;
- **pressure / trigger** — what changes the current situation;
- **character action** — what someone actually does;
- **result** — what visibly or narratively changes;
- **exit state** — what the next beat must inherit.

A beat that ends with no changed fact, choice, relationship, option, possession, position, danger, or understanding is probably weak.

Use the deletion test:

> If this beat disappears, what later decision, payoff, state, or audience understanding becomes weaker or impossible?

If the answer is "almost nothing", merge, rebuild, or delete it.

Do not create beats just because time passes or a character travels between two useful scenes.

---

## STEP 4: Run The H3 Adaptation Pass

Now adapt the approved beats for MiniMax H3.

For every visible event, choose one production strategy:

### A. DIRECT

Use when the event is clear enough to express as one continuous H3 shot.

Examples:

- a character wakes and looks toward a sound;
- a vehicle accelerates along a readable path;
- one subject approaches a door;
- a projector activates and throws light across a room.

### B. ELIDE

Use when the process is fragile or boring but the changed state matters.

Example:

```text
before: reel is on the table
after: MISE is carrying the reel
```

Do not spend a shot proving every finger/contact transition unless the pickup itself matters.

### C. SPLIT

Use when the event matters but one shot carries too many state changes.

Split by dramatic function, not arbitrary duration.

Example:

```text
Shot 1: attacker commits to the strike.
Shot 2: defender evades and counters.
```

Do not split simply because "more shots feels cinematic."

### D. REFERENCE-ASSIST

Use when motion, identity, composition, or endpoint is important enough to justify a stronger reference.

Possible reference needs:

- character identity;
- environment;
- prop;
- motion;
- first frame;
- last frame;
- composition.

Keep reference roles specific. Do not bind everything as a generic reference.

### E. UNRESOLVED

If an event is both dramatically essential and production-risky, mark it unresolved rather than pretending the design is ready.

Propose the smallest experiment needed to validate it.

---

# H3 Risk Review

Risk is a production warning, not a quality score and not an automatic rejection.

Use:

- `LOW`
- `MEDIUM`
- `HIGH`

Evaluate factors such as:

- number of active subjects;
- overlapping bodies or occlusion;
- close-contact interaction;
- precise hand/object contact;
- rapid changes of facing or position;
- crowded or moving background;
- complicated multi-step action;
- multiple simultaneous action owners;
- demanding continuity with a previous/next shot;
- exact text or UI content;
- long multi-speaker dialogue or lip-sync burden;
- a shot description that secretly contains multiple shots.

A HIGH-risk shot may still be correct when it is dramatically important.

For HIGH risk, attach an adaptation recommendation:

```text
skip
split
change coverage
simplify surrounding action
use motion reference
use first/last frame
lock stronger identity/environment references
prototype before full production
```

---

## STEP 5: Build The Shot Sequence

Create the minimum number of shots needed to make the beats clear, engaging, and generatable.

Each shot proposal should define:

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

Do not fully direct the camera here unless the sequence meaning depends on it.
Detailed camera choreography belongs to the downstream single-shot director.

### Shot Function

Prefer a clear functional label such as:

- reveal;
- discovery;
- decision;
- approach;
- confrontation;
- pursuit;
- escape;
- activation;
- transformation;
- impact;
- payoff;
- aftermath;
- scale reveal;
- transition only when genuinely necessary.

If adjacent shots perform essentially the same function, test whether they should be merged or one should be removed.

### Shot Deletion Test

For every shot ask:

> If this shot is removed and the next shot begins from its exit state, what real narrative or emotional information is lost?

Delete or merge shots whose answer is only:

- "we no longer see the character walk there";
- "we miss the hand reaching";
- "the transition feels less complete";
- "it gives us another angle."

Coverage is not purpose.

### No Hidden Montage Inside One Shot

Reject a shot that implicitly requires:

- hard cuts;
- multiple locations;
- major time jumps;
- several unrelated camera setups;
- several independent dramatic events.

Split those at the story/sequence level.

---

## STEP 6: Preserve H3Mise State Correctly

Use H3Mise concepts instead of inventing a second continuity system.

### NarrativeState

Story-level truth such as:

- what happened;
- what a character knows;
- relationship state;
- current goal;
- commitment;
- important off-screen consequence.

The Story Director may propose NarrativeState changes.

### Planned VisualContinuity

Shot planning may define:

- costume;
- held item;
- visible damage;
- position/facing;
- location;
- time/weather;
- prop state;
- screen direction;
- other visible state required by the next shot.

### Actual VisualContinuity

Do not claim generated video actually matches the planned state before a Take is selected and reviewed.

A selected Take is the source for actual visual continuity.

### Assets And States

Do not create a new Entity just because an existing character has a temporary state.

Prefer:

```text
MISE
+
state: holding reel
```

over:

```text
MISE
MISE holding reel
MISE sitting
MISE pressing button
```

Use a separate visual state reference only when generation consistency genuinely requires one.

---

## STEP 7: Run The Shot Critic

Before handoff, review the sequence once.

Check:

### Necessity

Every shot has a real dramatic, informational, emotional, spatial, or causal job.

### Progress

The sequence does not repeatedly show:

```text
walk
look
approach
reach
pick up
turn
walk
```

unless the progression itself carries suspense or comedy.

### Variation With Purpose

Avoid mechanical shot-size variety.
A wider, closer, lower, or moving camera is useful only when it changes audience understanding or experience.

### H3 Load

No shot is overloaded merely because the full prose scene contained many actions.

### Continuity

Entry state matches the previous exit state unless the cut intentionally advances state.

### Screen Direction

Unexpected direction reversal should be intentional or flagged for downstream preflight.

### Reference Strategy

References solve a known need rather than being added by habit.

### Ending

The last shot should deliver payoff, consequence, unresolved tension, or aftertaste.
Do not end only because the requested duration has been reached.

---

# Handoff Contract

Once the Shot Sequence passes, hand each shot to the single-shot H3 direction layer.

The handoff should contain only what the downstream director needs:

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

The downstream H3 director decides:

- detailed blocking;
- camera geometry;
- dominant camera behavior;
- performance mechanics;
- anticipation / action / follow-through / recovery;
- exact reference binding strategy when needed;
- final DirectorPlan detail;
- prompt compilation.

Do not duplicate those responsibilities here.

---

# H3Mise Agent Integration

When this Skill is used by an agent that is actively driving H3Mise:

- Treat H3Mise project data as canonical.
- Use existing `story_to_beats`, `beats_to_shots`, `auto_director`, or equivalent delegated prepare/apply flows when they match the task.
- Do not bypass H3Mise validation by writing project records directly.
- Do not start a paid image or video render merely because a story or sequence is approved.
- Storyboard generation remains optional and paid when a real image provider is used.
- Storyboard panels are planning assets until explicitly promoted to references.
- Do not overwrite a Take; a new render creates a new Take.
- Do not infer Actual VisualContinuity from the plan. Commit actual state only after a selected Take is reviewed.
- If current H3 provider capabilities cannot express a desired mode, keep the creative intent but mark the production strategy unresolved or choose a supported alternative without pretending equivalence.

---

# Output Modes

Return only the artifact needed for the current request.

## Story Repair

Return:

- repaired story spine;
- changed beats;
- short reason for each major repair;
- unresolved assumptions.

## New Episode / Short

Return:

- concise premise;
- causal story spine;
- StoryBeat plan;
- Shot Sequence;
- H3 risk/adaptation notes only where useful.

## Existing Beats -> Shots

Do not rewrite approved story unnecessarily.

Return:

- minimal shot sequence;
- skipped/elided processes;
- continuity handoff;
- H3 risks.

## Diagnose A Weak Auto-Generated Episode

Prioritize:

1. earliest causal weakness;
2. passive protagonist;
3. missing pressure or reversal;
4. procedural/meaningless beats;
5. repetitive shots;
6. H3-overloaded actions;
7. weak payoff.

Then propose the smallest upstream repair that fixes the downstream sequence.

---

# Final Gates

Before marking the story/sequence ready:

## Story Gate

- protagonist action materially drives events;
- "why now" is clear;
- resistance is real;
- important decisions survive the obvious-alternative test;
- at least one meaningful pressure/tactic/value shift occurs when the format supports it;
- ending/payoff comes from earlier action and setup;
- major beats create state changes;
- the story can be understood without director commentary.

## H3 Gate

- each shot is one clear continuous event by default;
- no hidden montage or accidental multi-shot prompt;
- fragile processes are skipped, split, reframed, or reference-assisted;
- every shot has an entry and exit state;
- continuity needs are explicit;
- HIGH-risk shots include a concrete adaptation strategy;
- no shot exists only for coverage;
- the sequence is ready to hand off to single-shot direction.

If either gate fails, return to the earliest broken decision instead of polishing downstream prompts.

---

# Guiding Principles

> **Tell the story through consequential visible change.**

> **Show what matters; skip what merely connects it.**

> **Do not make H3 perform a difficult process when a clean state transition tells the same story better.**

> **Do not simplify away the one action that actually carries the drama.**

> **Every shot must earn its generation cost.**
