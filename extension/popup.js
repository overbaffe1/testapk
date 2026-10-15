import { extractSubscriptionJsonUrl, parseSubscription } from "./lib/subscribe.js";

const $ = (id) => document.getElementById(id);
const ui = {
  status: $("status"),
  subscription: $("subscription"),
  connect: $("connect"),
  checkIp: $("checkIp"),
  server: $("server"),
  activeMode: $("activeMode"),
  tunnel: $("tunnel"),
  ip: $("ip"),
  message: $("message"),
  modes: [...document.querySelectorAll('input[name="mode"]')],
};

let snapshot = null;
let busy = false;

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "Нет ответа от расширения");
  return response.result;
}

function selectedMode() {
  return ui.modes.find((input) => input.checked)?.value || "socks5";
}

function selectMode(value) {
  const normalized = ["raw", "wg", "socks5"].includes(value) ? value : "socks5";
  for (const input of ui.modes) input.checked = input.value === normalized;
}

function message(text = "", kind = "") {
  ui.message.textContent = text;
  ui.message.className = `message ${kind}`.trim();
}

function setStatus(text, kind) {
  ui.status.className = `status ${kind}`;
  ui.status.querySelector("span").textContent = text;
}

function render({ state, tunnel }) {
  snapshot = { state, tunnel };
  const enabled = Boolean(state.enabled);
  const ready = enabled && Boolean(tunnel?.socksReady);
  const failed = Boolean(state.lastError);

  if (failed) setStatus("Ошибка", "error");
  else if (ready) setStatus("Подключено", "on");
  else if (enabled) setStatus("Подключение…", "wait");
  else setStatus("Отключено", "off");

  if (!ui.subscription.value && state.profileSource) ui.subscription.value = state.profileSource;
  selectMode(state.transportMode);

  const mode = (state.transportMode || "socks5").toUpperCase();
  const profile = state.profile;
  const port = state.transportMode === "raw" && profile?.rawPort ? profile.rawPort : profile?.peer?.port;
  ui.server.textContent = profile?.peer ? `${profile.peer.host}:${port}` : "—";
  ui.activeMode.textContent = mode;
  ui.ip.textContent = state.egressIp || "—";

  if (ready) ui.tunnel.textContent = "работает";
  else if (tunnel?.running) ui.tunnel.textContent = "запускается…";
  else if (tunnel?.binaryFound === false) ui.tunnel.textContent = "нужна установка";
  else ui.tunnel.textContent = "не запущен";

  ui.connect.textContent = enabled ? "Отключить" : "Подключить";
  ui.connect.classList.toggle("disconnect", enabled);
  ui.subscription.disabled = enabled || busy;
  for (const input of ui.modes) input.disabled = enabled || busy;
  ui.connect.disabled = busy;
  ui.checkIp.disabled = busy || !ready;

  if (state.lastError) message(state.lastError, "error");
}

async function refresh() {
  try {
    render(await send("getState"));
  } catch (error) {
    setStatus("Ошибка", "error");
    message(error.message, "error");
  }
}

async function fetchSubscriptionText(url) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json, text/plain, */*" },
  });
  if (!response.ok) throw new Error(`Сервер подписки ответил HTTP ${response.status}`);
  return response.text();
}

async function loadProfile(source) {
  let payload = source;
  let parsed;
  if (/^https?:\/\//i.test(source)) {
    const url = new URL(source);
    const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!granted) throw new Error("Разреши доступ к серверу подписки");

    message("Загружаю подписку…");
    payload = await fetchSubscriptionText(url.href);
    parsed = parseSubscription(payload);

    // URL без ?format=qwdtt может открыть обычную HTML-страницу 3x-ui.
    // Сначала парсер пробует конфигурацию, встроенную в textarea. Если в
    // исходном HTML её нет (страница заполняется JS), загружаем JSON endpoint.
    if (!parsed.ok && parsed.kind === "html") {
      let jsonUrl = extractSubscriptionJsonUrl(payload, url.href);
      if (!jsonUrl) {
        const fallback = new URL(url.href);
        fallback.searchParams.set("format", "qwdtt");
        jsonUrl = fallback.href;
      }
      const target = new URL(jsonUrl);
      if (target.origin === url.origin && target.href !== url.href) {
        message("Загружаю конфигурацию qWDTT…");
        payload = await fetchSubscriptionText(target.href);
        parsed = parseSubscription(payload);
      }
    }
  } else {
    parsed = parseSubscription(payload);
  }

  if (!parsed.ok) throw new Error(parsed.error);
  await send("setProfile", { profile: parsed.profiles[0], source });
  return parsed.profiles[0];
}

ui.connect.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  ui.connect.disabled = true;
  message();
  try {
    if (snapshot?.state?.enabled) {
      ui.connect.textContent = "Отключаю…";
      await send("disconnect");
      message("Отключено", "ok");
    } else {
      const source = ui.subscription.value.trim();
      if (!source) throw new Error("Вставь ссылку на подписку");
      ui.connect.textContent = "Подключаю…";
      setStatus("Подключение…", "wait");
      await loadProfile(source);
      await send("updateSettings", {
        patch: { mode: "managed", transportMode: selectedMode(), lastError: "" },
      });
      await send("connect");
      message("Туннель запускается…", "ok");
    }
  } catch (error) {
    message(error.message, "error");
  } finally {
    busy = false;
    await refresh();
  }
});

ui.checkIp.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  ui.checkIp.disabled = true;
  message("Проверяю IP…");
  try {
    const result = await send("checkIp");
    if (result?.error) throw new Error(result.error);
    if (!result?.ip) throw new Error("Сервер проверки не вернул IP");
    message(`IP через туннель: ${result.ip}`, "ok");
  } catch (error) {
    message(`Проверка IP: ${error.message}`, "error");
  } finally {
    busy = false;
    await refresh();
  }
});

for (const input of ui.modes) {
  input.addEventListener("change", async () => {
    const mode = selectedMode();
    ui.activeMode.textContent = mode.toUpperCase();
    if (snapshot?.state) snapshot.state.transportMode = mode;
    try {
      await send("updateSettings", { patch: { transportMode: mode } });
    } catch (error) {
      message(error.message, "error");
    }
  });
}

await refresh();
setInterval(refresh, 2000);
