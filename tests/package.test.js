import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";

function chromeExtensionId(publicKeyBase64) {
  const digest = crypto.createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest().subarray(0, 16);
  return [...digest]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => String.fromCharCode("a".charCodeAt(0) + nibble))
    .join("");
}

test("публичный ключ закрепляет ID, зарегистрированный установщиком", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  const installer = fs.readFileSync(new URL("../installer-go/main_windows.go", import.meta.url), "utf8");
  const id = chromeExtensionId(manifest.key);
  assert.equal(id, "innpafjoibpjdgdemphggiomjlppglgj");
  assert.match(installer, new RegExp(`extensionID\\s*=\\s*"${id}"`));
});

test("Windows-установщик пишет только в профиль пользователя", () => {
  const installer = fs.readFileSync(new URL("../installer-go/main_windows.go", import.meta.url), "utf8");
  assert.match(installer, /LOCALAPPDATA/);
  assert.match(installer, /registry\.CURRENT_USER/);
  assert.doesNotMatch(installer, /registry\.LOCAL_MACHINE|Program Files/i);
});

test("Windows-пакет устанавливает официальный Wintun рядом с туннелем", () => {
  const installer = fs.readFileSync(new URL("../installer-go/main_windows.go", import.meta.url), "utf8");
  const workflow = fs.readFileSync(new URL("../.github/workflows/build-tunnel.yml", import.meta.url), "utf8");
  assert.match(installer, /go:embed assets\/wintun\.dll/);
  assert.match(installer, /replaceFile\(wintunPath, wintunDLL\)/);
  assert.match(workflow, /https:\/\/www\.wintun\.net\/builds\/wintun-0\.14\.1\.zip/);
});
