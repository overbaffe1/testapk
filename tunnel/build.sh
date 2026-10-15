#!/usr/bin/env bash
# Собирает нативный туннель WDTT (Go-клиент qWDTT в режиме -mode socks).
#
#   ./tunnel/build.sh              # собрать для текущей ОС
#   ./tunnel/build.sh --all        # собрать для linux/mac/windows
#
# Требуется Go 1.26+ (https://go.dev/dl). Модули скачиваются из proxy.golang.org.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src"
OUT_DIR="$SCRIPT_DIR/bin"

if ! command -v go >/dev/null 2>&1; then
  echo "❌ Go не найден. Установите Go 1.26+ и повторите." >&2
  exit 1
fi

GO_VERSION="$(go version | awk '{print $3}')"
echo "→ Go: $GO_VERSION"

build_one() {
  local goos="$1" goarch="$2" ext=""
  [[ "$goos" == "windows" ]] && ext=".exe"
  local out="$OUT_DIR/wdtt-tunnel-${goos}-${goarch}${ext}"
  echo "→ Сборка $goos/$goarch → $out"
  ( cd "$SRC_DIR" && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -trimpath -ldflags="-s -w" -o "$out" . )
}

mkdir -p "$OUT_DIR"

if [[ "${1:-}" == "--all" ]]; then
  build_one linux amd64
  build_one linux arm64
  build_one darwin amd64
  build_one darwin arm64
  build_one windows amd64
  # Основной бинарник для текущей платформы.
  cp "$OUT_DIR/wdtt-tunnel-$(go env GOOS)-$(go env GOARCH)" "$OUT_DIR/wdtt-tunnel" 2>/dev/null || true
else
  ( cd "$SRC_DIR" && go mod tidy )
  ( cd "$SRC_DIR" && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$OUT_DIR/wdtt-tunnel" . )
  # Windows-сборка на Windows получит .exe — переименуем.
  [[ "$(go env GOOS)" == "windows" ]] && mv -f "$OUT_DIR/wdtt-tunnel" "$OUT_DIR/wdtt-tunnel.exe"
fi

echo
echo "✅ Готово: $OUT_DIR"
ls -la "$OUT_DIR"
