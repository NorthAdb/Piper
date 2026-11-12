# Piper 基座（BASE）

Piper 基于开源项目 **Pi** 的源码进行二次开发（不是 SDK 嵌入，是源码级基座，后续会直接改造 pi-agent-core 内部）。

## 锁定版本

- 上游：https://github.com/earendil-works/pi
- 版本：**v1.5.1**
- 上游 commit：`dd30101cfc5b0609411dd80b6f93adbc14db14cf`
- 锁定日期：2026-11-10
- 导入方式：以该 tag 的源码树作为本仓第一笔提交整体导入；上游许可证 MIT，见根目录 LICENSE（上游原文）。

## 规矩

- 不自动跟随上游：升级一律人工评估后拣选合并，并在此文件更新锁定记录。
- 基座原有文件尽量少改；改造优先落在我们自己的新包里，必须改基座内部时在提交信息里注明原因。
- 本仓自有代码与上游代码的区分以包为界：`packages/` 下上游原有包为基座，我们新增的包会在各自 README 里注明。

## CI 精简（2026-11-10）

- `.github/workflows/` 只保留 `ci.yml`（上游 CI 本体：push main / PR 时构建检查，在本仓一直通过且后续内核改造需要它）。
- 删除其余 14 个上游 workflow：发布机器（preview-packages、publish-model-catalog、p2-cloud-bundle、build-binaries、env、env-daemons、nix——依赖上游 Earendil 的密钥与发布基础设施，在本仓必然失败或与本项目无关）、社区治理（issue-gate、pr-gate、approve-contributor、issue-triage-labels、issue-analysis、remove-inprogress-on-close——上游按贡献者名单把关的机制，单人项目不用）、定时审计（npm-audit，需要时本地跑即可）。
- 删除内容都在 git 历史里，需要时可找回；后续如需 Piper 自己的 CI（如 apps/piper 的 check + 冻结夹具评测），按本项目需要新写，不恢复上游文件。

## 事后追认说明（应 PA—design 审计要求补记，2026-11-11）

上面「CI 精简」一节记录的删除（提交 `ba67176`，删 14 个上游 workflow、只留 `ci.yml`）**不在第零层与第一件的切片计划内**，是计划外改动，在此补记决策过程，请 PA—design 在 R8 复审时一并追认：

- 起因：用户（萧北）在 2026-11-10 的对话中提出，上游 Pi 的 CI 每次推送都报错、且报错与本仓代码无关，询问是否要调整。
- 评估：实施方（Muse）实查了仓库的 Actions 运行记录与全部 15 个 workflow 的触发条件，结论是只有 `ci.yml` 本体在每次推送时真正通过且对本仓有用；其余 14 个或依赖上游 Earendil 的发布基础设施与密钥（在本仓必然失败）、或是上游的社区治理与定时机器（对单人项目无用），据此建议只保留 `ci.yml`、删除其余 14 个。
- 批准与执行：用户在对话中明确批准该建议后，实施方才执行删除，并把删除清单与理由写入上面「CI 精简」节。
- 本说明只补记过程，不改动那次删除本身；如审计不予追认，恢复哪些 workflow 由审计意见决定，实施方按意见另行处理。

## 基座内部改动记录

- 2026-11-12（第二件 P2-1，分支 feat/p2-1-tool-approval）：首次改 `packages/agent` 内部。改 `src/types.ts`、`src/agent-loop.ts`、`src/agent.ts`：工具调用在循环内走「提议 → 预检 → 允许 / 拒绝 / 挂起待批 → 恢复执行」状态机（`BeforeToolCallResult.decision`、事件 `tool_approval_pending`、`Agent.resolveToolCall`）。原因：未批不执行、执行事件只在真正执行前发出、重启后凭 transcript 恢复，这三条保证在宿主侧拦截无法成立，必须落在循环的 prepare 与 execute 之间。策略、工作区与 GitHub 写入不进基座，仍在 `apps/piper`。验收：`packages/agent/test/tool-approval.test.ts`（新增）+ 既有 agent 套件全绿，根级 `npm run check` 通过，CI 以 PR 的 `upstream-suites` 为准。
