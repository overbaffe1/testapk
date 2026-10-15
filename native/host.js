#!/usr/bin/env node
/**
 * Native messaging host: com.wdtt.tunnel
 *
 * Chrome запускает этот скрипт, когда расширение подключается через
 * chrome.runtime.connectNative(). Хост управляет процессом туннеля WDTT
 * (Go-клиент в режиме `-mode socks`) и отдаёт расширению статус/логи.
 *
 * Протокол native messaging: 4 байта длины (LE) + JSON в обе стороны.
 * В stdout писать можно ТОЛЬКО протокольные сообщения — весь лог идёт в stderr.
 */

const fs = require("fs");
const tunnel = require("./lib/tunnel");
const { checkExternalIp } = require("./lib/socks");

const HOST_NAME = "com.wdtt.tunnel";

function writeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(header);
  process.stdout.write(payload);
}

function reply(id, ok, payload, error, code) {
  writeMessage({ id, type: "result", ok, payload: ok ? payload : undefined, error: ok ? undefined : error, code });
}

function emit(event, payload) {
  writeMessage({ type: "event", event, payload });
}

async function handle(message) {
  const { id, type, payload = {} } = message || {};
  switch (type) {
    case "ping":
      reply(id, true, { pong: true, host: HOST_NAME, pid: process.pid, home: tunnel.HOME_DIR });
      break;

    case "status":
      reply(id, true, { status: tunnel.status() });
      break;

    case "start": {
      try {
        const res = tunnel.start({
          args: payload.args || [],
          socks: payload.socks || null,
          binary: payload.binary || "",
        });
        reply(id, true, res);
        emit("status", res.status);
      } catch (err) {
        reply(id, false, undefined, String(err?.message || err), err?.code);
      }
      break;
    }

    case "stop": {
      const res = tunnel.stop();
      reply(id, true, res);
      emit("status", res.status);
      break;
    }

    case "logs": {
      const lines = Number(payload.lines) || 120;
      reply(id, true, { lines: tunnel.tailLog(lines) });
      break;
    }

    case "check": {
      try {
        const socks = payload.socks || {};
        const result = await checkExternalIp({
          socksHost: socks.host || "127.0.0.1",
          socksPort: Number(socks.port) || 1080,
          username: socks.user || "",
          password: socks.pass || "",
        });
        reply(id, true, result);
      } catch (err) {
        reply(id, false, undefined, String(err?.message || err), "check-failed");
      }
      break;
    }

    default:
      reply(id, false, undefined, `Неизвестная команда: ${type}`, "unknown");
  }
}

function main() {
  let buffer = Buffer.alloc(0);

  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const body = buffer.subarray(4, 4 + length).toString("utf8");
      buffer = buffer.subarray(4 + length);
      let message = null;
      try {
        message = JSON.parse(body);
      } catch (err) {
        console.error("[wdtt-host] bad json:", err?.message);
        continue;
      }
      Promise.resolve(handle(message)).catch((err) => {
        console.error("[wdtt-host] handler error:", err);
      });
    }
  });

  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}

main();
