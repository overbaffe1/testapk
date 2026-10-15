# Нативный туннель (WDTT → локальный SOCKS5)

`tunnel/src/` — Go-клиент WDTT/qWDTT без изменений: [upstream](https://github.com/SpaceNeuroX/proxy-turn-vk-android)
(версия 1.4.4, GPL-3.0). Нативный хост запускает его в режиме `-mode socks`:
клиент поднимает локальный SOCKS5 и гонит трафик через VK TURN + WireGuard
на ваш VPS.

## Сборка

```bash
./tunnel/build.sh          # под текущую ОС
./tunnel/build.sh --all    # linux/mac/windows (amd64+arm64)
```

Требуется **Go 1.26+** (`https://go.dev/dl`). Модули Go скачиваются из
`proxy.golang.org` при первом `go mod tidy` (нужен интернет).

Результат: `tunnel/bin/wdtt-tunnel` (или `wdtt-tunnel.exe`).

В Windows используйте `tunnel\build.ps1`.

## Как расширение запускает туннель

Нативный хост (`native/host.js`) подставляет в аргументы командной строки параметры, собранные из подписки:

```
wdtt-tunnel \
  -peer srv4.dream31.ru:56000 \        # адрес:DTLS-порт VPS
  -vk <хеш(и) звонка VK> \              # через запятую
  -n 18 \                               # потоки (кратно 9, максимум 108)
  -listen 127.0.0.1:9000 \              # локальный UDP-порт клиента
  -device-id chrome-xxxxxxxx \
  -password <пароль подключения> \
  -captcha-mode auto \
  -vk-auth anonymous \
  -go-dns yandex \
  -obfs audio \
  -mode socks \
  -socks 127.0.0.1:1080                 # SOCKS5, который забирает Chrome
```

Соответствие полей подписки:

| Поле подписки | Куда идёт |
|---------------|-----------|
| `ip` + `port` (или `peer`) | `-peer host:port` |
| `hash` / `hashes` | `-vk` |
| `pass` / `password` | `-password` |
| `workers` | `-n` (кратно 9) |
| `port` из `qwdtt://config` | `-listen 127.0.0.1:<port>` |

## Логи и состояние

* stdout/stderr туннеля → `~/.wdtt-tunnel/tunnel.log` (ротация на 8 МБ).
* Состояние процесса → `~/.wdtt-tunnel/state.json`.
* Каталог можно переопределить переменной окружения `WDTT_HOME`.
* Путь к бинарнику можно задать в настройках расширения или через `WDTT_TUNNEL_BIN`.

Готовность SOCKS5 определяется по строке `[SOCKS] listening 127.0.0.1:1080` в логе.
