#!/bin/bash
# Pharm Monitor launcher — double-click this file in Finder.
# Checks TradingView's CDP connection, restarts it if needed, then runs the monitor.
cd "$(dirname "$0")" || exit 1

echo ""
echo "  🐶 Pharm Setup Monitor"
echo "  ─────────────────────────────"
echo ""

# 1. Is TradingView reachable on the CDP port?
if curl -s --max-time 3 http://localhost:9222/json/version >/dev/null 2>&1; then
  echo "  ✅ TradingView CDP is up"
else
  echo "  ⚠️  CDP is down — restarting TradingView..."
  bash "$HOME/.claude/skills/tvclaude.skill/restart-tv.sh" >/dev/null 2>&1

  # wait up to 45s for it to come back
  for i in $(seq 1 45); do
    if curl -s --max-time 2 http://localhost:9222/json/version >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  if curl -s --max-time 3 http://localhost:9222/json/version >/dev/null 2>&1; then
    echo "  ✅ TradingView relaunched with CDP"
    echo "  ⏳ giving the chart a few seconds to load bars..."
    sleep 8
  else
    echo ""
    echo "  ❌ Could not reach TradingView on port 9222."
    echo "     Open TradingView manually, then run this again."
    echo ""
    read -n 1 -s -r -p "  Press any key to close..."
    exit 1
  fi
fi

# 2. Make sure dependencies are installed
if [ ! -d node_modules ]; then
  echo "  📦 installing dependencies (first run only)..."
  npm install --silent
fi

# 3. Show which setups are armed
echo ""
node -e "
try {
  const c = require('./pharm-setups.json');
  console.log('  Plan: ' + c.source);
  console.log('  Risk: ' + c.risk.max_risk_R + 'R max, <=' + c.risk.max_adds + ' adds — no adds underwater');
  console.log('  ' + c.setups.length + ' setups armed:');
  for (const s of c.setups) {
    const r = s.max_risk_R ?? c.risk.max_risk_R, a = s.max_adds ?? c.risk.max_adds;
    console.log('    ' + (s.dir === 'long' ? 'L' : 'S') + '  ' + String(s.zone[0] + '-' + s.zone[1]).padEnd(15) + String(s.rating).padEnd(22) + r + 'R/' + a + ' adds');
  }
} catch (e) { console.log('  (could not read pharm-setups.json: ' + e.message + ')'); }
"
echo ""
echo "  ─────────────────────────────"
echo "  Starting monitor. Close this window or press Ctrl-C to stop."
echo ""

# 4. Run the monitor
node pharm-monitor.js

echo ""
read -n 1 -s -r -p "  Monitor stopped. Press any key to close..."
