#!/usr/bin/env bash
# One-time Codespace setup: python deps, Ollama + analysis model, whisper weights.
set -euo pipefail

echo "==> Installing Python dependencies"
pip install -r requirements.txt

echo "==> Installing Ollama"
curl -fsSL https://ollama.com/install.sh | sh

echo "==> Pulling the analysis model (one-time, ~3GB)"
(ollama serve > /tmp/ollama.log 2>&1 &)
for i in $(seq 1 30); do
  curl -s http://localhost:11434/api/tags > /dev/null && break
  sleep 1
done
ollama pull gemma3:4b

echo "==> Pre-downloading the Whisper transcription model (one-time, ~460MB)"
python - <<'PY'
from faster_whisper import WhisperModel
WhisperModel("small", device="cpu", compute_type="int8")
print("whisper model ready")
PY

echo "==> Setup complete"
