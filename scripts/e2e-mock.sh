#!/bin/bash
B=http://127.0.0.1:4789
J='Content-Type: application/json'
COOKIE="-b /data/code/H3Mise/.h3mise-cookie.txt"
pass(){ echo "✓ $1"; }
fail(){ echo "✗ $1 — $2"; exit 1; }
SID=$(curl -s --noproxy "*" $COOKIE $B/api/shots | grep -o '"id":"shot-001"' | head -1 | cut -d'"' -f4)

# Upload first frame
UP=$(curl -s --noproxy "*" $COOKIE -X POST $B/api/assets/media/upload -F "file=@/data/code/H3Mise/scripts/first-frame.png;type=image/png" -F "label=Alley first frame")
AID=$(echo "$UP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$AID" ] || fail "upload media" "$UP"
pass "media uploaded $AID"

# Bind as first_frame for the shot
BR=$(curl -s --noproxy "*" $COOKIE -X POST $B/api/assets/bindings -H "$J" -d "{\"assetId\":\"$AID\",\"roles\":[\"first_frame\"],\"label\":\"Alley night first frame\",\"shotId\":\"$SID\"}")
BID=$(echo "$BR" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$BID" ] || fail "create binding" "$BR"
pass "binding created $BID"

# Preflight should pass now
PVID=$(curl -s --noproxy "*" $COOKIE $B/api/shots/$SID/prompts | grep -o '"id":"prompt-001"' | head -1 | cut -d'"' -f4)
PF=$(curl -s --noproxy "*" $COOKIE -X POST $B/api/shots/$SID/preflight -H "$J" -d "{\"promptVersionId\":\"$PVID\",\"providerId\":\"mock\"}")
echo "$PF" | grep -q '"blocked":false' && pass "preflight passes with first frame" || fail "preflight" "$(echo "$PF" | head -c 200)"

# Render (mock) — no preflight block
R=$(curl -s --noproxy "*" $COOKIE -X POST $B/api/render -H "$J" -d "{\"shotId\":\"$SID\",\"promptVersionId\":\"$PVID\",\"providerId\":\"mock\",\"durationSeconds\":5}")
JID=$(echo "$R" | grep -o '"id":"job-[0-9]*"' | head -1 | cut -d'"' -f4)
[ -n "$JID" ] || fail "render submit" "$R"
pass "render job $JID submitted"

# Wait for mock render (~6s)
for i in $(seq 1 25); do
  JOB=$(curl -s --noproxy "*" $COOKIE $B/api/render/$JID)
  ST=$(echo "$JOB" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  [ "$ST" = "LOCAL_READY" ] && break
  [ "$ST" = "FAILED" ] && { fail "render failed" "$(echo "$JOB" | head -c 300)"; }
  sleep 1
done
[ "$ST" = "LOCAL_READY" ] || fail "render timeout" "$ST"
pass "render LOCAL_READY"

# Take exists with frames
TID=$(curl -s --noproxy "*" $COOKIE $B/api/render/$JID | grep -o '"takeId":"[^"]*"' | head -1 | cut -d'"' -f4)
TK=$(curl -s --noproxy "*" $COOKIE $B/api/takes/$TID)
echo "$TK" | grep -q '"posterPath"' && pass "take $TID with poster"
echo "$TK" | grep -q '"firstFramePath"' && pass "take has first frame (frame bridge)"
echo "$TK" | grep -q '"lastFramePath"' && pass "take has last frame"

# Take video served with Range (A/B compare support)
RANGE=$(curl -s --noproxy "*" -o /dev/null -w "%{http_code}" -H "Range: bytes=0-1023" $COOKIE $B/api/takes/$TID/video)
[ "$RANGE" = "206" ] && pass "take video Range request → 206" || fail "range" "$RANGE"
FULL=$(curl -s --noproxy "*" -o /dev/null -w "%{http_code}" $COOKIE $B/api/takes/$TID/video)
[ "$FULL" = "200" ] && pass "take video full request → 200" || fail "full" "$FULL"

# Select take → continuity commit → timeline → export
SEL=$(curl -s --noproxy "*" $COOKIE -X POST $B/api/takes/$TID/select)
echo "$SEL" | grep -q '"selected"' && pass "take selected"
SH=$(curl -s --noproxy "*" $COOKIE $B/api/shots/$SID | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "$SH" | grep -q 'SELECTED' && pass "shot status SELECTED" || fail "shot status" "$SH"

CON=$(curl -s --noproxy "*" $COOKIE -X POST $B/api/continuity/commit -H "$J" -d "{\"shotId\":\"$SID\",\"scope\":\"visual\",\"kind\":\"actual\",\"sourceTakeId\":\"$TID\",\"state\":{\"location\":\"narrow city alley\",\"weather\":\"heavy rain\",\"timeOfDay\":\"night\",\"screenDirection\":\"left-to-right\",\"facing\":\"profile right\",\"costume\":{\"lin_yu\":\"wet coat\"}}}")
echo "$CON" | grep -q '"id"' && pass "actual visual continuity committed"

# Timeline clip (only selected takes allowed)
CL=$(curl -s --noproxy "*" $COOKIE -X POST $B/api/timeline/clips -H "$J" -d "{\"shotId\":\"$SID\",\"takeId\":\"$TID\",\"trimIn\":0,\"trimOut\":5}")
echo "$CL" | grep -q '"id"' && pass "timeline clip added" || fail "clip" "$CL"

EX=$(curl -s --noproxy "*" $COOKIE -X POST $B/api/timeline/export -H "$J" -d '{"title":"E2E export"}')
EJOB=$(echo "$EX" | grep -o '"jobId":"job-[a-z0-9]*"' | head -1 | cut -d'"' -f4)
[ -n "$EJOB" ] || fail "export submit" "$EX"
for i in $(seq 1 60); do
  EJ=$(curl -s --noproxy "*" $COOKIE $B/api/jobs/$EJOB)
  EST=$(echo "$EJ" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  [ "$EST" = "done" ] && break
  [ "$EST" = "failed" ] && { fail "export failed" "$(echo "$EJ" | head -c 300)"; }
  sleep 2
done
[ "$EST" = "done" ] || fail "export timeout" "$EST"
echo "$EJ" | grep -q '"relPath"' && pass "timeline exported via background job: $(echo "$EJ" | grep -o '"relPath":"[^"]*"' | cut -d'"' -f4)" || fail "export result" "$(echo "$EJ" | head -c 300)"
echo "ALL-E2E-OK"
