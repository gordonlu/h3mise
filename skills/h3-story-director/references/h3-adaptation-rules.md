# MiniMax H3 Adaptation Rules

Use this reference after the story beats are approved and before final Shot sequencing.

The purpose is to preserve dramatic function while adapting the visible execution to MiniMax H3.

## Core Production Rule

Default:

```text
one H3 generation
=
one continuous shot
=
one primary visible event
```

A shot can contain anticipation, action, follow-through, and recovery, but should not secretly contain several locations, time jumps, hard cuts, or unrelated dramatic events.

## Choose One Adaptation Strategy

### DIRECT

Use when the event can be expressed clearly as one continuous H3 shot.

Good candidates:

- wake / notice / react;
- approach / stop;
- run through a readable space;
- vehicle acceleration along a clear path;
- one reveal;
- one activation;
- one transformation;
- one confrontation beat.

### ELIDE

Use when the process is fragile or boring but the resulting state matters.

Example:

```text
before: film reel lies on the table
after: MISE carries the reel into the corridor
```

Do not generate every reach / grasp / lift / turn step unless the pickup itself carries drama.

### SPLIT

Use when the event matters but one shot contains too many changes.

Split by dramatic function, not arbitrary duration.

Example:

```text
Shot A: attacker commits to the strike.
Shot B: defender evades and counters.
```

Do not split merely to make the sequence look cinematic.

### REFERENCE-ASSIST

Use when stronger conditioning is justified.

Possible roles:

- identity;
- environment;
- prop;
- motion;
- first frame;
- last frame;
- composition.

Bind references to a specific need. Do not add every available asset by habit.

### UNRESOLVED

Use when the event is dramatically essential but current H3 capability or available references do not make the execution credible.

Do not pretend it is production-ready.

Propose the smallest useful test.

## H3 Risk Factors

Use LOW / MEDIUM / HIGH as production warnings.

Consider:

- active subject count;
- body overlap / occlusion;
- close-contact interaction;
- precise hand-object contact;
- multiple simultaneous action owners;
- crowded or moving background;
- rapid facing / position changes;
- long multi-step action chain;
- demanding identity continuity;
- long multi-speaker lip-sync;
- exact text / UI content;
- hidden cuts inside the description.

HIGH does not mean "bad shot". It means the shot needs an adaptation strategy.

## Motion Reference Reality

Fast motion is not automatically unsuitable.

Reference quality often drops when motion is entangled with:

- multiple people;
- complex moving background;
- heavy occlusion;
- frequent cuts;
- strong camera movement competing with subject motion.

A clean single-subject fast dance can be more useful than a slower but visually entangled action clip.

For complex references, prefer:

```text
trim to one continuous segment
-> remove irrelevant cuts
-> choose the cleanest readable motion section
-> bind only the intended reference role
```

## First / Last Frame Strategy

Use first-frame or first/last-frame guidance when the start or end state matters more than exact intermediate choreography.

Good uses:

- start and end composition;
- entering / leaving a stable pose;
- changing a prop or environmental state;
- continuity handoff between shots.

Do not expect a frame pair to guarantee an exact physical path when the intermediate action is itself difficult.

## Model-Difficulty Preservation Rule

For every difficult event ask:

1. Does the action itself carry evidence, contact, injury, choice, reveal, or payoff?
2. Or does only the resulting state matter?

If only the result matters:

- ELIDE or change coverage.

If the visible action matters:

- keep the dramatic function;
- simplify surrounding action;
- split the event;
- use a stronger reference;
- change coverage;
- prototype the risky beat.

Never replace an essential action with an easier but dramatically different event just to make generation convenient.

## Shot Density Check

Reject or split a shot that requires too many of these at once:

- enter;
- pick up;
- turn;
- speak;
- dodge;
- change prop;
- change facing;
- reveal another subject;
- move camera dramatically;
- exit.

A useful H3 shot has a dominant event and a readable end state.

## Adaptation Output

For each production beat, record:

```text
strategy: DIRECT / ELIDE / SPLIT / REFERENCE-ASSIST / UNRESOLVED
reason:
preserved dramatic function:
reference need:
entry state:
exit state:
risk:
```

Do not expand this into a final H3 prompt. Detailed single-shot direction belongs downstream.
