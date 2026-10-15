/**
 * Тесты парсера подписок на реальных форматах qWDTT/WDTT.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseSubscription,
  parseLegacyLink,
  parseQwdttLink,
  parseJsonPayload,
  tryBase64Decode,
  buildTunnelArgs,
  normalizeWorkers,
} from "../extension/lib/subscribe.js";

// Реальные данные пользователя (обрезанный пароль/хеш не меняем — формат важен).
const QWDTT_JSON = JSON.stringify({
  vpn: "v2.ru/cerberus1@HOST:443#WDTT",
  name: "@overbafe1",
  ip: "srv4.dream31.ru",
  port: 56000,
  raw: 56003,
  pass: "k7FaeaaR2UbyvJde",
  hash: "FDzujtg_2dEw1KJK5UFLAsHNxtID32lHa2Md4lSLJqw",
  sub: "https://srv4.dream31.ru:2096/subnow/pwgq9a78fnaqpax6?format=qwdtt",
});

const WDTT_JSON_B64 =
  "eyJ2cG4iOiJ2ay5ydS9jZXJiZXIzMSDQktCw0Ygg0LvRg9GH0YjQuNC5IHZwbiIsIm5hbWUiOiJAb3ZlcmJhZmUxIiwiaXAiOiJzcnY0LmRyZWFtMzEucnUiLCJkdGxzIjo1NjAwMCwicmF3Ijo1NjAwMywicGFzcyI6Ims3RmFlYWFSMlVieXZKZGUiLCJoYXNoIjoiRkR6dWp0Z18yZEV3MUtKSzVVRkxBc0hOeHRJRDMybEhhMk1kNGxTTEpxdyIsInN1YiI6Imh0dHBzOi8vc3J2NC5kcmVhbTMxLnJ1OjIwOTYvc3Vibm93L3B3Z3E5YTc4Zm5hcXBheDYifQ==";

const WDTT_LINK =
  "wdtt://srv4.dream31.ru:56000:56001:0:k7FaeaaR2UbyvJde:FDzujtg_2dEw1KJK5UFLAsHNxtID32lHa2Md4lSLJqw";

const QWDTT_LINK =
  "qwdtt://config?name=%40overbafe1&peer=srv4.dream31.ru%3A56000&hashes=FDzujtg_2dEw1KJK5UFLAsHNxtID32lHa2Md4lSLJqw&workers=18&port=9000&pass=k7FaeaaR2UbyvJde";

test("парсит qWDTT JSON (ip/port/pass/hash)", () => {
  const res = parseSubscription(QWDTT_JSON);
  assert.equal(res.ok, true);
  const p = res.profiles[0];
  assert.equal(p.peer.host, "srv4.dream31.ru");
  assert.equal(p.peer.port, 56000);
  assert.equal(p.password, "k7FaeaaR2UbyvJde");
  assert.deepEqual(p.hashes, ["FDzujtg_2dEw1KJK5UFLAsHNxtID32lHa2Md4lSLJqw"]);
  assert.equal(p.name, "@overbafe1");
});

test("парсит base64-ссылку WDTT JSON", () => {
  const res = parseSubscription(WDTT_JSON_B64);
  assert.equal(res.ok, true);
  const p = res.profiles[0];
  assert.equal(p.peer.host, "srv4.dream31.ru");
  assert.equal(p.peer.port, 56000);
  assert.equal(p.password, "k7FaeaaR2UbyvJde");
  assert.deepEqual(p.hashes, ["FDzujtg_2dEw1KJK5UFLAsHNxtID32lHa2Md4lSLJqw"]);
});

test("парсит ссылку wdtt:// (ip:dtls:wg:local:pass:hash)", () => {
  const res = parseSubscription(WDTT_LINK);
  assert.equal(res.ok, true);
  const p = res.profiles[0];
  assert.equal(p.peer.host, "srv4.dream31.ru");
  assert.equal(p.peer.port, 56000);
  assert.equal(p.listenPort, 9000); // local_port = 0 → дефолт 9000
  assert.equal(p.password, "k7FaeaaR2UbyvJde");
  assert.deepEqual(p.hashes, ["FDzujtg_2dEw1KJK5UFLAsHNxtID32lHa2Md4lSLJqw"]);
});

test("парсит ссылку qwdtt://config", () => {
  const res = parseSubscription(QWDTT_LINK);
  assert.equal(res.ok, true);
  const p = res.profiles[0];
  assert.equal(p.peer.host, "srv4.dream31.ru");
  assert.equal(p.peer.port, 56000);
  assert.equal(p.workers, 18);
  assert.equal(p.listenPort, 9000);
  assert.equal(p.password, "k7FaeaaR2UbyvJde");
});

test("парсит список профилей", () => {
  const res = parseSubscription(
    JSON.stringify({
      profiles: [
        { name: "A", peer: "1.2.3.4:56000", hashes: "hashA", workers: 9, port: 9000, password: "pA" },
        { name: "B", peer: "1.2.3.5:56000", hashes: "hashB", workers: 18, port: 9001, password: "pB" },
      ],
    }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.profiles.length, 2);
  assert.equal(res.profiles[1].peer.port, 56000);
  assert.equal(res.profiles[1].workers, 18);
});

test("понимает список без обёртки (массив)", () => {
  const res = parseSubscription(JSON.stringify([{ peer: "1.2.3.4:56000", hashes: "h", password: "p" }]));
  assert.equal(res.ok, true);
  assert.equal(res.profiles.length, 1);
});

test("HTTP-ссылка отдаётся на загрузку, а не парсится", () => {
  const res = parseSubscription("https://srv4.dream31.ru:2096/subnow/pwgq9a78fnaqpax6?format=qwdtt");
  assert.equal(res.ok, false);
  assert.equal(res.kind, "url");
});

test("мусор не принимается", () => {
  const res = parseSubscription("просто текст");
  assert.equal(res.ok, false);
});

test("decode base64", () => {
  assert.ok(tryBase64Decode(WDTT_JSON_B64).startsWith("{"));
  assert.equal(tryBase64Decode("short"), null);
});

test("кол-во потоков кратно 9 и в диапазоне", () => {
  assert.equal(normalizeWorkers(1), 9);
  assert.equal(normalizeWorkers(10), 9);
  assert.equal(normalizeWorkers(18), 18);
  assert.equal(normalizeWorkers(23), 18);
  assert.equal(normalizeWorkers(1000), 108);
  assert.equal(normalizeWorkers(undefined), 18);
});

test("собирает аргументы туннеля", () => {
  const res = parseSubscription(QWDTT_JSON);
  const args = buildTunnelArgs(res.profiles[0], { socksPort: 1080, deviceId: "chrome-test" });
  assert.ok(args.includes("-mode"));
  assert.equal(args[args.indexOf("-mode") + 1], "socks");
  assert.equal(args[args.indexOf("-socks") + 1], "127.0.0.1:1080");
  assert.equal(args[args.indexOf("-peer") + 1], "srv4.dream31.ru:56000");
  assert.equal(args[args.indexOf("-password") + 1], "k7FaeaaR2UbyvJde");
  assert.equal(args[args.indexOf("-vk") + 1], "FDzujtg_2dEw1KJK5UFLAsHNxtID32lHa2Md4lSLJqw");
});

test("легаси-ссылка без схемы", () => {
  const res = parseSubscription("srv4.dream31.ru:56000:56001:9000:k7FaeaaR2UbyvJde:FDzujtg_2dEw1KJK5UFLAsHNxtID32lHa2Md4lSLJqw");
  assert.equal(res.ok, true);
  assert.equal(res.profiles[0].peer.port, 56000);
  assert.equal(res.profiles[0].listenPort, 9000);
});

test("частичные парсеры не падают на мусоре", () => {
  assert.equal(parseLegacyLink("wdtt://host"), null);
  assert.equal(parseQwdttLink("qwdtt://config?nothing=1"), null);
  assert.equal(parseJsonPayload("{"), null);
});
