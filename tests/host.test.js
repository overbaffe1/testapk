/**
 * Тесты нативного хоста: протокол native messaging + управление процессом туннеля.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_SCRIPT = path.resolve(HERE, "..", "native", "host.js");
const MOCK_TUNNEL = path.resolve(HERE, "fixtures", "mock-tunnel.sh");

/** Клиент протокола native messaging поверх stdin/stdout. */
function createHostClient({ env = {} } = {}) {
  const child = spawn(process.execPath, [HOST_SCRIPT], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map();
  let buffer = Buffer.alloc(0);
  let seq = 0;

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const body = buffer.subarray(4, 4 + length).toString("utf8");
      buffer = buffer.subarray(4 + length);
      const message = JSON.parse(body);
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        entry(message);
      }
    }
  });

  return {
    request(type, payload = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, (message) => (message.ok ? resolve(message.payload) : reject(new Error(message.error))));
        const json = Buffer.from(JSON.stringify({ id, type, payload }), "utf8");
        const header = Buffer.alloc(4);
        header.writeUInt32LE(json.length, 0);
        child.stdin.write(header);
        child.stdin.write(json);
        setTimeout(() => reject(new Error("таймаут хоста")), 10000).unref?.();
      });
    },
    close() {
      child.kill();
    },
  };
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wdtt-host-"));
}

test("хост отвечает на ping и отдаёт статус", async () => {
  const home = tempHome();
  const client = createHostClient({ env: { WDTT_HOME: home } });
  try {
    const pong = await client.request("ping");
    assert.equal(pong.pong, true);
    assert.equal(pong.host, "com.wdtt.tunnel");

    const { status } = await client.request("status");
    assert.equal(status.running, false);
    assert.ok(Array.isArray(status.logTail));
  } finally {
    client.close();
  }
});

test("хост запускает и останавливает туннель", async () => {
  const home = tempHome();
  const client = createHostClient({ env: { WDTT_HOME: home } });
  try {
    const start = await client.request("start", {
      args: ["-mode", "socks", "-socks", "127.0.0.1:1080"],
      socks: { host: "127.0.0.1", port: 1080 },
      binary: MOCK_TUNNEL,
    });
    assert.equal(start.started, true);
    assert.equal(start.status.running, true);

    // SOCKS5 поднимается асинхронно — дожидаемся готовности.
    let ready = false;
    for (let attempt = 0; attempt < 30 && !ready; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const { status } = await client.request("status");
      ready = status.socksReady;
    }
    assert.equal(ready, true, "туннель должен сообщить о готовом SOCKS5");

    // Лог должен содержать строку о готовности SOCKS5.
    const logs = await client.request("logs", { lines: 50 });
    assert.ok(logs.lines.some((line) => line.includes("[SOCKS] listening")));

    const stop = await client.request("stop");
    assert.equal(stop.stopped, true);

    const { status } = await client.request("status");
    assert.equal(status.running, false);
  } finally {
    client.close();
  }
});

test("хост сообщает об отсутствии бинарника", async () => {
  const home = tempHome();
  const client = createHostClient({ env: { WDTT_HOME: home } });
  try {
    await assert.rejects(
      () => client.request("start", { args: [], binary: "/nonexistent/wdtt-tunnel", socks: {} }),
      /не найден/i,
    );
  } finally {
    client.close();
  }
});
