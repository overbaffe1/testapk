/**
 * Парсер подписок qWDTT / WDTT.
 *
 * Поддерживаемые форматы (любой из них можно вставить в расширение):
 *
 *  1. qWDTT JSON (один сервер) — то, что отдаёт /subnow/...?format=qwdtt:
 *     {"vpn":"...","name":"@user","ip":"srv4.dream31.ru","port":56000,
 *      "raw":56003,"pass":"k7Fae...","hash":"FDzujt...","sub":"https://..."}
 *
 *  2. qWDTT JSON (список профилей):
 *     {"profiles":[{"name":"...","peer":"host:56000","hashes":"...",
 *                   "workers":18,"port":9000,"password":"..."}]}
 *     или просто массив [...]
 *
 *  3. WDTT JSON (легаси): {"name","peer","hashes","workers","port","password"}
 *
 *  4. Ссылка WDTT (легаси):
 *     wdtt://<ip>:<dtls_port>:<wg_port>:<local_port>:<password>:<vk_hash>
 *
 *  5. Ссылка qWDTT:
 *     qwdtt://config?name=&peer=&hashes=&workers=&port=&pass=
 *
 *  6. Любой из пунктов 1-5, закодированный в base64.
 *
 *  7. HTTP(S)-ссылка на подписку (загружается отдельно, см. fetchSubscription).
 *
 * Модуль не зависит от API Chrome — его можно тестировать в Node (tests/).
 */

export const WORKERS_PER_GROUP = 9;
export const MAX_WORKERS = 108;
export const DEFAULT_WORKERS = 18;
export const DEFAULT_DTLS_PORT = 56000;
export const DEFAULT_LISTEN_PORT = 9000;

const VK_HASH_RE = /^[A-Za-z0-9_-]{6,}$/;

/** @typedef {{host:string, port:number}} Peer */
/**
 * @typedef {{
 *   name:string, peer:Peer, rawPort:number, hashes:string[], workers:number,
 *   listenPort:number, password:string, source:string
 * }} Profile */

/** Нормализует число хешей VK: принимает строку/массив/разделители. */
export function parseHashes(raw) {
  if (Array.isArray(raw)) {
    return raw.map((h) => String(h).trim()).filter(Boolean);
  }
  if (raw === null || raw === undefined) return [];
  return String(raw)
    .split(/[,;\s]+/)
    .map((h) => h.trim())
    .filter(Boolean);
}

/** Приводит количество потоков к допустимому для Go-клиента значению. */
export function normalizeWorkers(value) {
  let n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) n = DEFAULT_WORKERS;
  n = Math.min(n, MAX_WORKERS);
  if (n < WORKERS_PER_GROUP) n = WORKERS_PER_GROUP;
  // Go-клиент режет воркеры по группам по 9 — число должно быть кратно группе.
  n = Math.floor(n / WORKERS_PER_GROUP) * WORKERS_PER_GROUP;
  if (n < WORKERS_PER_GROUP) n = WORKERS_PER_GROUP;
  return n;
}

/** Разбирает "host:port" в объект пира. */
export function parsePeer(raw, defaultPort = DEFAULT_DTLS_PORT) {
  if (!raw) return null;
  let host = String(raw).trim();
  let port = defaultPort;

  // Поддержка схемы вида scheme://host:port
  const schemeMatch = host.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  if (schemeMatch) host = host.slice(schemeMatch[0].length);

  // IPv6 в квадратных скобках
  const ipv6 = host.match(/^\[([0-9a-f:]+)\](?::(\d+))?$/i);
  if (ipv6) {
    return { host: `[${ipv6[1]}]`, port: ipv6[2] ? Number(ipv6[2]) : defaultPort };
  }

  const idx = host.lastIndexOf(":");
  if (idx > 0 && /^\d+$/.test(host.slice(idx + 1))) {
    port = Number(host.slice(idx + 1));
    host = host.slice(0, idx);
  }
  if (!host) return null;
  return { host, port };
}

function firstString(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function firstNumber(obj, keys, fallback) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  }
  return fallback;
}

/** Приводит объект профиля к внутреннему виду. */
function profileFromObject(obj, fallbackName = "WDTT") {
  if (!obj || typeof obj !== "object") return null;

  const name = firstString(obj, ["name", "title", "label", "groupName"]) || fallbackName;

  // Пир: либо явный peer, либо ip+port.
  let peer = parsePeer(firstString(obj, ["peer", "server", "address", "host"]));
  if (!peer) {
    const ip = firstString(obj, ["ip", "server_ip", "serverIp", "domain"]);
    if (ip) {
      const port = firstNumber(obj, ["port", "dtls", "dtls_port", "server_port", "dtlsPort"], DEFAULT_DTLS_PORT);
      peer = parsePeer(`${ip}:${port}`);
    }
  }
  if (!peer) return null;

  const hashes = parseHashes(firstString(obj, ["hashes", "vkHashes", "hash", "vk_hash", "vkHash"]));
  if (!hashes.length) return null;

  const password = firstString(obj, ["password", "pass", "passwd", "secret"]);
  const workers = normalizeWorkers(firstNumber(obj, ["workers", "workersPerHash", "threads"], DEFAULT_WORKERS));
  const listenPort = firstNumber(obj, ["port_local", "listenPort", "localPort"], 0);
  const rawPort = firstNumber(obj, ["raw", "raw_port", "rawPort"], 0);

  return {
    name,
    peer,
    rawPort,
    hashes,
    workers,
    // listenPort из qWDTT-ссылки — это локальный UDP-порт клиента,
    // в JSON-профиле поле "port" занимает смысл DTLS-порта, поэтому
    // listenPort берём только из явно локальных ключей.
    listenPort: listenPort || DEFAULT_LISTEN_PORT,
    password,
  };
}

/** Разбирает легаси-ссылку wdtt://ip:dtls:wg:local:pass:hash. */
export function parseLegacyLink(text) {
  const rest = text.replace(/^wdtt:\/\//i, "").trim();
  if (!rest) return null;
  const parts = rest.split(":");
  if (parts.length < 6) return null;

  const host = parts[0].trim();
  const dtlsPort = Number.parseInt(parts[1], 10);
  const localPort = Number.parseInt(parts[3], 10);
  const password = parts[4];
  const hash = parts.slice(5).join(":");
  if (!host || !Number.isFinite(dtlsPort) || !password || !hash) return null;

  return {
    name: `WDTT ${host}`,
    peer: { host, port: dtlsPort },
    rawPort: 0,
    hashes: parseHashes(hash),
    workers: DEFAULT_WORKERS,
    listenPort: Number.isFinite(localPort) && localPort > 0 ? localPort : DEFAULT_LISTEN_PORT,
    password,
  };
}

/** Разбирает ссылку qwdtt://config?... */
export function parseQwdttLink(text) {
  const normalized = text.replace(/^qwdtt:config/i, "qwdtt://config");
  let url;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }
  const q = url.searchParams;
  const peerRaw = q.get("peer") || "";
  if (!peerRaw) return null;

  const dtlsPort = q.get("dtls_port") || q.get("server_port");
  let peer = parsePeer(peerRaw);
  if (peer && dtlsPort) {
    const p = Number.parseInt(dtlsPort, 10);
    if (Number.isFinite(p)) peer = { ...peer, port: p };
  }
  if (!peer) return null;

  const hashes = parseHashes(q.get("hashes") || "");
  if (!hashes.length) return null;

  const localPort = Number.parseInt(q.get("port") || "", 10);
  const rawPort = Number.parseInt(q.get("raw") || q.get("raw_port") || "", 10);
  return {
    name: q.get("name") || "qWDTT",
    peer,
    rawPort: Number.isFinite(rawPort) ? rawPort : 0,
    hashes,
    workers: normalizeWorkers(q.get("workers")),
    listenPort: Number.isFinite(localPort) && localPort > 0 ? localPort : DEFAULT_LISTEN_PORT,
    password: q.get("pass") || q.get("password") || "",
  };
}

/** Разбирает JSON-подписку (один профиль, список профилей или qWDTT-объект). */
export function parseJsonPayload(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }

  if (Array.isArray(data)) {
    const profiles = data.map((item, i) => profileFromObject(item, `WDTT #${i + 1}`)).filter(Boolean);
    return profiles.length ? profiles : null;
  }

  if (data && typeof data === "object") {
    const list = data.profiles || data.servers || data.items;
    if (Array.isArray(list)) {
      const profiles = list.map((item, i) => profileFromObject(item, `WDTT #${i + 1}`)).filter(Boolean);
      if (profiles.length) return profiles;
    }
    const single = profileFromObject(data);
    return single ? [single] : null;
  }
  return null;
}

/** Пытается декодировать base64 (в т.ч. URL-безопасный). */
export function tryBase64Decode(text) {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 16) return null;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(compact)) return null;
  try {
    let normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
    while (normalized.length % 4 !== 0) normalized += "=";
    const decoded = atob(normalized);
    const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
    const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const trimmed = utf8.trim();
    if (!trimmed) return null;
    if (/^[[{]/.test(trimmed) || /^qwdtt:/i.test(trimmed) || /^wdtt:/i.test(trimmed)) return trimmed;
    return null;
  } catch {
    return null;
  }
}

/** Декодирует минимальный набор HTML entities из атрибутов и textarea. */
function decodeHtmlEntities(value) {
  const decodeCodePoint = (whole, code, radix) => {
    const point = Number.parseInt(code, radix);
    return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  };
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);?/gi, (whole, code) => decodeCodePoint(whole, code, 16))
    .replace(/&#(\d+);?/g, (whole, code) => decodeCodePoint(whole, code, 10))
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/** Извлекает WDTT/qWDTT-ссылки из HTML-страницы информации о подписке. */
export function extractSubscriptionLinksFromHtml(html) {
  const text = String(html ?? "");
  const links = [];
  const add = (value) => {
    const link = decodeHtmlEntities(value).trim();
    if (/^(?:q?wdtt):\/\//i.test(link) && !links.includes(link)) links.push(link);
  };

  // На страницах 3x-ui ссылки находятся в скрытом textarea. Сначала берём
  // именно его, чтобы не спутать конфигурацию с примерами из скриптов.
  const textareaRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea\s*>/gi;
  for (const match of text.matchAll(textareaRe)) {
    if (!/\bid\s*=\s*(["'])subscription-links\1/i.test(match[1])) continue;
    for (const line of decodeHtmlEntities(match[2]).split(/\r?\n/)) add(line);
  }

  // Резерв для страниц другой версии, где ссылки выведены только в div.
  const decoded = decodeHtmlEntities(text);
  for (const match of decoded.matchAll(/\b(?:q?wdtt):\/\/[^\s<>"']+/gi)) add(match[0]);
  return links;
}

/** Находит qWDTT JSON endpoint в HTML страницы подписки. */
export function extractSubscriptionJsonUrl(html, baseUrl = "") {
  const text = String(html ?? "");
  const attr = text.match(/\bdata-subjson-url\s*=\s*(["'])(.*?)\1/i);
  let candidate = attr ? decodeHtmlEntities(attr[2]).trim() : "";
  if (!candidate) {
    const decoded = decodeHtmlEntities(text);
    candidate = decoded.match(/https?:\/\/[^\s<>"']*[?&]format=qwdtt(?:[&#][^\s<>"']*)?/i)?.[0] || "";
  }
  if (!candidate) return "";
  try {
    return new URL(candidate, baseUrl || undefined).href;
  } catch {
    return "";
  }
}

/**
 * Основной парсер: принимает любой поддерживаемый формат.
 * @returns {{ok:true, profiles:Profile[], kind:string, source:string}|{ok:false, error:string, kind:string}}
 */
export function parseSubscription(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "Пустая подписка", kind: "empty" };

  if (/^(?:<!doctype\s+html|<html\b)/i.test(text)) {
    for (const link of extractSubscriptionLinksFromHtml(text)) {
      const nested = parseSubscription(link);
      if (nested.ok) return { ...nested, kind: `${nested.kind}+html`, source: text };
    }
    return {
      ok: false,
      error: "HTML-страница подписки не содержит распознаваемой WDTT-конфигурации",
      kind: "html",
    };
  }

  if (/^https?:\/\//i.test(text)) {
    return { ok: false, error: "Это HTTP-ссылка — загрузите её кнопкой «Загрузить по URL»", kind: "url" };
  }

  if (/^wdtt:\/\//i.test(text)) {
    // Сервер подписки без ?format=qwdtt возвращает двойную обёртку:
    // base64("wdtt://" + base64(JSON)). После первого декодирования сюда
    // приходит wdtt://<base64 JSON>, а не легаси host:ports:pass:hash.
    const rest = text.replace(/^wdtt:\/\//i, "").trim();
    const decoded = tryBase64Decode(rest);
    if (decoded) {
      const nested = parseSubscription(decoded);
      if (nested.ok) return { ...nested, kind: `${nested.kind}+wdtt-base64`, source: text };
    }

    const profile = parseLegacyLink(text);
    if (profile) return { ok: true, profiles: [profile], kind: "wdtt-link", source: text };
    return { ok: false, error: "Не удалось разобрать ссылку wdtt://", kind: "wdtt-link" };
  }

  if (/^qwdtt:config/i.test(text) || /^qwdtt:\/\/config/i.test(text)) {
    const profile = parseQwdttLink(text);
    if (profile) return { ok: true, profiles: [profile], kind: "qwdtt-link", source: text };
    return { ok: false, error: "Не удалось разобрать ссылку qwdtt://config", kind: "qwdtt-link" };
  }

  if (/^[[{]/.test(text)) {
    const profiles = parseJsonPayload(text);
    if (profiles) return { ok: true, profiles, kind: "json", source: text };
    return { ok: false, error: "JSON не содержит профиля (нужны peer/ip+port и hash)", kind: "json" };
  }

  // Ссылка без схемы: host:dtls:wg:local:pass:hash
  if (/^[^\s:/?#]+:\d+(:|$)/.test(text)) {
    const profile = parseLegacyLink(`wdtt://${text}`);
    if (profile) return { ok: true, profiles: [profile], kind: "wdtt-link", source: text };
  }

  const decoded = tryBase64Decode(text);
  if (decoded) {
    const result = parseSubscription(decoded);
    if (result.ok) return { ...result, kind: `${result.kind}+base64` };
    return { ok: false, error: result.error, kind: "base64" };
  }

  return { ok: false, error: "Формат не распознан", kind: "unknown" };
}

/**
 * Строит аргументы командной строки для нативного туннеля (Go-клиент WDTT).
 * @param {Profile} profile
 * @param {{socksHost?:string, socksPort?:number, deviceId?:string, goDns?:string,
 *          obfs?:string, captchaMode?:string, vkAuthMode?:string, listenHost?:string,
 *          directPatterns?:string[], transportMode?:"raw"|"wg"|"socks5"}} opts
 */
export function buildTunnelArgs(profile, opts = {}) {
  const {
    socksHost = "127.0.0.1",
    socksPort = 1080,
    deviceId = "chrome-extension",
    goDns = "yandex",
    obfs = "audio",
    captchaMode = "auto",
    vkAuthMode = "anonymous",
    listenHost = "127.0.0.1",
    workers = 0,
    directPatterns = [],
    transportMode = "socks5",
  } = opts;

  const hashes = parseHashes(profile.hashes).filter((h) => VK_HASH_RE.test(h) || h.length > 0);
  const workerCount = workers > 0 ? normalizeWorkers(workers) : normalizeWorkers(profile.workers);
  const rawSelected = transportMode === "raw";
  if (rawSelected && !profile.rawPort) {
    throw new Error("В подписке нет RAW-порта сервера");
  }
  const peerPort = rawSelected ? profile.rawPort : profile.peer.port;
  const args = [
    "-peer", `${profile.peer.host}:${peerPort}`,
    "-vk", hashes.join(","),
    "-n", String(workerCount),
    "-listen", `${listenHost}:${profile.listenPort || DEFAULT_LISTEN_PORT}`,
    "-device-id", String(deviceId || "chrome-extension"),
    "-password", String(profile.password ?? ""),
    "-captcha-mode", captchaMode,
    "-vk-auth", vkAuthMode,
    "-go-dns", goDns,
    "-obfs", obfs,
    "-mode", rawSelected ? "rawsystem" : transportMode === "wg" ? "wg" : "socks",
    "-socks", `${socksHost}:${socksPort}`,
  ];
  if ((rawSelected || transportMode === "wg") && Array.isArray(directPatterns) && directPatterns.length) {
    args.push("-system-bypass", directPatterns.map((value) => String(value).trim()).filter(Boolean).join(","));
  }
  return args;
}

/** Человекочитаемое описание профиля для UI. */
export function describeProfile(profile) {
  const masks = profile.hashes.map((h) => (h.length > 6 ? `${h.slice(0, 4)}…${h.slice(-3)}` : h)).join(", ");
  return {
    name: profile.name,
    server: `${profile.peer.host}:${profile.peer.port}`,
    hashes: masks,
    hashCount: profile.hashes.length,
    workers: profile.workers,
    listenPort: profile.listenPort,
    hasPassword: Boolean(profile.password),
  };
}
