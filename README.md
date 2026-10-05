# dsh-conversation-bridge

> **只管"交接"这一个问题的 DSH 插件。** 把一个对话交给下一个对话，并让下一个对话**能给它发消息/回信、也能翻回原文**。
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
| **跨对话发消息** `conversation_send` | 旧对话**现在综合后**的结论；还能借它的手调度它名下的子 agent；也能反过来回信/反问它 | 唤醒 +1 轮，可能触发压缩 | **首选** |
| **翻旧书** `conversation_outline/search/read` | 旧对话**持久日志原文**，含被压缩掉的工具结果与弯路 | **零唤醒**，只烧自己的上下文 | **回退底线** |
| **交接件** `conversation_handoff_write/handoffs` | 交接时固化下来的四段结论 | 零 | 起点 |

> 跨对话消息在对方日志里是 `user` 角色（宿主限制），所以本插件给投递的 `rpcId` 加 `bridge-` 前缀：
> 装了本插件的收信方据此把它识别为「插件输入」，不会误当成真人插话而把 `trust` 打成 `unknown`。
**为什么发消息优先仍然安全**：因为"答没答完"和"可不可信"都是**副产品**——
`conversation_read` 用 `answered` 告诉你它答完没有，用 `trust` 告诉你这一问是否把它推过了压缩线，而不是让你盲目相信。

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
| `conversation_send` | 唤醒 | **唯一的管道工具**：提问 / 回信 / 反问 / 只通知；默认插入到对方下一步；返回 `messageId`、事前读数、压缩风险 |
| `conversation_read` | ✅ | 读答复（先看 `answered` 再看 `trust`）／按 `atSeq` 取原文块 |
| `conversation_outline` | ✅ | 旧书目录：按轮一行，标压缩点与工具失败 |
| `conversation_search` | ✅ | 旧书检索：关键词 AND、角色过滤、预算截断 |
| `conversation_start` | 写 | 开新对话并投递交接件（**唯一开窗入口，不自动开**） |
| `conversation_handoffs` | ✅ | 交接件目录页／全文 |
| `conversation_handoff_write` | 写 | 写交接件（固定四段，缺段或过短会被拒） |

### 典型接力流程

```text
老对话 A：占用到 70% → 插件提醒 → 写交接件 → conversation_start 开新对话 B
新对话 B：
  ① conversation_send(A, "上次那个报错的根因是什么")
     → conversation_read(A, messageId=上面的 messageId) → answered=true 且 trust=clean 就直接用
  ② 若 answered=false（它还在跑/还没答）就稍后再读；若 trust=compacted_by_ask（这一问把 A 推过线了）：
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
      globalPerMinute: 30      # 全局限流
      defaultMode: steer       # steer = 插进对方下一步（默认）| queue = 等它本轮跑完
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
- **只做防呆，不设门禁**：跨对话发消息是一条**纯管道**（对标宿主自己的 `send_message`）——
    没有冷却、没有环路检测、没有深度上限。任意多轮协作都畅通；只留一个全局频率（每分钟 30 条）
    挡代码死循环。防滥用交给调用方的判断与你在界面上的可视干预。

完整设计与已核验的宿主机制（带证据）见 [`DESIGN.md`](./DESIGN.md)。

---

## 已知行为（不是缺陷，但会让人困惑）

- **装完/升级后必须重启 DSH**；插件代码与配置的改动都**不会热重载**。
- **已存在的对话看不到新装的工具**：DSH 把系统提示词（含工具清单）按会话落盘复用，为前缀缓存稳定而
  原样重建。所以想用本插件的工具，请**开一个新对话**——旧对话不会因为重启而获得它们。
- **启动后约 20 秒内**，`sessionController` 服务尚未就绪，那段时间新建的会话可能看不到
  跨对话的 7 个工具（本地交接件读写不受影响）。
- **投递围栏（宿主规则，插件绕不过）**：会话本身是子 agent，或它正被一个**活着的子 agent**持有，
  宿主都拒绝投递。插件会提前拦住第一种，并把宿主那句 `owned by subagent routing`
  翻译成"等它那个子 agent 跑完再来投 / 改用只读翻书"；第二种（它自己正在跑子 agent）
  同样投不进去——这是宿主的安全规则，不是插件的 bug。
- 子 agent 会话的**上下文占用可能读不到**（宿主对该投影的限制），此时 `conversation_context`
  会如实报 `available:false`。
- **跨对话消息在 GUI 里长什么样，取决于宿主版本**：插件投递时会声明来源
  （`agent-message` 中继 / 本插件的 `notice`），**认这个声明的宿主**会把它渲染成
  "来自会话 X 的中继消息"或一行注入提示；**不认的宿主**会忽略该字段，消息按用户消息显示
  （此时靠 `bridge-` 前缀把它和真人插话区分开，功能不受影响）。
  本机让宿主认这个声明需要打一次宿主补丁，见 `DESIGN.md` §7.3 与 `tools/host-prompt-source-patch.mjs`。
- **`conversation_start` 的首条消息仍然是"用户消息"**（故意）：那是"用户开了一个新对话并贴进交接件"，
  会话标题与列表排序都依赖它是一条用户提示词。
- **投递范围只限交接双方**（产品边界，见 `DESIGN.md` §7.4）：`conversation_send` 只能发给
  "你用 `conversation_start` 拉起的对话"或"拉起你的那个对话"；与无关对话互投会被拒绝（两个方向都拒）。
  **只读工具不受限**——`conversation_read` / `outline` / `search` / `context` / `list` 依然能读任意对话
  （边界只画在"投递"上：投递会打扰对方、耗对方上下文；读不会）。
  - 交接关系记在插件自己的账本里（默认 `~/.dsh-conversation-bridge/lineage.json`，配置项 `lineage.file`），
    `conversation_start` 成功时自动记一条边。
  - **升级到本版本之前的旧搭档之间没有这条边**：第一次投递会被拒；按错误话术用 `conversation_start`
    再开一次窗即可，或手工往账本里补一条 `{"opener":"session-a","child":"session-b","at":0}`。

---

## 开发

```sh
node test/smoke.mjs   # 20 组断言，假宿主，忠实复刻宿主 paginate 与子 agent 围栏语义
```

零依赖、无构建步骤：`lib/host.js`（只读宿主适配）、`lib/scan.js`（纯函数扫描）、
`lib/handoff.js`（交接件落盘）、`index.js`（配置 + 工具 + 装配）。

## License

MIT
