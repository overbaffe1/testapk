/**
 * Service worker расширения: управляет прокси Chrome, нативным туннелем и статусами.
 */

import { loadState, saveState, patchState, withDefaults } from "./lib/settings.js";
import { host } from "./lib/host.js";
import { enableProxy, disableProxy } from "./lib/proxy.js";
import { buildTunnelArgs } from "./lib/subscribe.js";

const POLL_ALARM = "wdtt-poll";
const POLL_PERIOD_MIN = 0.5; // 30 секунд — минимальный интервал, который разрешает Chrome
const BADGE_COLORS = {
  on: "#1f9d55",
  connecting: "#d9a441",
  error: "#d93025",
  off: "#6b7280",
};

/** Текущий статус туннеля (обновляется опросом хоста). */
let tunnelStatus = {
  running: false,
  socksReady: false,
  pid: 0,
  error: "",
  startedAt: 0,
  logTail: [],
  binaryFound: false,
  binaryPath: "",
};

// ─────────────────────────── значок расширения ───────────────────────────

async function setBadge(text, colorKey) {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS[colorKey] || BADGE_COLORS.off });
  } catch {
    /* ignore */
  }
}

function badgeFor(state) {
  if (!state.enabled) return ["", "off"];
  if (state.lastError) return ["ERR", "error"];
  if (state.mode === "external") return ["ON", "on"];
  if (tunnelStatus.socksReady) return ["ON", "on"];
  return ["…", "connecting"];
}

// ─────────────────────────── прокси ───────────────────────────

async function applyProxyState(state, enabled) {
  if (enabled) {
    await enableProxy(state.socks, state.bypassList);
  } else {
    await disableProxy();
  }
}

async function setEnabled(enabled, state) {
  const next = { ...state, enabled, lastError: "" };
  await applyProxyState(next, enabled);
  await saveState(next);
  await updateBadge();
  return next;
}

// ─────────────────────────── туннель ───────────────────────────

function buildStartPayload(state) {
  const profile = state.profile;
  if (!profile) throw new Error("Нет профиля подписки");

  const args = buildTunnelArgs(profile, {
    socksHost: state.socks.host,
    socksPort: state.socks.port,
    deviceId: `chrome-${chrome.runtime.id?.slice(0, 8) || "ext"}`,
    goDns: state.tunnel.goDns,
    obfs: state.tunnel.obfs,
    captchaMode: state.tunnel.captchaMode,
    vkAuthMode: state.tunnel.vkAuthMode,
    workers: Number(state.tunnel.workers) || 0,
  });

  return {
    args,
    socks: { host: state.socks.host, port: Number(state.socks.port) || 1080 },
    binary: state.tunnel.binary || "",
  };
}

async function startTunnel(state) {
  const payload = buildStartPayload(state);
  const res = await host.request("start", payload, { timeoutMs: 30000 });
  tunnelStatus = { ...tunnelStatus, ...(res.status || {}), error: "" };
  return res;
}

async function stopTunnel() {
  try {
    await host.request("stop", {}, { timeoutMs: 10000 });
  } catch (err) {
    console.warn("[wdtt] stop failed", err);
  }
  tunnelStatus = { ...tunnelStatus, running: false, socksReady: false, pid: 0 };
}

async function refreshTunnelStatus() {
  try {
    const res = await host.request("status", {}, { timeoutMs: 8000 });
    tunnelStatus = { ...tunnelStatus, ...(res.status || {}) };
  } catch (err) {
    // Нативный хост недоступен — это нормально, если туннель запущен вручную.
    if (tunnelStatus.running) {
      tunnelStatus = { ...tunnelStatus, error: String(err?.message || err) };
    }
  }
  return tunnelStatus;
}

// ─────────────────────────── публичный API для UI ───────────────────────────

async function currentStatus() {
  const state = await loadState();
  if (state.mode === "managed") await refreshTunnelStatus();
  const [text, color] = badgeFor(state);
  await setBadge(text, color);
  return { state, tunnel: tunnelStatus, badge: { text, color } };
}

async function connect() {
  let state = await loadState();
  if (!state.profile) throw new Error("Сначала вставьте подписку");

  try {
    if (state.mode === "managed") {
      await startTunnel(state);
    }
    state = await setEnabled(true, state);
  } catch (err) {
    const message = String(err?.message || err);
    const friendly = /native messaging|not found|хост/i.test(message)
      ? "Нативный хост не установлен. Выполните native/install.sh (см. инструкцию) или переключитесь в режим «Внешний SOCKS5»."
      : message;
    state = await patchState({ lastError: friendly });
    await updateBadge();
    throw new Error(friendly);
  }
  return currentStatus();
}

async function disconnect() {
  const state = await loadState();
  await setEnabled(false, state);
  if (state.mode === "managed") await stopTunnel();
  return currentStatus();
}

async function updateBadge() {
  const state = await loadState();
  const [text, color] = badgeFor(state);
  await setBadge(text, color);
}

const handlers = {
  async getState() {
    return currentStatus();
  },
  async connect() {
    return connect();
  },
  async disconnect() {
    return disconnect();
  },
  async setProfile({ profile, source }) {
    const patch = { profile, lastError: "" };
    if (typeof source === "string" && source) patch.profileSource = source;
    const state = await patchState(patch);
    return { state };
  },
  async updateSettings({ patch }) {
    const current = await loadState();
    const next = withDefaults({ ...current, ...patch });
    await saveState(next);
    if (next.enabled) await applyProxyState(next, true);
    return { state: next };
  },
  async checkIp() {
    const state = await loadState();
    try {
      const res = await host.request("check", { socks: state.socks }, { timeoutMs: 20000 });
      if (res?.ip) await patchState({ egressIp: res.ip });
      return res;
    } catch (err) {
      return { error: String(err?.message || err) };
    }
  },
  async getLogs({ lines = 120 } = {}) {
    try {
      return await host.request("logs", { lines }, { timeoutMs: 8000 });
    } catch (err) {
      return { lines: [], error: String(err?.message || err) };
    }
  },
  async getInfo() {
    return {
      extensionId: chrome.runtime.id,
      hostName: host.hostName,
      version: chrome.runtime.getManifest().version,
    };
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers?.[message?.type];
  if (!handler) return false;
  Promise.resolve(handler(message))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // асинхронный ответ
});

// ─────────────────────────── автозапуск и опрос ───────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await chrome.tabs.create({ url: chrome.runtime.getURL("options.html#welcome") });
  }
  await updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await loadState();
  if (state.autoConnect && state.profile) {
    try {
      await connect();
    } catch (err) {
      console.warn("[wdtt] auto connect failed", err);
    }
  } else {
    await updateBadge();
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== POLL_ALARM) return;
  const state = await loadState();
  if (state.mode !== "managed") {
    await updateBadge();
    return;
  }
  await refreshTunnelStatus();

  if (state.enabled && !tunnelStatus.running && !tunnelStatus.error) {
    // Туннель упал — пробуем поднять заново (kill switch не даёт утечь в direct).
    try {
      await startTunnel(state);
    } catch (err) {
      await patchState({ lastError: `Туннель не отвечает: ${err?.message || err}` });
    }
  }
  await updateBadge();
});

async function ensureAlarm() {
  const existing = await chrome.alarms.get(POLL_ALARM);
  if (!existing) chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MIN });
}

chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.runtime.onInstalled.addListener(ensureAlarm);

// ─────────────────────────── события прокси ───────────────────────────

chrome.proxy.onProxyError.addListener((details) => {
  console.warn("[wdtt] proxy error", details);
  patchState({ lastError: `Ошибка прокси: ${details?.error || "неизвестно"}` });
});

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    loadState().then((state) => {
      if (details?.isProxy && state.socks?.auth && state.socks.user) {
        callback({ authCredentials: { username: state.socks.user, password: state.socks.pass || "" } });
      } else {
        callback({});
      }
    });
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"],
);

// Стартуем опрос сразу при загрузке service worker.
ensureAlarm();
updateBadge();
