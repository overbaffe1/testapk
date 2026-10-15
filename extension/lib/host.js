/**
 * Клиент native messaging: общается с нативным хостом com.wdtt.tunnel,
 * который управляет процессом туннеля WDTT.
 */

export const HOST_NAME = "com.wdtt.tunnel";

export class HostError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "HostError";
    this.code = code;
  }
}

export class HostClient {
  constructor(hostName = HOST_NAME) {
    this.hostName = hostName;
    this.port = null;
    this.pending = new Map();
    this.listeners = new Set();
    this.seq = 0;
    this.state = "disconnected"; // disconnected | connecting | connected | error
    this.lastError = "";
  }

  get connected() {
    return this.state === "connected";
  }

  onEvent(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  #emit(event, payload) {
    for (const listener of this.listeners) {
      try {
        listener(event, payload);
      } catch (err) {
        console.error("[wdtt] listener error", err);
      }
    }
  }

  connect() {
    if (this.port) return this.port;
    this.state = "connecting";
    let port;
    try {
      port = chrome.runtime.connectNative(this.hostName);
    } catch (err) {
      this.state = "error";
      this.lastError = String(err?.message || err);
      throw new HostError(`Не удалось подключиться к нативному хосту: ${this.lastError}`);
    }

    this.port = port;
    port.onMessage.addListener((message) => this.#onMessage(message));
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      this.lastError = err?.message || "нативный хост отключился";
      this.port = null;
      this.state = "error";
      for (const { reject } of this.pending.values()) {
        reject(new HostError(this.lastError, "disconnected"));
      }
      this.pending.clear();
      this.#emit("disconnected", { error: this.lastError });
    });
    this.state = "connected";
    this.#emit("connected", {});
    return port;
  }

  #onMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "event") {
      this.#emit(message.event, message.payload);
      return;
    }
    if (message.type === "result" && message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.ok) entry.resolve(message.payload);
      else entry.reject(new HostError(message.error || "ошибка нативного хоста", message.code));
    }
  }

  request(type, payload, { timeoutMs = 20000 } = {}) {
    let port;
    try {
      port = this.connect();
    } catch (err) {
      return Promise.reject(err);
    }

    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostError(`Таймаут ответа хоста (${type})`, "timeout"));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      try {
        port.postMessage({ id, type, payload });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HostError(String(err?.message || err), "post-failed"));
      }
    });
  }

  disconnect() {
    if (!this.port) return;
    try {
      this.port.disconnect();
    } catch {
      /* ignore */
    }
    this.port = null;
    this.state = "disconnected";
  }
}

export const host = new HostClient();
