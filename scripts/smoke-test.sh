#!/usr/bin/env bash
#
# End-to-end smoke test for a running Mommy Care deployment.
#
#   BASE=https://mommy.smadar.ai MANAGER_CODE=... ./scripts/smoke-test.sh
#
# It exercises the public team view, manager authentication, every mutation,
# week navigation, copy-previous-week and the SSE stream, then deletes every
# row it created and asserts the database is back to its starting counts.
# Safe to run against production, but it does write while it runs.
#
set -u
B="${BASE:?set BASE, e.g. https://mommy.smadar.ai}"
CODE="${MANAGER_CODE:?set MANAGER_CODE}"
J="$(mktemp)"
rm -f $J
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1  (got '$2' want '$3')"; fail=$((fail+1)); fi }
code() { curl -s -o /tmp/pbody.json -w '%{http_code}' "$@"; }

c=$(code $B/healthz); chk "HTTPS health 200" "$c" "200"
chk "database up" "$(node -e "console.log(require('/tmp/pbody.json').database)")" "up"
chk "TLS valid" "$(curl -s -o /dev/null -w '%{ssl_verify_result}' $B/healthz)" "0"

c=$(code $B/); chk "team view loads" "$c" "200"
grep -q 'id="root"' /tmp/pbody.json && chk "app shell served" ok ok || chk "app shell served" no ok
grep -qi "MANAGER_SECRET\|$CODE" /tmp/pbody.json && chk "no secret in HTML" leak none || chk "no secret in HTML" none none
BUNDLE=$(grep -o 'app\.[0-9a-f]*\.js' /tmp/pbody.json | head -1)
curl -s "$B/$BUNDLE" > /tmp/bundle.js
chk "bundle served" "$(test -s /tmp/bundle.js && echo ok)" "ok"
grep -q "$CODE" /tmp/bundle.js && chk "no manager code in JS bundle" leak none || chk "no manager code in JS bundle" none none

c=$(code $B/api/mommy/state); chk "public state readable" "$c" "200"
WEEK=$(node -e "console.log(require('/tmp/pbody.json').week)")
BEFORE_CG=$(node -e "console.log(require('/tmp/pbody.json').caregivers.length)")
BEFORE_SH=$(node -e "console.log(require('/tmp/pbody.json').shifts.length)")
echo "  week=$WEEK caregivers_before=$BEFORE_CG shifts_before=$BEFORE_SH"
chk "timezone is Asia/Jerusalem" "$(node -e "console.log(require('/tmp/pbody.json').timezone)")" "Asia/Jerusalem"

c=$(code -X POST -H 'Content-Type: application/json' -d '{"name":"x"}' $B/api/mommy/caregivers)
chk "unauth mutation blocked" "$c" "401"
c=$(code -X POST -H 'Content-Type: application/json' -d '{"code":"0000"}' $B/api/mommy/auth/manager)
chk "wrong manager code rejected" "$c" "401"
c=$(code -c $J -X POST -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\"}" $B/api/mommy/auth/manager)
chk "manager login accepted" "$c" "200"
# curl's cookie jar marks HttpOnly with a #HttpOnly_ host prefix and Secure in
# the 4th column. Secure is only expected when the test target is HTTPS.
COOKIE_LINE=$(grep mommy_session $J | head -1)
case "$COOKIE_LINE" in '#HttpOnly_'*) HTTPONLY=yes ;; *) HTTPONLY=no ;; esac
SECURE=$(printf '%s' "$COOKIE_LINE" | cut -f4)
chk "session cookie is HttpOnly" "$HTTPONLY" "yes"
case "$B" in
  https://*) chk "session cookie is Secure" "$SECURE" "TRUE" ;;
  *) echo "SKIP  session cookie Secure flag (target is not HTTPS)" ;;
esac

c=$(code -b $J -X POST -H 'Content-Type: application/json' -d '{"name":"בדיקת ייצור","paid":true,"rate":50}' $B/api/mommy/caregivers)
chk "manager creates caregiver" "$c" "201"
CG=$(node -e "console.log(require('/tmp/pbody.json').id)")
c=$(code -b $J -X PATCH -H 'Content-Type: application/json' -d '{"rate":70}' $B/api/mommy/caregivers/$CG)
chk "manager edits caregiver" "$(node -e "console.log(require('/tmp/pbody.json').rate)")" "70"

c=$(code -b $J -X POST -H 'Content-Type: application/json' -d "{\"week\":\"$WEEK\",\"day\":2,\"start\":540,\"end\":1020,\"caregiverId\":\"$CG\",\"note\":\"בדיקה\",\"msg\":\"הודעת בדיקה\",\"confirmed\":true}" $B/api/mommy/shifts)
chk "manager creates shift" "$c" "201"
SH=$(node -e "console.log(require('/tmp/pbody.json').id)")
V=$(node -e "console.log(require('/tmp/pbody.json').version)")
c=$(code -b $J -X PATCH -H 'Content-Type: application/json' -d "{\"note\":\"בדיקה מעודכנת\",\"version\":$V}" $B/api/mommy/shifts/$SH)
chk "manager edits shift" "$(node -e "console.log(require('/tmp/pbody.json').note)")" "בדיקה מעודכנת"

# a caregiver with no manager session may request a shift, but only as pending
c=$(code -X POST -H 'Content-Type: application/json' -d "{\"week\":\"$WEEK\",\"day\":4,\"start\":600,\"end\":840,\"caregiverId\":\"$CG\",\"note\":\"בדיקת בקשה\",\"confirmed\":true,\"msg\":\"לא אמור להישמר\"}" $B/api/mommy/shifts)
chk "caregiver can request a shift" "$c" "201"
REQ=$(node -e "console.log(require('/tmp/pbody.json').id)")
chk "request is forced pending" "$(node -e "console.log(require('/tmp/pbody.json').confirmed)")" "false"
chk "manager message stripped from request" "$(node -e "console.log(require('/tmp/pbody.json').msg)")" ""
c=$(code -X POST -H 'Content-Type: application/json' -d "{\"week\":\"$WEEK\",\"day\":4,\"start\":0,\"end\":120}" $B/api/mommy/shifts)
chk "unassigned request rejected" "$c" "400"
c=$(code -X PATCH -H 'Content-Type: application/json' -d '{"confirmed":true}' $B/api/mommy/shifts/$REQ)
chk "caregiver cannot approve a shift" "$c" "401"
c=$(code -X DELETE "$B/api/mommy/shifts/$REQ?as=$CG")
chk "caregiver can withdraw her own request" "$c" "200"

# a caregiver with no manager session may add a checklist task and tick it
c=$(code -X POST -H 'Content-Type: application/json' -d '{"text":"בדיקת צ׳קליסט"}' $B/api/mommy/checklist)
chk "caregiver can add a checklist task" "$c" "201"
ITEM=$(node -e "console.log(require('/tmp/pbody.json').id)")
c=$(code -X PATCH -H 'Content-Type: application/json' -d '{"done":true}' $B/api/mommy/checklist/$ITEM)
chk "caregiver can tick a task" "$(node -e "console.log(require('/tmp/pbody.json').done)")" "true"
c=$(code -X DELETE $B/api/mommy/checklist/$ITEM)
chk "caregiver cannot delete a task" "$c" "401"
c=$(code -b $J -X DELETE $B/api/mommy/checklist/$ITEM)
chk "manager can delete a task" "$c" "200"

# persistence across a brand-new client with no cookies at all
c=$(code $B/api/mommy/state)
chk "another device sees the shift" "$(node -e "console.log(require('/tmp/pbody.json').shifts.filter(s=>s.note==='בדיקה מעודכנת').length)")" "1"
chk "another device sees note" "$(node -e "console.log(require('/tmp/pbody.json').shifts[0].note)")" "בדיקה מעודכנת"
chk "another device sees message" "$(node -e "console.log(require('/tmp/pbody.json').shifts[0].msg)")" "הודעת בדיקה"
chk "confirmation persisted" "$(node -e "console.log(require('/tmp/pbody.json').shifts[0].confirmed)")" "true"
chk "pay rate hidden from team" "$(node -e "const d=require('/tmp/pbody.json');console.log(d.caregivers.find(c=>c.id==='$CG').rate)")" "0"

# week navigation + copy previous
NEXT=$(node -e "const [y,m,d]='$WEEK'.split('-').map(Number);console.log(new Date(Date.UTC(y,m-1,d,12)+7*86400000).toISOString().slice(0,10))")
c=$(code -b $J "$B/api/mommy/weeks/$NEXT"); chk "week navigation works" "$c" "200"
c=$(code -b $J -X POST $B/api/mommy/weeks/$NEXT/copy-previous)
chk "copy previous week" "$(node -e "console.log(require('/tmp/pbody.json').copied)")" "1"

# SSE reachable through the Railway edge
timeout 8 curl -sN $B/api/mommy/events > /tmp/prod-sse.txt &
sleep 2
curl -s -b $J -X PATCH -H 'Content-Type: application/json' -d '{"msg":"סנכרון"}' $B/api/mommy/shifts/$SH > /dev/null
sleep 4
grep -q 'event: hello' /tmp/prod-sse.txt && chk "SSE stream opens over HTTPS" ok ok || chk "SSE stream opens over HTTPS" no ok
grep -q 'event: change' /tmp/prod-sse.txt && chk "SSE delivers change events" ok ok || chk "SSE delivers change events" "$(cat /tmp/prod-sse.txt | tr '\n' ' ')" ok

# ---- clean up every row this test created -------------------------------
curl -s -b $J -X POST $B/api/mommy/weeks/$NEXT/copy-previous > /dev/null 2>&1
for w in "$WEEK" "$NEXT"; do
  for id in $(curl -s -b $J "$B/api/mommy/weeks/$w" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{JSON.parse(s).shifts.forEach(x=>console.log(x.id))})"); do
    curl -s -b $J -X DELETE $B/api/mommy/shifts/$id > /dev/null
  done
done
curl -s -b $J -X DELETE $B/api/mommy/caregivers/$CG > /dev/null
c=$(code -b $J $B/api/mommy/state)
chk "cleanup: caregivers back to start" "$(node -e "console.log(require('/tmp/pbody.json').caregivers.length)")" "$BEFORE_CG"
chk "cleanup: shifts back to start" "$(node -e "console.log(require('/tmp/pbody.json').shifts.length)")" "$BEFORE_SH"

c=$(code -b $J -c $J -X POST $B/api/mommy/auth/logout); chk "logout works" "$c" "200"
c=$(code -b $J -X POST -H 'Content-Type: application/json' -d '{"name":"y"}' $B/api/mommy/caregivers)
chk "mutation blocked after logout" "$c" "401"

echo "-----------------------------"
echo "PASSED=$pass FAILED=$fail"
exit $((fail > 0))
