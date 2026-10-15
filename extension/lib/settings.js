/**
 * Хранилище настроек расширения.
 */

export const STORAGE_KEY = "wdttState";

export const DEFAULTS = {
  /** Включён ли прокси в браузере. */
  enabled: false,
  /** Текущий профиль подписки (объект Profile из subscribe.js). */
  profile: null,
  /** Исходный текст подписки — чтобы переиспользовать его в popup. */
  profileSource: "",
  /** Как используется туннель:
   *  managed  — расширение само запускает нативный туннель;
   *  external — туннель уже запущен пользователем (Android-приложение, systemd, ...). */
  mode: "managed",
  /** Параметры локального SOCKS5. */
  socks: {
    host: "127.0.0.1",
    port: 1080,
    auth: false,
    user: "",
    pass: "",
  },
  /** Автоподключение при старте браузера. */
  autoConnect: false,
  /** Kill switch: не возвращать трафик в direct, пока туннель не поднят. */
  killSwitch: true,
  /** Список хостов, которые идут напрямую. */
  bypassList: ["localhost", "127.0.0.1", "::1", "<local>"],
  /** Параметры нативного туннеля. */
  tunnel: {
    binary: "",
    workers: 0, // 0 = взять количество потоков из подписки
    goDns: "yandex",
    obfs: "audio",
    captchaMode: "auto",
    vkAuthMode: "anonymous",
  },
  /** Последняя известная ошибка. */
  lastError: "",
  /** Последний известный внешний IP (заполняется хостом). */
  egressIp: "",
};

/** Глубокое слияние с настройками по умолчанию. */
export function withDefaults(input) {
  const base = structuredClone(DEFAULTS);
  if (!input || typeof input !== "object") return base;
  return {
    ...base,
    ...input,
    socks: { ...base.socks, ...(input.socks || {}) },
    tunnel: { ...base.tunnel, ...(input.tunnel || {}) },
    bypassList: Array.isArray(input.bypassList) ? input.bypassList : base.bypassList,
  };
}

export async function loadState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return withDefaults(data?.[STORAGE_KEY]);
}

export async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  return state;
}

export async function patchState(patch) {
  const current = await loadState();
  const next = withDefaults({ ...current, ...patch });
  await saveState(next);
  return next;
}
