// bridge.js — QQ ↔ DSH 桥接主进程（核心）。
//
// 链路：
//   QQ 消息 → NapCat (OneBot v11 WS) → 本进程 → DSH Web API (session.prompt)
//   DSH agent 回复/工具调用 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 本进程连接两端：
//   1. NapCat：OneBot WebSocket(ws://127.0.0.1:3001) 收事件 + HTTP(http://127.0.0.1:3000) 发消息
//   2. DSH：Web API(http://127.0.0.1:3080) 创建会话、投递 prompt、订阅事件流
//
// 用法：node src/bridge.js （用后文 README 配置）
//
// 说明：这是"消息驱动"版 —— 每个 QQ 会话对应一个 DSH agent 会话，
//      收到 QQ 消息就投递 prompt，让 DeepSeek 自主决定（回/不回/行为）。

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const STATE_PATH = path.join(ROOT, "state", "sessions.json");

// ── 配置 ───────────────────────────────────────────────────────────────────
function loadConfig() {
  let raw;
  try {
    let text = fs.readFileSync(CONFIG_PATH, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`无法读取配置 ${CONFIG_PATH}：${e.message}`);
  }
  const cfg = {
    dsh: { baseUrl: "http://127.0.0.1:3080", ...(raw.dsh ?? {}) },
    onebot: { wsUrl: "ws://127.0.0.1:3001", httpUrl: "http://127.0.0.1:3000", token: "", ...(raw.onebot ?? {}) },
    ownerQQ: raw.ownerQQ ?? null,
    agentPreset: raw.agentPreset ?? "qq-chat",
    workspaceTitle: raw.workspaceTitle ?? "QQ 聊天",
    allow: { private: [].concat(raw.allow?.private ?? []), groups: [].concat(raw.allow?.groups ?? []) },
    deny: { private: [].concat(raw.deny?.private ?? []), groups: [].concat(raw.deny?.groups ?? []) },
    allowAllWhenEmpty: raw.allowAllWhenEmpty === true,
    sendDelayMs: raw.sendDelayMs ?? 300,
    consolePort: raw.consolePort ?? 3100,
    consoleToken: raw.consoleToken ?? "",
  };
  return cfg;
}

const cfg = loadConfig();
fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
fs.mkdirSync(path.join(ROOT, "state"), { recursive: true });

const log = (...a) => console.log(`[bridge] ${new Date().toISOString().slice(11, 19)}`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 会话映射持久化 ─────────────────────────────────────────────────────────
let state = { sessions: {} }; // key -> sessionId
function loadState() {
  try {
    const loaded = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (loaded?.sessions) state = loaded;
  } catch {}
}
function saveState() {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); } catch {}
}
loadState();

// ── DSH Web API 客户端 ─────────────────────────────────────────────────────
class DshClient {
  constructor(baseUrl) {
    this.base = String(baseUrl ?? "http://127.0.0.1:3080").replace(/\/+$/, "");
  }
  async rpc(method, payload) {
    const res = await fetch(`${this.base}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${method}`);
    if (!body.result?.ok) {
      const e = body.result?.error ?? {};
      throw new Error(`${method} failed: ${e.code ?? ""}: ${e.message ?? ""}`);
    }
    return body.result.value;
  }
  async createSession(opts = {}) {
    return this.rpc("sessions.create", { sessionId: opts.sessionId, cwd: opts.cwd, agentPreset: opts.agentPreset });
  }
  async prompt({ sessionId, content, mode = "queue" }) {
    return this.rpc("sessions.prompt", { sessionId, mode, content });
  }
  connectMux(onEnvelope) {
    // events.mux 是仅下行 WebSocket
    const url = new URL("/api/events.mux", this.base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    ws.onopen = () => log("DSH events.mux 已连接");
    ws.onmessage = (ev) => {
      try {
        const full = JSON.parse(ev.data);
        onEnvelope(full);
      } catch {}
    };
    ws.onclose = () => { log("DSH events.mux 断开，准备重连"); setTimeout(() => this.connectMux(onEnvelope), 3000); };
    ws.onerror = () => {};
    return ws;
  }
}

const dsh = new DshClient(cfg.dsh.baseUrl);

// ── OneBot 客户端 ──────────────────────────────────────────────────────────
class OneBotClient {
  constructor() {
    this.ws = null;
    this.httpUrl = cfg.onebot.httpUrl.replace(/\/+$/, "");
    this.token = cfg.onebot.token;
    this.onEvent = null; // (event) => void
  }
  async api(action, params = {}) {
    const res = await fetch(`${this.httpUrl}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== "ok" || body.retcode !== 0) {
      throw new Error(`OneBot ${action} 失败: ${body.wording ?? body.retcode ?? res.status}`);
    }
    return body.data;
  }
  connect() {
    const url = new URL(cfg.onebot.wsUrl);
    const proto = url.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${proto}://${url.host}${url.pathname}${this.token ? `?access_token=${encodeURIComponent(this.token)}` : ""}`;
    log(`连接 OneBot WebSocket: ${wsUrl}`);
    this.ws = new WebSocket(wsUrl);
    this.ws.onopen = () => log("OneBot WebSocket 已连接");
    this.ws.onmessage = (ev) => {
      let raw;
      try { raw = JSON.parse(ev.data); } catch { return; }
      if (raw?.post_type === "message") this.onEvent?.(raw);
    };
    this.ws.onclose = () => { log("OneBot 断开，重连"); setTimeout(() => this.connect(), 3000); };
    this.ws.onerror = () => {};
  }
  sendMessage(kind, id, segments) {
    const action = kind === "private" ? "send_private_msg" : "send_group_msg";
    const base = kind === "private" ? { user_id: Number(id) } : { group_id: Number(id) };
    return this.api(action, { ...base, message: segments });
  }
}

const bot = new OneBotClient();

// ── 工具 ──────────────────────────────────────────────────────────────────
function segmentsToText(segments) {
  if (typeof segments === "string") return segments.trim();
  const out = [];
  for (const s of segments ?? []) {
    const d = s?.data ?? {};
    switch (s?.type) {
      case "text": out.push(d.text ?? ""); break;
      case "at": out.push(d.qq === "all" ? "@全体成员" : `@${d.qq}`); break;
      case "face": out.push(`[表情${d.id ?? ""}]`); break;
      case "image": out.push("[图片]"); break;
      case "record": out.push("[语音]"); break;
      case "video": out.push("[视频]"); break;
      case "reply": out.push("[引用消息]"); break;
      default: out.push(`[${s?.type ?? "未知"}]`); break;
    }
  }
  return out.join("").trim();
}

// ── 会话与消息驱动 ─────────────────────────────────────────────────────────
const reverse = new Map(); // sessionId -> key
for (const [k, sid] of Object.entries(state.sessions)) reverse.set(sid, k);

async function ensureSession(key) {
  if (state.sessions[key]) return state.sessions[key];
  const dir = path.join(ROOT, "state", "agents", key.replace(/[^\w:-]/g, "_"));
  fs.mkdirSync(dir, { recursive: true });
  let sessionId;
  try {
    const v = await dsh.createSession({ cwd: dir, agentPreset: cfg.agentPreset });
    sessionId = v?.sessionId;
  } catch (e) {
    log("创建会话失败，重试默认:", e.message);
    const v = await dsh.createSession({});
    sessionId = v?.sessionId;
  }
  if (sessionId) {
    state.sessions[key] = sessionId;
    reverse.set(sessionId, key);
    saveState();
    log(`新会话 ${key} -> ${sessionId}`);
    return sessionId;
  }
  throw new Error(`无法创建会话 ${key}`);
}

function allowed(kind, id) {
  const s = String(id);
  const deny = (cfg.deny[kind] ?? []).map(String);
  if (deny.includes(s)) return false;
  const allow = (cfg.allow[kind] ?? []).map(String);
  if (allow.length > 0) return allow.includes(s);
  return cfg.allowAllWhenEmpty;
}

async function handleIncoming(raw) {
  const mtype = raw.message_type;
  let key, kind, id;
  if (mtype === "group") { key = `group:${raw.group_id}`; kind = "group"; id = raw.group_id; }
  else if (mtype === "private") { key = `private:${raw.user_id}`; kind = "private"; id = raw.user_id; }
  else return;

  if (!allowed(kind, id)) { log(`忽略 ${key}（不在白名单）`); return; }
  const text = segmentsToText(raw.message);
  if (!text) return;
  log(`收到 ${key}: ${text.slice(0, 60)}`);

  let sessionId;
  try { sessionId = await ensureSession(key); } catch (e) { log("ensureSession 失败:", e.message); return; }

  const content = [{
    type: "text",
    text: `【QQ${kind === "group" ? "群" : "私聊"}消息】${text}`,
  }];
  try {
    await dsh.prompt({ sessionId, content, mode: "queue" });
    log(`已投递 ${key} -> ${sessionId}`);
  } catch (e) { log("prompt 失败:", e.message); }
}

// ── DSH 事件流：把 agent 关于该会话的输出发回 QQ ───────────────────────────
// events.mux 帧结构（参考项目已验证）：
//   envelope.payload 是 server 帧，其中 type==='session/event' 时
//   frame.sessionId 为会话 id、frame.event 为具体的 session 事件（turn/start、
//   assistant/message、turn/end 等）。用 turn collector 累积文本，turn/end 产出。
function createTurnCollector() {
  const turns = new Map();
  return {
    push(event) {
      if (event?.type === "turn/start") { turns.set(event.data?.turn, { text: "" }); return null; }
      if (event?.type === "assistant/chunk") return null; // 忽略流式分块
      if (event?.type === "assistant/message") {
        const t = turns.get(event.data?.turn);
        if (!t) return null;
        for (const b of event.data?.message?.content ?? []) {
          if (b?.type === "text" && typeof b.text === "string") t.text += b.text;
        }
        return null;
      }
      if (event?.type === "turn/end") {
        const t = turns.get(event.data?.turn);
        turns.delete(event.data?.turn);
        if (!t) return null;
        return { turn: event.data?.turn, reason: event.data?.reason, text: t.text };
      }
      return null;
    },
  };
}

const turnCollectors = new Map(); // sessionId -> collector

function setupMux() {
  dsh.connectMux((full) => {
    const frame = full?.payload;
    if (!frame || typeof frame !== "object") return;
    const sessionId = frame.sessionId ?? frame.session_id;
    const key = reverse.get(sessionId);
    if (!key || !(key.startsWith("group:") || key.startsWith("private:"))) return;
    if (frame.type !== "session/event") return;

    let collector = turnCollectors.get(sessionId);
    if (!collector) { collector = createTurnCollector(); turnCollectors.set(sessionId, collector); }

    const ended = collector.push(frame.event);
    if (ended) {
      turnCollectors.delete(sessionId);
      const text = (ended.text || "").trim();
      if (text) {
        const [kind, id] = key.split(":");
        bot.sendMessage(kind, id, [{ type: "text", data: { text } }])
          .then(() => log(`agent 回复 ${key}: ${text.slice(0, 60)}`))
          .catch((e) => log(`发送失败 ${key}: ${e.message}`));
      } else {
        log(`agent 回合结束但无文本输出 ${key}`); // 可能自主选择不回复/潜水
      }
    }
  });
}

// ── 启动 ───────────────────────────────────────────────────────────────────
log(`桥接启动 (DSH=${cfg.dsh.baseUrl}, OneBot ws=${cfg.onebot.wsUrl}, preset=${cfg.agentPreset})`);
bot.onEvent = handleIncoming;
bot.connect();
setupMux();

process.on("SIGINT", () => { log("退出"); process.exit(0); });
process.on("SIGTERM", () => { log("退出"); process.exit(0); });
