# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased] · 0.1.0（未发布）

首个公开版本。按 `DESIGN.md` 的 v2 设计实现。

### 取数通道
- **回问优先**：`conversation_ask` 向另一个对话提问（窄指令 + `askId`），
  返回事前读数（对方占用、预计压缩风险）；`conversation_read` 用 `askId` 读答复。
- **可信度是回问的副产品**：`trust` 四态（`clean` / `compacted_by_ask` /
  `compacted_earlier` / `unknown`），用 `rpcId` 精确定位"自己问的那一条"来判定窗口，
  不需要事前记游标。
- **翻旧书回退**：`conversation_outline`（Tier-0 目录）→ `conversation_search`
  （Tier-1 检索，含被压缩掉的工具结果）→ `conversation_read`（`atSeq` 取原文块，Tier-2）。
  全程只读，**不唤醒对方**。
- **交接件自持落盘**：`conversation_handoff_write` 写固定四段（缺段/过短直接拒绝），
  `conversation_handoffs` 读目录页或全文。**不维护索引文件**（目录即索引）。
- **水位提醒**：上下文占用越阈值时注入一条提醒，指路"写交接件 → 开新对话"，
  带武装/回落/冷却与交接后静默窗口。

### 工程
- **零第三方依赖**：只用 Node 内建模块；配置手写校验。
- **服务缺失即降级**：没有 `sessionController` 时工具不注册但插件仍加载，只保留交接件能力。
- **护栏**：回问深度上限、环路禁止、同对冷却、全局频率；状态在插件内推导，
  不依赖模型自觉传参。
- 冒烟测试 16 组（假宿主，忠实复刻宿主 `paginate` 语义）。

### 注意
- 已知限制：子 agent 会话**不可被回问**（宿主有归属围栏），只能翻它的日志；
  要它的活结论必须通过它的主对话。
- 需要宿主支持 `sessionController.page` / `projections` 的 `AbortSignal` 参数语义。
