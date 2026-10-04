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
- 冒烟测试 20 组（假宿主，忠实复刻宿主 `paginate` 与子 agent 围栏语义）。

### 注意
- 已知限制：子 agent 会话**不可被回问**（宿主有归属围栏），只能翻它的日志；
  要它的活结论必须通过它的主对话。
- 需要宿主支持 `sessionController.page` / `projections` 的 `AbortSignal` 参数语义。
- **已存在的对话看不到新装的工具**：DSH 按会话落盘复用系统提示词（含工具清单），
  想用本插件请**开新对话**。装完或升级后还需**重启 DSH**（插件代码/配置不热重载）。
- 启动后约 20 秒内 `sessionController` 未就绪，该窗口内新建的会话可能看不到跨对话工具。

### 修复（第 3 次真机复验后，于第 4 次重启验证通过）
- `conversation_search` 的渲染补上 `scannedRange`（0 命中与有命中两种情况都给出实际扫描
  范围与"是否到会话开头"），与 `context`/`outline` 一致。
- **回问的 `trust` 不再被非真人消息误判**：`<goal_round>`、模型切换提示等也是 user 角色消息，
  原先一律算作"并发输入"，导致 `trust` 几乎恒为 `unknown`，等于废掉"先回问拿结论"这条首选路。
  现在只有 `source.kind === 'user'`（真人输入）才算并发噪声。
- 假宿主纠正保真度：子 agent 围栏只在 `page` 上，`projections`/`inspect` 能读。
- 交接提醒文案改为工具无关：`conversation_handoff_write` 不可见时（本会话提示词冻结于安装之前）
  改用惯用的写文件工具写到 `handoffDir`，并在提醒里给出真实目录。

### 修复（第 2 次真机验收后）
- **工具输出必须无损 JSON**：缺 `rpcId` 的 user 消息曾写入 `undefined`，导致
  `conversation_read` 在含人类消息的页上 **100% 返回 `value is not lossless JSON`**、
  整页作废。现在所有工具输出统一过 `jsonSafe()`，且缺省字段不写键。
- **子 agent 会话改用 `{kind:'subagent', parentSessionId, mode}` 地址读取**（原先一律按
  `{kind:'session'}` 被宿主拒绝）；`mode` 未知时自动试探。`read`/`context`/`outline`/`search`
  均可选传 `parentSessionId` / `mode`。占用投影对子 agent 读不到时如实报 `available:false`。
- **`atSeq` 改为精确**：指到非消息事件时报错并给出附近可读 seq，不再静默返回别的位置。
- **`scannedRange`**：`context` / `outline` / `search` 报告实际扫到的 seq 范围与是否到会话开头，
  避免把"这段没扫到"误读成"从没压缩过"；`head` 为空时用 checkpoint 正文回填。
- **交接件回读不再强制带 `cwd`**：写入返回的绝对路径可直接回读（仍拒绝插件目录之外的路径）。
- **`conversation_list` 渲染带上总数**，被 `limit` 截断时明确提示。
- **`conversation_ask` / `conversation_read` 渲染补齐**：`accepted` / `askDepth` / 预计占用 /
  `answered` / `reason` / 定位 seq / 窗口内压缩点 —— 模型只能看到渲染文本，结构化字段必须可读。
- **`conversation_start` 按 workspace 归组**（见下）：不再落到"未分组"。

### 修复（第 1 次真机验收后）
- **冷启动时工具被静默跳过**：`apply` 里用 `ctx.get('sessionController')` 探测可用性，
  而该服务在应用启动后约 18 秒才就绪 ⇒ 9 个工具一个都没注册（entry 却显示
  `fiberPhase: active`）。改用 `ctx.inject([...])` 等服务就绪再注册，并让不依赖会话服务的
  本地工具立即注册。
- `conversation_start` 改为先按工作目录 `resolveByPath` 解析 workspace 再传 `workspaceId`；
  只传 `cwd` 会落到"未分组"。
