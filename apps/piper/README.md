# Piper（雏形）

Grok Bot 式多 bot Personal Agent 的第一阶段形态雏形，垂直方向：开发者运维 / 开源维护。
形态口径见仓库外规格文件（2026-11-10 定案，7 条默认值）：概念只 5 个（Bot / Chat / Session / Routine / Artifact）、主 bot 是置顶且多一项 bot 管理权的普通 bot、记忆 bot 级私有 + 账号级「关于我」、文件优先存储、先 web 侧。

## 启动

前置：仓库根目录先装配并构建基座中本 app 依赖的两个包（只需一次；基座未构建时对话接口会明确报 BASE_NOT_BUILT，其余 API 照常可用）：

```bash
# 仓库根目录
npm install --ignore-scripts
npm --prefix packages/schema run build
npm --prefix packages/telemetry run build
npm run hydrate:model-data            # 生成 packages/ai 的模型目录数据（gitignore 排除的生成物）
npm --prefix packages/ai run build:offline
npm --prefix packages/agent run build
```

启动服务：

```bash
cd apps/piper
npm start            # 或 node server.mjs
# 打开 http://localhost:4310 ，口令默认 piper-dev
```

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 监听端口 | `4310` |
| `PIPER_TOKEN` | 单用户登录口令 | `piper-dev` |
| `PIPER_MODEL_API_KEY` | 模型 API Key（OpenAI 兼容端点）；未设时对话明确回「未配置模型」事件，不崩溃 | 无 |
| `OPENAI_API_KEY` | 同上，后备变量名 | 无 |
| `PIPER_MODEL_BASE_URL` | OpenAI 兼容端点 base URL | `https://api.openai.com/v1` |
| `PIPER_MODEL_ID` | 模型 id | `gpt-4o-mini` |
| `GITHUB_TOKEN` | 可选，提高晨间扫描的 GitHub API 限额 | 无（公开限额） |

## Pi 接入

结论：**源码级真接入**，不是 SDK 嵌入、不是子进程调 CLI。`apps/piper` 作为 monorepo 内新增 app，
在 `package.json` 里以 workspace 依赖直接引用基座两个包，运行时 import 的是它们构建出的 dist：

- `@earendil-works/pi-agent-core`（`packages/agent`）：对话内核用其 `Agent` 类
  （`packages/agent/src/agent.ts`）。构造：`new Agent({ initialState: { systemPrompt, model, messages }, streamFn })`；
  `agent.subscribe(fn)` 订阅 `AgentEvent`（`message_update` 带流式增量、`tool_execution_start/end`、`message_end`）；
  `agent.prompt(text)` 驱动一轮。bot 的 systemPrompt 与历史会话（JSONL 读出后转换）都走这条路。
- `@earendil-works/pi-ai`（`packages/ai`）：模型层用 `createModels()` + `createProvider()` 自建一个
  OpenAI 兼容 provider（`id: "piper"`，`api: openAICompletionsApi()`，auth 用 `envApiKeyAuth(...)` 读上面两个环境变量，
  model 对象按 `packages/ai/src/types.ts` 的 `Model` 形状手工构造，`api: "openai-completions"`）。
  `Models.streamSimple(model, context, options)` 即 `Agent` 需要的 `StreamFn`
  （`packages/agent/src/types.ts` 注释原文即称其满足该形状），与 coding-agent 在
  `packages/coding-agent/src/core/sdk.ts` 里组装 `Agent` 的方式一致。
- `packages/coding-agent` 勘察结论：它有完整的 `AgentSession` / 会话管理，但绑定了它自己的
  settings / 资源加载 / 工具集体系，雏形不直接复用；雏形只用 agent-core 的 `Agent` + 自管 JSONL 会话，
  后续迭代若要接 coding-agent 的会话恢复与工具集，再在此处演进。

实现位置：`lib/kernel.mjs`（`streamChat` / `extractDraftWithModel` / 规则兜底）。
基座 dist 用动态 import 懒加载：未构建时只有对话路径报错（`BASE_NOT_BUILT`，错误信息含构建步骤），
bot CRUD / 例程 / 产物等 API 不受影响。无模型 Key 时 `streamChat` 抛 `MODEL_NOT_CONFIGURED`，
路由层转成 SSE `error` 事件，文案明确写「未配置模型」。

主 bot 建 bot 的字段抽取：有 Key 时先走模型抽取（`extractDraftWithModel`，`completeSimple` 要求只输出 JSON，
解析失败即弃用），无 Key 或抽取失败走规则兜底（`extractDraftByRules`）；两种来源都在草案卡上标注。

## 数据层（文件优先）

运行时数据在 `apps/piper/data/`（`.gitignore` 排除，仅保留 `.gitkeep`）：

- `bots.json`：bot 元数据（雏形用 JSON 文件代替规格中的 SQLite，接口不变，后续可平滑替换）
- `about-me.md`：账号级「关于我」，全 bot 可读；写入仅主 bot（雏形未开写入接口）
- `workspaces/<botId>/`：每 bot 隔离工作区，`memory.md` 为其记忆（右栏只读展示）
- `sessions/<botId>.jsonl`：每 bot 独立会话流水
- `artifacts/<id>.md`：产物，文件头 HTML 注释内嵌结构化元数据
- `routines.json`：routine 定义与上次运行结果

预置 bot：主 bot「Piper」（置顶、`canManageBots`）与运维 bot「仓库管家」（绑定 NorthAdb/LinkForge、NorthAdb/Loom，挂 morning-scan 例程）。

## API 契约

见 `server.mjs` 文件头注释（逐条列明）。要点：SSE 事件类型固定为
`session / delta / tool / system / draft / error / done`；草案卡结构
`{name, systemPrompt, tools, repos, memoryScope, source}`，经 `POST /api/bots/draft-confirm` 确认才落库；
`GET /api/approvals` 雏形恒返回空数组（收件箱占位）。

## 验收线对照（规格六）

| 验收项 | 状态 |
|---|---|
| 壳：单口令登录 + 三栏 | 已实现（`POST /api/login` cookie 会话；左 bot 列表 / 中 chat / 右三页签） |
| bot 建改删双入口 | 界面表单（POST/PUT/DELETE /api/bots）+ 主 bot 对话草案卡（draft 事件 → draft-confirm 落库） |
| 与任意 bot 真对话（Pi 内核、流式） | 已实现（agent-core Agent + pi-ai streamSimple，SSE delta）；需自备模型 Key 实测真回复，无 Key 时明确「未配置模型」 |
| 每 bot 独立会话与工作区 | 已实现（sessions/<botId>.jsonl、workspaces/<botId>/） |
| Routine 示例：晨间只读扫描出日报 | 已实现（GitHub 公开 REST，日报存 artifacts，右栏可读） |
| 待批收件箱空架子 | 已实现（GET /api/approvals 恒空数组，前端有入口与空状态） |
| 不做：权限网关 / 记忆自动沉淀 / 多模型 / 移动端 | 按规格未做；记忆页签只读 |

实测记录见本文件末尾「实测」节（随提交更新）。

## 实测

（待填：启动与 curl 验收输出摘要。）
