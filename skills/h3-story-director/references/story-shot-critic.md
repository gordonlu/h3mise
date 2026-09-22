# H3 Story And Shot Critic

Use this reference as a compact self-review after story creation and again after Shot sequencing.

It is not a second writer. It should identify the earliest weak decision and request the smallest useful repair.

## Story Critic

Check in this order.

### 1. Causal Break

Can the story be retold as:

```text
condition
-> action / refusal
-> consequence
-> changed state
-> next necessity
```

Flag the earliest transition that works only as "and then".

### 2. Passive Protagonist

If the protagonist can do almost nothing and the main events still happen, repair the story before polishing scenes.

### 3. Obvious Alternative

Name the easiest believable alternative available to the character.

If it solves the problem and the story does not block or reject it credibly, flag author convenience.

### 4. Pressure / Strategy Shift

Does pressure actually change what the character can or will do?

If every beat uses the same tactic with more activity, the middle is likely flat.

### 5. Payoff

Does the ending emerge from earlier action, setup, relationship, object, or choice?

A late convenience is not payoff.

### 6. Generated Neatness

Flag:

- theme speeches;
- over-explained motives;
- mechanically perfect setups;
- everyone speaking in the same polished voice;
- conflict resolved with no human residue;
- every beat feeling like one line in a checklist.

## Shot Critic

### 1. Deletion Test

Ask:

> If this shot is removed and the next shot starts from this shot's exit state, what real loss occurs?

Real loss may be:

- causal information;
- emotional turn;
- suspense;
- reveal;
- relationship change;
- spatial fact needed later;
- payoff;
- essential performance event.

Not enough:

- "we no longer see them walk there";
- "we miss another angle";
- "the transition feels less complete";
- "it is more cinematic."

### 2. Procedural-Shot Test

Watch for sequences such as:

```text
walk
-> look
-> approach
-> reach
-> pick up
-> turn
-> walk
```

If these steps do not carry suspense, comedy, danger, information, or relationship change, collapse them into fewer shots and use state transition.

### 3. Function Repetition

If adjacent shots serve essentially the same function, test merge/delete.

Example:

```text
approach
approach
approach
```

is usually weaker than one clear approach shot followed by a new function.

### 4. H3 Overload

Flag a shot that hides:

- several dramatic events;
- several locations;
- multiple hard cuts;
- too many action owners;
- too many contact-dependent steps;
- a camera plan competing with complex subject action.

Return it to H3 adaptation instead of making the prompt longer.

### 5. Continuity

Check:

- entry state inherits previous exit state;
- held props are correct;
- screen direction reversal is intentional or flagged;
- character state is not reset;
- next shot does not assume an unseen action that mattered.

### 6. Reference Discipline

A reference should solve a known production need.

Flag reference accumulation that has no clear role.

## Critic Output

Keep it short:

```text
BLOCKER:
earliest broken decision

WHY IT MATTERS:
downstream effect

SMALLEST REPAIR:
specific beat / shot change
```

When there is no blocker, report only the most consequential improvement.

Do not generate a long lecture, film-theory essay, or complete rewrite unless requested.
