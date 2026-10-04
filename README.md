# dsh-conversation-bridge

> **只管"交接"这一个问题的 DSH 插件。** 把一个对话交给下一个对话，并让下一个对话**能回问、也能翻回原文**。
>
> 零第三方依赖 · 不与任何记忆插件集成 · 服务缺失即降级

---

## 它解决什么

上下文会满，满了会压缩。压缩把"模型可见的表面"换成一段摘要——**原文留在日志里，但模型再也看不见了**。

于是新对话接手时只有一份有损的摘要：为什么这条路走不通、哪个报错才是真因，全丢了。
而"回旧对话问一句"看起来能救场，却会给旧对话**加压**：多一轮输入，可能正好把它推过压缩线——
**问题本身制造了新的丢失**。

本插件给新对话三条取数通道，并且每一条都**说清拿到的东西可信到什么程度**：

| 通道 | 拿什么 | 代价 | 定位 |
|---|---|---|---|
| **回问** `conversation_ask` | 旧对话**现在综合后**的结论；还能借它的手调度它名下的子 agent | 唤醒 +1 轮，可能触发压缩 | **首选** |
| **翻旧书** `conversation_outline/search/read` | 旧对话**持久日志原文**，含被压缩掉的工具结果与弯路 | **零唤醒**，只烧自己的上下文 | **回退底线** |
| **交接件** `conversation_handoff_write/handoffs` | 交接时固化下来的四段结论 | 零 | 起点 |

**为什么回问优先仍然安全**：因为可信度是回问的**副产品**——
`conversation_read` 会告诉你这一问是否把对方推过了压缩线（`trust`），而不是让你盲目相信。

---

## 边界（重要）

- ❌ **不接入、不探测、不提及任何记忆插件**。你装没装记忆系统、装的是哪个，与本插件无关；
  记忆插件有自己的运转与自维护手段，不需要我们接入。
- ❌ 不做记忆系统、不做向量检索、不建归档副本、不做会话归档。
- ✅ 它**只**关心两件事：**自己要留存的东西**（交接件）与**自己要去的地方**（宿主会话日志）。
- ✅ 产物只有一个：`handoff-*.md` 交接件（固定四段）。

---

## 安装

需要已经能跑的 DSH（`dsh web` 或 Desktop 版）。

### 用插件页装（推荐）

在 **插件 → 添加插件** 里填 `dsh-conversation-bridge` 安装并启用，然后**重启 DSH**。

### 用 CLI

```sh
dsh plugin --profile <你的profile> add dsh-conversation-bridge
# 然后重启 dsh
```

> **改配置或换代码都需要重启才生效**

### 交给 AI 装

```text
在 DSH 的 profile 里安装并启用 dsh-conversation-bridge，然后重启 dsh。
```

---

## 工具一览（9 个）

| 工具 | 只读？ | 用途 |
|---|---|---|
| `conversation_list` | ✅ | 列出对话，可按 `parentSessionId` 展开子 agent 子树 |
| `conversation_context` | ✅ | 占用（token/窗口/百分比）+ 历史压缩点；标注来源 `live`/`cached` |
| `conversation_ask` | 唤醒 | 回问；返回 `askId`、事前读数、压缩风险 |
| `conversation_read` | ✅ | 读答复（带 `trust`）／按 `atSeq` 取原文块 |
| `conversation_outline` | ✅ | 旧书目录：按轮一行，标压缩点与工具失败 |
| `conversation_search` | ✅ | 旧书检索：关键词 AND、角色过滤、预算截断 |
| `conversation_start` | 写 | 开新对话并投递交接件（**唯一开窗入口，不自动开**） |
| `conversation_handoffs` | ✅ | 交接件目录页／全文 |
| `conversation_handoff_write` | 写 | 写交接件（固定四段，缺段或过短会被拒） |

### 典型接力流程

```text
老对话 A：占用到 70% → 插件提醒 → 写交接件 → conversation_start 开新对话 B
新对话 B：
  ① conversation_ask(A, "上次那个报错的根因是什么")
     → conversation_read(A, askId)  → trust=clean 就直接用
  ② 若 trust=compacted_by_ask（这一问把 A 推过线了）或 A 答不上来：
     conversation_outline(A) → conversation_search(A, "EADDRINUSE")
     → conversation_read(A, atSeq=命中位置)  取原文
```

---

## 配置

改 profile 里同一 `id` 的行即可，插件内部会与默认值逐字段合并（你只写要改的字段）：

```yaml
- id: conversation-bridge
  config:
    exposeTools: true
    ask:
      maxDepth: 3              # 回问链最大跳数
      pairCooldownMs: 600000   # 同一对会话的最小间隔
      globalPerMinute: 30      # 全局限流
      defaultMode: queue       # queue | steer
      narrow: true             # 包成窄指令（只回答、不复盘、不重做）
      replyAllowanceTokens: 1500
    archive:
      maxScanEvents: 3000      # 单次扫描事件上限
      maxHits: 20
      maxBlockChars: 2400      # 单块最大字符
      outlineMaxTurns: 50
      includeToolResults: true # 读取包含工具结果（压缩最容易丢的就是它）
      pageSize: 30
      maxPages: 8
      listLimit: 30
    handoff:
      enabled: true
      threshold: 0.7           # 占用到 70% 提醒（宿主压缩线通常 0.80）
      rearmBelow: 0.55
      cooldownMs: 600000
      handoffQuietMs: 1800000  # 交接后本对话静默多久
      deliver: steer
      skipSubagents: true
      toolEnabled: true
      dir: ""                  # 空 = <会话 cwd>/.dsh-conversation-bridge/handoffs/
      minSectionChars: 40      # 每段最小长度，不达标拒绝写入
      sections: ["任务状态", "目标", "已试方案与失败原因", "进度与下一步"]
```

---

## 实现要点

- **只读路径绝不唤醒对方**：只用宿主的 `list` / `inspect` / `page` / `projections` 四条只读通道，
  代码里任何地方都不出现 `resolveAgent`；冒烟测试里放了间谍把这条钉死。
- **可信度用 `rpcId` 定位**：`prompt` 会把我们的 `requestId` 写成日志里的 `source.rpcId`，
  于是"窗口起点"不需要事前记游标，`compacted_by_ask` 的判定可以精确到 seq。
- **压缩点可识别**：`compaction/summary` 带 `shadowedRange`，checkpoint 是带
  `surfaceOp:{op:'replace'}` 的 `user/message`；读到 checkpoint 会标成
  `[压缩摘要 seq=N，覆盖 seq=A..B；原文仍可翻]`，避免把摘要误当原始事实。
- **护栏在插件内**：回问深度、环路、冷却、频率由插件自己维护的有向图推导，**不靠模型传参**。

完整设计与已核验的宿主机制（带证据）见 [`DESIGN.md`](./DESIGN.md)。

---

## 已知行为（不是缺陷，但会让人困惑）

- **装完/升级后必须重启 DSH**；插件代码与配置的改动都**不会热重载**。
- **已存在的对话看不到新装的工具**：DSH 把系统提示词（含工具清单）按会话落盘复用，为前缀缓存稳定而
  原样重建。所以想用本插件的工具，请**开一个新对话**——旧对话不会因为重启而获得它们。
- **启动后约 20 秒内**，`sessionController` 服务尚未就绪，那段时间新建的会话可能看不到
  跨对话的 7 个工具（本地交接件读写不受影响）。
- 子 agent 会话**不能回问**（宿主归属围栏），只能翻它的日志；要它的活结论请通过它的主对话。
- 子 agent 会话的**上下文占用可能读不到**（宿主对该投影的限制），此时 `conversation_context`
  会如实报 `available:false`。

---

## 开发

```sh
node test/smoke.mjs   # 20 组断言，假宿主，忠实复刻宿主 paginate 与子 agent 围栏语义
```

零依赖、无构建步骤：`lib/host.js`（只读宿主适配）、`lib/scan.js`（纯函数扫描）、
`lib/handoff.js`（交接件落盘）、`index.js`（配置 + 工具 + 装配）。

## License

MIT
