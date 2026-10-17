/**
 * Управление процессом нативного туннеля WDTT.
 *
 * Туннель — это Go-клиент WDTT в режиме `-mode socks`: он поднимает
 * локальный SOCKS5 (по умолчанию 127.0.0.1:1080), а трафик гонит
 * через VK TURN (DTLS + WireGuard) на ваш VPS.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const HOME_DIR = process.env.WDTT_HOME || path.join(os.homedir(), ".wdtt-tunnel");
const STATE_FILE = path.join(HOME_DIR, "state.json");
const LOG_FILE = path.join(HOME_DIR, "tunnel.log");
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const BINARY_CANDIDATES = [
  path.join(REPO_ROOT, "tunnel", "bin", "wdtt-tunnel"),
  path.join(REPO_ROOT, "tunnel", "bin", "wdtt-tunnel.exe"),
  path.join(HOME_DIR, "bin", "wdtt-tunnel"),
  path.join(HOME_DIR, "bin", "wdtt-tunnel.exe"),
  "/usr/local/bin/wdtt-tunnel",
  "/opt/wdtt/wdtt-tunnel",
];

function ensureDirs() {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(path.join(HOME_DIR, "bin"), { recursive: true });
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  ensureDirs();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** Ищет бинарник туннеля: явный путь → env → репозиторий → ~/.wdtt-tunnel → PATH. */
function findBinary(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.WDTT_TUNNEL_BIN) candidates.push(process.env.WDTT_TUNNEL_BIN);
  candidates.push(...BINARY_CANDIDATES);

  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      /* следующий кандидат */
    }
  }

  // Ищем в PATH
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `wdtt-tunnel${ext}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* ищем дальше */
      }
    }
  }
  return "";
}

/** Возвращает последние строки лог-файла. */
function tailLog(lines = 120) {
  try {
    const content = fs.readFileSync(LOG_FILE, "utf8");
    const all = content.split(/\r?\n/).filter((line) => line.length);
    return all.slice(-lines);
  } catch {
    return [];
  }
}

function detectError(logLines) {
  const markers = ["FATAL_AUTH", "КРИТИЧ", "Критическая ошибка", "не удалось", "Не удалось", "DENIED", "Fatal"];
  for (let i = logLines.length - 1; i >= 0; i -= 1) {
    const line = logLines[i];
    if (markers.some((marker) => line.includes(marker))) return line.trim();
  }
  return "";
}

/** Собирает текущий статус туннеля. */
function status() {
  const state = readState();
  const running = isAlive(state.pid);
  const logLines = tailLog(200);
  const detectedReady = logLines.some((line) => line.includes("[SOCKS] listening"));
  let stateChanged = false;

  // Запоминаем готовность на всю жизнь текущего процесса. Иначе после того,
  // как строка listening выпадет из последних 200 строк лога, UI ошибочно
  // снова покажет «Подключение…», хотя SOCKS продолжает работать.
  if (running && detectedReady && !state.socksReady) {
    state.socksReady = true;
    stateChanged = true;
  }
  if (!running && state.socksReady) {
    state.socksReady = false;
    stateChanged = true;
  }

  const socksReady = running && Boolean(state.socksReady);
  const binaryPath = state.binary || findBinary("");
  const result = {
    running,
    socksReady,
    pid: running ? state.pid : 0,
    startedAt: state.startedAt || 0,
    socks: state.socks || null,
    args: state.args || [],
    binaryPath,
    binaryFound: Boolean(binaryPath),
    error: running ? "" : detectError(logLines) || state.error || "",
    logTail: logLines.slice(-40),
  };
  // Если процесс умер — фиксируем это в состоянии.
  if (!running && state.pid && !state.error) {
    const err = detectError(logLines);
    if (err) {
      state.error = err;
      stateChanged = true;
      result.error = err;
    }
  }
  if (stateChanged) writeState(state);
  return result;
}

/** Запускает туннель (если уже запущен — возвращает текущий статус). */
function start({ args, socks, binary }) {
  const current = status();
  if (current.running) {
    return { started: false, status: current };
  }

  const bin = findBinary(binary);
  if (!bin) {
    const msg =
      "Бинарник туннеля не найден. Соберите его командой tunnel/build.sh " +
      "или укажите путь в настройках расширения.";
    writeState({ ...readState(), error: msg, pid: 0, socksReady: false });
    const err = new Error(msg);
    err.code = "binary-missing";
    throw err;
  }

  ensureDirs();
  // Ротация лога, чтобы он не рос бесконечно.
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > 8 * 1024 * 1024) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    /* файла ещё нет */
  }

  const fd = fs.openSync(LOG_FILE, "a");
  const launchArgs = [...(args || [])];
  const modeIndex = launchArgs.findIndex((arg) => arg === "-mode");
  const mode = modeIndex >= 0 ? launchArgs[modeIndex + 1] : "";
  const systemMode = mode === "wg" || mode === "rawsystem";
  if (systemMode && !launchArgs.some((arg) => arg === "-log-file" || arg.startsWith("-log-file="))) {
    launchArgs.push("-log-file", LOG_FILE);
  }
  const child = spawn(bin, launchArgs, {
    detached: true,
    stdio: ["ignore", fd, fd],
    cwd: HOME_DIR,
    env: { ...process.env, WDTT_HOME: HOME_DIR },
  });
  child.unref();
  fs.closeSync(fd);

  writeState({
    pid: child.pid,
    startedAt: Date.now(),
    socks: socks || null,
    args: launchArgs,
    binary: bin,
    socksReady: false,
    error: "",
  });

  return { started: true, status: status() };
}

/** Останавливает туннель. */
function stop() {
  const state = readState();
  if (!state.pid || !isAlive(state.pid)) {
    writeState({ ...state, pid: 0, socksReady: false, error: "" });
    return { stopped: false, status: status() };
  }
  try {
    process.kill(state.pid, "SIGTERM");
  } catch (err) {
    return { stopped: false, error: String(err?.message || err), status: status() };
  }
  writeState({ ...state, pid: 0, socksReady: false, error: "" });
  return { stopped: true, status: status() };
}

module.exports = {
  HOME_DIR,
  STATE_FILE,
  LOG_FILE,
  REPO_ROOT,
  findBinary,
  status,
  start,
  stop,
  tailLog,
};
