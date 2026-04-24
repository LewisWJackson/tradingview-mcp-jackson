#!/usr/bin/env bash
# notify-signal.sh — A-kalite sinyal tespit edildiginde arka planda kisa bir
# Claude analizi uretir ve $SIGNAL_NOTIFY_SINK yoluyla yazilir.
#
# Kullanim (scheduler icinden):
#   SIGNAL_JSON="{...}" ./scripts/notify-signal.sh
#
# Gereksinimler:
#   - claude CLI PATH'te olmali (Claude Code kurulu)
#   - Env degiskenleri (opsiyonel):
#       SIGNAL_NOTIFY_ENABLED=1       → bu olmazsa script hicbir sey yapmaz
#       SIGNAL_NOTIFY_MODEL=haiku     → hizli ve ucuz; opus veya sonnet de olur
#       SIGNAL_NOTIFY_SINK=/path/file → ciktinin gidecegi dosya (default: logs/signals-notified.log)
#       TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID → dolu ise Telegram'a da gonderilir
#
# Tasarim notu: scheduler.js bu script'i `spawn` ile cagirir; cevap beklemez.
# Script bekleyen bir is degil, "fire and forget". Hata durumunda sessizce cikar.

set -uo pipefail

if [ "${SIGNAL_NOTIFY_ENABLED:-0}" != "1" ]; then
  exit 0
fi

signal="${SIGNAL_JSON:-}"
if [ -z "$signal" ]; then
  exit 0
fi

claude_bin="$(command -v claude || true)"
if [ -z "$claude_bin" ]; then
  echo "[notify-signal] claude CLI bulunamadi, atliyorum" >&2
  exit 0
fi

model="${SIGNAL_NOTIFY_MODEL:-haiku}"
sink="${SIGNAL_NOTIFY_SINK:-$(dirname "$0")/../scanner/logs/signals-notified.log}"
mkdir -p "$(dirname "$sink")"

prompt=$(cat <<EOF
Asagida TradingView tarayicisinin az once urettigi bir A veya B kalite sinyal
var. Gorevin: 4-6 satirlik, Turkce, dogrudan eyleme gecirilebilir bir ozet.
Format:
  SEMBOL | TF | YON
  Entry: ... | SL: ... | TP1: ... | TP2: ... | R:R: ...
  Ana gerekce (1 satir)
  Uyari / risk (1 satir, yoksa "-")
Hicbir seyi guzellestirme, emoji koyma, ek yorum yapma. Sadece ozet.

SINYAL JSON:
$signal
EOF
)

analysis=$(printf '%s' "$prompt" | "$claude_bin" -p --model "$model" --output-format text 2>/dev/null || echo "[notify-signal] claude CLI analiz uretemedi")

timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
{
  printf '=== %s ===\n' "$timestamp"
  printf '%s\n\n' "$analysis"
} >> "$sink"

# Opsiyonel: Telegram'a gonder
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  curl -s -m 5 -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${analysis}" \
    >/dev/null 2>&1 || true
fi

exit 0
