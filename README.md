# qWDTT — туннель в браузер (Chrome/Chromium/Brave/Edge)

Chrome-расширение, которое пускает **весь трафик браузера через ваш WDTT/qWDTT-туннель**
(VK TURN → DTLS → WireGuard → ваш VPS). Никаких VPN-профилей в системе: расширение
управляет прокси Chrome, а локальный SOCKS5 держит нативный туннель.

```
Chrome  ──SOCKS5──▶  wdtt-tunnel (локальный)  ──UDP/WRAP──▶  VK TURN  ──▶  ваш VPS  ──▶  интернет
   ▲                        │
   └── chrome.proxy ─────────┘ (fixed_servers или PAC для split tunnel → socks5://127.0.0.1:1080)
```

Поддерживаются все форматы вашей подписки: qWDTT JSON, base64-ссылка, `wdtt://`,
`qwdtt://config?...` и HTTP-подписка.

---

## Быстрый старт — Windows x64

1. Скачайте и распакуйте **[`dist/qwdtt-windows-x64.zip`](dist/qwdtt-windows-x64.zip)**.
2. В `chrome://extensions` включите режим разработчика, нажмите
   **«Загрузить распакованное расширение»** и выберите распакованную папку пакета —
   ту, где прямо лежит `manifest.json`.
3. Дважды нажмите `qwdtt-setup.exe`, дождитесь окна «qWDTT установлен» и полностью
   перезапустите Chrome. Установщик работает через `%LOCALAPPDATA%` и `HKCU`: UAC,
   CMD, PowerShell, Go, Node.js и пароль администратора не нужны.

После одноразовой установки всё просто: вставьте HTTP-ссылку подписки, выберите
**RAW / WG / SOCKS5**, нажмите **«Подключить»**, дождитесь зелёного статуса и нажмите
**«Проверить IP»**.

Отдельный пакет только расширения: [`dist/chrome-1.3.0.zip`](dist/chrome-1.3.0.zip).
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
| `extension/` | MV3-расширение: загружает подписку, выбирает RAW/WG/SOCKS5, ставит `chrome.proxy` → `socks5://127.0.0.1:1080`, показывает статус и IP. |
| `native-go/` | Самостоятельный native messaging host: запускает/останавливает туннель и проверяет внешний IP **через сам SOCKS5**; Node.js не нужен. |
| `tunnel/src/` | Go-клиент WDTT upstream: режим `socks` (WG userspace) и добавленный `rawsocks` (RAW userspace); наружу для Chrome выдаётся локальный SOCKS5. |

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
| **RAW** | Сырые IP-пакеты без WireGuard через RAW-порт подписки; userspace IP-стек выдаёт Chrome локальный SOCKS5. Нужен `raw`-порт на сервере. |
| **WG** | Стандартный DTLS + WireGuard из подписки; WireGuard работает в userspace без системного VPN. |
| **SOCKS5** | Рекомендуемый браузерный режим: стандартный qWDTT/WG-транспорт завершается локальным SOCKS5 для `chrome.proxy`. |

Браузер физически умеет принимать трафик только через HTTP/SOCKS proxy, поэтому в каждом режиме
последний локальный участок — `127.0.0.1:1080`. Это запускается автоматически кнопкой
«Подключить» и не требует ручной настройки.

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
tunnel/src/    Go-клиент WDTT — режимы socks и rawsocks
tunnel/bin/    Собранные бинарники (создаются build.sh/CI, в git не коммитятся)
scripts/       Сборка расширения, генерация иконок
tests/         node:test — парсер, нативный хост, фоновый скрипт
dist/          Готовый zip расширения
```

---

## Лицензия и происхождение

Код туннеля в `tunnel/src/` — это Go-клиент из
[SpaceNeuroX/proxy-turn-vk-android](https://github.com/SpaceNeuroX/proxy-turn-vk-android) (GPL-3.0),
взятый без изменений; текст лицензии — `tunnel/src/LICENSE.upstream`.
Расширение и native host — GPL-3.0 (см. `LICENSE`).

WDTT — проект [amurcanov/proxy-turn-vk-android](https://github.com/amurcanov/proxy-turn-vk-android).
