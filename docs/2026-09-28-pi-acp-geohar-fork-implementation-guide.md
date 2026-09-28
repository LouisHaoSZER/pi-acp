# Pi ACP fork 技术实现指导手册

> **创建时间**：2026-09-28
> **状态**：进行中
> **关联方案**：`docs/memory/2026-09-24-pi-acp-eval-runtime-design.md`
> **fork 基线**：`georgeharker/pi-acp`（npm `@geohar/pi-acp`，MIT，v0.3.2）

## 0. 目标与前置约束

基于 `georgeharker/pi-acp` fork 一个 `tcop-eval-pi-acp`，让 Pi 走评测模块的 ACP 主路径，支持容器沙盒、job 注入 MCP / skills / 提示词，并产出 `execution_path=acp`、`evidence_grade=acp_event` 的 trace。

不改 `agent-driver` 的协议分支。driver 是 ACP v1 client，硬门槛：

- `cmd/tools/agent-driver/acp/session.go::checkMcpTransport`：job 里每条 MCP 配置的 transport 必须在 agent 声明的能力内，未声明对应 transport 时直接拒绝注入。
- `cmd/tools/agent-driver/profile/negotiate.go`：`initialize._meta["tcop.ai/eval"]` 决定 artifact / tool_name / model_identity 是否可评；artifact 缺失会导致 artifact 类 target unevaluable。

## 1. 决策门

1. **MCP transport**：本手册默认 job 只用 Streamable HTTP（`TransportStreamableHTTP`）。如果 job 有 legacy SSE，见第 6 节；在没探测清楚前不把 `sse: true` 硬写死。
2. **锁定版本**：`pi` >= v0.80.4；`pi-mcp-adapter` 锁定一个版本；Node 22+。
3. **fork 目标**：`georgeharker/pi-acp`，入口 `dist/index.js`，ACP 协议 v1。

## 2. Fork 与本地构建

```bash
git clone https://github.com/georgeharker/pi-acp.git tcop-eval-pi-acp
cd tcop-eval-pi-acp
npm ci
npm run typecheck   # 先确认基线干净
npm run test
npm run build       # 产物 dist/index.js
npm run smoke       # 自带 stdio smoke，验证 ACP 连接
```

关键目录：

| 文件 | 作用 |
|---|---|
| `src/acp/agent.ts` | ACP server：`initialize`、`session/new`、`prompt`、`cancel`、`close` |
| `src/acp/mcp-config.ts` | `mcpServers` -> pi-mcp-adapter 配置 + session 临时文件 + cleanup |
| `src/acp/session.ts` | pi 工具事件 -> ACP `tool_call` / `tool_call_update` rawInput/rawOutput |
| `src/pi-rpc/process.ts` | spawn `pi --mode rpc --no-themes --mcp-config <tmp>` |
| `src/index.ts` | stdio 入口 |

geohar 已替我们做好的部分：MCP 接线（`session/new.mcpServers` -> 临时配置 -> `--mcp-config`）、`mcpCapabilities.http=true`、工具事件翻译。fork 主要补评测契约与会话隔离。

## 3. 必改点 1：`initialize` 补 `_meta["tcop.ai/eval"]`

文件：`src/acp/agent.ts`，`async initialize(params)` 的 return 对象。

当前返回：

```ts
return {
  protocolVersion: ...,
  agentInfo: {...},
  authMethods: ...,
  agentCapabilities: {
    loadSession: true,
    mcpCapabilities: { http: true, sse: false },
    promptCapabilities: {...},
    sessionCapabilities: {...}
  }
}
```

顶层补：

```ts
return {
  protocolVersion: ...,
  agentInfo: {...},
  authMethods: ...,
  agentCapabilities: {...},
  _meta: {
    "tcop.ai/eval": {
      version: 1,
      artifact: true,
      tool_name: true,
      model_identity: true,
    },
  },
}
```

说明：

- 键名和字段必须与 `pkg/eval/acpmeta` 一致（`version`、`artifact`、`tool_name`、`model_identity`）。
- 如果 SDK 的 `InitializeResponse` 类型没有 `_meta`，`npm run typecheck` 会报错；优先使用 SDK 扩展字段，否则做类型安全断言，不用 `any` 静默绕过。
- 三项全 `true` 的前提是 trace 能拿到 artifact、工具名、模型身份。做不到的维度应如实降级为 `false`，不为过校验硬写 `true`。

## 4. 必改点 2：会话隔离 + 锁定模型配置

目标：

- 每个 ACP session 一个 pi 子进程。
- `PI_CODING_AGENT_DIR = <trial cwd>/.pi-home`。
- 不写用户目录或项目目录下的 `.pi/mcp.json`。
- 验收：trial 目录外没有 Pi 会话文件。

### 4.1 给 pi spawn 增加 per-session env

文件：`src/pi-rpc/process.ts`，`SpawnParams` 增加：

```ts
type SpawnParams = {
  cwd: string
  piCommand?: string
  sessionPath?: string
  additionalDirectories?: readonly string[]
  mcpConfigPath?: string
  rpcTimeoutMs?: number
  /** 新增：该 session 的私有 Pi 配置目录等环境变量 */
  env?: NodeJS.ProcessEnv
}
```

spawn 处合并：

```ts
env: { ...process.env, ...(params.env ?? {}), PI_ACP: '1' },
```

### 4.2 在 `session/new` 创建 `.pi-home` 并写模型配置

文件：`src/acp/agent.ts`，`newSession(params)`。

spawn 前：

```ts
const piHome = join(params.cwd, '.pi-home')
await preparePiHome(piHome, lockedModelSettings())
```

`preparePiHome`：

1. `mkdir -p <cwd>/.pi-home`。
2. 把锁定版本 pi 认识的模型 settings 写入 `<cwd>/.pi-home/settings.json`。

spawn 时：

```ts
proc = await PiRpcProcess.spawn({
  cwd,
  mcpConfigPath: mcpWrite.handle?.path,
  piCommand: getPiCommandOverride(),
  rpcTimeoutMs: getRpcTimeoutMs(),
  env: { PI_CODING_AGENT_DIR: piHome },
})
```

`session/close` 时删除 `piHome` 与 `mcpWrite.handle.cleanup()`。

> 第 4.2 节必须实测钉死：先手工确认锁定版 pi 的 `settings.json` 模型字段和 provider 字段，再写代码。API key 仍从容器 `env_from` 注入，不写进 `settings.json`。

## 5. 不改或基本不改的部分

- **MCP 透传**：geohar 已实现 `mcpServers` -> `--mcp-config`，session 结束 cleanup，header 原样写进 adapter 配置。保留。
- **skills**：pi 自己加载 skills；driver 已把 `SKILL.md` 物化进 trial cwd。需对齐 `cwd_layout.skill_root`，这是 job/endpoint 配置，不是 fork 代码。
- **提示词**：`prompt_text` 走标准 `session/prompt`，geohar 已支持；系统提示词可走 `<cwd>/AGENTS.md` 或 pi prompt 模板，按需落盘。

## 6. SSE 分支

geohar 当前：

- `mcpCapabilities: { http: true, sse: false }`
- `translateMcpServers` 对 `type === 'sse'` 直接 `skipped`，pi-mcp-adapter 配置形状无法表达 SSE。

如果 job 有 SSE：

- 首选：在容器内为 SSE URL 起一个 session 内 Streamable HTTP 本地代理，`mcp.json` 只写 `127.0.0.1`，`initialize` 仍只声明 `http`。
- 或者：换回 crow-cli 重新评估。
- 不要：只把 `sse: true` 改掉但实际不接，那会撞 `checkMcpTransport` 后整 job protocol abort。

## 7. 容器化

镜像内锁定四样：Node、`pi`、`pi-mcp-adapter`、fork 后的 `dist/`。

```bash
# 安装 pi
npm install -g @earendil-works/pi-coding-agent
# 安装 pi-mcp-adapter（让 pi 认 --mcp-config）
pi install npm:pi-mcp-adapter
# 构建并放到 /opt/pi-eval-acp
npm ci && npm run build
mkdir -p /opt/pi-eval-acp && cp -r dist /opt/pi-eval-acp/
```

endpoint 形如：

```yaml
acp_endpoints:
  pi:
    kind: container
    image: <registry>/tcop-eval-pi-acp@sha256:<digest>
    command: ["node", "/opt/pi-eval-acp/dist/index.js"]
    max_sessions: 1
    env_from: [DEEPSEEK_API_KEY]
    cwd_layout:
      skill_root: <锁定版 pi 在 cwd 下扫描 skills 的相对目录>
agents:
  - id: pi
    acp_endpoint_ref: pi
    skills: [...]
    mcp: [...]
```

约束：镜像不装 Docker CLI、不挂 `docker.sock`、`image` 必须进 allowlist 且带 digest、密钥只走 `env_from`。

## 8. Spike 验收清单

最小闭环：1 个 Streamable HTTP MCP + 1 个 artifact target + 1 个 skill。

逐项确认：

1. `initialize` 返回 `mcpCapabilities.http=true`，且带 `_meta["tcop.ai/eval"]`。
2. driver 的 `checkMcpTransport` 不拒绝。
3. `session/new` 后 pi 子进程的 `--mcp-config` 文件被生成，header/trial token 到达 MCP server。
4. `tool_call` / `tool_call_update` 的 `title` / `rawInput` / `rawOutput` 被 normalize 正确折叠，工具名能对上评分规则。
5. artifact target 可评（`ValidateTargets` 不报 unevaluable）。
6. 格子落库 `execution_path=acp`、`evidence_grade=acp_event`。
7. 容器 run 结束被删除，trial 目录外无 Pi 会话文件，`.pi-home` 和 `mcp.json` 被清理。

1–3 决定协议层通不通，4–7 决定评分链路通不通。任何一项失败，先修对应项，不直接进生产镜像。

## 9. 提交与发布建议

- 保留上游历史，用独立分支做评测适配；评测专用改动尽量隔离在 `src/acp` 顶层，不侵入 pi RPC 通用逻辑。
- 每次改动后跑 `npm run format && npm run typecheck && npm run test`。
- 容器镜像采用 digest 发布，job 引用 `@sha256:`。
- 跑通后回写 `docs/memory/2026-09-24-pi-acp-eval-runtime-design.md` 与 legacy 隔离规格，把 Pi 从 legacy 分级中更新。
