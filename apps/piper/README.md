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

注（L0-2）：模型三项（端点、模型名、Key）可在设置页保存到 `data/settings-model.json`，
**设置文件优先于环境变量**，保存即热生效、不必重启；环境变量只作文件缺失时的初值，
不会被自动写进文件。设置读回只给是否已配置与 Key 末四位掩码（`GET /api/settings/model`）。

注（L0-4）：GitHub 令牌同样可在设置页「连接器」组保存到 `data/settings-github.json`，
文件优先于 `GITHUB_TOKEN` 环境变量；扫描经 `lib/settings.mjs` 的 `githubToken()` 统一读取
（唯一的令牌入口），读回只给末四位掩码（`GET /api/settings/connectors`）。

## Pi 接入

结论：**源码级真接入**，不是 SDK 嵌入、不是子进程调 CLI。`apps/piper` 作为 monorepo 内新增 app，
在 `package.json` 里以 workspace 依赖直接引用基座两个包，运行时 import 的是它们构建出的 dist：

- `@earendil-works/pi-agent-core`（`packages/agent`）：对话内核用其 `Agent` 类
  （`packages/agent/src/agent.ts`）。构造：`new Agent({ initialState: { systemPrompt, model, messages }, streamFn })`；
  `agent.subscribe(fn)` 订阅 `AgentEvent`（`message_update` 带流式增量、`tool_execution_start/end`、`message_end`）；
  `agent.prompt(text)` 驱动一轮。bot 的 systemPrompt 与历史会话（JSONL 读出后转换）都走这条路。
- `@earendil-works/pi-ai`（`packages/ai`）：模型层用 `createModels()` + `createProvider()` 自建一个
  OpenAI 兼容 provider（`id: "piper"`，`api: openAICompletionsApi()`——该工厂不在 pi-ai 主入口导出，
  实测位于 `dist/api/openai-completions.lazy.js`，即 package exports 的 `./api/*` 子路径；auth 用自定义
  `ApiKeyAuth.resolve` 直接解析 `modelConfig()` 合并后的 Key（L0-2 起：设置文件优先、环境变量兜底，
  不再走 `envApiKeyAuth`，否则设置页保存的 Key 喂不进 provider），
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
- `settings-model.json`：设置页保存的模型配置（端点、模型名、Key 明文只存此文件，L0-2；见 `lib/settings.mjs`）
- `settings-profile.json`：设置页保存的基础资料（称呼、时区；时区缺省 `Asia/Hong_Kong`，L0-3）
- `settings-github.json`：设置页保存的 GitHub 令牌（明文只存此文件，L0-4；经 `githubToken()` 读取）
- `notifications.jsonl`：应用内通知一行一条（L0-5），扫描完成 / 整轮失败时写入；P1-6 起
  `approval.pending`（新待批写操作）、`approval.executed` / `approval.failed`（网关执行结果）真正写入
- `audit.jsonl`：网关审计一行一条（P1-6，见 `lib/audit.mjs`），只追加：时间、bot、意图摘要
  （kind / repo / prNumber / 正文长度与脱敏预览，不含任何秘密）、结果
  （denied / approved / executing / executed / failed / rejected）、原因、关联 Finding、评论链接；
  `GET /api/audit?findingId=` 可追溯。文件路径可用 `PIPER_AUDIT_FILE` 覆盖（仅供测试隔离）
- `approvals.jsonl`：批准记录一行一条（R1，见 `lib/approvals.mjs`），只追加：approvalId、
  关联 Finding、批准时刻的意图快照（kind / repo / prNumber / 正文）与 SHA-256 哈希、批准
  时间。网关只执行这份快照。文件路径可用 `PIPER_APPROVALS_FILE` 覆盖（仅供测试隔离）
- `findings.jsonl`：分诊 Finding 一行一条（P1-1，见 `lib/findings.mjs`）：需要人拍板的事项的结构化对象
  （repo / type / subject 去重键 / evidenceUrl 必填 / suggestedAction / writeIntent / expiresAt /
  status（open|approved|rejected|expired|executed|executing）/ botId），每次读写现读落盘、重启不丢；
  状态迁移由显式迁移表强制（R1），writeIntent 落盘后不可改；
  校验在写入边界：无 evidenceUrl、非法 type/status/writeIntent 一律拒绝。只读 API：
  `GET /api/findings`（可按 status/repo/botId 过滤）、`GET /api/findings/:id`。
  文件路径可用环境变量 `PIPER_FINDINGS_FILE` 覆盖（仅供单元测试 / 评测隔离，缺省即此文件）
- 待批收件箱不另存数据（P1-5）：`lib/approvals.mjs` 把带 writeIntent 的 Finding 整形成
  审批视图（id 与 findingId 同值），批准/驳回即改 Finding 状态；过期 open 项在读列表时
  惰性转 expired
- `about-me.md`：账号级「关于我」，只有一份——设置页（`PUT /api/about-me`，需登录）、右栏记忆
  与对话注入读的都是它；上限 20000 字符，超限拒绝且不写坏原文件（L0-3）
- `workspaces/<botId>/`：每 bot 隔离工作区，`memory.md` 为其记忆（右栏只读展示）
- `sessions/<botId>.jsonl`：每 bot 独立会话流水
- `artifacts/<id>.md`：产物，文件头 HTML 注释内嵌结构化元数据
- `routines.json`：routine 定义与上次运行结果；`schedule` 为机器可解析的 `"HH:MM"`（P1-4），
  `scheduleText` 为展示文案，旧版纯文本 schedule 在服务启动时自动迁移

预置 bot：主 bot「Piper」（置顶、`canManageBots`）与运维 bot「仓库管家」（绑定 NorthAdb/LinkForge、NorthAdb/Loom，挂 morning-scan 例程）。

## API 契约

见 `server.mjs` 文件头注释（逐条列明）。要点：SSE 事件类型固定为
`session / delta / tool / system / draft / error / done`；草案卡结构
`{name, systemPrompt, tools, repos, memoryScope, source}`，经 `POST /api/bots/draft-confirm` 确认才落库；
`GET /api/approvals` 自 P1-5 起读真实存储：待批项即带 `writeIntent` 的 open/approved/executing
Finding 的审批视图（不另存一份），每条带批准记录 id 与 intentHash；`POST /api/approvals/:id/approve`
自 P1-6 起批准后经薄网关（`lib/gateway.mjs`，默认拒绝、只放行 `pr_comment` 一种写）真正执行，
R1 起必须带回 intentHash（不一致回 409）且网关只执行批准时刻的意图快照、靠评论里的
幂等标记防重复发送，`reject` 只改状态不产生写操作。
定时调度（P1-4）：`server.mjs` 进程内调度晨间扫描，每天 `routines.schedule` 的时刻
（缺省 08:00，时区读基础资料），与手动触发走同一执行函数、同一通知语义；
只读状态端点 `GET /api/schedule/status` 给出时区、下次运行、上次运行与结果。

## 验收线对照（规格六）

| 验收项 | 状态 |
|---|---|
| 壳：单口令登录 + 三栏 | 已实现（`POST /api/login` cookie 会话；左 bot 列表 / 中 chat / 右三页签；前端为 React + assistant-ui，见「前端」节） |
| bot 建改删双入口 | 界面表单（POST/PUT/DELETE /api/bots）+ 主 bot 对话草案卡（draft 事件 → draft-confirm 落库） |
| 与任意 bot 真对话（Pi 内核、流式） | 已实现（agent-core Agent + pi-ai streamSimple，SSE delta）；需自备模型 Key 实测真回复，无 Key 时明确「未配置模型」 |
| 每 bot 独立会话与工作区 | 已实现（sessions/<botId>.jsonl、workspaces/<botId>/） |
| Routine 示例：晨间只读扫描出拍板清单 + 日报 | 已实现（GitHub 公开 REST；主产物为 Finding（P1-2，响应带 `findings`），日报存 artifacts 且清单在前、观察在后，右栏可读） |
| 待批收件箱 | 已实现（P1-5：独立整页视图，列表读真实 Finding 存储，批准/驳回写回状态；网关执行在 P1-6） |
| 不做：记忆自动沉淀 / 多模型 / 移动端 | 按规格未做；记忆页签只读。权限网关已由第一件落地为薄网关（P1-6，一种有闸写 + 正负审计） |

实测记录见本文件末尾「实测」节（随提交更新）。

## 回归脚本

历次实测的 API 断言已固化为脚本 `scripts/regression.mjs`（L0-1 落地，后续切片只扩展它）：

```bash
cd apps/piper
npm run build:web        # 脚本需要 public/ 已构建
npm run regression       # 或 node scripts/regression.mjs
```

脚本以「无模型 Key」的默认环境在测试端口（4398，可用 `REGRESSION_PORT` 覆盖）启动一份
`server.mjs`，逐项断言后退出：原 26 项覆盖未登录 401、登录、bot CRUD、chat 无 Key 的
`MODEL_NOT_CONFIGURED`、草案规则兜底全链路、晨间扫描与产物、收件箱、记忆与首页托管；
L0-2 扩展第 27-30 项覆盖模型设置（无 Key 默认值、保存不回显全文、测试连接坏端点不崩溃、
清除恢复未配置）；L0-3 至 L0-5 续扩至 43 项；P1-1 续扩第 44-46 项覆盖 Finding 只读 API
（未登录 401、列表结构、不存在 404）；P1-2 把第 22 项改成产物 + 清单结构口径并续扩第 47-48 项
（扫描响应带 findings、与只读 API 同一存储）；P1-4 续扩第 49-52 项（调度状态端点 401 与
结构、schedule 机器可解析且带 nextRunAt）；P1-5 把第 23 项 approvals 断言按切片授权
改成「来自真实存储且结构合法」口径并续扩第 53-56 项（未登录读写 401、不存在项批准/
驳回 404、例程与产物带 botId）；P1-6 续扩第 57-58 项（审计端点未登录 401、结构与
按 findingId 过滤），当前共 **58 项**。晨间扫描一项真实调用 GitHub 公开 API（与产品行为一致），
其余不依赖外网。设置组断言带保护：`data/settings-model.json` 若在运行前已存在（真实配置），
整组跳过且不覆盖，运行后脚本自建的设置文件会被删除、恢复无文件状态。

Finding 存储层的单元测试在 `scripts/test-findings.mjs`（不走 HTTP、不打网络，用临时文件隔离）：

```bash
cd apps/piper
npm run test:findings    # 或 node scripts/test-findings.mjs
```

覆盖写入补齐字段、按 status/repo/botId 过滤、缺 evidenceUrl / 非法 status / 非法 type /
非法 writeIntent 被拒绝、改状态后去重不再命中、新进程从文件读回（重启不丢）、删除。

调度状态机另有假时钟测试 `scripts/test-schedule.mjs`（注入 now 与运行函数，不等真实时间）：

```bash
npm run test:schedule    # 或 node scripts/test-schedule.mjs
```

覆盖下一次运行的时区换算、到点只触发一次、失败 15 分钟内补跑 3 次后放弃、补跑成功即停、
启动补跑（已过点未成功才补）、并发重入返回 busy、skipped 不推进计划、status 形状。

网关另有替身测试 `scripts/test-gateway.mjs`（进程内 fetch 替身 + 临时 findings/audit/
notifications 文件，不打活网、不对真实仓库发评论）：

```bash
npm run test:gateway    # 或 node scripts/test-gateway.mjs
```

覆盖拒绝路径（未批准直调、意图被改、仓库未绑定、不支持的意图、正文含令牌）与执行
路径（批准恰好发一次、无令牌失败可重试、PR 已关闭保持 approved、写接口失败可重试），
两类审计齐全性与脱敏，以及源码绕过断言（只有 gateway.mjs 构造评论写端点）。

扫描规则另有替身测试 `scripts/test-scan.mjs`（进程内 fetch 替身 + 临时 findings 文件，不打活网）：

```bash
npm run test:scan    # 或 node scripts/test-scan.mjs
```

覆盖两条规则的命中与证据链接、跳过进行中 run / 别分支 run / draft PR（且不查其审查）、
日报清单在观察之前、连扫两次不重复开、单仓 API 失败不拖垮整轮、安静仓零 Finding。

## 冻结夹具评测（P1-3）

把两条规则钉在入库的 GitHub 响应夹具上回归，改规则先看评测变红：

```bash
cd apps/piper
npm run eval:scan    # 或 node scripts/eval-scan.mjs
```

- 夹具在 `test/fixtures/github/*.json`，一文件一用例。字段：`name` / `description` /
  `scans`（连扫几轮，缺省 1）/ `repos`（每仓的 `info`/`commits`/`issues`/`runs`/`pulls`/
  `reviews` 响应，或 `{ "error": 500 }` 表示全端点失败）/ `expect`（`failures`、
  `findings` 期望集合（repo/type/subject/evidenceUrl 精确比对）、可选 `reportIncludes`）。
- 运行器 `scripts/eval-scan.mjs` 给每用例独立的临时 findings 文件，fetch 全域换成夹具
  替身：未映射的 URL 会被记录、回 599 并在结尾断言为空——评测永不访问真实 api.github.com，
  也不产生真实写入。每用例除期望 Finding 集合外，还断言累计新开条数与期望一致（去重被打穿
  会立刻变红）。当前五用例：`ci-failed-latest`、`pr-needs-review`、`quiet-no-findings`、
  `dedup-rescan`、`repo-api-error`。
- 新增用例：往 `test/fixtures/github/` 放一个符合上面格式的 JSON 即可，不用改脚本；
  文件名即用例来源，`name` 字段写用例名。新增夹具应来自真实响应脱敏或手造的最小形状，
  不要把真实令牌写进夹具。

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

### L0-1 设置页骨架实测（2026-11-10，分支 feat/l0-1-settings-shell）

- 回归脚本落地：此前只存在于验收过程的 26 项断言已固化为 `scripts/regression.mjs`
  （运行方式见上文「回归脚本」节）。脚本在未改任何代码的基线上先行验证 26/26 通过，
  证明断言与现状契约对齐，不是照着新代码反写的。
- 设置页骨架（`web/src/Settings.tsx`）：左栏底部、待批收件箱下方新增「设置」入口；
  点击进入独立整页视图（顶部「返回」回三栏），内分四组页签——模型 / 基础资料 /
  连接器 / 通知——均为「尚未配置 / 即将接入」的空状态，本切片不保存任何配置。
  设置视图在登录门之后（未登录先见登录页，原 401 行为不变）。
- 验证：`npm run check`（tsc）无错误；`npm run build:web` 成功，bundle 内含「设置」入口与
  四组文案；`node scripts/regression.mjs` 26/26 通过（无 Key 默认环境）。
- 未做浏览器截图：本环境无浏览器工具，设置页观感以构建产物 + 契约证据替代，留待用户本地目检。

### L0-2 模型与真 Key 实测（2026-11-10，分支 feat/l0-2-model-key）

- 设置存储：`lib/settings.mjs` 读写 `data/settings-model.json`（`git check-ignore` 实测命中
  `data/*` 规则，不可追踪）。`modelConfig()` 改为设置文件优先、环境变量兜底，每次现读，
  保存后下一次 prompt 即用新配置；环境变量里的秘密不被自动写入文件。
- 接口：`GET /api/settings/model`（`{configured, baseUrl, modelId, apiKeyHint}`，hint 只有
  `••••` + 末四位）、`PUT /api/settings/model`（部分字段单独更新；`apiKey:""` 清除）、
  `POST /api/settings/model/test`（候选配置打一次最小请求，15 秒超时，回 `{ok}` 或
  `{ok:false, error}`，不抛 5xx）。设置页「模型」组为真表单（端点、模型名、Key 密码框、
  测试连接、保存、清除 Key）；保存成功后顶栏「未配置模型」徽标随 `modelConfigured` 刷新。
- 无 Key 行为不变：`MODEL_NOT_CONFIGURED` 的 code 保留，文案改为「请在设置中配置模型…」。
- 回归：脚本扩展至 30 项，`node scripts/regression.mjs` **30/30 通过**（无 Key 默认环境）；
  `npm run check` 无错误；`npm run build:web` 成功。
- 真链路（本地 OpenAI 兼容 stub，端口 4399，流式与非流式都支持）：PUT 保存 stub 配置后，
  同一进程内 `modelConfigured` 即变 true（未重启）；测试连接回 `ok:true`；与仓库管家对话
  收到两个 `delta` 并正确拼合为「你好，这是 stub 的流式回复。」，助手消息落盘
  `sessions/repo-keeper.jsonl`，且 JSONL 全文不含 stub Key；对主 bot 说「创建一个代码审查
  bot，负责审查 PR 的代码质量」，草案走**模型抽取**（`draft.source="model"`、name=代码审查）；
  清除 Key 后立即回到未配置。验证后设置文件已删除、恢复无文件状态。
- 人工真 Key 验收步骤（有真实厂商 Key 时照此复验一遍，并把结果补记到本节）：
  1. `npm start` 后登录，左栏底部进「设置 → 模型」，填端点、模型名、真 Key，点「测试连接」应显示连接可用；
  2. 保存后回主界面，顶栏徽标应变「模型已配置」；
  3. 任选一个 bot 发一句话，应收到流式回复（多个 delta），且该 bot 的 `data/sessions/<botId>.jsonl` 出现助手消息；
  4. 对主 bot 说「创建一个代码审查 bot，负责审查 PR 的代码质量」，草案卡来源应标注模型抽取；确认后落库；
  5. 回设置页点「清除 Key」，顶栏徽标应回「未配置模型」，再发消息应回 `MODEL_NOT_CONFIGURED`。
- 截图类验收（设置页已配置状态、Key 掩码）本环境做不了（无浏览器工具），以以上构建 +
  接口 + stub 链路证据替代，留待用户本地目检。

### L0-3 基础资料与「关于我」实测（2026-11-10，分支 feat/l0-3-profile-about）

- 存储：基础资料（称呼、时区）存 `data/settings-profile.json`（`lib/settings.mjs` 的
  `readProfileSettings / saveProfileSettings`，时区缺省 `Asia/Hong_Kong`）；「关于我」不另存——
  仍只有一份 `data/about-me.md`，`store.writeAboutMe` 写入（临时文件 + rename 落盘）。
- 接口：`GET / PUT /api/settings/profile`（部分字段更新）；`PUT /api/about-me`（需登录，
  `markdown` 须为字符串；超过 20000 字符回 413 且原文件不动）。设置页「基础资料」组为真表单
  （`web/src/SettingsProfile.tsx`：称呼、时区（带常用时区候选）、「关于我」正文与字符计数）。
- 注入核对：对话注入没有缓存问题——`server.mjs` 每轮 chat 都现调 `readAboutMe()` 组装
  systemPrompt（`readAboutMe` 本身每次读文件），改完保存下一轮即生效，无需改动。
- 回归：脚本扩展至 35 项，`node scripts/regression.mjs` **35/35 通过**（无 Key 默认环境）；
  新增断言：未登录 `PUT /api/about-me` 401；profile 保存后读回一致；写入带标记的「关于我」
  后 `GET /api/about-me` 与 `/api/memory/:botId` 的 `aboutMe` 均含标记（同源一份的两个读口；
  设置页读同一 `GET /api/about-me`，为第三处）；超限 20001 字符被拒且文件保持上一步内容；
  脚本结束时把 about-me 与 profile 还原为运行前内容并断言一致。`npm run check` 无错误；
  `npm run build:web` 成功。
- 验收第 3 条（新对话注入含新文本）在无 Key 环境无法从对话层直接观测：以「每轮现读文件」
  的代码路径 + 读取同源断言作为证据；有真 Key 时可按 L0-2 人工复验步骤顺带核对（改一条
  「关于我」事实后新开对话问 bot）。
- 截图类验收（设置页基础资料组）本环境做不了（无浏览器工具），以构建 + 契约证据替代，
  留待用户本地目检。

### L0-4 连接器列表与 GitHub 配置实测（2026-11-10，分支 feat/l0-4-connectors）

- 统一槽位：连接器形状在 `lib/settings.mjs` 的 `listConnectors()` 定义（id / name / purpose /
  status（placeholder | unconfigured | connected）/ statusNote / bots / access / configurable），
  接口 `GET /api/settings/connectors`；设置页「连接器」组渲染为卡片（`web/src/SettingsConnectors.tsx`），
  每卡可展开看状态与口径。GitHub 卡的 bots 范围按 bot 的 `github*` 工具动态得出。
- GitHub 令牌：`PUT /api/settings/connectors/github` 保存到 `data/settings-github.json`
  （空串清除）；`githubToken()`（设置文件优先、`GITHUB_TOKEN` 环境变量兜底）是唯一读取入口，
  `lib/scan.mjs` 已改走它、删掉原来的环境变量直读。读回只有 `tokenHint` 末四位掩码。
- 占位卡口径：网页查询为 unconfigured（注明 L0-6 接入、只读 + SSRF 防护）；日历、邮件为
  placeholder，展开文案写明「尚未接入，真连接排在有闸分诊闭环之后」，邮件另注明「发必须
  先成草稿、经全局收件箱确认后才发出」。
- 回归：脚本扩展至 39 项，`node scripts/regression.mjs` **39/39 通过**（无令牌默认环境；
  若运行前已有真实 `settings-github.json`，连接器组整组跳过以免覆盖）；新增断言：四卡与
  状态正确；保存假令牌后状态 connected、只回掩码、响应不含全文；源码断言 scan 无第二套
  令牌入口，且用进程内 fetch 替身实际跑一次扫描、捕获出站请求头，断言每条请求都带
  `Bearer <已保存令牌>`（不打活网、日志不打印令牌）；清除后回到 unconfigured 且
  `githubToken()` 为空。无令牌时手动扫描仍走公开 API（原 20-22 项继续通过）。
  `npm run check` 无错误；`npm run build:web` 成功。
- 明确不做核对：无 GitHub 写操作、无 OAuth 流、日历 / 邮件未做真同步、网页查询未实现
  （仍是占位状态，L0-6 才做）。
- 截图类验收（连接器四卡与展开口径）本环境做不了（无浏览器工具），以构建 + 契约证据
  替代，留待用户本地目检。

### L0-5 应用内通知实测（2026-11-10，分支 feat/l0-5-notifications）

- 通知存储：`lib/notify.mjs` 管 `data/notifications.jsonl`（一行一条，文件持久化）；
  接口 `GET /api/notifications`（列表新在前 + 未读数）、`POST /api/notifications/read`
  （`{ids}` 只标记这些、无 ids 全部标记）。左栏「通知」入口带未读徽标，直达设置页通知组
  （`web/src/SettingsNotifications.tsx`：列表、逐条 / 全部标已读）。
- 写入点（本批只有例程）：晨间扫描成功写 `routine.completed`；全部仓库取证失败视为整轮
  失败——日报照常落盘，但 routine 状态记 `failed`、写 `routine.failed` 通知（扫描函数返回
  失败计数后由路由判定，单仓失败不中断整体）；意料外抛错同样记 failed 通知后回 500，
  进程不崩溃。`approval.pending` 只在类型枚举与前端标签里预留，没有造假待批数据。
- 回归：脚本扩展至 43 项，`node scripts/regression.mjs` **43/43 通过**；新增断言：未登录
  401；本轮成功扫描的完成通知与 `lastArtifactId` 对得上且初始未读；标记已读后未读数减一，
  且脚本以新进程从文件读回同一条为已读（等价重启后不丢）；把仓库管家临时绑到不存在的
  仓库后整轮失败（状态 failed + 新增失败通知、进程存活），恢复绑定后再跑成功并写完成
  通知。`npm run check` 无错误；`npm run build:web` 成功。
- 环境备注（如实记录）：实测中途出现过两轮 20/41/42（及一次 43 恢复段）失败，定性为本机
  出口共享 IP 被 GitHub 二级限流的瞬时 403（同刻 `rate_limit` 显示 core 限额未满、curl
  与 Node 直连随后均恢复 200）；等待约一分钟后完整回归 43/43。这同时真实触发了一次
  「整轮失败」路径，与注入坏仓库的失败断言互为印证。注意：回归每跑一轮约消耗 25 次
  GitHub 未授权请求（扫描 3 次），短时间连跑多轮可能再次撞限。
- 明确不做核对：无邮箱 / 企微等外部渠道、无通知偏好设置、前端无实时推送（进视图时拉取）；
  未接 P1 的待批事项（仅预留类型）。
- 截图类验收（通知入口徽标、通知列表观感）本环境做不了（无浏览器工具），以构建 +
  契约证据替代，留待用户本地目检。

### P1-1 Finding 模型与存储实测（2026-11-10，分支 feat/p1-1-finding-model）

- 存储：`lib/findings.mjs` 管 `data/findings.jsonl`（一行一条，现读落盘）。字段按切片表全量落地：
  id / repo / type（本批只允许 `ci_failed`、`pr_needs_review`）/ subject（去重键，归一为字符串）/
  title / summary / evidenceUrl（必填且须为 http/https URL）/ suggestedAction /
  writeIntent（可空；只允许 `pr_comment` + prNumber + body）/ expiresAt / status
  （open / approved / rejected / expired / executed）/ botId / createdAt / updatedAt。
  取证字段（repo/type/subject/evidenceUrl/botId）立住后不可改，可改的只有 status 与建议类字段。
  存储层提供 create / list（按 status/repo/botId 过滤）/ get / update / delete / findOpenFinding
  （P1-2 去重用）。文件路径可用 `PIPER_FINDINGS_FILE` 覆盖，仅供测试与评测隔离。
- 接口：`GET /api/findings`（可过滤）、`GET /api/findings/:id`（不存在 404），未登录 401。
  本切片不改扫描产物格式，日报仍是旧统计形态（改造在 P1-2）。
- 单元测试：`node scripts/test-findings.mjs` **18/18 通过**（临时文件隔离、不打网络）：
  合法写入补齐字段、writeIntent 归一、缺/坏 evidenceUrl 被拒、非法 status/type/writeIntent 被拒、
  三维过滤、改状态、去重命中与关闭后不再命中、删除、以及另起一个 node 进程从同一文件读回
  已落盘条目（等价进程重启后还在）。
- 回归：脚本扩展至 46 项，`node scripts/regression.mjs` **46/46 通过**（新增 44-46 为
  Finding 只读 API 三项）；`npm run check` 无错误。本切片无界面改动，无截图项。
- 环境备注（如实记录）：首轮回归 42/46，失败的 20/41/42/43 全是依赖活 GitHub API 的扫描项——
  本机共享出口 IP 的未授权限额被耗尽（`API rate limit exceeded for 104.29.194.34`，core
  remaining=0），扫描整轮取证失败，与本切片代码无关（本切片未动 scan）。等限额窗口重置后
  复跑即 46/46。这与 L0-5 记录的同类抖动一致：无令牌回归对共享 IP 限额敏感，连跑需间隔。
- 明确不做核对：未改扫描算法、未做审批与网关、未做评测夹具（P1-3）、未改 `packages/`、
  未改 SSE 事件名。

### P1-2 扫描产出拍板清单实测（2026-11-10，分支 feat/p1-2-scan-findings）

- 规则改造：`lib/scan.mjs` 重写。数据仍经 `gh()` 以 `githubToken()` 取（L0-4 口径不变），
  新增 reviews 取证。两条程序化规则（建议用规则模板，模型不参与判定）：
  `ci_failed` = 默认分支最近一次已结束 run 结论为 failure（API 用 branch 参数、客户端再按
  head_branch 过滤，跳过进行中的 run）；`pr_needs_review` = open、非 draft、无任何 APPROVED
  审查。命中先以 findOpenFinding 按 (repo, type, subject) 查 open 去重，再 createFinding 落盘，
  expiresAt 设 7 天。扫描返回扩展为 `{ artifact, report, failures, total, findings }`，
  HTTP 响应同步带 `findings`；整轮失败判定与通知语义（L0-5）未动，完成通知只引用清单计数。
- 日报结构：先「## 拍板清单」（本轮新开 Finding 的标题 + 证据链接 + 建议；没有则明写
  「本轮没有需要拍板的事项。」），后「## 其余观察」（每仓小节：概况/最近提交/待处理 PR 与
  Issue/最近 CI；单仓失败写失败原因）。star、提交列表、已通过 CI、draft 与已批准 PR 只进观察。
- 替身测试：`node scripts/test-scan.mjs` **5/5 通过**（fetch 替身 + 临时 findings 文件，
  不打活网）：失败 CI 与待审 PR 各开一条且证据链接精确、进行中 run 与别分支失败 run 不误报、
  draft PR 不开且不查其审查、清单节排在观察节之前、连扫两次第二轮新开 0 条（open 仍 2 条）、
  一仓 500 时 failures=1 且不拖垮整轮、安静仓（成功 CI + 已批准 PR）零 Finding。
- 回归：第 22 项按切片改成「产物 + 清单结构」口径（标题 + 两节标题 + 顺序），新增 47-48 项
  （扫描响应 findings 结构、与只读 API 同一存储），`node scripts/regression.mjs` **48/48 通过**；
  `npm run check` 无错误。本轮活扫描（LinkForge、Loom）实际新开 0 条——两仓当时无失败的
  最近 CI、无待审 PR，属于安静状态；规则命中证据以替身测试与 P1-3 冻结夹具为准，不拿活仓
  状态当断言。本切片无界面改动，无截图项。
- 明确不做核对：未扩扫描种类（不报 star 变化/新 issue）；未做定时（P1-4）、未做任何写操作
  （P1-6）；未改 `packages/`、未改 SSE 事件名；L0-5 的 approvals 回归断言口径未动（P1-5 才改）。

### P1-3 冻结夹具评测实测（2026-11-10，分支 feat/p1-3-fixture-evals）

- 落地：夹具五份入 `test/fixtures/github/`（ci-failed-latest、pr-needs-review、
  quiet-no-findings、dedup-rescan（scans=2）、repo-api-error），运行器 `scripts/eval-scan.mjs`
  （`npm run eval:scan`），每用例独立临时 findings 文件、fetch 全域替身、未映射 URL 记录并
  在结尾断言为空（不打活网的证据是结构性的，不是口头承诺）。
- 结果：`node scripts/eval-scan.mjs` **5/5 用例通过**；断言口径 = 每用例 failures 数、
  open Finding 集合与 expect 精确一致（含 evidenceUrl）、累计新开条数与期望一致
  （dedup-rescan 两轮后仍恰好两条）、日报片段（repo-api-error 的「扫描失败」与坏仓名）。
- 守门证明（切片要求，如实记录）：先备份 `lib/scan.mjs`，把 ci_failed 判定从
  `conclusion === "failure"` 故意改成 `"success"`，跑评测 → **0/5 全红**（反转规则既漏报
  真失败——ci-failed-latest、dedup-rescan、repo-api-error，又误报成功 run——pr-needs-review、
  quiet-no-findings），退出码 1；从备份还原后复跑 **5/5 全绿**，且 `git diff` 确认 scan.mjs
  与改坏前逐字一致。评测确实守得住规则回归。
- 全量核对：同一分支上 `test-findings` 18/18、`test-scan` 5/5、`npm run check` 无错误，
  回归 **48/48 通过**。如实备注：回归首跑 44/48，失败的仍是 20/41/42/43 四项活 GitHub API
  依赖项——本机出口 IP 在多个共享地址间轮换、各自的未授权限额被耗尽（403
  `API rate limit exceeded`），等窗口恢复后复跑即全绿；本切片相对 P1-2 分支零产品代码
  改动（只有夹具、评测脚本、README 与一条 npm script），P1-2 分支同日已实测 48/48。
  本切片无产品界面与行为改动（只加测试资产），无截图项。
- 明确不做核对：未用活仓做通过断言；未把评测 gate 到记忆或 RSI 验收（那些模块尚不存在）；
  未改 `packages/`、未改 SSE 事件名、未动 L0-5 的 approvals 回归断言口径。

### P1-4 真定时调度实测（2026-11-10，分支 feat/p1-4-schedule）

- 实现：新增 `lib/schedule.mjs`（零外部依赖）。`server.mjs` 进程内装配一个调度状态机，
  每 30 秒 tick 一次；时区每次规划现读基础资料（`readProfileSettings().timezone`，缺省
  `Asia/Hong_Kong`），计划时刻读 `routines.json` 中 morning-scan 的 `schedule` 字段。
  `schedule` 已从旧版中文描述迁移为机器可解析的 `"08:00"`（启动时自动迁移，抠不出时刻
  则回退 08:00），展示文案走 `scheduleText`，由服务端按当前时区现算。
- 执行路径统一：手动 `POST /api/routines/morning-scan/run` 与定时触发共用
  `executeMorningScan()`——同一扫描函数、同一例程状态更新、同一 L0-5 通知语义（整轮
  失败记 failed + 失败通知，部分失败仍算完成）。执行层带重入防护：已有扫描在途时
  手动触发回 409、调度 tick 返回 busy/skipped，不会并行开两轮。
- 补跑语义：到点整轮失败（或抛错）后，15 分钟窗口内最多补跑 3 次（每次间隔 5 分钟），
  补跑成功即停；用尽则保持失败状态等下一周期。启动补跑：进程启动时若今日计划时刻
  已过且今日尚未成功（按存储的 lastRunAt/lastStatus 判定），补跑一次；今日已成功绝不补。
- 只读状态：`GET /api/schedule/status` 返回 `{ timezone, routines: [{ id, nextRunAt,
  nextRetryAt, running, attempts, lastRunAt, lastStatus }] }`；`GET /api/routines` 给
  morning-scan 附带现算的 `scheduleText` 与 `nextRunAt`，右栏例程卡显示计划/上次/下次运行，
  不再出现「仅手动触发」。
- 测试：`node scripts/test-schedule.mjs` **12/12 通过**（假时钟驱动状态机，不等真实
  时间）：nextRunAfter 时区换算（HKT 08:00 = UTC 00:00、跨日、恰到点算已过）、
  parseScheduleTime 与旧文本迁移、shouldCatchUp 四象限、到点只跑一次且次日再跑、
  失败 +5/+10/+15 分钟补跑共 4 跑后放弃、补跑成功清零 attempts、启动补跑两种状态、
  并发 tick 返回 busy 且 run 只调一次、skipped 不推进计划、status 形状。
- 回归：脚本扩展至 52 项，`node scripts/regression.mjs` **52/52 通过**（新增 49-52：
  状态端点未登录 401、结构完整、schedule 为 HH:MM 且文案无「仅手动触发」并带 nextRunAt、
  nextRunAt 在未来 25 小时内）。回归 harness 另加一段「等调度空闲」：服务端启动瞬间
  可能正跑启动补跑，先等其结束再数产物，避免与手动扫描的 +1 断言竞态（断言未放宽）。
  同批复跑：test-findings 18/18、test-scan 5/5、eval:scan 5/5、`npm run check` 无错误、
  `npm run build:web` 成功。本机真实 data 的 routines.json 已实测完成迁移
  （schedule 变为 "08:00" 并生成 scheduleText）。
- 明确不做核对：未加外部调度依赖、未起新服务、未用系统 cron；未接 CI/review 事件
  触发；未改 `packages/`、未改 SSE 事件名。本切片无新页面（右栏例程卡多一行下次运行），
  截图以接口与状态机测试证据替代，留待用户本地目检。

### P1-5 待批收件箱独立视图 + 桌面按 bot 隔离实测（2026-11-10，分支 feat/p1-5-inbox-view）

- 读模型：新增 `lib/approvals.mjs`。待批项不另存一份——`GET /api/approvals` 返回带
  writeIntent 且状态为 open / approved 的 Finding 的审批视图（id 与 findingId 同值），
  字段含 bot、repo、type、title、summary、evidenceUrl、suggestedAction、writeIntent
  全文（仓库由 repo 给出、正文与 PR 号在 writeIntent 里）、expiresAt、status。
  读列表时惰性清理：open 且已过 expiresAt 的 Finding 自动转 expired 并退出列表。
  `POST /api/approvals/:id/approve` 把 open 转 approved（已 approved 重复批准幂等返回；
  已关闭状态回 409；无 writeIntent 回 400；不存在回 404），`reject` 转 rejected；
  本切片批准只改状态，不执行任何对外写操作（网关在 P1-6 接入同一入口）。
- 界面：左栏「待批收件箱」改为打开独立整页视图（`web/src/Inbox.tsx`，与设置同模式、
  有返回路径），删除原底部展开面板与「雏形占位 / 后续迭代接入」等开发口吻文案。
  空状态为「现在没有需要你批准的写操作。」；有数据时每条卡片展示类型徽标、证据链接、
  建议、过期时间与「批准后将执行的写操作」参数块（仓库、PR 号、评论正文全文），
  批准后的提示文案如实写明「写入会经网关执行（网关接入后生效），当前尚未向 GitHub
  发送任何内容」，不声称已执行。左栏徽标计数改走同一列表。
- 桌面隔离修复：`Desktop.tsx` 的例程与产物改为按当前选中 bot 的 botId 过滤
  （此前是全量展示）——选中主 bot Piper 时不再出现仓库管家的「晨间仓库扫描」与日报，
  选中仓库管家时只含它的例程与产物；空状态文案改为「该 bot 暂无例程/产物」。
- 回归：脚本扩展至 56 项，`node scripts/regression.mjs` **56/56 通过**。其中第 23 项
  按切片授权改口径：从「恒为空数组」改成「来自真实存储且结构合法」（数组元素带
  findingId、writeIntent.kind=pr_comment、status ∈ open/approved；当前真实数据里
  尚无带 writeIntent 的 Finding，列表为空仍合法）；新增 53-56：未登录 GET 401、
  未登录 POST approve 401、不存在项批准/驳回均 404、例程与产物均带 botId。
  同批复跑：eval:scan 5/5、test-schedule 12/12、`npm run check` 无错误、
  `npm run build:web` 成功（bundle 含收件箱空状态文案）。
- 如实说明：当前扫描（P1-2）产出的 Finding 不带 writeIntent（建议先用规则模板、
  writeIntent 由 P1-6 的网关切片接上扫描模板），因此本切片交付时收件箱在真实数据
  下为空列表——这是切片预期的合法状态，契约与界面均已就绪，P1-6 合入后即有数据。
- 明确不做核对：未实现任何写仓库操作、未做网关判定；未改 `packages/`、未改 SSE
  事件名、未重做视觉。截图（收件箱空状态、主 bot 右栏隔离）本环境做不了，以构建产物
  文案断言 + 契约回归替代，留待用户本地目检。

### P1-6 薄网关 + PR 评论 + 正负审计实测（2026-11-10，分支 feat/p1-6-gateway-comment）

- 网关：新增 `lib/gateway.mjs`，是 apps/piper 层唯一能对外写副作用的入口，默认拒绝。
  唯一放行的写意图是 `pr_comment`。批准执行前逐条复检：Finding 存有 writeIntent；
  请求动作与 Finding.writeIntent 逐字一致（kind / prNumber / body）；种类为 pr_comment；
  目标仓在 bot 绑定仓内；状态为 approved（未经批准的直调一律 denied/not_approved）；
  未过期（过期顺手转 expired）；正文不含当前令牌。执行前再复检目标 PR 仍为 open
  （现查 GitHub）。凭证只经 `githubToken()`（L0-4 唯一入口）；无令牌回
  failed/no_token，明确失败、绝不假成功。成功后 Finding 转 executed 并返回评论链接；
  失败（PR 已关闭、写接口报错、无令牌）Finding 保持 approved、原因经审计进入收件箱
  的 lastError 展示，再次点批准即重试。
- 数据接线：扫描（P1-2 规则二）自本切片起给 pr_needs_review 附带规则模板 writeIntent
  （正文即模板评论，扫描本身仍全程只读、不发送）；扫描新开这类 Finding 时服务端逐条
  写 `approval.pending` 通知。批准成功写 `approval.executed` 通知并落一份
  `gateway-execution` 审计 artifact（写了什么、评论链接、证据、正文全文，进对应 bot
  的产物列表）；失败写 `approval.failed` 通知。驳回只改状态 + 审计 rejected，零写调用。
- 审计：新增 `lib/audit.mjs` 管 `data/audit.jsonl`（只追加）。executed 样例字段：
  `{ id, ts, botId: "repo-keeper", intent: { kind: "pr_comment", repo: "NorthAdb/LinkForge",
  prNumber: 42, bodyLength: 48, bodyPreview: "晨间分诊提醒：这个 PR 尚未获得任何批准…" },
  result: "executed", reason: null, findingId, approvalId（与 findingId 同值）,
  commentUrl: "https://github.com/NorthAdb/LinkForge/pull/42#issuecomment-4242" }`
  （此为替身测试中的真实记录形状）。`GET /api/audit?findingId=` 按 Finding 追溯。
  脱敏实测中抓到一个真问题：意图被拒（正文含令牌）时，审计的 bodyPreview 会把正文里
  的令牌原样落盘——已在 `summarizeIntent` 里对当前令牌做替换脱敏（bodyLength 仍记
  原长度），测试断言整个审计文件不含令牌全文。
- 测试：`node scripts/test-gateway.mjs` **15/15 通过**（fetch 替身计数 + 临时文件，
  不打活网）。拒绝路径 6 条：未批准直调 denied/not_approved（写 API 0 次）、意图
  篡改 denied/intent_mismatch、仓库未绑定 denied/repo_not_bound、手写 merge_pr 意图
  denied/unsupported_intent、正文含令牌 denied/secret_in_body、过期（open 批准回 409
  且转 expired；approved 过期 denied/expired）。执行路径 5 条：批准恰好发一次且参数
  （路径 / 正文 / Authorization）与批准内容一致并转 executed、无令牌 failed/no_token
  后补令牌重试成功、PR 已关闭 failed/pr_not_open 且 lastError 在收件箱可见、写接口
  500 failed/comment_failed 保持 approved、驳回零调用且已关闭再批准回 409。另有审计
  字段与脱敏断言、源码绕过断言（lib 与 server 中只有 gateway.mjs 构造 `/comments`
  写端点；scan / kernel / approvals / findings 无 GitHub POST 写调用）。
- 回归：脚本扩展至 58 项，`node scripts/regression.mjs` **58/58 通过**（新增 57-58
  为审计端点 401 与结构/过滤）。同批复跑：test-findings 18/18、test-scan 5/5、
  test-schedule 12/12、eval:scan 5/5、`npm run check` 无错误、`npm run build:web`
  成功（bundle 含「批准并执行」）。全部网关测试走替身，未对任何真实仓库发评论——
  真实写入的验收在 P1-7 试用切片。
- 明确不做核对：未做打标签 / 合并 PR / 改代码 / 自动合并；未接第二种写意图；网关
  未打进 `packages/`；未改 SSE 事件名。截图（待批详情）本环境做不了，以替身测试的
  参数断言 + 审计样例替代，留待 P1-7 真实试用时一并目检。

### R1 审批执行返工实测（2026-11-10，分支 fix/r1-approval-execution）

审计 B1 + M1 的收口：批准的是「看到的那段内容」，双击、双标签、网络重试、进程在发完
评论后崩溃，对同一待批项都只产生一条评论。先红后修（用例先行，红输出留档）：

- 先红（未改实现时）：`test-findings` **17/27**（合法迁移链走不通、writeIntent 可被
  updateFinding 改掉、7 条非法迁移全部未被拒、executing 未进枚举）；
  `test-gateway` **12/18**（正向正文无幂等标记、无 executing 审计、快照不符照样把
  改后正文发出去、文件篡改后带旧哈希照样批准、并发批准替身 POST **2 次**、崩溃
  重放再 POST 一次共 2 次）。与审计探针 P1/P2/P3 的结论一致。
- 状态机（`lib/findings.mjs`）：新增 `executing` 状态与显式迁移表，`updateFinding`
  强制：open→approved|rejected|expired；approved→executing|rejected|expired；
  executing→executed|approved（失败退回）；其余抛 409。`writeIntent` 移出可改字段
  （批准后内容以批准记录快照为准）。`deleteFinding` 核查无生产路径调用（仅单测用）。
- 批准记录（`lib/approvals.mjs`）：批准落 append-only 记录到 `data/approvals.jsonl`
  （`PIPER_APPROVALS_FILE` 可覆盖）：{approvalId, findingId, intentSnapshot{kind, repo,
  prNumber, body}, intentHash（SHA-256）, approvedAt}。`GET /api/approvals` 下发
  approvalId + intentHash；`POST …/approve` 必须带回 intentHash，不一致（或缺失，
  针对 open 项）回 409「内容已变，请重新查看」。重试沿用原记录（快照与 approvalId
  不变）。前端 Inbox 带回哈希并显示「执行中」状态。口径变化：审计里的 approvalId
  自本返工起是批准记录 id，不再与 findingId 同值；旧的 denied/intent_mismatch 改为
  denied/intent_changed。
- 网关（`lib/gateway.mjs`）：只执行快照——执行前拿快照与当前 writeIntent 逐字比对，
  不一致 denied/intent_changed（原「请求动作与存储自比对」已删除）。领取执行 =
  approved→executing 在同步段内完成（无 await 间隔），第二个并发批准在 approvals
  层回 409「正在执行」。领取后先写审计 `executing` 再出站；发评论前先 GET 评论列表
  查幂等标记 `<!-- piper:approval=<approvalId> -->`，已有则复用其链接记 executed、
  不再 POST；POST 正文 = 快照正文 + 标记。网络步失败统一 executing→approved 退回。
- 改绿（本分支）：`test-gateway` **18/18**（原 15 条场景按新契约保留并新增并发互斥
  ——替身 50ms 延迟下恰好 1 次写 + 1 条 executed 审计 + 另一个 409；崩溃重放——
  替身 POST 成功后抛错，再次批准靠标记查重、总写次数仍 1；篡改两路——带旧哈希
  批准 409、网关快照不符 denied/intent_changed）；`test-findings` **27/27**（迁移表
  全拒 + 合法链 + writeIntent 不可改）；同批复跑 test-scan 5/5、test-schedule 12/12、
  eval:scan 5/5、回归 **58/58**（条目数不变，approvals/findings 结构断言按新契约
  对齐：状态枚举含 executing、approvals 每条带 intentHash）、`npm run check` 无错误、
  `npm run build:web` 成功。
- 明确不做核对：未接第二种写意图；未做通用权限语言；未改 `packages/`；未改 SSE
  事件名；未做多用户审批。R2–R11 不在本 PR（时区校验、Origin、测试隔离、去重
  冷却与对账等均未动）。全部测试走替身，未对真实仓库发评论。

### R2 监听与跨源写入收口实测（2026-11-10，分支 fix/r2-listen-origin，堆叠在 R1 上）

审计 B2 的收口：默认安装不再把「可写 GitHub 评论 + 模型 Key 末四位可见 + 能触发
测试连接」的服务面暴露给局域网，跨站表单/脚本也打不进来。先红后修：

- 先红（未改实现时）：回归新增 R2 组（59–63）**59/63**——SameSite 还是 Lax、
  evil Origin 的 PUT 回 200、text/plain 的 PUT 回 200、12 次错口令全 401 无限速；
  新脚本 `test-listen` **2/6**——默认监听是 `*`（全接口）、`PIPER_HOST=0.0.0.0` +
  默认口令照常启动。与审计探针 P-HTTP-4/P-HTTP-6 的结论一致。红输出留档在
  仓库外 `~/workspace/piper-r2-red.log`，PR 描述中摘录。
- 监听（`server.mjs`）：新增 `PIPER_HOST`（默认 `127.0.0.1`），`listen` 显式绑定；
  未设 `PIPER_TOKEN`（默认口令）且监听地址非回环（127.0.0.1 / ::1 / localhost
  之外）→ 进程在做任何事之前 `exit(1)` 并在 stderr 写明原因与解法。启动日志保留
  口令来源提示；登录页删除「本地开发默认 piper-dev」文案，改为通用提示（构建
  产物已 grep 核对旧文案消失）。
- 写请求守卫：所有 `/api/` 写方法（POST/PUT/PATCH/DELETE）在路由分发前统一过
  一道——`Origin` 有则必须与 `Host` 同源（解析失败按跨源处理），不符 403；
  `Content-Type` 必须以 `application/json` 开头，不符 415。无 Origin 的非浏览器
  客户端（curl、脚本、回归）不受影响；同源 Origin 的 PUT 回归断言为 200 放行。
  会话 Cookie 改为 `SameSite=Strict`。
- 登录限速：内存态按来源（TCP 对端地址）计连续失败，超过 10 次锁定 60 秒，
  锁定期间登录一律 429（正确口令亦然），登录成功清零。回归口径与返工稿验收
  一致：连续 11 次错口令均 401、第 12 次 429。
- 改绿（本分支）：回归 **63/63**（58 基线 + R2 组 5 项，只增不减）；`test-listen`
  **6/6**（默认 ss 实查 127.0.0.1、非回环 + 默认口令拒绝启动且退出码非 0 且输出
  含原因、非回环 + 显式口令监听 0.0.0.0）；同批复跑 test-findings 27/27、
  test-gateway 18/18、test-scan 5/5、test-schedule 12/12、eval:scan 5/5、
  `npm run check` 无错误、`npm run build:web` 成功。回归起 server 的方式与新默认
  监听天然兼容（本来就连 127.0.0.1 且显式设了 PIPER_TOKEN），无需适配改动。
- 明确不做核对：未做账号体系 / OAuth / 多用户；未做 HTTPS 终止（交给反代）；
  未碰 R3 的时区保存校验与调度防崩、未碰 R4 测试隔离、未碰 R5 及以后；返工稿
  建议随 R2 一并做的 R7「测试接口不外送已保存 Key」未在本 PR 做（保持单一
  主题），留 R7 处理。未改 `packages/`；未改 SSE 事件名。

### R3 时区校验与调度防崩实测（2026-11-10，分支 fix/r3-timezone-scheduler，堆叠在 R2 上）

审计 B3 的收口：一个时区错别字不再能让常驻进程「启动即崩且界面里修不好」。先红
后修（用例先行，红输出留档在仓库外 `~/workspace/piper-r3-red.log`，PR 描述摘录）：

- 先红（未改实现时）：新脚本 `test-badtz` **0/4**——把 `settings-profile.json` 的
  时区手改成 `Foo/Bar` 后启动，进程 exit=1，栈为启动 tick 里
  `RangeError: Invalid time zone specified: Foo/Bar`（与审计 `logs/15-bad-tz-restart.log`
  一致）；回归新增 R3 组后 **64/66**——`PUT /api/settings/profile {"timezone":
  "Foo/Bar"}` 回 200 且坏值真落盘（64/65 红），合法时区保存的守卫项 66 绿；
  `test-schedule` 新增 2 条后 **12/14**——`timezoneFn` 抛错时 `tick` 直接把异常抛给
  调用方（server 侧是 `void tick(...)`，即 unhandledRejection 杀进程的路径）。
- 保存校验（`lib/settings.mjs`）：新增 `isValidTimezone`（以 `Intl.DateTimeFormat`
  试构造为准）；`saveProfileSettings` 对非空时区先校验，非法抛 400 且不写文件。
  `readProfileSettings` 对存量文件里的非法时区回落缺省 `Asia/Hong_Kong` 并按坏值
  去重、只在日志提示一次（文件不改写，设置页保存一次即可修好）。
- 调度防崩（`lib/schedule.mjs` + `server.mjs`）：`createScheduler` 的 `tick` 整体
  包一层 try/catch——规划/推进阶段抛错时复位 `running`、经新增 `onError` 钩子通知
  并返回 `{action:"error"}`，绝不抛给调用方；server 侧钩子记日志并落一条
  `routine.failed` 通知。`server.mjs` 另加 `process.on("unhandledRejection")`，
  只记日志不退出，作为常驻进程的底线兜底。
- 前端（`SettingsProfile.tsx`）：时区从 7 项 datalist 改为全量 IANA 下拉
  （`Intl.supportedValuesOf("timeZone")`，shadcn Select），另保留手动输入框
  （填了优先）；提交前先校验，非法时给出提示且不调用保存接口。不在下拉列表里
  的存量值会进手动输入框，让用户看得见、改得掉。
- 改绿（本分支）：回归 **66/66**（63 基线 + R3 组 3 项，只增不减）；`test-schedule`
  **14/14**（12 基线 + 2：tick 不抛 + onError 一次、无 onError 亦不抛；恢复后调度
  未楔死、到点真正执行）；`test-badtz` **4/4**（坏文件启动存活、日志含回落提示、
  `/api/schedule/status` 回缺省时区、从设置接口 PUT 合法时区后调度状态随之更新）；
  同批复跑 test-findings 27/27、test-gateway 18/18、test-scan 5/5、test-listen 6/6、
  eval:scan 5/5，`npm run check` 无错误、`npm run build:web` 成功。
- 明确不做核对：未做每 bot 独立时区；未引入调度库；未碰 R4 测试隔离、未碰 R5
  及以后；未改 `packages/`；未改 SSE 事件名。
