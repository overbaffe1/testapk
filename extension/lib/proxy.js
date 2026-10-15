/**
 * Управление прокси Chrome через chrome.proxy.
 */

export const PROXY_SCOPE = "regular";

/** Нормализует введённые пользователем правила split tunnel. */
export function normalizeDirectPatterns(value) {
  const items = Array.isArray(value) ? value : String(value ?? "").split(/[\n,]+/);
  return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))];
}

function proxyDirective(socks) {
  let host = String(socks?.host || "127.0.0.1").trim() || "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  const port = Number(socks?.port) || 1080;
  return `SOCKS5 ${host}:${port}`;
}

/**
 * Собирает PAC: перечисленные шаблоны идут DIRECT, весь остальной трафик —
 * только через SOCKS5. Поддерживаются `arena.ai/*`, домены, `*.site.tld/*`
 * и полные URL с `*`/`?`.
 */
export function buildPacScript(socks, bypassList = [], directPatterns = []) {
  const proxy = proxyDirective(socks);
  const bypass = normalizeDirectPatterns(bypassList);
  const direct = normalizeDirectPatterns(directPatterns);

  // Только ES5-синтаксис: PAC исполняется отдельным движком Chrome.
  return `
var WDTT_PROXY = ${JSON.stringify(proxy)};
var WDTT_BYPASS_HOSTS = ${JSON.stringify(bypass)};
var WDTT_DIRECT_PATTERNS = ${JSON.stringify(direct)};

function wdttHostMatches(host, pattern) {
  pattern = String(pattern || "").toLowerCase();
  if (!pattern) return false;
  if (pattern === "<local>") return isPlainHostName(host);
  if (shExpMatch(host, pattern)) return true;
  if (pattern.indexOf("*") < 0 && pattern.indexOf("?") < 0 && dnsDomainIs(host, "." + pattern)) return true;
  return false;
}

function wdttDirectMatch(url, host, pattern) {
  pattern = String(pattern || "").toLowerCase();
  if (!pattern) return false;

  if (pattern.indexOf("://") >= 0) return shExpMatch(url, pattern);
  if (pattern.indexOf("/") >= 0) {
    var schemeEnd = url.indexOf("://");
    var withoutScheme = schemeEnd >= 0 ? url.substring(schemeEnd + 3) : url;
    return shExpMatch(withoutScheme, pattern);
  }
  return wdttHostMatches(host, pattern);
}

function FindProxyForURL(url, host) {
  url = String(url || "").toLowerCase();
  host = String(host || "").toLowerCase();

  for (var i = 0; i < WDTT_BYPASS_HOSTS.length; i++) {
    if (wdttHostMatches(host, WDTT_BYPASS_HOSTS[i])) return "DIRECT";
  }
  for (var j = 0; j < WDTT_DIRECT_PATTERNS.length; j++) {
    if (wdttDirectMatch(url, host, WDTT_DIRECT_PATTERNS[j])) return "DIRECT";
  }
  return WDTT_PROXY;
}
`.trim();
}

/** Собирает настройки прокси для локального SOCKS5. */
export function buildProxyValue(socks, bypassList, directPatterns = []) {
  const direct = normalizeDirectPatterns(directPatterns);
  if (direct.length) {
    return {
      mode: "pac_script",
      pacScript: {
        data: buildPacScript(socks, bypassList, direct),
        mandatory: true,
      },
    };
  }

  // Без split-правил оставляем простой fixed_servers: это самый надёжный
  // вариант и сохраняет прежнее поведение «весь трафик через VPN».
  const rules = {
    singleProxy: {
      scheme: "socks5",
      host: socks.host || "127.0.0.1",
      port: Number(socks.port) || 1080,
    },
  };
  const list = normalizeDirectPatterns(bypassList);
  if (list.length) rules.bypassList = list;
  return { mode: "fixed_servers", rules };
}

/** Включает прокси для всего профиля браузера. */
export async function enableProxy(socks, bypassList, directPatterns = []) {
  const value = buildProxyValue(socks, bypassList, directPatterns);
  await chrome.proxy.settings.set({ value, scope: PROXY_SCOPE });
  return value;
}

/** Выключает прокси (возвращает системные настройки). */
export async function disableProxy() {
  await chrome.proxy.settings.clear({ scope: PROXY_SCOPE });
}

/** Читает текущие настройки прокси (для диагностики). */
export async function getProxySettings() {
  const level = await chrome.proxy.settings.get({ incognito: false });
  return level?.value ?? null;
}
