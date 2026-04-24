#!/usr/bin/env bash
# =============================================================================
# KILL SWITCH — Layer B (Risk #3)
# =============================================================================
# Acil durum terminal fallback'i. Sunucu cevap vermiyor olsa bile calisir:
#
#   1. Scanner API'sine POST /api/emergency/halt (cancelOrders=true, timeout 3sn)
#   2. Basarisizsa halt-state.json'a DIREKT yazar (sunucu bu dosyayi 1sn icinde
#      okur ve yeni trade dispatch'i bloke eder)
#   3. Scanner node process'ini SIGTERM ile durdurur (10sn bekle, sonra KILL)
#   4. Executor cancel-all endpoint'ini direkt cagirir (timeout+retry)
#   5. Her adimda PASS/FAIL raporlar — sessiz basari YOK
#
# Kullanim:
#   ./scripts/kill-all.sh "reason here"
#   ./scripts/kill-all.sh "flash crash"
# =============================================================================

set -u  # unset var = error (set -e KULLANMA — adimlar bagimsiz devam etmeli)

REASON="${1:-terminal_kill_all}"
SCANNER_URL="${SCANNER_URL:-http://localhost:3838}"
EXECUTOR_URL="${OKX_EXECUTOR_URL:-http://localhost:3939/api/signals/new}"
EXECUTOR_CANCEL_URL="$(echo "$EXECUTOR_URL" | sed 's|/api/signals/new/*$|/api/emergency/cancel-all|')"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HALT_STATE_FILE="$REPO_ROOT/scanner/data/halt-state.json"

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "========================================================================="
echo "  KILL SWITCH (Layer B) — $TS"
echo "  Reason: $REASON"
echo "========================================================================="

PASS=0; FAIL=0
pass() { echo "  [PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

# -----------------------------------------------------------------------------
# Step 1 — API halt (tercih edilen yol)
# -----------------------------------------------------------------------------
echo ""
echo "[1/4] Scanner API halt + cancelOrders..."
API_RESP=$(curl -sS -m 3 -X POST "$SCANNER_URL/api/emergency/halt" \
  -H 'Content-Type: application/json' \
  -d "{\"reason\":\"$REASON\",\"by\":\"kill-all.sh\",\"cancelOrders\":true}" 2>&1 || echo "CURL_FAILED")

if echo "$API_RESP" | grep -q '"success":true'; then
  pass "API halt engaged: $(echo "$API_RESP" | head -c 200)"
  API_OK=1
else
  fail "API halt failed: $API_RESP"
  API_OK=0
fi

# -----------------------------------------------------------------------------
# Step 2 — Direct file write fallback (API cevap vermediyse)
# -----------------------------------------------------------------------------
echo ""
echo "[2/4] halt-state.json direct write..."
mkdir -p "$(dirname "$HALT_STATE_FILE")"
if [ "$API_OK" -eq 1 ] && [ -f "$HALT_STATE_FILE" ] && grep -q '"halted": true' "$HALT_STATE_FILE"; then
  pass "halt-state.json already written by API"
else
  # Sunucu cokmus — biz yaziyoruz. Sunucu ayaga kalkinca bu dosyayi okuyup
  # halt'ta kalacak (persistent).
  cat > "$HALT_STATE_FILE" <<EOF
{
  "halted": true,
  "reason": "$REASON",
  "haltedAt": "$TS",
  "haltedBy": "kill-all.sh",
  "source": "script",
  "layer": "B",
  "history": [
    { "event": "engage", "at": "$TS", "reason": "$REASON", "source": "script", "layer": "B", "by": "kill-all.sh" }
  ],
  "cancelAll": { "attempts": [], "lastAttemptAt": null, "lastSuccessAt": null }
}
EOF
  if [ -f "$HALT_STATE_FILE" ]; then
    pass "halt-state.json written directly"
  else
    fail "halt-state.json write failed"
  fi
fi

# -----------------------------------------------------------------------------
# Step 3 — Scanner process SIGTERM + SIGKILL fallback
# -----------------------------------------------------------------------------
echo ""
echo "[3/4] Scanner node process kill..."
PIDS=$(pgrep -f "scanner/server.js" || true)
if [ -z "$PIDS" ]; then
  pass "no scanner process running (already down)"
else
  echo "  Target PIDs: $PIDS"
  for PID in $PIDS; do
    kill -TERM "$PID" 2>/dev/null && echo "  SIGTERM -> $PID" || echo "  SIGTERM failed -> $PID"
  done
  # 10sn grace
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    STILL=$(pgrep -f "scanner/server.js" || true)
    [ -z "$STILL" ] && break
  done
  STILL=$(pgrep -f "scanner/server.js" || true)
  if [ -z "$STILL" ]; then
    pass "scanner stopped gracefully"
  else
    echo "  Still alive after 10s — SIGKILL..."
    for PID in $STILL; do kill -KILL "$PID" 2>/dev/null || true; done
    sleep 1
    STILL=$(pgrep -f "scanner/server.js" || true)
    [ -z "$STILL" ] && pass "scanner force-killed" || fail "scanner still alive after SIGKILL: $STILL"
  fi
fi

# -----------------------------------------------------------------------------
# Step 4 — Executor cancel-all direct (Layer C fallback)
# -----------------------------------------------------------------------------
echo ""
echo "[4/4] Executor cancel-all direct call..."
if [ "${OKX_EXECUTOR_ENABLED:-0}" != "1" ]; then
  echo "  OKX_EXECUTOR_ENABLED!=1 — skipping (no live executor)"
else
  CANCEL_OK=0
  for i in 1 2 3; do
    RESP=$(curl -sS -m 5 -X POST "$EXECUTOR_CANCEL_URL" \
      -H 'Content-Type: application/json' \
      -d "{\"reason\":\"$REASON\",\"source\":\"kill-all.sh\"}" 2>&1 || echo "CURL_FAILED")
    if echo "$RESP" | grep -qi '"success":true\|"ok":true\|cancelled'; then
      pass "executor cancel-all OK on attempt $i: $(echo "$RESP" | head -c 150)"
      CANCEL_OK=1
      break
    fi
    echo "  attempt $i/3 failed: $(echo "$RESP" | head -c 150)"
    sleep $i
  done
  [ "$CANCEL_OK" -eq 1 ] || fail "executor cancel-all FAILED all 3 attempts — MANUAL EXCHANGE UI INTERVENTION REQUIRED"
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo "========================================================================="
echo "  RESULT: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "  !! MANUAL VERIFICATION REQUIRED !!"
  echo "  1. Check exchange UI directly — are all positions closed?"
  echo "  2. Run reconciliation check: curl $SCANNER_URL/api/emergency/status"
  echo "========================================================================="
  exit 1
fi
echo "  All layers reported success."
echo "  NEXT: verify reconciliation within 60s — brokerPosition should be null"
echo "  curl $SCANNER_URL/api/emergency/status"
echo "========================================================================="
exit 0
