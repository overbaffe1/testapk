/**
 * Тесты фонового service worker расширения с mock-реализацией API Chrome.
 */

import test from "node:test";
import assert from "node:assert/strict";

/** Минимальная реализация chrome.* для тестов. */
function createChromeMock() {
  const storage = {};
  const proxyOps = [];
  const nativeCalls = [];
  const listeners = { message: [], proxyError: [], auth: [], alarm: [] };
  const badge = { text: "", color: "" };

  const port = () => {
    const p = {
      onMessage: { addListener: () => {} },
      onDisconnect: { addListener: () => {} },
      postMessage(message) {
        // Имитируем ответ нативного хоста.
        const reply = (payload) => {
          p.onMessage.listeners.forEach((fn) => fn({ id: message.id, type: "result", ok: true, payload }));
        };
        p.onMessage.listeners = p.onMessage.listeners || [];
        if (message.type === "start") {
          reply({ started: true, status: { running: true, socksReady: true, pid: 4242 } });
        } else if (message.type === "status") {
          reply({ status: { running: true, socksReady: true, pid: 4242 } });
        } else if (message.type === "stop") {
          reply({ stopped: true, status: { running: false, socksReady: false, pid: 0 } });
        } else if (message.type === "logs") {
          reply({ lines: ["[SOCKS] listening 127.0.0.1:1080"] });
        } else if (message.type === "check") {
          reply({ ip: "203.0.113.7", ms: 42 });
        } else {
          reply({});
        }
      },
      disconnect() {},
    };
    p.onMessage.listeners = [];
    p.onMessage.addListener = (fn) => p.onMessage.listeners.push(fn);
    return p;
  };

  const chromeMock = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return storage[key] ? { [key]: storage[key] } : {};
          return { ...storage };
        },
        async set(obj) {
          Object.assign(storage, obj);
        },
      },
    },
    proxy: {
      settings: {
        async set({ value, scope }) {
          proxyOps.push({ op: "set", value, scope });
        },
        async clear({ scope }) {
          proxyOps.push({ op: "clear", scope });
        },
        async get() {
          return { value: null };
        },
      },
      onProxyError: { addListener: (fn) => listeners.proxyError.push(fn) },
    },
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      getManifest: () => ({ version: "1.0.0" }),
      lastError: null,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      connectNative: (name) => {
        nativeCalls.push(name);
        return port();
      },
    },
    alarms: {
      async get() {
        return null;
      },
      create() {},
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    },
    action: {
      async setBadgeText({ text }) {
        badge.text = text;
      },
      async setBadgeBackgroundColor({ color }) {
        badge.color = color;
      },
    },
    webRequest: {
      onAuthRequired: { addListener: (fn) => listeners.auth.push(fn) },
    },
  };

  return { chromeMock, proxyOps, nativeCalls, listeners, badge, storage };
}

/** Отправляет сообщение в фоновый скрипт и ждёт ответа. */
function send(listeners, message) {
  return new Promise((resolve) => {
    listeners.message[0](message, {}, resolve);
  });
}

const PROFILE = {
  name: "@overbafe1",
  peer: { host: "srv4.dream31.ru", port: 56000 },
  hashes: ["FDzujtg_2dEw1KJK5UFLAsHNxtID32lHa2Md4lSLJqw"],
  workers: 18,
  listenPort: 9000,
  password: "k7FaeaaR2UbyvJde",
};

test("подключение включает SOCKS5-прокси, отключение — снимает", async () => {
  const { chromeMock, proxyOps, nativeCalls, listeners } = createChromeMock();
  globalThis.chrome = chromeMock;

  // Импорт после установки mock: background.js обращается к chrome при загрузке.
  const background = await import(`../extension/background.js?test=${Date.now()}`);

  await send(listeners, { type: "setProfile", profile: PROFILE });
  const connected = await send(listeners, { type: "connect" });
  assert.equal(connected.ok, true);

  const setOp = proxyOps.find((op) => op.op === "set");
  assert.ok(setOp, "прокси должен быть установлен");
  assert.equal(setOp.value.mode, "fixed_servers");
  assert.equal(setOp.value.rules.singleProxy.scheme, "socks5");
  assert.equal(setOp.value.rules.singleProxy.host, "127.0.0.1");
  assert.equal(setOp.value.rules.singleProxy.port, 1080);
  assert.ok(nativeCalls.includes("com.wdtt.tunnel"), "должен быть вызван нативный хост");

  const state = await send(listeners, { type: "getState" });
  assert.equal(state.result.state.enabled, true);

  await send(listeners, { type: "disconnect" });
  assert.ok(proxyOps.some((op) => op.op === "clear"), "прокси должен быть снят");
});

test("проверка IP идёт через нативный хост", async () => {
  const { chromeMock, listeners } = createChromeMock();
  globalThis.chrome = chromeMock;
  await import(`../extension/background.js?test=${Date.now()}`);

  const res = await send(listeners, { type: "checkIp" });
  assert.equal(res.ok, true);
  assert.equal(res.result.ip, "203.0.113.7");
});
