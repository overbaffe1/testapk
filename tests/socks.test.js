/**
 * End-to-end тест SOCKS5-клиента нативного хоста:
 * поднимаем mock SOCKS5 + локальный HTTPS-сервер и проверяем, что
 * определение внешнего IP идёт через туннель.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { checkExternalIp, connectViaSocks } = require("../native/lib/socks.js");

/** Минимальный SOCKS5-сервер: CONNECT → прямое соединение с целью. */
function startMockSocks() {
  return new Promise((resolve) => {
    const server = net.createServer((client) => {
      let stage = 0;
      let buffer = Buffer.alloc(0);

      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        if (stage === 0) {
          if (buffer.length < 2) return;
          const nmethods = buffer[1];
          if (buffer.length < 2 + nmethods) return;
          buffer = buffer.subarray(2 + nmethods);
          client.write(Buffer.from([0x05, 0x00]));
          stage = 1;
        }

        if (stage === 1) {
          if (buffer.length < 4) return;
          const atyp = buffer[3];
          let headerLen = 4;
          let host = "";
          if (atyp === 0x01) {
            if (buffer.length < 10) return;
            host = Array.from(buffer.subarray(4, 8)).join(".");
            headerLen = 10;
          } else if (atyp === 0x03) {
            if (buffer.length < 5) return;
            const len = buffer[4];
            if (buffer.length < 5 + len + 2) return;
            host = buffer.subarray(5, 5 + len).toString("utf8");
            headerLen = 5 + len + 2;
          } else {
            client.destroy();
            return;
          }
          const port = buffer.readUInt16BE(headerLen - 2);
          buffer = buffer.subarray(headerLen);

          const upstream = net.connect(port, host, () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            client.pipe(upstream);
            upstream.pipe(client);
          });
          upstream.on("error", () => client.destroy());
          stage = 2;
        }
      };

      client.on("data", onData);
      client.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function makeSelfSignedCert(dir) {
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "2",
    "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

test("внешний IP определяется через SOCKS5 (mock-туннель)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wdtt-socks-"));
  let cert;
  try {
    cert = makeSelfSignedCert(dir);
  } catch {
    t.skip("openssl недоступен — тест пропущен");
    return;
  }

  const server = https.createServer(cert, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ip: "203.0.113.9" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const httpsPort = server.address().port;

  const socks = await startMockSocks();
  const socksPort = socks.address().port;

  try {
    const result = await checkExternalIp({
      socksHost: "127.0.0.1",
      socksPort,
      targets: [
        { host: "127.0.0.1", port: httpsPort, path: "/?format=json", parse: (body) => JSON.parse(body).ip },
      ],
    });
    assert.equal(result.ip, "203.0.113.9");
    assert.ok(result.ms >= 0);
  } finally {
    socks.close();
    server.close();
  }
});

test("SOCKS5 корректно сообщает об отказе", async () => {
  const server = net.createServer((client) => {
    let stage = 0;
    client.on("data", (chunk) => {
      if (stage === 0) {
        stage = 1;
        client.write(Buffer.from([0x05, 0x00])); // «метод без авторизации»
        return;
      }
      // Отказ на CONNECT: 0x05 0x05 (connection refused)
      client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    });
    client.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    await assert.rejects(
      () => connectViaSocks({ socksHost: "127.0.0.1", socksPort: port, targetHost: "example.com", targetPort: 443 }),
      /отклонено/,
    );
  } finally {
    server.close();
  }
});
