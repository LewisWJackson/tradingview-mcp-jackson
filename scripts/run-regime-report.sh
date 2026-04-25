#!/usr/bin/env bash
# =============================================================================
# Faz 1 ara rapor uretici — launchd tarafindan tetiklenir.
#
# Bir hafta shadow veri toplaminin sonunda otomatik calismasi icin macOS
# launchd plist'iyle planlanmis (~/Library/LaunchAgents/com.tradingview-mcp.
# regime-report-week1.plist). Calistiktan sonra kendi plist'ini soker (one-shot).
# =============================================================================

set -u
REPO="/Users/ugurtabak/tradingview-mcp-jackson"
LOG_DIR="$REPO/scanner/logs"
mkdir -p "$LOG_DIR"

# Hangi hafta? Onceden uretilmis week-N varsa N+1 kullan
WEEK=1
while [ -f "$REPO/docs/regime-report-week${WEEK}.md" ]; do
  WEEK=$((WEEK + 1))
done
OUT="$REPO/docs/regime-report-week${WEEK}.md"
CRON_LOG="$LOG_DIR/regime-report-cron.log"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cd "$REPO" || { echo "[$TS] cd failed" >> "$CRON_LOG"; exit 2; }

# Header notu — DeepSeek tavsiyesi: WS zombi penceresi notu
{
  echo "<!--"
  echo "  Otomatik üretildi (launchd, $TS)"
  echo "  Veri kalitesi notu: 2026-04-25 02:00-12:30 UTC arasinda Binance WS"
  echo "  zombi tespit edildi (Risk #17). Bu pencerede yazilan rejim log'lari"
  echo "  stale fiyatla hesaplanmis olabilir; analizden manuel haric tutulmali."
  echo "-->"
  echo ""
} > "$OUT"

# Raporu uret + dosyaya append
if /Users/ugurtabak/local/node-v22.15.0-darwin-arm64/bin/node \
    "$REPO/scanner/scripts/regime-report.mjs" --days=7 >> "$OUT" 2>>"$CRON_LOG"; then
  EXIT=0
  echo "[$TS] OK week=$WEEK → $OUT" >> "$CRON_LOG"
  /usr/bin/osascript -e "display notification \"Rapor hazır: docs/regime-report-week${WEEK}.md\" with title \"Faz 1 Ara Rapor\" sound name \"Glass\"" 2>/dev/null
else
  EXIT=$?
  echo "[$TS] FAIL week=$WEEK exit=$EXIT" >> "$CRON_LOG"
  /usr/bin/osascript -e "display notification \"Rapor üretimi BAŞARISIZ (exit $EXIT) — log: scanner/logs/regime-report-cron.log\" with title \"Faz 1 Ara Rapor\" sound name \"Sosumi\"" 2>/dev/null
fi

# Self-uninstall — one-shot pattern (StartCalendarInterval Year alanini
# desteklemedigi icin annual recurrence olusur; calistiktan sonra plist'i
# silerek bir daha tetiklenmemesini garanti ediyoruz).
PLIST="$HOME/Library/LaunchAgents/com.tradingview-mcp.regime-report-week1.plist"
if [ -f "$PLIST" ]; then
  /bin/launchctl unload "$PLIST" 2>/dev/null || true
  /bin/rm -f "$PLIST"
  echo "[$TS] self-uninstalled $PLIST" >> "$CRON_LOG"
fi

exit $EXIT
