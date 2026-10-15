/**
 * Тесты split tunnel и конфигурации chrome.proxy.
 */

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { buildPacScript, buildProxyValue, normalizeDirectPatterns } from "../extension/lib/proxy.js";

function shellExpressionMatch(value, pattern) {
  const escaped = String(pattern)
    .replace(/[|\\{}()[\]^$+\.]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(String(value));
}

function evaluatePac(script, url, host) {
  return vm.runInNewContext(`${script}\nFindProxyForURL(${JSON.stringify(url)}, ${JSON.stringify(host)});`, {
    shExpMatch: shellExpressionMatch,
    isPlainHostName: (value) => !String(value).includes("."),
    dnsDomainIs: (value, domain) => String(value).endsWith(String(domain)),
  });
}

test("без split-правил весь внешний трафик остаётся на SOCKS5", () => {
  const value = buildProxyValue(
    { host: "127.0.0.1", port: 1080 },
    ["localhost", "127.0.0.1", "::1", "<local>"],
    [],
  );
  assert.equal(value.mode, "fixed_servers");
  assert.equal(value.rules.singleProxy.scheme, "socks5");
  assert.equal(value.rules.singleProxy.host, "127.0.0.1");
  assert.equal(value.rules.singleProxy.port, 1080);
});

test("нормализует правила из строк, запятых и повторов", () => {
  assert.deepEqual(normalizeDirectPatterns(" arena.ai/*\nexample.org,arena.ai/* "), ["arena.ai/*", "example.org"]);
});

test("split tunnel отправляет совпавшие URL напрямую, остальные через VPN", () => {
  const script = buildPacScript(
    { host: "127.0.0.1", port: 1080 },
    ["localhost", "127.0.0.1", "::1", "<local>"],
    ["arena.ai/*", "example.org", "https://only.test/private/*"],
  );

  assert.equal(evaluatePac(script, "https://arena.ai/chat/123", "arena.ai"), "DIRECT");
  assert.equal(evaluatePac(script, "https://arena.ai/", "arena.ai"), "DIRECT");
  assert.equal(evaluatePac(script, "https://example.org/page", "example.org"), "DIRECT");
  assert.equal(evaluatePac(script, "https://sub.example.org/page", "sub.example.org"), "DIRECT");
  assert.equal(evaluatePac(script, "https://only.test/private/page", "only.test"), "DIRECT");
  assert.equal(evaluatePac(script, "https://only.test/public", "only.test"), "SOCKS5 127.0.0.1:1080");
  assert.equal(evaluatePac(script, "https://another.test/", "another.test"), "SOCKS5 127.0.0.1:1080");
  assert.equal(evaluatePac(script, "http://localhost/app", "localhost"), "DIRECT");
});

test("при split-правилах Chrome получает обязательный PAC script", () => {
  const value = buildProxyValue(
    { host: "127.0.0.1", port: 1080 },
    ["localhost"],
    ["arena.ai/*"],
  );
  assert.equal(value.mode, "pac_script");
  assert.equal(value.pacScript.mandatory, true);
  assert.match(value.pacScript.data, /arena\.ai\/\*/);
  assert.match(value.pacScript.data, /SOCKS5 127\.0\.0\.1:1080/);
});
