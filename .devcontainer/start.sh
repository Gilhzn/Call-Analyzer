#!/usr/bin/env bash
# Runs on every Codespace start: bring up Ollama and the app (idempotent).
set -uo pipefail

cd "$(dirname "$0")/.."

if ! pgrep -x ollama > /dev/null; then
  nohup ollama serve > /tmp/ollama.log 2>&1 &
fi

for i in $(seq 1 15); do
  curl -s http://localhost:11434/api/tags > /dev/null && break
  sleep 1
done

if ! pgrep -f "uvicorn app.main:app" > /dev/null; then
  nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 > /tmp/call-analyzer.log 2>&1 &
fi

echo "Call Analyzer is starting on port 8000"
