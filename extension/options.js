/**
 * Страница настроек расширения.
 */

const $ = (id) => document.getElementById(id);

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error || "ошибка");
  return res.result;
}

let current = null;

function fill(state) {
  $("mode").value = state.mode;
  $("socksHost").value = state.socks.host;
  $("socksPort").value = state.socks.port;
  $("socksAuth").checked = Boolean(state.socks.auth);
  $("socksUser").value = state.socks.user || "";
  $("socksPass").value = state.socks.pass || "";
  $("tunnelBinary").value = state.tunnel.binary || "";
  $("tunnelWorkers").value = state.tunnel.workers;
  $("tunnelDns").value = state.tunnel.goDns;
  $("tunnelObfs").value = state.tunnel.obfs;
  $("tunnelCaptcha").value = state.tunnel.captchaMode;
  $("tunnelVkAuth").value = state.tunnel.vkAuthMode;
  $("autoConnect").checked = Boolean(state.autoConnect);
  $("killSwitch").checked = Boolean(state.killSwitch);
  $("directPatterns").value = (state.directPatterns || []).join("\n");
  $("bypassList").value = (state.bypassList || []).join(", ");
  $("profileBox").value = state.profile
    ? JSON.stringify(state.profile, null, 2)
    : "Профиль не задан — вставьте подписку в popup.";
}

function collect() {
  return {
    mode: $("mode").value,
    socks: {
      host: $("socksHost").value.trim() || "127.0.0.1",
      port: Number($("socksPort").value) || 1080,
      auth: $("socksAuth").checked,
      user: $("socksUser").value,
      pass: $("socksPass").value,
    },
    tunnel: {
      binary: $("tunnelBinary").value.trim(),
      workers: Number($("tunnelWorkers").value) || 0,
      goDns: $("tunnelDns").value,
      obfs: $("tunnelObfs").value,
      captchaMode: $("tunnelCaptcha").value,
      vkAuthMode: $("tunnelVkAuth").value,
    },
    autoConnect: $("autoConnect").checked,
    killSwitch: $("killSwitch").checked,
    directPatterns: $("directPatterns").value
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    bypassList: $("bypassList").value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

async function load() {
  const { state, tunnel } = await send("getState");
  current = state;
  fill(state);
  const info = await send("getInfo");
  $("extIdFull").textContent = info.extensionId;
  $("installCmd").textContent = `./native/install.sh ${info.extensionId}`;
  await diagnostics(state, tunnel);
}

async function diagnostics(state, tunnel) {
  const lines = [];
  lines.push(`Расширение: ${(await send("getInfo")).extensionId}`);
  lines.push(`Native host: com.wdtt.tunnel`);
  lines.push(`Режим: ${state.mode}`);
  lines.push(`Прокси включён: ${state.enabled ? "да" : "нет"}`);
  lines.push(`SOCKS5: ${state.socks.host}:${state.socks.port}`);
  lines.push(`Туннель: ${tunnel?.running ? `работает (pid ${tunnel.pid})` : "не запущен"}`);
  lines.push(`SOCKS готов: ${tunnel?.socksReady ? "да" : "нет"}`);
  lines.push(`Бинарник: ${tunnel?.binaryPath || "не найден"}`);
  if (tunnel?.error) lines.push(`Ошибка: ${tunnel.error}`);
  if (state.lastError) lines.push(`Ошибка расширения: ${state.lastError}`);
  $("diag").textContent = lines.join("\n");
}

$("saveBtn").addEventListener("click", async () => {
  try {
    await send("updateSettings", { patch: collect() });
    $("saveNote").textContent = "Сохранено";
    setTimeout(() => ($("saveNote").textContent = ""), 2000);
    await load();
  } catch (err) {
    $("saveNote").textContent = `Ошибка: ${err.message}`;
  }
});

$("diagRefresh").addEventListener("click", () => load().catch((e) => ($("diag").textContent = String(e.message))));
$("reloadState").addEventListener("click", () => load().catch(() => {}));
$("openPopup").addEventListener("click", () => chrome.action.openPopup?.());
$("copyId").addEventListener("click", async () => {
  const id = $("extIdFull").textContent;
  try {
    await navigator.clipboard.writeText(id);
    $("copyId").textContent = "скопировано";
    setTimeout(() => ($("copyId").textContent = "копировать"), 1500);
  } catch {
    $("copyId").textContent = "err";
  }
});

load().catch((err) => ($("diag").textContent = `Ошибка загрузки: ${err.message}`));
