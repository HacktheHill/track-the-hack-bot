#!/usr/bin/env bash
set -euo pipefail

MODEL_REVISION="bc640142c66e1fdd12af0bd68f40445458f3869b"
MODEL_FILE="Qwen3-4B-Q4_K_M.gguf"
MODEL_SHA256="7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5"
MODEL_DIR="${MODEL_DIR:-/opt/track-the-hack-local-model}"
MODEL_PATH="${MODEL_DIR}/${MODEL_FILE}"

install -d -m 0750 "$MODEL_DIR"
if [[ -f "$MODEL_PATH" ]] && echo "${MODEL_SHA256}  ${MODEL_PATH}" | sha256sum --check --status; then
  echo "Verified model already exists at ${MODEL_PATH}."
  exit 0
fi

temporary="$(mktemp "${MODEL_DIR}/.${MODEL_FILE}.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$temporary" \
  "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/${MODEL_REVISION}/${MODEL_FILE}"
echo "${MODEL_SHA256}  ${temporary}" | sha256sum --check --status
chmod 0440 "$temporary"
mv "$temporary" "$MODEL_PATH"
trap - EXIT
echo "Downloaded and verified ${MODEL_PATH}."
