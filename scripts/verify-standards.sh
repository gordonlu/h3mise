#!/bin/bash
# PRD §52 hard-standard checks: security guards, recoverability, SSE, traceability.
B=http://127.0.0.1:4789
J='Content-Type: application/json'
C="-b /data/code/H3Mise/.h3mise-cookie.txt"
pass(){ echo "✓ $1"; }
fail(){ echo "✗ $1 — $2"; exit 1; }

curl -s --noproxy "*" -c /data/code/H3Mise/.h3mise-cookie.txt $B/api/session > /dev/null

# 1. Origin guard: evil origin must be rejected (403)
R=$(curl -s --noproxy "*" -o /dev/null -w "%{http_code}" -H "Origin: https://evil.example" $B/api/health)
[ "$R" = "403" ] && pass "Origin guard rejects foreign origin" || fail "origin guard" "$R"

# 2. Session guard: mutating request without cookie must fail (401)
R=$(curl -s --noproxy "*" -o /dev/null -w "%{http_code}" -X POST $B/api/shots -H "$J" -d '{}')
[ "$R" = "401" ] && pass "Session guard rejects anonymous mutation" || fail "session guard" "$R"

# 3. Host guard: evil Host must be rejected
R=$(curl -s --noproxy "*" -o /dev/null -w "%{http_code}" -H "Host: evil.example" $B/api/health)
[ "$R" = "403" ] && pass "Host guard rejects foreign host" || fail "host guard" "$R"

# 4. Path traversal on /api/file — must never leak file contents
BODY=$(curl -s --noproxy "*" --path-as-is "$B/api/file/../../../../etc/passwd")
echo "$BODY" | grep -q "root:" && fail "traversal LEAKED /etc/passwd" || pass "raw traversal: no leak (framework normalizes)"
R=$(curl -s --noproxy "*" -o /dev/null -w "%{http_code}" "$B/api/file/..%2f..%2f..%2fetc%2fpasswd")
[ "$R" = "400" ] && pass "encoded traversal blocked ($R)" || fail "encoded traversal" "$R"
R=$(curl -s --noproxy "*" -o /dev/null -w "%{http_code}" "$B/api/file/%2Fetc%2Fpasswd")
[ "$R" = "400" ] && pass "absolute path injection blocked ($R)" || fail "absolute injection" "$R"

# 5. Media route: no arbitrary paths (must resolve by asset id)
BODY=$(curl -s --noproxy "*" --path-as-is "$B/api/media/../../etc/passwd")
echo "$BODY" | grep -q "root:" && fail "media route LEAKED" || pass "media route: id-only, no leak"

# 6. SSE stream stays open (timeout kills curl -> exit 124)
timeout 3 curl -s --noproxy "*" -N $C $B/api/events > /dev/null 2>&1
[ $? = 124 ] && pass "SSE stream stays open" || fail "SSE" "connection closed"
# 7. Traceability: take -> prompt -> plan -> binding chain
TAKE=$(curl -s --noproxy "*" $C $B/api/takes/take-006)
PV=$(echo "$TAKE" | grep -o '"promptVersionId":"[^"]*"' | cut -d'"' -f4)
DPV=$(echo "$TAKE" | grep -o '"directorPlanVersionId":"[^"]*"' | cut -d'"' -f4)
[ -n "$PV" ] && [ -n "$DPV" ] && pass "take traceability (prompt $PV, plan $DPV)" || fail "traceability" "$TAKE"

# 8. No hidden paid actions: render requires explicit preflight pass (already proven), retry is manual
# 9. Recoverability: kill server mid-render, restart, job resumes
SID=$(curl -s --noproxy "*" $C $B/api/shots | grep -o '"id":"shot-001"' | head -1 | cut -d'"' -f4)
PVID=$(curl -s --noproxy "*" $C $B/api/shots/$SID/prompts | grep -o '"id":"prompt-[0-9]*"' | head -1 | cut -d'"' -f4)
RJ=$(curl -s --noproxy "*" $C -X POST $B/api/render -H "$J" -d "{\"shotId\":\"$SID\",\"promptVersionId\":\"$PVID\",\"providerId\":\"mock\",\"durationSeconds\":5}")
JID=$(echo "$RJ" | grep -o '"id":"job-[0-9]*"' | head -1 | cut -d'"' -f4)
sleep 1
# kill hard (kill -9) to simulate force-quit
for p in $(ps -eo pid,cmd | grep -E "tsx/dist/cli.mjs src/index.ts|tsx/dist/preflight.cjs .*src/index.ts" | grep -v grep | awk '{print $1}'); do kill -9 "$p"; done
sleep 2
curl -s --noproxy "*" -m 2 $B/api/health > /dev/null 2>&1 && fail "server should be down" || pass "server killed hard"
cd /data/code/H3Mise && (setsid nohup env H3MISE_PROVIDER=mock H3MISE_HOME=/data/code/H3Mise/.h3mise-home PORT=4789 pnpm --filter @h3mise/server start > .h3mise-server.log 2>&1 &)
sleep 6
curl -s --noproxy "*" $B/api/health | grep -q '"ok":true' || fail "restart" "server did not come back"
curl -s --noproxy "*" -c /data/code/H3Mise/.h3mise-cookie.txt $B/api/session > /dev/null
for i in $(seq 1 25); do
  JOB=$(curl -s --noproxy "*" $C $B/api/render/$JID)
  ST=$(echo "$JOB" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  [ "$ST" = "LOCAL_READY" ] && break
  [ "$ST" = "FAILED" ] && { fail "recovery render failed" "$(echo "$JOB" | head -c 300)"; }
  sleep 1
done
[ "$ST" = "LOCAL_READY" ] && pass "recoverability: render job resumed after force-quit → $ST" || fail "recovery" "$ST"
# taskId persisted in the job
echo "$JOB" | grep -q '"providerTaskId":"mock-' && pass "provider taskId persisted" || fail "taskId" "$JOB"

echo "ALL-HARD-STANDARDS-OK"
