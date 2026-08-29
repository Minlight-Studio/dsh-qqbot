# qq-bot-plugin

> **QQ ↔ DeepSeek Harness 桥接插件**（中文文档）
>
> 把 QQ（通过 **NapCat** / OneBot v11）接入 **DeepSeek Harness (DSH)**。
> QQ 消息会变成 DSH agent 的输入，agent **自主决定**回不回、什么时候回、**怎么回**（包括**戳一戳**和**发表情包**）。

```
QQ 群 / 好友 ──► NapCat (OneBot v11 WS+HTTP) ──► bridge.js ──► DSH Web API (agent 会话)
                                                  │                    │
                                                  └────  agent 思维链自主决定回/不回 ────┘
```

- **QQ 侧**：NapCat（OneBot v11 协议）— 负责扫码登录和收发消息。
- **DSH 侧**：DeepSeek Harness Web（`dsh web`，默认 `127.0.0.1:3080`）。
- **插件**：`bridge.js`（消息驱动桥接）+ `mcp-qq.js`（给 DSH agent 用的 `qq_*` 工具集）+ `qq-chat` agent preset（自主决策人格）。

---

## 前置要求

- 一台 Linux 服务器（已在 **Ubuntu 24.04** 上测试），建议 2核/4GB。
- 能从浏览器访问到的 IP / 域名（或 NAT 端口映射）。
- Node.js **>= 22.13**。
- 一个要扫码登录的 QQ 账号。

> ⚠️ 如果你的服务器**海外连通性差**（国内 VPS 常见），下面所有下载步骤都使用**国内镜像**。如果你在别的环境，请相应调整。

---

## 一、安装 Node.js（>= 22.13）

### 方式 A — NodeSource 官方源（GitHub 能访问时用）

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # 应为 v24.x
```

### 方式 B — 国内镜像（海外不通时推荐）

```bash
wget https://npmmirror.com/mirrors/node/v24.15.0/node-v24.15.0-linux-x64.tar.xz
sudo mkdir -p /usr/local/lib/nodejs
sudo tar -xJf node-v24.15.0-linux-x64.tar.xz -C /usr/local/lib/nodejs
sudo ln -sf /usr/local/lib/nodejs/node-v24.15.0-linux-x64/bin/node /usr/local/bin/node
sudo ln -sf /usr/local/lib/nodejs/node-v24.15.0-linux-x64/bin/npm  /usr/local/bin/npm
sudo ln -sf /usr/local/lib/nodejs/node-v24.15.0-linux-x64/bin/npx  /usr/local/bin/npx
node -v && npm -v
```

国内服务器建议把 npm 换成国内源：

```bash
npm config set registry https://registry.npmmirror.com
```

---

## 二、安装 DeepSeek Harness（DSH）

```bash
npm install -g @deepseek-ai/dsh
dsh --version   # 例如 0.1.1-rc.2
```

用 systemd 托管启动（这样才能开机自启、崩溃自重启）：

```bash
sudo mkdir -p /root/dsh-data && cd /root/dsh-data
sudo tee /etc/systemd/system/dsh.service >/dev/null <<'EOF'
[Unit]
Description=DeepSeek Harness Web
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/dsh-data
Environment=PATH=/usr/local/lib/nodejs/node-v24.15.0-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/local/lib/nodejs/node-v24.15.0-linux-x64/bin/dsh web --host 127.0.0.1 --trusted-host "localhost:3080"
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now dsh.service
```

验证：

```bash
systemctl is-active dsh.service   # active
ss -tlnp | grep 3080              # 127.0.0.1:3080
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/   # 200
```

> **DSH 故意禁止 `--host 0.0.0.0`**（安全考虑：怕远程代码执行暴露到网络）。
> 想从外部访问控制台，要用一个**反向代理**监听公网侧、转发到 `127.0.0.1:3080`（见第八节带登录的反代）。

---

## 三、安装 NapCat（QQ 协议端）

NapCat 会往真实的 QQ 客户端里注入 hook。在无头 Linux 上我们用 **NapCat Shell 安装器**（它顺带把 QQ 和 `xvfb` 也装了）。如果 `ghcr.io` / `docker.io` 连不上（国内 VPS 常见），就用 Shell 安装（不用 Docker）：

```bash
# 官方 NapCat-Installer（自动选最快源，含 QQ + xvfb）
curl -o napcat.sh https://raw.githubusercontent.com/NapNeko/NapCat-Installer/main/script/install.sh \
  && bash napcat.sh --docker n --proxy 0 --confirm
```

装到 `$HOME/Napcat/opt/QQ`。成功后它会打印：

```
安装位置: /root/Napcat
启动 Napcat (无需 sudo):
  xvfb-run -a /root/Napcat/opt/QQ/qq --no-sandbox
后台运行 Napcat (使用 screen):
  screen -dmS napcat bash -c "xvfb-run -a /root/Napcat/opt/QQ/qq --no-sandbox"
WebUI Token: 查看 .../napcat/config/webui.json
```

> 如果遇到 `dpkg lock` 报错（`unattended-upgr` 占用），等一会儿或执行：
> `sudo pkill -9 unattended-upgr; sudo rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock`

---

## 四、启动 NapCat 并找到 WebUI Token

```bash
screen -dmS napcat bash -c "xvfb-run -a /root/Napcat/opt/QQ/qq --no-sandbox"
sleep 15
ss -tlnp | grep 6099    # NapCat WebUI 监听 *:6099
cat /root/Napcat/opt/QQ/resources/app/app_launcher/napcat/config/webui.json | grep token
```

记下 `token`。WebUI 地址是：

```
http://<你的IP>:6099
```

> **在你服务器的 NAT/面板里把端口 6099 映射出来**（相当于公网端口 → 6099），这样浏览器才能访问 WebUI 扫码。

---

## 五、扫码登录你的 QQ 账号

浏览器打开 `http://<你的IP>:<映射的端口>`，输入 WebUI Token，用手机 QQ 扫二维码登录。

**登录后还要开启 OneBot 的 HTTP 和 WebSocket 服务**（下面的默认值正是本插件所预期的）：

| 服务 | 默认 |
|---|---|
| OneBot HTTP API | `127.0.0.1:3000` |
| OneBot WebSocket | `127.0.0.1:3001` |

验证 OneBot 已就绪（登录后才有监听）：

```bash
ss -tlnp | grep -E ":3000|:3001"
```

> ⚠️ **千万不要把 3000 / 3001 暴露到公网** —— 桥接进程是在本机 localhost 连它们的。
> 只需要暴露 **6099（WebUI）** 用于重新扫码。

---

## 六、部署插件

把本仓库 clone（或直接拷贝）到服务器，例如 `/root/qq-bot-plugin`：

```bash
cd /root
git clone <你的仓库地址> qq-bot-plugin   # 或直接把整个目录拷过来
cd qq-bot-plugin
npm install    # 安装 @modelcontextprotocol/sdk + zod
```

创建配置：

```bash
cp config.example.json config.json
```

编辑 `config.json`：

```jsonc
{
  "dsh":     { "baseUrl": "http://127.0.0.1:3080" },
  "onebot":  {
    "wsUrl":   "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "token":   ""            // NapCat 没设 access token 就留空
  },
  "ownerQQ": 123456789,       // 你的 QQ 号（管理员）
  "agentPreset": "qq-chat",
  "workspaceTitle": "QQ 聊天",
  "allow": { "private": [], "groups": [] },   // 白名单；空列表 + allowAllWhenEmpty=false = 全部拒绝
  "deny":  { "private": [], "groups": [] },
  "allowAllWhenEmpty": false                  // 设为 true 则白名单为空时放行所有人
}
```

> ⚠️ `allowAllWhenEmpty: false` 默认**拒绝所有人**，直到你填了白名单（QQ 号 / 群号）。
> 测试时可以设为 `true`，正式使用再填白名单。

---

## 七、把 agent preset 装进 DSH

复制 preset，让 DSH 有 `qq-chat` 这个 profile 可用：

```bash
sudo mkdir -p ~/.dsh/.agent-presets/qq-chat
sudo cp presets/qq-chat-agent.cordis.yml ~/.dsh/.agent-presets/qq-chat/agent.cordis.yml
```

> 这个 preset 给了 agent「**自主行为规则**」：看未读 → 自主决定 → 回复 / 潜水 / 戳一戳 / 发表情包。
> 同时挂载了 `qq_*` 工具（通过 MCP 或桥接），让模型能在 QQ 上"动手"。

---

## 八、（可选）DSH 控制台的带登录反向代理

因为 DSH 拒绝 `0.0.0.0`，可以用一个带登录的反向代理监听公网/内网 IP、转发到 `127.0.0.1:3080`。用 Node 内置的 `http` 实现，带**签名 7 天 cookie 的自定义登录页**：

```bash
sudo tee /etc/systemd/system/dsh-proxy.service >/dev/null <<'EOF'
[Unit]
Description=DSH reverse proxy (login-protected)
After=network.target dsh.service

[Service]
Type=simple
WorkingDirectory=/root/dsh-proxy
Environment=PATH=/usr/local/lib/nodejs/node-v24.15.0-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/local/lib/nodejs/node-v24.15.0-linux-x64/bin/node /root/dsh-proxy/proxy.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-proxy.service
```

然后在 `/root/dsh-proxy/proxy.mjs` 写一个"登录 + 转发"的最小代理（登录 cookie 要**签名**、7 天有效）。最后在 NAT 面板里把代理端口映射出去。

> **为什么不用 Basic Auth？** 浏览器 Basic Auth 会和 DSH 的长 WebSocket 连接冲突，容易触发 `ERR_TOO_MANY_RETRIES`。自定义登录页 + session cookie 能避开这个坑。

---

## 九、运行桥接并测试

```bash
cd /root/qq-bot-plugin
node src/bridge.js
```

预期日志：

```
[bridge] 桥接启动 (DSH=http://127.0.0.1:3080, OneBot ws=ws://127.0.0.1:3001, preset=qq-chat)
[bridge] OneBot WebSocket 已连接
[bridge] DSH events.mux 已连接
```

现在给你的 QQ 机器人发条消息。桥接会把消息路由到 DSH agent 会话；agent 读取后**自主决定**（用 `qq_*` 工具）回不回、怎么回。看日志：

```
[bridge] 收到 group:123456: 你好
[bridge] 已投递 group:123456 -> sess_xxx
[bridge] agent 回复 group:123456: 你好呀～
```

如果需要它常驻，用 systemd 跑：

```bash
sudo tee /etc/systemd/system/qq-bridge.service >/dev/null <<'EOF'
[Unit]
Description=QQ Bridge (NapCat -> DSH)
After=network.target dsh.service napcat.service

[Service]
Type=simple
WorkingDirectory=/root/qq-bot-plugin
Environment=PATH=/usr/local/lib/nodejs/node-v24.15.0-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/local/lib/nodejs/node-v24.15.0-linux-x64/bin/node /root/qq-bot-plugin/src/bridge.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now qq-bridge.service
```

---

## 项目结构

```
qq-bot-plugin/
├── src/
│   ├── bridge.js           # 桥接主进程：OneBot <-> DSH API，消息驱动
│   ├── child-bridge.js     # OneBot v11 连接层（收发消息）
│   └── mcp-qq.js           # 给 DSH agent 的 qq_* 工具（含戳一戳 + 表情包）
├── presets/
│   └── qq-chat-agent.cordis.yml   # 自主决策人格 + 规则
└── config.example.json     # 配置模板
```

## 安全注意事项

- **把 QQ 号当机器人用可能被腾讯风控/冻结**。建议用小号。
- **不要暴露 OneBot 端口 3000/3001 到公网**——那等于把机器人控制权交出去。
- WebUI Token 要设强一些，DSH 控制台的登录密码也要强。
- 桥接默认启用**白名单**（`allowAllWhenEmpty=false`），fail-closed 更安全。

---

*MIT 协议。灵感来自社区现有的 QQ↔DSH 桥接；本仓库是独立实现，非复制。*
