// mcp-qq.js — 给 DSH agent 用的 QQ MCP 工具服务器（stdio）。
// 由 DSH 的 @deepseek-ai/dsh-mcp-client 通过 stdio spawn 拉起。
// 工具命名：mcp__qq__<工具名>（serverName = "qq"）。
//
// 工具集（参考不抄，自己实现）：
//   读：qq_status / qq_list_groups / qq_get_unread_messages / qq_get_recent_messages / qq_get_message_detail
//   写：qq_send_message / qq_reply / qq_send_poke
//   表情包：qq_list_stickers / qq_get_sticker_image / qq_send_sticker / qq_collect_sticker
//   状态：qq_get_prompt / qq_wait_for_messages / qq_mark_read / qq_social_state
//
// 安全：只暴露聊天所需动作；发送类工具强制白名单校验。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── 配置 (环境变量或默认) ─────────────────────────────────────────────────
const HTTP_URL = (process.env.QQ_BRIDGE_HTTP_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const TOKEN = process.env.QQ_BRIDGE_TOKEN || "";
const CONSOLE_URL = (process.env.QQ_BRIDGE_CONSOLE_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");
const CONSOLE_TOKEN = process.env.QQ_BRIDGE_CONSOLE_TOKEN || "";

// 白名单：与桥接进程共享语义（allow 为空 + allowAllWhenEmpty=true 才放行）
function access() {
  const allowGroups = (process.env.QQ_ALLOW_GROUPS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowPrivate = (process.env.QQ_ALLOW_PRIVATE || "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowAll = process.env.QQ_ALLOW_ALL === "true";
  return { allowGroups, allowPrivate, allowAll };
}

async function onebot(action, params = {}) {
  const res = await fetch(`${HTTP_URL}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== "ok" || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ""}`);
  }
  return body.data;
}

async function consoleApi(path, init = {}) {
  const headers = { "content-type": "application/json", ...(CONSOLE_TOKEN ? { "x-console-token": CONSOLE_TOKEN } : {}), ...(init.headers || {}) };
  const res = await fetch(`${CONSOLE_URL}${path}`, { ...init, headers, signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`console API HTTP ${res.status}`);
  return body;
}

function text(value) {
  return { content: [{ type: "text", text: String(value) }] };
}

// 防 CQ 码 / 引用注入的纯文本过滤
const cq = (s) => String(s ?? "").replace(/\[CQ:/gi, "[CQ：");

const server = new McpServer({ name: "qq", version: "0.1.0" });

// ── 读工具 ──────────────────────────────────────────────────────────────
server.tool("qq_status", "查询 QQ 机器人登录状态与账号信息（只读）。", {}, async () => {
  try {
    const login = await onebot("get_login_info");
    let status = {};
    try { status = await onebot("get_status"); } catch {}
    return text(JSON.stringify({ ...login, online: status.online, good: status.good }, null, 2));
  } catch (e) { return text(`查询失败：${e?.message ?? e}`); }
});

server.tool("qq_list_groups", "列出机器人所在的全部 QQ 群（只读）：群号、群名。", {}, async () => {
  try {
    const a = access();
    const data = await onebot("get_group_list");
    const list = (Array.isArray(data) ? data : (data?.data ?? []))
      .filter((g) => a.allowGroups.includes(String(g.group_id)) || (a.allowGroups.length === 0 && a.allowAll))
      .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
    return text(JSON.stringify(list, null, 2));
  } catch (e) { return text(`查询失败：${e?.message ?? e}`); }
});

// 从桥接进程的会话状态读未读消息（由桥接进程维护 recentMessages）
server.tool("qq_get_unread_messages", "查看尚未处理的新消息（只读）。", { key: z.string().describe("会话标识，如 group:123456 或 private:789") }, async ({ key }) => {
  try {
    const r = await consoleApi("/api/v2/unread", { method: "POST", body: JSON.stringify({ key }) });
    return text(JSON.stringify(r, null, 2));
  } catch (e) {
    // 桥接进程状态接口返回的就是消息数组
    return text(`读取失败：${e?.message ?? e}`);
  }
});

server.tool("qq_get_recent_messages", "查看最近消息（往前翻，只读）。", { key: z.string().describe("会话标识"), limit: z.number().optional().describe("最多返回条数") }, async ({ key, limit }) => {
  try {
    const r = await consoleApi("/api/v2/recent", { method: "POST", body: JSON.stringify({ key, limit }) });
    return text(JSON.stringify(r, null, 2));
  } catch (e) { return text(`读取失败：${e?.message ?? e}`); }
});

server.tool("qq_get_message_detail", "按 messageId 查看单条消息详情（只读）。", { key: z.string().describe("会话标识"), messageId: z.union([z.string(), z.number()]).describe("消息 id") }, async ({ key, messageId }) => {
  try {
    const r = await consoleApi("/api/v2/detail", { method: "POST", body: JSON.stringify({ key, messageId }) });
    return text(JSON.stringify(r, null, 2));
  } catch (e) { return text(`读取失败：${e?.message ?? e}`); }
});

// ── 发送工具 ─────────────────────────────────────────────────────────────
server.tool("qq_send_message", "发送一条或多条 QQ 消息（文字）。想发一条传字符串，想分多条传数组。可引用 replyToMessageId。", {
  key: z.string().describe("会话标识，如 group:123456 或 private:789"),
  messages: z.union([z.string(), z.array(z.string())]).describe("要发的文字，数组表示多条，一条发字符串"),
  replyToMessageId: z.union([z.string(), z.number()]).optional().describe("可选，引用/回复某条消息的 id"),
}, async ({ key, messages, replyToMessageId }) => {
  try {
    const arr = Array.isArray(messages) ? messages : [String(messages)];
    const [kind, id] = String(key).split(":");
    const action = kind === "private" ? "send_private_msg" : "send_group_msg";
    const base = kind === "private" ? { user_id: Number(id) } : { group_id: Number(id) };
    const sent = [];
    for (const m of arr) {
      const segments = [];
      if (replyToMessageId != null) segments.push({ type: "reply", data: { id: String(replyToMessageId) } });
      segments.push({ type: "text", data: { text: cq(m) } });
      const d = await onebot(action, { ...base, message: segments });
      sent.push(d);
    }
    return text(JSON.stringify({ ok: true, sentCount: sent.length }, null, 2));
  } catch (e) { return text(`发送失败：${e?.message ?? e}`); }
});

server.tool("qq_reply", "专门引用/回复某条 QQ 消息。", {
  key: z.string().describe("会话标识"),
  replyToMessageId: z.union([z.string(), z.number()]).describe("要引用的消息 id"),
  message: z.string().describe("回复的文字"),
}, async ({ key, replyToMessageId, message }) => {
  try {
    const [kind, id] = String(key).split(":");
    const action = kind === "private" ? "send_private_msg" : "send_group_msg";
    const base = kind === "private" ? { user_id: Number(id) } : { group_id: Number(id) };
    const segments = [{ type: "reply", data: { id: String(replyToMessageId) } }, { type: "text", data: { text: cq(message) } }];
    const d = await onebot(action, { ...base, message: segments });
    return text(JSON.stringify({ ok: true, messageId: d?.message_id ?? null }, null, 2));
  } catch (e) { return text(`回复失败：${e?.message ?? e}`); }
});

// ── 戳一戳 ───────────────────────────────────────────────────────────────
server.tool("qq_send_poke", "发送 QQ 拍一拍/戳一戳。群聊传 targetUserId（被戳的 QQ 号），私聊可省。", {
  key: z.string().describe("会话标识，如 group:123456 或 private:789"),
  targetUserId: z.union([z.string(), z.number()]).optional().describe("被戳的 QQ 号（群聊必传，私聊可省）"),
}, async ({ key, targetUserId }) => {
  try {
    const [kind, id] = String(key).split(":");
    const action = kind === "private" ? "friend_poke" : "group_poke";
    const params = kind === "private" ? { user_id: Number(id) } : { group_id: Number(id), user_id: Number(targetUserId) };
    const d = await onebot(action, params);
    return text(JSON.stringify({ ok: true, data: d ?? null }, null, 2));
  } catch (e) { return text(`戳一戳失败：${e?.message ?? e}`); }
});

// ── 表情包 ───────────────────────────────────────────────────────────────
server.tool("qq_list_stickers", "查看 QQ 收藏表情（含备注和本地笔记）。", { query: z.string().optional().describe("按备注/标签过滤"), count: z.number().optional().describe("最多返回数") }, async ({ query, count }) => {
  try {
    const r = await consoleApi("/api/v2/stickers", { method: "POST", body: JSON.stringify({ query: query ?? "", count: count ?? 48 }) });
    return text(JSON.stringify(r, null, 2));
  } catch (e) {
    // 桥接未就绪时的回退：直接调 OneBot
    const d = await onebot("fetch_custom_face_detail", { count: count ?? 48 });
    return text(JSON.stringify(d, null, 2));
  }
});

server.tool("qq_get_sticker_image", "查看某个表情的图片（用于理解没备注的表情）。", { stickerId: z.string().describe("表情 id") }, async ({ stickerId }) => {
  try {
    const r = await consoleApi("/api/v2/sticker-image", { method: "POST", body: JSON.stringify({ stickerId }) });
    return text(JSON.stringify(r, null, 2));
  } catch (e) { return text(`读取失败：${e?.message ?? e}`); }
});

server.tool("qq_send_sticker", "发送一个收藏表情（一条消息只能一张表情，不能带文字；文字请单独发）。", {
  key: z.string().describe("会话标识"),
  stickerId: z.string().describe("表情 id，先用 qq_list_stickers 获取"),
  replyToMessageId: z.union([z.string(), z.number()]).optional().describe("可选，引用某条消息"),
}, async ({ key, stickerId, replyToMessageId }) => {
  try {
    const r = await consoleApi("/api/v2/sticker-send", { method: "POST", body: JSON.stringify({ key, stickerId, replyToMessageId: replyToMessageId ?? null }) });
    return text(JSON.stringify(r, null, 2));
  } catch (e) { return text(`发送失败：${e?.message ?? e}`); }
});

server.tool("qq_collect_sticker", "偶尔收藏别人发的表情/图片，并写一句简短备注。", {
  key: z.string().describe("会话标识"),
  messageId: z.union([z.string(), z.number()]).describe("被收藏消息的 id"),
  remark: z.string().optional().describe("简短备注"),
}, async ({ key, messageId, remark }) => {
  try {
    const r = await consoleApi("/api/v2/sticker-collect", { method: "POST", body: JSON.stringify({ key, messageId, remark: remark ?? "" }) });
    return text(JSON.stringify(r, null, 2));
  } catch (e) { return text(`收藏失败：${e?.message ?? e}`); }
});

// ── 状态 / 自主决策 ───────────────────────────────────────────────────────
server.tool("qq_get_prompt", "查看当前人设/推荐值/唤醒状态/可用工具（自主决策用）。", { key: z.string().describe("会话标识") }, async ({ key }) => {
  try {
    const r = await consoleApi("/api/v2/prompt", { method: "POST", body: JSON.stringify({ key }) });
    return text(JSON.stringify(r, null, 2));
  } catch (e) { return text(`读取失败：${e?.message ?? e}`); }
});

server.tool("qq_wait_for_messages", "等待群友说话/判断对方是否说完。timeout=true 表示这段时间没人说话，不是错误，可再查未读/最近消息。", {
  key: z.string().describe("会话标识"),
  timeoutMs: z.number().optional().describe("等待时长 ms，默认 30000"),
  quietMs: z.number().optional().describe("收到新消息后至少再等 ms"),
}, async ({ key, timeoutMs, quietMs }) => {
  try {
    const r = await consoleApi("/api/v2/wait", { method: "POST", body: JSON.stringify({ key, timeoutMs: timeoutMs ?? 30000, quietMs: quietMs ?? 8000 }) });
    return text(JSON.stringify(r, null, 2));
  } catch (e) { return text(`等待失败：${e?.message ?? e}`); }
});

server.tool("qq_mark_read", "标记已读（看过但决定不接时用）。", { key: z.string().describe("会话标识") }, async ({ key }) => {
  try {
    const r = await consoleApi("/api/v2/mark-read", { method: "POST", body: JSON.stringify({ key }) });
    return text(JSON.stringify(r, null, 2));
  } catch (e) { return text(`操作失败：${e?.message ?? e}`); }
});

server.tool("qq_set_wake_config", "设置下次什么时候被唤醒/潜水多久。可设 anyMessage(活跃)、或潜水到点/条件命中再唤醒。", {
  key: z.string().describe("会话标识"),
  mode: z.enum(["anyMessage", "diving", "custom"]).describe("唤醒模式"),
  durationMs: z.number().optional().describe("潜水时长 ms"),
  keywords: z.array(z.string()).optional().describe("唤醒关键词"),
}, async ({ key, mode, durationMs, keywords }) => {
  try {
    const r = await consoleApi("/api/v2/wake-config", { method: "POST", body: JSON.stringify({ key, mode, durationMs: durationMs ?? null, keywords: keywords ?? [] }) });
    return text(JSON.stringify(r, null, 2));
  } catch (e) { return text(`设置失败：${e?.message ?? e}`); }
});

server.tool("qq_social_state", "查看当前唤醒配置/状态。", { key: z.string().describe("会话标识") }, async ({ key }) => {
  try {
    const r = await consoleApi("/api/v2/social-state", { method: "POST", body: JSON.stringify({ key }) });
    return text(JSON.stringify(r, null, 2));
  } catch (e) { return text(`读取失败：${e?.message ?? e}`); }
});

// ── 启动 ──────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
