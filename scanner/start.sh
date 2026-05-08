#!/bin/bash
# TV Scanner — Baslat
# Kullanim: ./scanner/start.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Node.js path
export PATH="/Users/ugurtabak/local/node-v22.15.0-darwin-arm64/bin:$PATH"

echo "========================================"
echo "  TV Scanner — Otonom Trading Analiz"
echo "========================================"
echo ""

# TradingView CDP kontrolu
echo "[1/3] TradingView baglantisi kontrol ediliyor..."
if curl -m 3 -s http://localhost:9222/json/version > /dev/null 2>&1; then
  echo "  OK — TradingView CDP aktif (port 9222)"
else
  echo "  X — TradingView CDP bulunamadi!"
  echo ""
  echo "  Otomatik baslatiliyor..."
  "$SCRIPT_DIR/launch-tv.sh"
  echo ""
  # Tekrar kontrol
  sleep 3
  if ! curl -m 3 -s http://localhost:9222/json/version > /dev/null 2>&1; then
    echo "  TradingView hala baglanamiyor. Manuel baslatma:"
    echo "  open -a TradingView --args --remote-debugging-port=9222"
    echo ""
    read -p "  Yine de sunucuyu baslatmak ister misiniz? (e/h): " choice
    if [ "$choice" != "e" ]; then
      exit 1
    fi
  fi
fi

echo ""
echo "[2/3] Bagimliliklar kontrol ediliyor..."
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "  npm install calistiriliyor..."
  cd "$SCRIPT_DIR" && npm install
else
  echo "  ✓ Bagimliliklar mevcut"
fi

echo ""
# OKX Executor entegrasyonu — kripto A/B/C sinyalleri localhost:3939'a POST edilir.
# Kapatmak icin: OKX_EXECUTOR_ENABLED=0 ./start.sh
export OKX_EXECUTOR_ENABLED="${OKX_EXECUTOR_ENABLED:-1}"
export OKX_EXECUTOR_URL="${OKX_EXECUTOR_URL:-http://127.0.0.1:3939/api/signals/new}"

echo "[3/3] Sunucu baslatiliyor..."
echo "  Web UI: http://localhost:3838"
echo "  OKX Executor webhook: ENABLED=$OKX_EXECUTOR_ENABLED → $OKX_EXECUTOR_URL"
echo "  Durdurmak icin: Ctrl+C"
echo ""

cd "$SCRIPT_DIR" && node server.js
