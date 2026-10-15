/**
 * Минимальный SOCKS5-клиент: используется нативным хостом, чтобы проверить
 * туннель end-to-end и узнать внешний IP (браузерные fetch идут через прокси,
 * но проверка из хоста не зависит от настроек Chrome).
 */

const net = require("net");
const tls = require("tls");

const SOCKS_VERSION = 0x05;
const CMD_CONNECT = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV4 = 0x01;
const ATYP_IPV6 = 0x04;

/**
 * Буферизованный ридер поверх сокета: данные могут прийти несколькими
 * чанками, а ответы SOCKS5 часто прилетают одним пакетом — «лишние» байты
 * нельзя терять, иначе следующий ответ прочитается со сдвигом.
 */
function attachReader(socket) {
  if (socket.__wdttReader) return socket.__wdttReader;
  const reader = { buffer: Buffer.alloc(0), waiters: [], error: null };
  const fail = (err) => {
    reader.error = err;
    while (reader.waiters.length) reader.waiters.shift().reject(err);
  };
  socket.on("data", (chunk) => {
    reader.buffer = Buffer.concat([reader.buffer, chunk]);
    while (reader.waiters.length && reader.buffer.length >= reader.waiters[0].count) {
      const waiter = reader.waiters.shift();
      const data = reader.buffer.subarray(0, waiter.count);
      reader.buffer = reader.buffer.subarray(waiter.count);
      waiter.resolve(data);
    }
  });
  socket.on("error", (err) => fail(err));
  socket.on("close", () => fail(reader.error || new Error("SOCKS: соединение закрыто")));
  socket.__wdttReader = reader;
  return reader;
}

function readExactly(socket, count) {
  const reader = attachReader(socket);
  if (reader.buffer.length >= count) {
    const data = reader.buffer.subarray(0, count);
    reader.buffer = reader.buffer.subarray(count);
    return Promise.resolve(data);
  }
  return new Promise((resolve, reject) => {
    if (reader.error) {
      reject(reader.error);
      return;
    }
    reader.waiters.push({ count, resolve, reject });
  });
}

function encodeAddress(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return Buffer.concat([Buffer.from([ATYP_IPV4]), Buffer.from(host.split(".").map(Number))]);
  }
  if (host.includes(":")) {
    return Buffer.concat([Buffer.from([ATYP_IPV6]), Buffer.from(host.split(":").flatMap((p) => [parseInt(p || "0", 16)]))]);
  }
  const name = Buffer.from(host, "utf8");
  return Buffer.concat([Buffer.from([ATYP_DOMAIN, name.length]), name]);
}

/** Открывает TCP-туннель через SOCKS5 до targetHost:targetPort. */
function connectViaSocks({ socksHost, socksPort, targetHost, targetPort, username, password, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: socksHost, port: socksPort });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("SOCKS: таймаут подключения"));
    }, timeoutMs);

    const fail = (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    socket.once("error", fail);
    socket.once("connect", async () => {
      try {
        const methods = username ? Buffer.from([SOCKS_VERSION, 0x02, 0x00, 0x02]) : Buffer.from([SOCKS_VERSION, 0x01, 0x00]);
        socket.write(methods);
        const greeting = await readExactly(socket, 2);
        if (greeting[0] !== SOCKS_VERSION) throw new Error("SOCKS: неверная версия протокола");

        if (greeting[1] === 0x02) {
          if (!username) throw new Error("SOCKS: требуется авторизация");
          const user = Buffer.from(username, "utf8");
          const pass = Buffer.from(password || "", "utf8");
          socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
          const authReply = await readExactly(socket, 2);
          if (authReply[1] !== 0x00) throw new Error("SOCKS: неверные логин/пароль");
        } else if (greeting[1] !== 0x00) {
          throw new Error("SOCKS: нет поддерживаемого метода авторизации");
        }

        const addr = encodeAddress(targetHost);
        const portBuf = Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]);
        socket.write(Buffer.concat([Buffer.from([SOCKS_VERSION, CMD_CONNECT, 0x00]), addr, portBuf]));

        const head = await readExactly(socket, 4);
        if (head[1] !== 0x00) {
          const codes = {
            1: "общий сбой",
            2: "запрещено правилами",
            3: "сеть недостижима",
            4: "хост недостижим",
            5: "отказано в соединении",
            6: "TTL истёк",
            7: "команда не поддерживается",
            8: "тип адреса не поддерживается",
          };
          throw new Error(`SOCKS: соединение отклонено (${codes[head[1]] || head[1]})`);
        }
        // длины остатка адреса
        let consumed = 0;
        if (head[3] === ATYP_DOMAIN) {
          const lenBuf = await readExactly(socket, 1);
          consumed = 1 + lenBuf[0] + 2;
        } else if (head[3] === ATYP_IPV4) {
          consumed = 4 + 2;
        } else {
          consumed = 16 + 2;
        }
        if (consumed > 0) await readExactly(socket, consumed);

        clearTimeout(timer);
        socket.off("error", fail);
        resolve(socket);
      } catch (err) {
        fail(err);
      }
    });
  });
}

/** Распаковывает chunked-тело HTTP-ответа. */
function decodeChunked(raw) {
  let out = "";
  let rest = raw;
  while (true) {
    const lineEnd = rest.indexOf("\r\n");
    if (lineEnd < 0) break;
    const size = Number.parseInt(rest.slice(0, lineEnd).split(";")[0].trim(), 16);
    if (!Number.isFinite(size)) break;
    if (size === 0) break;
    const start = lineEnd + 2;
    out += rest.slice(start, start + size);
    rest = rest.slice(start + size + 2);
  }
  return out;
}

/** Делает HTTPS-запрос через SOCKS5 и возвращает тело ответа. */
async function httpsGetViaSocks({ socksHost, socksPort, targetHost, targetPort = 443, path = "/", username, password, timeoutMs = 15000 }) {
  const socket = await connectViaSocks({ socksHost, socksPort, targetHost, targetPort, username, password, timeoutMs });
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: targetHost, rejectUnauthorized: false }, () => {
      secure.write(
        `GET ${path} HTTP/1.1\r\nHost: ${targetHost}\r\nUser-Agent: wdtt-chrome/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
      );
    });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new Error("TLS: таймаут ответа"));
    }, timeoutMs);

    const chunks = [];
    secure.on("data", (chunk) => chunks.push(chunk));
    secure.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    secure.on("end", () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const separator = raw.indexOf("\r\n\r\n");
      if (separator < 0) {
        reject(new Error("HTTP: некорректный ответ"));
        return;
      }
      const headers = raw.slice(0, separator).toLowerCase();
      let body = raw.slice(separator + 4);
      if (headers.includes("transfer-encoding: chunked")) body = decodeChunked(body);
      resolve(body);
    });
  });
}

/** Определяет внешний IP через туннель. */
async function checkExternalIp({ socksHost, socksPort, username, password, targets }) {
  const defaultTargets = [
    { host: "api.ipify.org", path: "/?format=json", parse: (b) => JSON.parse(b).ip },
    { host: "ifconfig.me", path: "/ip", parse: (b) => b.trim() },
  ];
  const list = targets && targets.length ? targets : defaultTargets;
  let lastError = null;
  for (const target of list) {
    try {
      const started = Date.now();
      const body = await httpsGetViaSocks({
        socksHost,
        socksPort,
        targetHost: target.host,
        targetPort: target.port || 443,
        path: target.path,
        username,
        password,
      });
      const ip = target.parse(body);
      if (ip) return { ip, ms: Date.now() - started };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("не удалось определить IP");
}

module.exports = { connectViaSocks, httpsGetViaSocks, checkExternalIp };
