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
