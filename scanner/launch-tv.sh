#!/bin/bash
# TradingView Desktop'u CDP (Chrome DevTools Protocol) modunda baslat
# Bu script TV Scanner icin gereklidir.
#
# Kullanim:
#   ./scanner/launch-tv.sh
#
# Ilk seferlik (quarantine kaldirmak icin):
#   xattr -cr /Applications/TradingView.app

TV_APP="/Applications/TradingView.app/Contents/MacOS/TradingView"
CDP_PORT=9222

# Quarantine kontrolu
if xattr -l /Applications/TradingView.app 2>/dev/null | grep -q quarantine; then
  echo "[!] TradingView quarantine'li. Kaldiriliyor..."
  xattr -cr /Applications/TradingView.app
  echo "    Quarantine kaldirildi."
fi

# Zaten calisiyorsa kontrol et
if curl -m 3 -s "http://localhost:${CDP_PORT}/json/version" > /dev/null 2>&1; then
  echo "[*] TradingView zaten CDP modunda calisiyor (port ${CDP_PORT})"
  echo "    $(curl -m 3 -s "http://localhost:${CDP_PORT}/json/version" | grep -o '"Browser":"[^"]*"')"
  exit 0
fi

# TradingView process varsa kapat
if pgrep -x "TradingView" > /dev/null; then
  echo "[*] Mevcut TradingView kapatiliyor..."
  pkill -x "TradingView"
  sleep 2
fi

echo "[*] TradingView CDP modunda baslatiliyor (port ${CDP_PORT})..."
# open -a Mac'te GUI uygulamalarini baslatmak icin en guvenilir yol
# --args ile argumanlar Electron'a iletilir
open -a TradingView --args --remote-debugging-port=${CDP_PORT}
TV_PID=$(pgrep -x TradingView | head -1)

echo "[*] PID: ${TV_PID}"
echo "[*] Baglanti bekleniyor..."

# Baglanti hazir olana kadar bekle (max 15 saniye)
for i in $(seq 1 15); do
  if curl -m 3 -s "http://localhost:${CDP_PORT}/json/version" > /dev/null 2>&1; then
    echo ""
    echo "========================================="
    echo "  TradingView CDP HAZIR"
    echo "  Port: ${CDP_PORT}"
    echo "  PID:  ${TV_PID}"
    echo "========================================="
    echo ""
    echo "Simdi TV Scanner'i baslatabilirsiniz:"
    echo "  ./scanner/start.sh"
    echo ""
    echo "Veya dogrudan:"
    echo "  cd scanner && node server.js"
    exit 0
  fi
  printf "."
  sleep 1
done

echo ""
echo "[!] Baglanti kurulamadi. TradingView acilmis mi kontrol edin."
exit 1
