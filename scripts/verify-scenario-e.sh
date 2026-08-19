#!/bin/bash
# PRD §51 E: failure repair — tag failure, change reference role, new PromptVersion, new render, A/B.
B=http://127.0.0.1:4789
J='Content-Type: application/json'
CJAR=/data/code/H3Mise/.h3mise-cookie.txt
curl -s --noproxy "*" -c $CJAR $B/api/session > /dev/null
C="-b $CJAR"
pass(){ echo "✓ $1"; }
fail(){ echo "✗ $1 — $2"; exit 1; }
SID=shot-001

# 1. Find a candidate take and tag identity_drift
TAKES=$(curl -s --noproxy "*" $C $B/api/shots/$SID)
TID=$(echo "$TAKES" | python3 -c "
import json,sys
d=json.load(sys.stdin)
cand=[t for t in d['takes'] if t['status']=='candidate']
print(cand[0]['id'] if cand else d['takes'][0]['id'])
")
[ -n "$TID" ] || fail "take lookup" "$TAKES"
TAG=$(curl -s --noproxy "*" $C -X PATCH $B/api/takes/$TID -H "$J" -d '{"failureTags":["identity_drift","camera"]}')
echo "$TAG" | grep -q '"identity_drift"' && pass "take $TID tagged identity_drift + camera" || fail "tag" "$TAG"

# 2. Modify reference role: add identity role to the first-frame binding
BID=$(curl -s --noproxy "*" $C $B/api/shots/$SID | python3 -c "
import json,sys
d=json.load(sys.stdin)
b=[x for x in d['bindings'] if x['roles'] and 'first_frame' in x['roles']]
print(b[0]['id'] if b else '')
")
[ -n "$BID" ] || fail "binding lookup" "no first_frame binding"
BR=$(curl -s --noproxy "*" $C -X PATCH $B/api/assets/bindings/$BID -H "$J" -d '{"roles":["first_frame","identity"],"preserve":["face identity","wet hair"]}')
echo "$BR" | grep -q '"identity"' && pass "reference roles updated: first_frame + identity (preserve set)" || fail "binding update" "$BR"

# 3. New PromptVersion (recompile — never overwrites)
BEFORE=$(curl -s --noproxy "*" $C $B/api/shots/$SID/prompts | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
PV=$(curl -s --noproxy "*" $C -X POST $B/api/shots/$SID/prompts/compile -H "$J" -d '{"mode":"i2va"}')
PVID=$(echo "$PV" | grep -o '"id":"prompt-[0-9]*"' | head -1 | cut -d'"' -f4)
AFTER=$(curl -s --noproxy "*" $C $B/api/shots/$SID/prompts | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
[ "$AFTER" -gt "$BEFORE" ] && pass "new PromptVersion created ($BEFORE → $AFTER, history preserved)" || fail "prompt versioning" "$BEFORE/$AFTER"

# 4. New render → new take (A/B compare with the old one)
RJ=$(curl -s --noproxy "*" $C -X POST $B/api/render -H "$J" -d "{\"shotId\":\"$SID\",\"promptVersionId\":\"$PVID\",\"providerId\":\"mock\",\"durationSeconds\":5}")
JID=$(echo "$RJ" | grep -o '"id":"job-[0-9]*"' | head -1 | cut -d'"' -f4)
for i in $(seq 1 25); do
  ST=$(curl -s --noproxy "*" $C $B/api/render/$JID | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  [ "$ST" = "LOCAL_READY" ] && break
  [ "$ST" = "FAILED" ] && { fail "repair render" "$(curl -s --noproxy "*" $C $B/api/render/$JID | head -c 250)"; }
  sleep 1
done
[ "$ST" = "LOCAL_READY" ] || fail "repair render timeout" "$ST"
pass "repair render done (job $JID)"

# 5. Verify two takes with different prompt versions exist (A/B traceability)
TRACE=$(curl -s --noproxy "*" $C $B/api/shots/$SID | python3 -c "
import json,sys
d=json.load(sys.stdin)
takes=d['takes']
pvs={t['promptVersionId'] for t in takes}
print(len(pvs), sorted(pvs))
")
NPV=$(echo "$TRACE" | cut -d' ' -f1)
[ "$NPV" -ge 2 ] && pass "A/B: takes trace to $NPV distinct PromptVersions ($TRACE)" || fail "A/B trace" "$TRACE"
echo "ALL-SCENARIO-E-OK"
