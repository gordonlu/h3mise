#!/bin/bash
# PRD §51 acceptance scenarios B (external AI paste) and C (Raw Prompt).
B=http://127.0.0.1:4789
J='Content-Type: application/json'
CJAR=/data/code/H3Mise/.h3mise-cookie.txt
curl -s --noproxy "*" -c $CJAR $B/api/session > /dev/null
C="-b $CJAR"
pass(){ echo "✓ $1"; }
fail(){ echo "✗ $1 — $2"; exit 1; }

# --- Scenario C: Raw Prompt (no DirectorPlan needed) -----------------------
S=$(curl -s --noproxy "*" $C -X POST $B/api/shots -H "$J" -d '{"title":"Raw prompt shot","h3Mode":"t2va","durationSeconds":5}')
SID=$(echo "$S" | grep -o '"id":"shot-[0-9]*"' | head -1 | cut -d'"' -f4)
[ -n "$SID" ] || fail "create raw shot" "$S"
pass "raw shot created $SID (no plan)"

RAWP='integrated_multimodal_description:
Subject: A lone cyclist crossing a wet bridge at dusk.
Action: Pedals steadily, glances back once.
Camera: slow lateral tracking shot, locked to subject speed.
Location: city bridge, light rain, sodium lamps.
Reality: strict realism.
overall_soundscape: rain, distant traffic, bicycle chain.
non_diegetic_music: sparse ambient pad.'
PV=$(curl -s --noproxy "*" $C -X POST $B/api/shots/$SID/prompts/raw -H "$J" -d "$(python3 -c "import json,sys; print(json.dumps({'text': sys.stdin.read(), 'mode': 't2va'}))" <<< "$RAWP")")
PVID=$(echo "$PV" | grep -o '"id":"prompt-[0-9]*"' | head -1 | cut -d'"' -f4)
[ -n "$PVID" ] || fail "raw prompt import" "$PV"
pass "raw prompt imported $PVID (source: $(echo "$PV" | grep -o '"source":"[^"]*"' | cut -d'"' -f4))"

# No DirectorPlan required: plans list must be empty
PLANS=$(curl -s --noproxy "*" $C $B/api/shots/$SID/plans)
echo "$PLANS" | grep -q '\[\]' && pass "raw path works without DirectorPlan" || fail "raw path plan check" "$PLANS"

PF=$(curl -s --noproxy "*" $C -X POST $B/api/shots/$SID/preflight -H "$J" -d "{\"promptVersionId\":\"$PVID\",\"providerId\":\"mock\"}")
echo "$PF" | grep -q '"blocked":false' && pass "raw prompt preflight passes (t2va, no refs)" || fail "raw preflight" "$(echo "$PF" | head -c 200)"

# --- Scenario B: external AI paste (YAML DirectorPlan) ---------------------
S2=$(curl -s --noproxy "*" $C -X POST $B/api/shots -H "$J" -d '{"title":"External AI shot","h3Mode":"i2va"}')
SID2=$(echo "$S2" | grep -o '"id":"shot-[0-9]*"' | head -1 | cut -d'"' -f4)

YAML='intent:
  shot_function: closeup
  visual_thesis: A hand reaches for a door handle in slow rain
  dramatic_goal: tension before opening
  peak: fingers touch the cold metal
  end_state: door begins to open
subject:
  primary_subject: Woman hand
  action: reaches, hesitates, grips
  primary_motion_owner: Hand
camera:
  shot_size_start: closeup
  shot_size_peak: extreme closeup
  shot_size_end: closeup
  geometry: 50mm at hand height, slight angle
  dominant_behavior: static
  trigger: none
  speed_relation: locked
  stop_condition: grip completes
performance:
  objective: open the door quietly
  obstacle: fear of what is inside
  tactic: slow steady reach
  performance_turn: hesitation before grip
  primary_action: reach and grip
  gaze: toward the door
  end_pose: gripping handle
environment:
  location: apartment hallway, night
  weather: rain on window
  medium: air, wet window glass
  lighting: single warm bulb
reality:
  mode: strict_realism
generation:
  requested_mode: i2va
  duration_seconds: 5
  aspect_ratio: "16:9"'
PARSE=$(curl -s --noproxy "*" $C -X POST $B/api/shots/$SID2/plans/parse -H "$J" -d "$(python3 -c "import json,sys; print(json.dumps({'text': sys.stdin.read()}))" <<< "$YAML")")
echo "$PARSE" | grep -q '"ok":true' || fail "yaml parse" "$PARSE"
pass "external AI YAML parsed (preview available)"
PLAN=$(echo "$PARSE" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['plan']))")
DPV=$(curl -s --noproxy "*" $C -X POST $B/api/shots/$SID2/plans -H "$J" -d "{\"source\":\"external_ai\",\"plan\":$PLAN}")
echo "$DPV" | grep -q '"id":"dpv-' && pass "external plan applied as new version (source=external_ai)" || fail "apply plan" "$DPV"

# Context package copy
PKG=$(curl -s --noproxy "*" $C -X POST $B/api/shots/$SID2/context-package -H "$J" -d '{"task":"Plan Shot"}')
echo "$PKG" | grep -q '"director_plan"' && pass "context package contains director_plan" || fail "context package" "$(echo "$PKG" | head -c 150)"

echo "ALL-SCENARIOS-BC-OK"
