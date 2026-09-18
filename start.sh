#!/usr/bin/env bash
# Arena2API - راه‌اندازی سریع روی لینوکس
# ساخت venv (در صورت نبود)، نصب وابستگی‌ها، اجرای سرور
set -e
cd "$(dirname "$0")"

PY=python3
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "❌ python3 پیدا نشد. نصب کنید: sudo apt install python3 python3-pip python3-venv"
  exit 1
fi

if [ ! -d ".venv" ]; then
  echo "📦 ساخت محیط مجازی..."
  if ! "$PY" -m venv .venv 2>/dev/null; then
    echo "❌ ماژول venv نصب نیست. اجرا کنید: sudo apt install python3-venv"
    exit 1
  fi
fi

source .venv/bin/activate

if [ ! -f ".venv/.deps_ok" ]; then
  echo "📥 نصب وابستگی‌ها..."
  pip install -q -r requirements.txt
  touch .venv/.deps_ok
fi

PORT="${PORT:-9090}"
echo "🚀 سرور Arena2API روی پورت $PORT در حال اجراست..."
echo "   API: http://localhost:$PORT/v1"
python server.py
