/**
 * Popup расширения: управление подпиской, туннелем и прокси.
 */

import { parseSubscription, describeProfile } from "./lib/subscribe.js";

const $ = (id) => document.getElementById(id);

const els = {
  pill: $("statusPill"),
  toggle: $("toggleBtn"),
  toggleLabel: document.querySelector("#toggleBtn .toggle-label"),
  srv: $("srvValue"),
  hash: $("hashValue"),
  workers: $("workersValue"),
  socks: $("socksValue"),
  tunnel: $("tunnelValue"),
  ip: $("ipValue"),
  errorRow: $("errorRow"),
  error: $("errorValue"),
  subInput: $("subInput"),
  applyBtn: $("applyBtn"),
  pasteBtn: $("pasteBtn"),
  fetchBtn: $("fetchBtn"),
  checkIpBtn: $("checkIpBtn"),
  refreshLogsBtn: $("refreshLogsBtn"),
  logBox: $("logBox"),
  parseNote: $("parseNote"),
  optionsBtn: $("optionsBtn"),
  helpBtn: $("helpBtn"),
  extId: $("extId"),
};

async function send(type, payload = {}) {
  try {
    const res = await chrome.runtime.sendMessage({ type, ...payload });
    if (!res) throw new Error("пустой ответ от background");
    if (!res.ok) throw new Error(res.error || "ошибка");
    return res.result;
  } catch (err) {
    throw new Error(String(err?.message || err));
  }
}

function setNote(text, kind = "") {
  els.parseNote.textContent = text || "";
  els.parseNote.className = `note ${kind}`.trim();
}

function renderPill(state, tunnel) {
  let text = "выключено";
  let cls = "pill pill-off";
  if (state.enabled) {
    if (state.lastError) {
      text = "ошибка";
      cls = "pill pill-err";
    } else if (state.mode === "external" || tunnel?.socksReady) {
      text = "подключено";
      cls = "pill pill-on";
    } else {
      text = "подключение…";
      cls = "pill pill-wait";
    }
  }
  els.pill.textContent = text;
  els.pill.className = cls;
}

function render(state, tunnel) {
  renderPill(state, tunnel);

  const on = state.enabled;
  els.toggle.classList.toggle("on", on);
  els.toggleLabel.textContent = on ? "Отключить" : "Подключить";
  document.querySelector("#toggleBtn .toggle-sub").textContent = on
    ? "трафик Chrome идёт через туннель"
    : "весь трафик Chrome пойдёт через туннель";

  const profile = state.profile;
  if (profile) {
    const info = describeProfile(profile);
    els.srv.textContent = info.server;
    els.hash.textContent = info.hashes || "—";
    els.workers.textContent = String(info.workers);
    if (!els.subInput.value && state.profileSource) els.subInput.value = state.profileSource;
  } else {
    els.srv.textContent = "—";
    els.hash.textContent = "—";
    els.workers.textContent = "—";
  }

  els.socks.textContent = `${state.socks.host}:${state.socks.port}${state.socks.auth ? " (auth)" : ""}`;

  if (state.mode === "external") {
    els.tunnel.textContent = "внешний SOCKS5";
  } else if (tunnel?.socksReady) {
    els.tunnel.textContent = `работает (pid ${tunnel.pid})`;
  } else if (tunnel?.running) {
    els.tunnel.textContent = "поднимается…";
  } else if (tunnel && tunnel.binaryFound === false) {
    els.tunnel.textContent = "бинарник не собран";
  } else {
    els.tunnel.textContent = "не запущен";
  }
  els.ip.textContent = state.egressIp || "—";

  if (state.lastError) {
    els.errorRow.classList.remove("hidden");
    els.error.textContent = state.lastError;
  } else {
    els.errorRow.classList.add("hidden");
  }
}

async function refresh() {
  try {
    const { state, tunnel } = await send("getState");
    render(state, tunnel);
    return { state, tunnel };
  } catch (err) {
    setNote(`Ошибка: ${err.message}`, "err");
    return null;
  }
}

async function refreshLogs() {
  try {
    const res = await send("getLogs", { lines: 120 });
    const lines = res?.lines || [];
    els.logBox.textContent = lines.length ? lines.join("\n") : "(лог пуст)";
    els.logBox.scrollTop = els.logBox.scrollHeight;
  } catch (err) {
    els.logBox.textContent = `Не удалось получить лог: ${err.message}`;
  }
}

els.toggle.addEventListener("click", async () => {
  els.toggle.classList.add("busy");
  try {
    const { state } = await refresh();
    if (state?.enabled) {
      await send("disconnect");
      setNote("Туннель отключён");
    } else {
      await send("connect");
      setNote("Подключение…", "ok");
    }
  } catch (err) {
    setNote(err.message, "err");
  } finally {
    els.toggle.classList.remove("busy");
    await refresh();
    await refreshLogs();
  }
});

els.applyBtn.addEventListener("click", async () => {
  const raw = els.subInput.value.trim();
  if (!raw) {
    setNote("Вставьте подписку", "err");
    return;
  }
  const parsed = parseSubscription(raw);
  if (!parsed.ok) {
    setNote(parsed.error, "err");
    return;
  }
  const profile = parsed.profiles[0];
  await send("setProfile", { profile, source: raw });
  if (parsed.profiles.length > 1) {
    setNote(`В подписке ${parsed.profiles.length} профилей, взят первый`, "ok");
  } else {
    setNote("Подписка применена", "ok");
  }
  await refresh();
});

els.pasteBtn.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      setNote("Буфер обмена пуст", "err");
      return;
    }
    els.subInput.value = text.trim();
    setNote("Вставлено из буфера — нажмите «Применить»", "ok");
  } catch {
    setNote("Не удалось прочитать буфер: вставьте текст вручную (Ctrl+V)", "err");
    els.subInput.focus();
  }
});

els.fetchBtn.addEventListener("click", async () => {
  const raw = els.subInput.value.trim();
  if (!/^https?:\/\//i.test(raw)) {
    setNote("Вставьте HTTP-ссылку на подписку и нажмите «По URL»", "err");
    return;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    setNote("Некорректная ссылка", "err");
    return;
  }
  try {
    const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!granted) {
      setNote("Доступ к домену не выдан", "err");
      return;
    }
    setNote("Загружаю подписку…");
    const res = await fetch(url.href, { headers: { Accept: "application/json, text/plain, */*" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    const parsed = parseSubscription(body);
    if (!parsed.ok) throw new Error(parsed.error);
    await send("setProfile", { profile: parsed.profiles[0], source: body.trim() });
    els.subInput.value = body.trim();
    setNote("Подписка загружена и применена", "ok");
    await refresh();
  } catch (err) {
    setNote(`Не удалось загрузить: ${err.message}`, "err");
  }
});

els.checkIpBtn.addEventListener("click", async () => {
  setNote("Проверяю внешний IP…");
  const res = await send("checkIp");
  if (res?.error) {
    setNote(`Проверка не удалась: ${res.error}`, "err");
  } else if (res?.ip) {
    setNote(`Внешний IP: ${res.ip} (${res.ms ?? "?"} мс)`, "ok");
  } else {
    setNote("Ответ без IP", "err");
  }
  await refresh();
});

els.refreshLogsBtn.addEventListener("click", refreshLogs);
els.optionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
els.helpBtn.addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("options.html#install") }));

(async () => {
  const info = await send("getInfo").catch(() => null);
  if (info) els.extId.textContent = info.extensionId?.slice(0, 8) || "";
  await refresh();
  await refreshLogs();
  setInterval(refresh, 2500);
})();
