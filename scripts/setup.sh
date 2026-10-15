#!/usr/bin/env bash
# Подготовка всего к установке: туннель + пакет расширения.
#
#   ./scripts/setup.sh
#
# После этого останется:
#   1) chrome://extensions → «Загрузить распакованное расширение» → папка extension/
#   2) ./native/install.sh <EXTENSION_ID>

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== 1/2 Сборка нативного туннеля ==="
if command -v go >/dev/null 2>&1; then
  bash "$ROOT/tunnel/build.sh"
else
  echo "⚠️  Go не найден — пропускаю сборку туннеля."
  echo "   Установите Go 1.26+ (https://go.dev/dl) и запустите ./tunnel/build.sh"
  echo "   Либо заберите готовый бинарник из артефактов CI (Actions → build-tunnel)."
fi

echo
echo "=== 2/2 Сборка пакета расширения ==="
bash "$ROOT/scripts/build-extension.sh"

echo
cat <<'EOF'
Готово. Дальше:

  1) Откройте chrome://extensions, включите «Режим разработчика».
  2) «Загрузить распакованное расширение» → выберите папку extension/ (или распакуйте dist/*.zip).
  3) Скопируйте ID расширения и выполните:  ./native/install.sh <EXTENSION_ID>
  4) Перезапустите Chrome, откройте popup расширения, вставьте подписку → «Применить» → «Подключить».
EOF
