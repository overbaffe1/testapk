# qWDTT — туннель в браузер (Chrome/Chromium/Brave/Edge)

Chrome-расширение, которое пускает **весь трафик браузера через ваш WDTT/qWDTT-туннель**
(VK TURN → DTLS → WireGuard/RAW → ваш VPS). Режим SOCKS5 работает целиком в
userspace, а WG и RAW автоматически поднимают системный Wintun-интерфейс Windows.

```
SOCKS5: Chrome ──SOCKS5──▶ userspace WG ──▶ WDTT/TURN ──▶ VPS ──▶ интернет
WG:     Windows ──Wintun + WireGuard──────▶ WDTT/TURN ──▶ VPS ──▶ интернет
RAW:    Windows ──Wintun + raw IP─────────▶ WDTT/TURN ──▶ VPS ──▶ интернет
```

Расширение продолжает подключать Chrome к локальному SOCKS5 во всех режимах;
в WG/RAW этот listener использует уже поднятый системный маршрут.

Поддерживаются все форматы вашей подписки: qWDTT JSON, base64-ссылка, `wdtt://`,
`qwdtt://config?...` и HTTP-подписка.

---

## Быстрый старт — Windows x64

1. Скачайте и распакуйте **[`dist/qwdtt-windows-x64.zip`](dist/qwdtt-windows-x64.zip)**.
2. В `chrome://extensions` включите режим разработчика, нажмите
   **«Загрузить распакованное расширение»** и выберите распакованную папку пакета —
   ту, где прямо лежит `manifest.json`.
3. Дважды нажмите `qwdtt-setup.exe`, дождитесь окна «qWDTT установлен» и полностью
   перезапустите Chrome. Установщик работает через `%LOCALAPPDATA%` и `HKCU` без UAC.
   При подключении **WG** или **RAW** Windows отдельно покажет стандартный запрос UAC,
   потому что эти режимы создают системный Wintun и маршруты. Ручные CMD/PowerShell,
   Go и Node.js не нужны.

После одноразовой установки всё просто: вставьте HTTP-ссылку подписки, выберите
**RAW / WG / SOCKS5**, нажмите **«Подключить»**, дождитесь зелёного статуса и нажмите
**«Проверить IP»**.

Отдельный пакет только расширения: [`dist/chrome-1.4.0.zip`](dist/chrome-1.4.0.zip).
Без desktop-компонента он не запускает WDTT: Chrome не даёт расширениям доступ к UDP,
DTLS и системным сокетам.

### Сплит-туннель

В popup раскройте **«Сплит-туннель»** и укажите сайты, которые должны открываться
напрямую, без VPN, по одному шаблону на строку. Например:

```text
arena.ai/*
example.org
*.company.test/*
```

`*` означает любое продолжение. Совпавшие адреса идут напрямую; весь остальной
трафик браузера по умолчанию продолжает идти через WDTT.

### Linux/macOS и сборка из исходников

```bash
./tunnel/build.sh
./native/install.sh <EXTENSION_ID>
```

Нужны Go 1.26+ и Node.js 18+. Готовые бинарники также собираются workflow
`build-tunnel` для Linux, macOS и Windows.

---

## Как это работает

| Слой | Что делает |
|------|-----------|
| `extension/` | MV3-расширение: загружает подписку, выбирает RAW/WG/SOCKS5, управляет `chrome.proxy`, показывает статус и IP. |
| `native-go/` | Самостоятельный native messaging host: запускает/останавливает туннель, управляет UAC-broker и проверяет внешний IP **через сам SOCKS5**; Node.js не нужен. |
| `tunnel/src/` | Go-клиент WDTT: userspace SOCKS5, системный WireGuard через Wintun и системный RAW TUN; наружу для Chrome во всех случаях выдаётся локальный SOCKS5. |

Почему нельзя обойтись одним расширением: транспорт WDTT — это UDP через TURN-серверы VK с
DTLS-рукопожатием и WireGuard внутри. Браузер не умеет открывать «сырые» UDP/TCP-сокеты
и говорить DTLS, поэтому локальный SOCKS5 поднимает нативный клиент, а расширение уже
перенаправляет в него трафик.

---

## Форматы подписки

Вставить можно любой из вариантов — расширение само определит формат:

```
qWDTT JSON:
{"vpn":"...","name":"@user","ip":"srv4.dream31.ru","port":56000,"raw":56003,
 "pass":"k7Fae...","hash":"FDzujt...","sub":"https://..."}

base64 от того же JSON:
wdtt://eyJ2cG4iOiJ2ay5ydS9jZXJiZXIzMS...

WDTT (легаси):
wdtt://<ip>:<dtls_port>:<wg_port>:<local_port>:<password>:<vk_hash>

qWDTT:
qwdtt://config?name=@user&peer=host:56000&hashes=...&workers=18&port=9000&pass=...

HTTP-подписка (загружается автоматически по кнопке «Подключить»):
https://srv4.dream31.ru:2096/subnow/xxxx?format=qwdtt
```

Извлекаются: `peer` (ip:DTLS-порт), `hash`/`hashes`, `pass`/`password`, `workers`, локальный порт.
Остальное (vpn/sub/name) сохраняется для отображения.

---

## Режимы подключения

| Режим | Что происходит |
|-------|----------------|
| **RAW** | Системный Wintun передаёт сырые IPv4-пакеты через RAW-порт подписки без WireGuard. Требует UAC и поля `raw` в подписке. |
| **WG** | Системный Wintun + wireguard-go; конфиг WG получается через стандартный DTLS-порт подписки. Требует UAC. |
| **SOCKS5** | WireGuard и TCP/IP-стек работают в userspace; меняется только прокси Chrome. UAC не требуется. |

В каждом режиме расширение автоматически держит локальный `127.0.0.1:1080` для Chrome.
В WG/RAW дополнительно устанавливаются системные маршруты `0.0.0.0/1` и `128.0.0.0/1`;
маршрут к TURN и домены split tunnel закрепляются за исходным физическим интерфейсом.

---

## Расширенные настройки (страница настроек расширения)

* **Источник SOCKS5** — управляемый/внешний.
* **SOCKS5 хост/порт** — по умолчанию `127.0.0.1:1080`.
* **Авторизация SOCKS5** — логин/пароль (обрабатывается через `chrome.webRequest.onAuthRequired`).
* **Путь к бинарнику туннеля** — если он не лежит в `tunnel/bin/` или `~/.wdtt-tunnel/bin/`.
* **Потоков** — кратно 9 (требование Go-клиента), максимум 108.
* **DNS для VK** — Яндекс/Cloudflare/Google или DoH-варианты.
* **Маскировка** — `audio` или `video` (RTP-обфускация).
* **Капча** — `auto`/`rjs`/`wv`.
* **Авторизация VK** — `anonymous` (по хешу звонка) или `account` (своим аккаунтом).
* **Автоподключение при запуске браузера**.
* **Kill switch** — не возвращать трафик в `direct`, пока туннель не поднят (по умолчанию включён:
  если SOCKS5 упал, браузер не утечёт трафик мимо туннеля).
* **Список хостов напрямую** — `localhost,127.0.0.1,::1,<local>`.

---

## Диагностика

* Popup → «Проверить IP» — запрос идёт **через SOCKS5** (нативный хост делает CONNECT+TLS сам),
  поэтому показывает реальный внешний IP туннеля.
* Windows: лог `%LOCALAPPDATA%\\wdtt-tunnel\\tunnel.log`, состояние рядом в `state.json`.
* Linux/macOS: лог `~/.wdtt-tunnel/tunnel.log`, состояние `~/.wdtt-tunnel/state.json`.
* Значок расширения: `ON` — туннель готов, `…` — подключение, `ERR` — ошибка.

Частые проблемы:

| Симптом | Причина / решение |
|---------|-------------------|
| «Компонент qWDTT не установлен» | Windows: повторно запустите `native\\install.cmd` из полного пакета с текущим ID; затем полностью перезапустите Chrome |
| «Бинарник туннеля не найден» | скачан только `chrome-*.zip` вместо полного Windows-пакета либо не выполнена сборка `./tunnel/build.sh` |
| `FATAL_AUTH: неверный пароль подключения` | в подписке устаревший `pass` → обновите подписку |
| «Звонок не найден» / `call not found` | VK-звонок, к которому привязан хеш, закрыт → нужен новый хеш |
| Капча | VK требует капчу: лог покажет `captcha_required`; в режиме `auto` клиент решает её сам, иначе поменяйте режим капчи |

---

## Сборка и тесты

```bash
npm test                      # юнит-тесты парсера, нативного хоста и service worker
./scripts/build-extension.sh  # dist/chrome-<версия>.zip
./scripts/gen-icons.py        # перегенерировать иконки
./tunnel/build.sh --all       # туннель под linux/mac/windows
```

CI: `.github/workflows/build-tunnel.yml` собирает бинарники туннеля для
Linux/macOS/Windows (артефакты Actions → можно забрать и не собирать локально).

---

## Структура репозитория

```
extension/     Chrome MV3-расширение (простой popup, service worker, парсер подписок)
native-go/     Самостоятельный native messaging host на Go (без Node.js)
native/        Установщики Windows/Linux/macOS и резервный Node.js-хост
tunnel/src/    Go-клиент WDTT — userspace SOCKS5 и системные WG/RAW через Wintun
tunnel/bin/    Собранные бинарники (создаются build.sh/CI, в git не коммитятся)
scripts/       Сборка расширения, генерация иконок
tests/         node:test — парсер, нативный хост, фоновый скрипт
dist/          Готовый zip расширения
```

---

## Лицензия и происхождение

Код туннеля в `tunnel/src/` основан на Go-клиенте
[SpaceNeuroX/proxy-turn-vk-android](https://github.com/SpaceNeuroX/proxy-turn-vk-android) (GPL-3.0)
и адаптирован для desktop SOCKS5/Wintun; текст лицензии — `tunnel/src/LICENSE.upstream`.
Расширение и native host — GPL-3.0 (см. `LICENSE`).

WDTT — проект [amurcanov/proxy-turn-vk-android](https://github.com/amurcanov/proxy-turn-vk-android).
