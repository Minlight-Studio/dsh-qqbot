// qq-bot-plugin: child-bridge.js
// 桥接子进程：作为一个独立 Node 进程，连接 QQ 协议端（SnowLuma/NapCat 的 OneBot v11）。
//
// 为什么需要独立子进程？
//   DSH 动态插件运行在受限环境（无原生 fetch/WebSocket/require/process），
//   而 OneBot 需要 WebSocket 长连接 + HTTP API。所以用 subprocess.spawn 拉起本进程，
//   插件与本进程之间通过 stdin/stdout 的 JSON 行协议通信。
//
// 协议（JSON line, 每行一个对象）：
//   插件 → 本进程 (stdin):
//     { "type": "call", "id": 1, "action": "send_group_msg", "params": {...} }
//     { "type": "ping" }
//   本进程 → 插件 (stdout):
//     { "type": "event", "event": { "sessKey": "group:123", "kind": "...", "raw": {...} } }
//     { "type": "result", "id": 1, "ok": true, "data": {...} }
//     { "type": "status", "online": true, "selfId": 123456 }
//     { "type": "log", "level": "info|error", "msg": "..." }
//
// 配置：通过环境变量传入，避免在代码里硬编码。
//   QQ_BRIDGE_WS_URL   OneBot WebSocket 地址  (如 ws://127.0.0.1:3001)
//   QQ_BRIDGE_HTTP_URL OneBot HTTP API 地址   (如 http://127.0.0.1:3000)
//   QQ_BRIDGE_TOKEN    OneBot accessToken（无则留空）

import { URL } from 'node:url';

const WS_URL = process.env.QQ_BRIDGE_WS_URL || 'ws://127.0.0.1:3001';
const HTTP_URL = (process.env.QQ_BRIDGE_HTTP_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const TOKEN = process.env.QQ_BRIDGE_TOKEN || '';

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const log = (level, msg) => out({ type: 'log', level, msg: String(msg) });

// ── OneBot HTTP API ─────────────────────────────────────────────────────────
async function onebotHttp(action, params = {}) {
  const res = await fetch(`${HTTP_URL}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// ── OneBot WebSocket（收事件，自动重连）─────────────────────────────────────
let ws = null;
let reconnectDelay = 1000;
let everConnected = false;
let selfId = null;

function handleEvent(raw) {
  // 只关心消息类事件，其余（如心跳/状态）暂不向上转发（可扩展）。
  if (!raw || typeof raw !== 'object') return;
  const post = raw.post_type;
  if (post !== 'message') return;

  const mtype = raw.message_type;
  let sessKey = null;
  let kind = null;
  if (mtype === 'group') {
    // 只处理纯文本/记录，群号 sessKey
    sessKey = `group:${raw.group_id}`;
    kind = 'group';
  } else if (mtype === 'private') {
    sessKey = `private:${raw.user_id}`;
    kind = 'private';
  } else {
    return;
  }

  const segments = Array.isArray(raw.message) ? raw.message : [{ type: 'text', data: { text: String(raw.message ?? '') } }];
  const text = segments
    .map((s) => {
      const d = s?.data ?? {};
      switch (s?.type) {
        case 'text': return d.text ?? '';
        case 'at': return d.qq === 'all' ? '@全体成员' : `@${d.qq}`;
        case 'face': return `[表情${d.id ?? ''}]`;
        case 'image': return '[图片]';
        case 'record': return '[语音]';
        case 'video': return '[视频]';
        case 'file': return `[文件${d.name ?? ''}]`;
        case 'reply': return '[引用消息]';
        case 'json': return '[卡片消息]';
        default: return `[${s?.type ?? '未知'}]`;
      }
    })
    .join('')
    .trim();

  const event = {
    sessKey,
    kind,
    selfId,
    messageId: raw.message_id ?? null,
    userId: mtype === 'group' ? (raw.user_id ?? null) : (raw.user_id ?? null),
    groupId: mtype === 'group' ? (raw.group_id ?? null) : null,
    text,
    segments,
    rawEventId: raw.event_id ?? null,
    time: raw.time ?? Math.floor(Date.now() / 1000),
  };
  out({ type: 'event', event });
}

function connect() {
  let url;
  try {
    url = new URL(WS_URL);
  } catch (e) {
    log('error', `WebSocket 地址非法: ${WS_URL} (${e.message})`);
    process.exit(1);
  }

  const proto = url.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${proto}://${url.host}${url.pathname}${TOKEN ? `?access_token=${encodeURIComponent(TOKEN)}` : ''}`;

  log('info', `正在连接 OneBot WebSocket: ${wsUrl}`);
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    log('error', `创建 WebSocket 失败: ${e.message}`);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectDelay = 1000;
    everConnected = true;
    log('info', 'OneBot WebSocket 已连接');
    out({ type: 'status', online: true, selfId });
  };

  ws.onmessage = (ev) => {
    let raw;
    try {
      raw = JSON.parse(ev.data);
    } catch {
      return;
    }
    // 若 OneBot 返回的是 self 信息，记录 selfId
    if (raw?.post_type === 'meta_event' && raw?.meta_event_type === 'lifecycle') {
      log('info', `OneBot lifecycle: ${raw.sub_type ?? ''}`);
    }
    handleEvent(raw);
  };

  ws.onerror = () => {
    log('error', 'WebSocket 连接出错');
  };

  ws.onclose = () => {
    out({ type: 'status', online: false, selfId });
    log('warn', 'OneBot WebSocket 已断开，准备重连');
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (!everConnected) return; // 首次连接失败不无限重试，由插件侧决定
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  log('info', `${delay}ms 后重连...`);
  setTimeout(connect, delay);
}

// ── stdin 请求处理 ──────────────────────────────────────────────────────────
let stdinBuf = '';
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk.toString('utf8');
  let idx;
  while ((idx = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, idx);
    stdinBuf = stdinBuf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      handleLine(JSON.parse(line));
    } catch (e) {
      log('error', `stdin 解析失败: ${e.message}`);
    }
  }
});

async function handleLine(req) {
  if (!req || typeof req !== 'object') return;
  if (req.type === 'ping') {
    out({ type: 'pong' });
    return;
  }
  if (req.type === 'call' && req.action) {
    try {
      const data = await onebotHttp(req.action, req.params ?? {});
      out({ type: 'result', id: req.id ?? null, ok: true, data });
    } catch (e) {
      out({ type: 'result', id: req.id ?? null, ok: false, error: e.message ?? String(e) });
    }
  }
}

// ── 启动 ────────────────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  log('info', '收到 SIGINT，退出');
  process.exit(0);
});
process.on('SIGTERM', () => {
  log('info', '收到 SIGTERM，退出');
  process.exit(0);
});

log('info', `桥接子进程启动 (ws=${WS_URL}, http=${HTTP_URL})`);
connect();
