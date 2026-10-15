#!/usr/bin/env bash
# Собирает пакет расширения для установки в Chrome (dist/qwdtt-chrome-<версия>.zip).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT/extension"
DIST="$ROOT/dist"

VERSION="$(python3 -c "import json;print(json.load(open('$EXT_DIR/manifest.json'))['version'])")"
OUT="$DIST/qwdtt-chrome-$VERSION.zip"

mkdir -p "$DIST"
rm -f "$OUT"

# В архив кладём только содержимое extension/ (manifest.json в корне архива).
( cd "$EXT_DIR" && zip -qr "$OUT" . -x '*.DS_Store' )

echo "✅ $OUT"
unzip -l "$OUT" | tail -n +2 | head -20
