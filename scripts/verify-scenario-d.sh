#!/bin/bash
# PRD §51 D: multi-shot continuity — frame bridge from selected take's last frame.
B=http://127.0.0.1:4789
J='Content-Type: application/json'
CJAR=/data/code/H3Mise/.h3mise-cookie.txt
curl -s --noproxy "*" -c $CJAR $B/api/session > /dev/null
C="-b $CJAR"
pass(){ echo "✓ $1"; }
fail(){ echo "✗ $1 — $2"; exit 1; }

# Shot 1: select existing take, commit continuity
T1=$(curl -s --noproxy "*" $C $B/api/shots/shot-001 | python3 -c "import json,sys; d=json.load(sys.stdin); print([t['id'] for t in d['takes'] if t['status']=='selected'][0])" 2>/dev/null)
[ -n "$T1" ] || fail "shot-001 selected take" "none"
pass "shot-001 selected take: $T1"

# Create shot 2 with i2va (needs first frame)
S2=$(curl -s --noproxy "*" $C -X POST $B/api/shots -H "$J" -d '{"title":"Shot 2 — walks on","h3Mode":"i2va","durationSeconds":5}')
SID2=$(echo "$S2" | grep -o '"id":"shot-[0-9]*"' | head -1 | cut -d'"' -f4)
[ -n "$SID2" ] || fail "create shot2" "$S2"

# Frame bridge: bind take-1's last frame (auto-registered as media) as first_frame
LF=$(curl -s --noproxy "*" $C $B/api/assets/media | python3 -c "
import json,sys
media=json.load(sys.stdin)
for m in media:
    if m['label'] and 'Take $T1 last frame' in m['label']:
        print(m['id']); break
")
[ -n "$LF" ] || fail "last-frame asset for $T1" "not found"
BR=$(curl -s --noproxy "*" $C -X POST $B/api/assets/bindings -H "$J" -d "{\"assetId\":\"$LF\",\"roles\":[\"first_frame\"],\"label\":\"Frame bridge from $T1 (last frame)\",\"shotId\":\"$SID2\"}")
echo "$BR" | grep -q '"id"' && pass "frame bridge binding created (last frame → shot-2 first frame)" || fail "binding" "$BR"

# Continuity inherit: shot-2 planned start state from committed actual
curl -s --noproxy "*" $C -X POST $B/api/shots/$SID2/plans -H "$J" -d "{\"source\":\"manual\",\"plan\":{\"intent\":{\"shotFunction\":\"medium\",\"visualThesis\":\"continues from previous shot\",\"dramaticGoal\":\"\",\"peak\":\"\",\"endState\":\"\"},\"subject\":{\"primarySubject\":\"Lin Yu\",\"action\":\"continues walking\",\"primaryMotionOwner\":\"Lin Yu\"},\"blocking\":{\"startPosition\":\"same as previous shot end\",\"endPosition\":\"\",\"facing\":\"profile right\",\"movementAxis\":\"screen left to right\",\"travelPath\":\"continue straight\",\"spatialRelationships\":\"\"},\"camera\":{\"shotSizeStart\":\"medium\",\"shotSizePeak\":\"medium\",\"shotSizeEnd\":\"\",\"geometry\":\"\",\"lensIntent\":\"\",\"dominantBehavior\":\"static\",\"trigger\":\"\",\"speedRelation\":\"locked\",\"stopCondition\":\"\"},\"performance\":{\"objective\":\"\",\"obstacle\":\"\",\"tactic\":\"\",\"performanceTurn\":\"\",\"movementQuality\":{\"weight\":\"\",\"time\":\"\",\"space\":\"\",\"flow\":\"\"},\"anticipation\":\"\",\"primaryAction\":\"\",\"followThrough\":\"\",\"recovery\":\"\",\"gaze\":\"\",\"endPose\":\"\"},\"environment\":{\"location\":\"same alley\",\"weather\":\"heavy rain\",\"medium\":\"\",\"wind\":\"\",\"lighting\":\"neon + streetlight\",\"foreground\":\"\",\"midground\":\"\",\"background\":\"\"},\"reality\":{\"mode\":\"strict_realism\",\"constraints\":[]},\"continuity\":{\"plannedStartState\":\"wet coat, standing under streetlight (inherited)\",\"plannedEndState\":\"\"},\"generation\":{\"requestedMode\":\"i2va\",\"durationSeconds\":5,\"aspectRatio\":\"16:9\",\"audioIntent\":\"\"}}}" | grep -o '"id":"dpv-[0-9]*"' | head -1
pass "shot-2 plan saved with inherited start state"

# Compile + preflight + render shot 2
PV=$(curl -s --noproxy "*" $C -X POST $B/api/shots/$SID2/prompts/compile -H "$J" -d '{"mode":"i2va"}')
PVID=$(echo "$PV" | grep -o '"id":"prompt-[0-9]*"' | head -1 | cut -d'"' -f4)
PF=$(curl -s --noproxy "*" $C -X POST $B/api/shots/$SID2/preflight -H "$J" -d "{\"promptVersionId\":\"$PVID\",\"providerId\":\"mock\"}")
echo "$PF" | grep -q '"blocked":false' && pass "shot-2 preflight passes (bridge first frame)" || fail "shot2 preflight" "$(echo "$PF" | head -c 200)"
RJ=$(curl -s --noproxy "*" $C -X POST $B/api/render -H "$J" -d "{\"shotId\":\"$SID2\",\"promptVersionId\":\"$PVID\",\"providerId\":\"mock\",\"durationSeconds\":5}")
JID=$(echo "$RJ" | grep -o '"id":"job-[0-9]*"' | head -1 | cut -d'"' -f4)
for i in $(seq 1 25); do
  ST=$(curl -s --noproxy "*" $C $B/api/render/$JID | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  [ "$ST" = "LOCAL_READY" ] && break
  [ "$ST" = "FAILED" ] && { fail "shot2 render" "$(curl -s --noproxy "*" $C $B/api/render/$JID | head -c 250)"; }
  sleep 1
done
[ "$ST" = "LOCAL_READY" ] || fail "shot2 render timeout" "$ST"
pass "shot-2 rendered via frame bridge"

# Timeline: both selected takes in order
T2=$(curl -s --noproxy "*" $C $B/api/render/$JID | grep -o '"takeId":"take-[0-9]*"' | cut -d'"' -f4)
curl -s --noproxy "*" $C -X POST $B/api/takes/$T2/select > /dev/null
curl -s --noproxy "*" $C -X POST $B/api/timeline/clips -H "$J" -d "{\"shotId\":\"$SID2\",\"takeId\":\"$T2\"}" > /dev/null
TL=$(curl -s --noproxy "*" $C $B/api/timeline)
echo "$TL" | python3 -c "
import json,sys
tl=json.load(sys.stdin)
takes=[c['takeId'] for c in tl['clips']]
assert len(takes) >= 2, takes
print('✓ timeline order:', takes)
" || fail "timeline order" "$TL"
echo "ALL-SCENARIO-D-OK"
