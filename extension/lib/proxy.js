/**
 * Управление прокси Chrome через chrome.proxy.
 */

export const PROXY_SCOPE = "regular";

/** Собирает значение fixed_servers для локального SOCKS5. */
export function buildProxyValue(socks, bypassList) {
  const scheme = "socks5";
  const rules = {
    singleProxy: {
      scheme,
      host: socks.host || "127.0.0.1",
      port: Number(socks.port) || 1080,
    },
  };
  const list = (bypassList || []).map((item) => String(item).trim()).filter(Boolean);
  if (list.length) rules.bypassList = list;
  return { mode: "fixed_servers", rules };
}

/** Включает прокси для всего профиля браузера. */
export async function enableProxy(socks, bypassList) {
  const value = buildProxyValue(socks, bypassList);
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
