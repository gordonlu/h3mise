# H3 Story State Engine

Use this reference after the story exists. It verifies state continuity across StoryBeats and Shots without creating a second state system beside H3Mise.

## Source Of Truth

Use H3Mise concepts directly:

- `NarrativeState` for story facts;
- `VisualContinuityState` for planned or observed visible continuity;
- `CharacterState` for a character's current visual state;
- Entity / prop state for story-relevant object state;
- Shot entry / exit state for production handoff;
- Selected Take for actual generated visual continuity.

Do not invent a parallel ledger that conflicts with project data.

## NarrativeState

NarrativeState may track facts such as:

- what happened;
- what a character knows or believes;
- relationship state;
- current goal;
- commitment;
- important off-screen consequence.

NarrativeState comes from story logic and user decisions.

Do not infer NarrativeState as truth from generated pixels.

## Planned Visual Continuity

Before generation, a Shot may require visible state such as:

- character appearance / CharacterState;
- costume;
- held item;
- visible injury or damage;
- location;
- time / weather;
- prop state;
- screen direction;
- facing;
- vehicle state;
- other visible continuity required by adjacent shots.

This is planned state, not proof of what the model actually generated.

## Actual Visual Continuity

Actual visual continuity comes only from a reviewed Selected Take.

Never write:

```text
planned = actual
```

without reviewing the generated result.

If the Take drifts, preserve the story truth and record the visual discrepancy instead of silently changing NarrativeState to match the mistake.

## Beat State Chain

Each consequential beat should be reconstructable as:

```text
entry state
-> trigger
-> character action or refusal
-> result
-> exit state
-> direct necessity / opportunity / constraint for next beat
```

Hard checks:

- A character cannot use knowledge they never obtained.
- A prop cannot change holder or state without a cause.
- A relationship cannot reset between scenes.
- A visible injury or costume state cannot disappear without explanation when continuity matters.
- A later reveal must be compatible with earlier observable facts.
- A next beat must inherit the previous exit state unless the cut intentionally advances state.

## Character Strategy Check

For an important behavioral turn, track:

```text
current goal
current knowledge / belief
current tactic
new stimulus / failed tactic / changed cost
new tactic
result
```

No major strategy shift should happen only because the plot needs it.

## Prop And Object State

Track only consequential props.

Useful states include:

- location;
- holder;
- installed / removed;
- open / closed;
- intact / damaged;
- active / inactive;
- discovered / hidden.

Do not turn every background object into tracked state.

## Shot Entry / Exit Contract

A Shot handoff should state only what matters:

```yaml
entry:
  narrative:
  visible:

event:
  primary_change:

exit:
  narrative:
  visible:
```

If the next Shot can begin from the exit state without showing a fragile transition, that is often preferable to forcing the transition on-screen.

## State Deletion Test

Delete a beat or shot mentally.

If all later states, decisions, and payoffs remain equally plausible, the deleted unit may not be carrying story causality.

## Final State Gate

Before handoff:

- NarrativeState is internally consistent.
- Planned VisualContinuity is explicit where needed.
- Planned and actual continuity are not conflated.
- Character knowledge is traceable.
- Consequential prop states are traceable.
- Shot exits are usable as next-shot entries.
- No invisible state jump is being hidden by decorative direction.
