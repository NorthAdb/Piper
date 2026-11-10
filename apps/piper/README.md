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
npm start            # 先构建前端（vite build -> public/）再启动 node server.mjs
# 打开 http://localhost:4310 ，口令默认 piper-dev
```

（前端已构建过时也可直接 `node server.mjs`；改完前端源码重新 `npm start` 或 `npm run build:web` 即可。）

## 前端

技术栈（2026-11-10 定案并落地）：**React 19 + TypeScript + Vite + Tailwind CSS v4**，
源码在 `web/`，构建产物输出 `public/` 由 `server.mjs` 静态托管（`public/` 已 gitignore，不入库）。
后端 API 与 SSE 事件契约（`session / delta / tool / system / draft / error / done`）**一律未动**，
前端历经三步：原生实现（feat/prototype）→ React + assistant-ui（feat/web-assistant-ui）→
设计系统视觉升级（feat/web-visual-upgrade），逐项回归见文末实测节。

以 **assistant-ui（MIT，`@assistant-ui/react` 0.15.33）** 为主要组件底，实际用到的组件/API：

- `AssistantRuntimeProvider` + `useExternalStoreRuntime`：前端自持消息状态（按 bot 隔离，
  父级以 `key={botId}` 挂载），`convertMessage` 把自有 part 模型映射为 `ThreadMessageLike`；
- `ThreadPrimitive.Root / Viewport / Messages / Empty`、`ComposerPrimitive.Root / Input / Send`：中栏对话区与输入区，
  视觉按 assistant-ui 官方 registry thread 的实现方式（消息列居中定宽、用户气泡、助手整幅无气泡、
  Composer 为悬浮圆角卡片）；
- `MessagePrimitive.Root / Parts`：消息渲染分发——文本走 `Text` 槽位（助手消息用
  `@assistant-ui/react-markdown` 的 `MarkdownTextPrimitive` + `remark-gfm` 流式渲染，用户消息纯文本），
  工具事件走 `tool-call` part + `tools.Fallback`（渲染为 AI Elements 的 Tool 组件，见下），
  草案/系统/错误走 `data-*` part + `data.by_name` 分发到对应卡片；
- 草案卡是自定义 data part 渲染器（shadcn Card 实现，确认/放弃按钮对接既有 `draft` 事件与
  `draft-confirm` 接口，回调经 React context 注入），不是 assistant-ui 内置件。

### 设计系统（feat/web-visual-upgrade）

Tailwind CSS **4.3.5**（`@tailwindcss/vite` 插件）+ shadcn 主题变量体系，入口 `web/src/index.css`：

- **主题**：单主题深色（bot 控制台气质）。变量定义在 `:root`（html 带 `.dark` 类，
  使 `dark:` 变体与 Radix 组件按深色工作），颜色用 oklch：zinc 系深灰面
  （`--background` oklch(0.135) / `--card` / `--sidebar` 等）、信号靛蓝主色
  （`--primary` oklch(0.655 0.165 276)，用于按钮、选中态、焦点环）、规范 `--destructive` 红；
  成功/运行中状态在组件层用 emerald/amber 色阶。圆角基准 `--radius: 0.625rem`，
  字体走系统栈（含 CJK）+ ui-monospace 等宽栈。全局规范：边框 `--border` 白 9% 透明、
  输入面 `--input`、`--ring` 与主色同色相。
- **shadcn 基础组件**（copy-in 官方形态，落在 `web/src/components/ui/`）：
  button、badge、card、tabs、dialog、input、textarea、label、scroll-area、separator、
  tooltip、collapsible、select（select 是 AI Elements CodeBlock 的传递依赖）。工具函数
  `cn` 在 `web/src/lib/utils.ts`（clsx + tailwind-merge）；图标统一用 **lucide-react**。
- **布局**：三栏 CSS grid（264px / 1fr / 360px）；左栏与右栏走 sidebar 令牌
  （`bg-sidebar` / `border-sidebar-border`）；中栏顶部会话标题栏（bot 头像 + 名字 + 模型状态徽标）。

### AI Elements 真引入清单（feat/web-visual-upgrade）

上一版只借鉴形态、未引入代码；本版已付脚手架成本，按 shadcn copy-in 方式把官方源码
（vercel/ai-elements，`packages/elements/src/`）落到 `web/src/components/ai-elements/` 并实际使用：

| 件 | 落点 | 用处 | 相对官方源码的适配 |
|---|---|---|---|
| Tool | `components/ai-elements/tool.tsx` | 中栏工具卡（状态徽标 + 折叠详情） | 仅导入路径 `@repo/shadcn-ui/*` → `@/` 别名 |
| Artifact | `components/ai-elements/artifact.tsx` | 右栏产物详情卡（标题栏/描述/关闭/内容区） | 仅导入路径同上 |
| CodeBlock | `components/ai-elements/code-block.tsx` | Tool 的传递依赖：参数/结果的 JSON 高亮渲染 | 导入路径同上；Tailwind v4 important 改后缀语法（`dark:bg-[...]!`）；高亮器改 shiki/core + JS 正则引擎、仅注册 json 文法与 github-light/dark 主题——官方全量 `createHighlighter` 会让构建产物约 11MB/310 个文法 chunk，收窄后 1.1MB/2 文件（本项目实际只高亮 json） |

未引入：Reasoning（后端 SSE 契约无推理事件，无落点）、Queue/Plan 等（当前形态用不上）。

三栏布局保持规格：左栏 bot 列表与右栏「bot 桌面」（例程/产物/记忆）是业务组件自研
（`BotList.tsx` / `Desktop.tsx`，分别用 shadcn 基础件与 AI Elements Artifact 实现），
数据走既有 API；登录页沿用既有 cookie 口令机制（视觉改 shadcn Card）。

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
  OpenAI 兼容 provider（`id: "piper"`，`api: openAICompletionsApi()`——该工厂不在 pi-ai 主入口导出，
  实测位于 `dist/api/openai-completions.lazy.js`，即 package exports 的 `./api/*` 子路径；auth 用 `envApiKeyAuth(...)` 读上面两个环境变量，
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
| 壳：单口令登录 + 三栏 | 已实现（`POST /api/login` cookie 会话；左 bot 列表 / 中 chat / 右三页签；前端为 React + assistant-ui，见「前端」节） |
| bot 建改删双入口 | 界面表单（POST/PUT/DELETE /api/bots）+ 主 bot 对话草案卡（draft 事件 → draft-confirm 落库） |
| 与任意 bot 真对话（Pi 内核、流式） | 已实现（agent-core Agent + pi-ai streamSimple，SSE delta）；需自备模型 Key 实测真回复，无 Key 时明确「未配置模型」 |
| 每 bot 独立会话与工作区 | 已实现（sessions/<botId>.jsonl、workspaces/<botId>/） |
| Routine 示例：晨间只读扫描出日报 | 已实现（GitHub 公开 REST，日报存 artifacts，右栏可读） |
| 待批收件箱空架子 | 已实现（GET /api/approvals 恒空数组，前端有入口与空状态） |
| 不做：权限网关 / 记忆自动沉淀 / 多模型 / 移动端 | 按规格未做；记忆页签只读 |

实测记录见本文件末尾「实测」节（随提交更新）。

## 实测

2026-11-10 在本机实测（Node v24.22.1；基座按上面步骤构建后 `npm start` 于 apps/piper，端口 4310）：

- 启动日志：`Piper prototype listening on http://localhost:4310 (token: default piper-dev, model: NOT configured)`（无 Key 时如实显示未配置）。
- 未登录访问 `/api/bots` 返回 401；`POST /api/login {token:"piper-dev"}` 返回 `{"ok":true}` 并种 cookie。
- `GET /api/bots`：含两个预置 bot，主 bot「Piper」置顶（`isMain/canManageBots=true`），「仓库管家」绑定 NorthAdb/LinkForge、NorthAdb/Loom。
- `POST /api/bots` 新建成功（返回新 bot id）；`PUT /api/bots/:id` 改名成功；`DELETE` 普通 bot 返回 ok，删主 bot 被拒（400「主 bot 不可删除」）。
- `POST /api/chat`（无 Key，普通消息）：SSE 依次 `session` → `error {code:"MODEL_NOT_CONFIGURED", message:"未配置模型：请设置 PIPER_MODEL_API_KEY…"}` → `done`，服务不崩溃。
- `POST /api/chat`（无 Key，对主 bot 说「创建一个代码审查 bot，负责审查 PR 的代码质量」）：SSE `system`（标注来源：规则兜底）→ `draft {name:"代码审查", systemPrompt:"审查 PR 的代码质量", source:"rules"}` → `done`；随后 `POST /api/bots/draft-confirm` 确认后 bot 真落库（出现在 bots.json 与列表中）。
- `POST /api/chat`（配 Key 场景的真链路验证）：本环境无真实模型 Key，改用本地 stub 的 OpenAI 兼容端点
  （`PIPER_MODEL_BASE_URL=http://localhost:4399/v1` + 假 Key）验证全链路：SSE 收到两个 `delta` 事件
  （pi-agent-core 的 `message_update` → pi-ai `openai-completions` 流式），助手全文正确拼合并落盘
  `sessions/repo-keeper.jsonl`。结论：Pi 内核流式接入真实可用；真实厂商 Key 下的回复质量未在本环境实测，留待配置真 Key 后验收。
- `POST /api/routines/morning-scan/run`：真实调用 GitHub 公开 API 生成日报
  `2026-11-10-morning-scan-*`，开头为 `# 晨间仓库日报 2026-11-10`，含 LinkForge 的 star/最近推送/最近提交
  （如 `2026-11-08 Merge pull request #29 …`）；`GET /api/artifacts` 与 `GET /api/artifacts/:id` 可列表与读全文；
  `GET /api/routines` 显示 `lastRunAt/lastStatus:"ok"`。
- `GET /api/approvals`：返回 `{"approvals":[]}`（占位符合规格）。
- `GET /api/memory/repo-keeper`：返回该 bot 的 memory.md（种子阶段为空串）与账号级 about-me 全文。
- 前端首页 `GET /` 返回 200（单页三栏，人工目检结构，未做视觉 polish——后续迭代可能换 React 组件库，后端 API 与数据层不变）。

### 前端迁移实测（2026-11-10，分支 feat/web-assistant-ui）

原生前端已由 React + assistant-ui 实现替代（源码 `web/`），同环境复测（Node v24.22.1，端口 4310，无模型 Key）：

- 构建：`npm run check`（tsc --noEmit）无错误；`npm run build:web`（vite 8.3.4）成功，
  产物 `public/index.html` + `assets/index-*.js`（约 774KB，gzip 233KB；有 >500KB chunk 警告，
  雏形阶段接受，后续可按需代码分割）+ `assets/index-*.css`。`npm start` 已串联构建，实测从构建到监听全流程通。
- 静态托管：`GET /` 返回新构建的 index.html（引用哈希 bundle），bundle JS/CSS 均 200；
  bundle 内含新前端代码（「Bot 草案卡」）与 assistant-ui 运行时，确认托管的是新产物而非旧原生页。
- 回归（与迁移前逐项一致）：未登录 `/api/bots` 401；登录 `{"ok":true}`；`/api/session` 显示
  `modelConfigured:false`；`/api/bots` 两预置 bot 且主 bot 置顶；
  chat 普通消息 SSE 依次 `session` → `error {code:"MODEL_NOT_CONFIGURED", message:"未配置模型：…"}` → `done`；
  对主 bot 说建 bot 意图，SSE `system`（规则兜底标注）→ `draft {name:"代码审查", source:"rules"}` → `done`，
  `draft-confirm` 后落库并出现在列表中（测试 bot 已删除，数据恢复为两个种子 bot）；
  主 bot 历史流水含 draft 条目（新前端渲染为只读草案卡）；bot POST/PUT/DELETE 回归通过、删主 bot 仍被拒的
  后端行为未变；晨间扫描真实生成日报 `2026-11-10-morning-scan-*`（`lastStatus:"ok"`），产物列表/单篇读取正常；
  `/api/approvals` 恒 `{"approvals":[]}`；`/api/memory/repo-keeper` 返回 memory.md 与「关于我」全文。
- 说明：本子任务环境无浏览器，页面级交互（流式渲染观感、草案卡点击确认）未做浏览器实测，
  以上均为服务端与契约层证据；前端事件处理与后端契约一一对应（见 `web/src/ChatPane.tsx` 的 SSE 分发）。

### 视觉升级实测（2026-11-10，分支 feat/web-visual-upgrade）

设计系统 + 三栏精修 + AI Elements 真引入，同环境复测（Node v24.22.1，端口 4310，无模型 Key）：

- 构建：`npm run check`（tsc --noEmit）无错误；`npm run build:web`（vite 8.3.4 + Tailwind v4）成功。
  产物 `public/` 共约 1.1MB / 2 文件：JS 约 1.07MB（gzip 约 325KB）、CSS 约 47KB。
  与上一版（JS 774KB / gzip 233KB）相比增量来自 Radix 基础件、Tailwind 运行时与
  AI Elements CodeBlock 的 shiki（已收窄为 core + json 文法，见「AI Elements 真引入清单」）；
  仍有 >500KB chunk 警告，雏形阶段接受，后续可按路由/组件代码分割。
- 静态托管：`GET /` 返回 200，html 带 `class="dark"`，JS bundle 含新界面文案
  （「Personal Agent 控制台」「Bot 草案卡」「待批收件箱」），CSS 含设计系统主题变量（oklch `--primary` 等）。
- 回归（自动化脚本逐项断言，**26/26 通过**，与升级前清单一致、功能一项不丢）：
  未登录 401 → 登录 ok → `/api/session` modelConfigured:false → bots 两预置且主 bot 置顶 →
  bot POST（201）/PUT 改名/DELETE 普通 bot ok、删主 bot 400 →
  chat 普通消息 SSE `session → error MODEL_NOT_CONFIGURED「未配置模型」→ done` →
  主 bot 建 bot 意图 SSE `system`（规则兜底）`→ draft{name:"代码审查", source:"rules"} → done` →
  `draft-confirm`（201）落库、列表与主 bot 历史均含该草案 → 测试数据清理后恢复两预置 bot →
  晨间扫描真实生成日报（`lastStatus:"ok"`）、产物列表 +1 且单篇可读 →
  `/api/approvals` 恒 `{"approvals":[]}` → `/api/memory/repo-keeper` 返回 memory.md 与「关于我」。
- 如实记录：首轮脚本有 2 项假失败（POST /api/bots、draft-confirm），定位为脚本误期望
  状态码 200、实际后端契约一直是 201（server.mjs 未改），修正脚本后 26/26 通过；
  与前端迁移时那次 grep 误匹配同类，均为验收脚本问题、非接口回归。
- 说明：本环境无浏览器，页面观感（深色主题、卡片层次、流式渲染）未做浏览器目检，
  由用户本地 `npm start` 后确认；以上为构建、托管与契约层证据。
