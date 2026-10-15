#!/usr/bin/env bash
# Регистрирует native messaging host com.wdtt.tunnel для Chrome/Chromium/Brave/Edge.
#
#   ./native/install.sh <EXTENSION_ID> [путь-к-репозиторию]
#
# Пример:
#   ./native/install.sh abcdefghijklmnopabcdefghijklmnop

set -euo pipefail

EXTENSION_ID="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -z "$EXTENSION_ID" ]]; then
  cat <<'EOF'
Использование: ./native/install.sh <EXTENSION_ID>

EXTENSION_ID — ID расширения (chrome://extensions → включить «Режим разработчика» →
«Копировать ID»). Он же показан в настройках расширения.
EOF
  exit 1
fi

if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "⚠️  Похоже, что ID расширения некорректен: '$EXTENSION_ID'" >&2
  echo "   Ожидается 32 символа a–p." >&2
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "❌ node не найден в PATH. Установите Node.js 18+ и повторите." >&2
  exit 1
fi

# Обёртка с абсолютным путём к node: Chrome не наследует PATH профиля/rc-файлов.
WRAPPER="$SCRIPT_DIR/wdtt-host.sh"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
# Сгенерировано native/install.sh
exec "$NODE_BIN" "$SCRIPT_DIR/host.js" "\$@"
EOF
chmod +x "$WRAPPER"

# Копируем host в ~/.wdtt-tunnel, чтобы путь не зависел от расположения репозитория.
STATE_DIR="${WDTT_HOME:-$HOME/.wdtt-tunnel}"
mkdir -p "$STATE_DIR/lib"
cp -f "$SCRIPT_DIR/host.js" "$STATE_DIR/host.js"
cp -f "$SCRIPT_DIR/lib/tunnel.js" "$STATE_DIR/lib/tunnel.js"
cp -f "$SCRIPT_DIR/lib/socks.js" "$STATE_DIR/lib/socks.js"
cat > "$STATE_DIR/wdtt-host.sh" <<EOF
#!/usr/bin/env bash
# Сгенерировано native/install.sh
export WDTT_HOME="$STATE_DIR"
exec "$NODE_BIN" "$STATE_DIR/host.js" "\$@"
EOF
chmod +x "$STATE_DIR/wdtt-host.sh"

manifest() {
  cat <<EOF
{
  "name": "com.wdtt.tunnel",
  "description": "qWDTT Chrome extension — управление туннелем WDTT (локальный SOCKS5)",
  "path": "$STATE_DIR/wdtt-host.sh",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF
}

installed=0
declare -a TARGETS=(
  "$HOME/.config/google-chrome/NativeMessagingHosts"
  "$HOME/.config/chromium/NativeMessagingHosts"
  "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  "$HOME/.config/microsoft-edge/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
)

for dir in "${TARGETS[@]}"; do
  if [[ -d "$dir" ]]; then
    manifest > "$dir/com.wdtt.tunnel.json"
    echo "✅ Зарегистрировано: $dir/com.wdtt.tunnel.json"
    installed=1
  fi
done

if [[ "$installed" -eq 0 ]]; then
  # Каталога браузера нет — создаём для Chrome/Chromium, остальные подхватят сами.
  for dir in "$HOME/.config/google-chrome/NativeMessagingHosts" "$HOME/.config/chromium/NativeMessagingHosts"; do
    mkdir -p "$dir"
    manifest > "$dir/com.wdtt.tunnel.json"
    echo "✅ Зарегистрировано: $dir/com.wdtt.tunnel.json"
  done
fi

echo
echo "Готово. Перезапустите Chrome (или перезагрузите расширение)."
echo "Бинарник туннеля ищется в: $REPO_ROOT/tunnel/bin/wdtt-tunnel"
if [[ ! -x "$REPO_ROOT/tunnel/bin/wdtt-tunnel" ]]; then
  echo "⚠️  Туннель не собран — выполните: tunnel/build.sh"
fi
