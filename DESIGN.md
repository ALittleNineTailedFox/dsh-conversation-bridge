# dsh-conversation-bridge · 设计文档

> 版本：v2 设计（回问优先）
> 日期：2026-10-04
> 位置：`<仓库根>\DESIGN.md`
> 状态：**设计定稿，等待开工**（尚未按本设计改代码；当前工作区代码是 v1 实现）

---

## 0. 接续须知（给下一个接手的会话，先读这一节）

### 0.1 一分钟现状

- 本目录已有一个**可运行的 v1 插件**（`index.js`），已装进 desktop profile（`link:` 挂载），注册了 5 个工具。
- **v1 与本文档的差距**：v1 是"发消息/读最近 N 条"，**没有**只读全量检索、没有可信度读数、没有护栏、`conversation_context` 还会误唤醒对方；而且**依赖外部记忆插件**（已按本篇去掉）。
- **源码已修、线上未装**的一个 bug：`sessionController.prompt` 漏传 `AbortSignal`（详见 §3.2）。
- **另一处 v1 隐藏失效**：`conversation_read` 用了 `throughSeq: -1` ⇒ 永远空页（详见 §3.4），重写时必须改。
- **配置改动/代码改动都需要重启 DSH 才生效**（`install_bundle` 对已装包返回 `restart-required`）。所以设计阶段不要在"调参数看效果"上耗时间。

### 0.2 权威事实在哪里

本文档 **§3「已核验的宿主机制」** 是全部结论的事实来源，每条都带证据（文件 + 行号或实测报错）。**改代码前先读 §3，不要重新去猜/重新去查。**

### 0.3 下一步

按 **§9 实施计划** 从 **P0** 开工。每完成一个阶段，回来把 §9 的复选框打勾、并把"§10 进度与未落账"更新一行。

### 0.4 铁律（本项目的决策约束）

1. **零硬依赖，裸机可跑**：只依赖 DSH 宿主自带的服务（工具注册、会话控制、Agent 注册表、会话投影）。
   **不依赖任何第三方包，也不假定任何其它插件存在**（§2.2）。宿主服务缺失时**降级**，不是崩溃。
2. **职责单一：只管"交接"这一个问题**。本插件**不接入、不探测、不指路、不依赖任何记忆插件**（§2.2）；
   它只关心**自己要留存的东西**——交接件由本插件自持落盘（§8.2），会话日志只读。
   用户装了什么记忆系统、它怎么自维护，与本插件无关。
3. **回问优先，翻书回退**（§4.1）。
4. **只读路径绝不唤醒对方**（§3.1）——这是"不加压"的技术底线。
5. **所有返回都有硬上限**（条数/字符/扫描事件数），否则防丢的手段会先把新对话自己撑爆。
6. **护栏状态放插件内，不靠模型自觉传参**（§7）。
7. **可独立发布**：公共包名 / 版本 / 许可 / README / CHANGELOG 齐备，`private` 关掉（§14）。

---

## 1. 背景与目标

### 1.1 要解决的问题

DSH 会话的上下文会满。满了会压缩（compaction），压缩把"模型可见表面"换成一段摘要——
**原文留在日志里，但模型再也看不见了**。于是：

- 新对话接手时，只能拿到上一段对话**写下来的交接件**（有损摘要）；
- 交接件没写到的细节（尤其是工具结果、失败原因、走过的弯路），**当场消失**；
- 而"回到旧对话去问一句"这件事看起来能救场，但它**会给旧对话加压**：多一轮输入，
  可能正好把它推过压缩线，于是**问题本身制造了新的丢失**。

### 1.2 目标

让新对话有**三条取数通道**，且知道每条通道拿到的东西**可信到什么程度**：

| 通道 | 拿什么 | 代价 | 定位 |
|---|---|---|---|
| **回问**（ask） | 旧对话**现在综合后**的结论；还能借它的手调度它名下的子 agent | 唤醒 +1 轮，可能触发压缩 | **首选** |
| **翻书**（archive） | 旧对话**持久日志原文**，含被压缩掉的内容 | 零唤醒，烧**自己**的上下文 | **回退底线** |
| **交接件**（handoff） | 交接时固化下来的四段式结论（**本插件自持落盘**，不依赖任何记忆插件） | 零 | 起点 |

### 1.3 非目标（明确不做）

> **本插件只解决"交接"这一个问题。** 用户装没装记忆插件、装的是哪一个，与本插件无关。

- ❌ 不做记忆系统（不自建向量检索、长期记忆库、Provider 体系、记忆空间）。
- ❌ **不与任何记忆插件集成**：不探测、不指路、不写入、不读取、不提及。记忆插件有它自己的
  运转与自维护手段，不需要我们接入（§2.2）。
- ❌ **不依赖任何特定插件**：没有任何记忆插件时，本插件必须完整可用。
- ❌ 不 import 任何第三方包（`@deepseek-ai/schemastery` 之类的宿主 shim 也不 import，配置手写校验）。
- ❌ 不做自动压缩/自动开窗（宿主的地盘；我们只**提醒 + 给人确认**）。
- ❌ 不做跨对话的实时流式通信。
- ❌ 不自己持久化任何归档副本（旧对话日志就是归档，见 §3.3）；自持的只有交接件（§8.2）。

---

## 2. 全景

### 2.1 组件关系

```
                    ┌──────────────────────────────────────────┐
                    │ 新对话 B（接手方）                        │
                    │  · conversation_send   → 回问优先          │
                    │  · conversation_read  → 答复 + 可信度      │
                    │  · conversation_outline/search/read(atSeq)│
                    │  · conversation_context（只读占用）        │
                    └───────────────┬──────────────────────────┘
                                    │
        ┌───────────────────────────┼────────────────────────────┐
        │                           │                            │
        ▼                           ▼                            ▼
┌───────────────┐        ┌────────────────────┐        ┌──────────────────┐
│ 旧对话 A      │        │ A 的持久会话日志    │        │ A 的子 agent 树   │
│ （主 agent）  │        │ （= "已经合上的旧书"）│        │ C/D/...          │
│               │        │                    │        │                  │
│ 可被回问 ✔    │        │ 只读可翻 ✔          │        │ 只读可翻 ✔        │
│ 可调度子agent │        │ 压缩只换表面不删原文 │        │ **不可被回问 ✘**  │
└───────────────┘        └────────────────────┘        └──────────────────┘
        │
        │ 结论沉淀（自持产物，零依赖）
        ▼
┌──────────────────────────────────────────────────┐
│ 交接件目录（本插件自持落盘，唯一的可变产物）          │
│  · handoff-*.md = 固定四段：任务状态 / 目标 /       │
│                  已试方案与失败原因 / 进度与下一步    │
│  · 目录本身即索引（读时扫目录，不维护 index 文件）    │
└──────────────────────────────────────────────────┘
        （除此之外，本插件不写任何地方；记忆层归别人，不管、不接、不提）
```

**为什么自持交接件文件而不是只靠会话日志**：会话是**可能被归档甚至删除**的（部署可能开了
自动归档/自动删除），而交接件是**结论层**，必须活得比会话久。会话日志（细节层）永远最新、
零成本，两者互补而不是重复（§8.2）。

### 2.2 独立发布原则（本项目的第一约束）

> **本插件是一个可独立发布的项目，不是一个对别的东西充满依赖的定制产品。**

| 原则 | 具体要求 |
|---|---|
| **零第三方依赖** | `dependencies` 为空。只用 Node 内建模块（`node:crypto` 等）。不 import `@deepseek-ai/*`，配置手写校验 |
| **宿主服务缺失即降级** | 只用宿主服务，且每个都可缺省：缺 `sessionController` → 跨对话工具不注册但插件仍加载；缺 `sessionProjections` → 占用走 `tokenMeter` 兜底；两者都缺 → 只保留交接提醒的文件落盘 |
| **职责单一** | 只解决交接：把"该留下的"落成**自持交接件**，并让下一段对话能把它拿回来。别的问题不碰 |
| **不假定别的插件** | 任何记忆插件的名字都不写进逻辑与文案；**不探测、不指路**（与记忆层零耦合） |
| **不写别人的地盘** | 不注册新投影、不追加自定义 Session 事件类型、不改宿主的压缩/归档策略 |
| **配置自洽** | 所有可调项在本插件自己的 Config 里；改配置不需要动别的插件，也不需要动 profile |

### 2.3 分层：各自拥有什么

| 层 | 谁拥有 | 内容 | 缺了会怎样 |
|---|---|---|---|
| **结论层**（自持文件） | **本插件** | 交接件 `handoff-*.md`，固定四段；目录即索引 | 插件失去核心产物 |
| **细节层**（宿主日志） | DSH 宿主 | 会话事件日志（压缩只换表面不删原文） | 无法翻书，回问仍可用 |
| **记忆层** | **别人** | 长期记忆、跨项目召回 | **与本插件无关**（不管、不接、不提） |

**本插件不做归档副本、不建索引库、不写别人的记忆文件。**
翻书一律读宿主日志（永远最新、零成本）；要留存的结论由**本插件自己落盘**成交接件。

### 2.4 三条通道的完整时序

```
A 上下文 ≥ 阈值
   └─ 插件注入提醒（默认 steer，落进下一步并唤醒）
        └─ A 写交接件（固定四段）→ 本插件落盘到 handoffDir
             └─ A 调 conversation_start 开 B（开场消息自动带：A 的 sessionId、
                交接件路径、两条路的用法与优先级、"先问后翻"）
                  └─ 用户表态，目标暂停 → A 停手

B 工作中需要 A 的旧信息
   ├─ 路一 首选：conversation_send(A, 问题)          ← 窄指令，A 回一轮
   │     └─ conversation_read(A, messageId=本次)
   │           ├─ trust=clean            → 直接用
   │           ├─ trust=compacted_by_ask → 结果可能失真 → 走路二比对
   │           └─ 答不上来/超时          → 走路二
   └─ 路二 回退：conversation_handoffs()         ← 先看交接件目录（结论层）
                 → conversation_outline(A) / conversation_search(A, 关键词)
                 → conversation_read(A, atSeq=命中) 取原文块（细节层）
                       └─ 直到翻到或确认"书里也没有"
```

---

## 3. 已核验的宿主机制（事实来源，不要重新查）

> 证据路径：`<DSH 安装目录>\resources\app\node_modules\@deepseek-ai\...`（DSH 安装目录，非源码仓）

### 3.1 `ctx.sessionController`：哪些只读、哪些会唤醒

| 方法 | 会唤醒对方？ | 用途 |
|---|---|---|
| `list(request, signal)` | **否** | 列出全部会话摘要（含 `parentSessionId` / `origin`） |
| `inspect(sessionId, signal)` | **否**（"without activating its Agent"） | 读持久化头部 + 全量事件前缀 |
| `page(request, signal)` | **否**（cold-safe） | 消息对齐的历史页 |
| `projections(request, signal)` | **否**（"without activating an Agent"） | 读全部已注册投影的 wire 视图 |
| `search(request, signal)` | **否** | 会话正文检索 |
| `resolveAgent(sessionId)` | **是**（resume） | 只用于"确实要唤醒"的场景 |
| `prompt(request, signal)` | **是** | 回问 |
| `rename` / `selectModel` / `updateQueue` / `create` / `fork` | **是** | v2 只用 `create`（开新对话）与 `rename` |

**铁律**：只读工具一律走 `list` / `inspect` / `page` / `projections`，**禁止**在这四条路径上出现 `resolveAgent`。
（v1 的 `conversation_context({sessionId})` 违反了这条，v2 必须改。）

**签名**：`prompt(request: SessionPromptRequest, signal: AbortSignal)`、`page(request, signal)`、
`list(_request, signal)`、`projections(request, signal)` —— 都要求显式传 `signal`（见 §3.2）。

`SessionPromptRequest = { requestId, sessionId, mode: 'queue'|'steer', content: PromptContentPart[], clientTimeZone? }`
`SessionCreateRequest = { workspaceId? | cwd?, sessionId?, agentPreset? }`（workspaceId 与 cwd 互斥）
`SessionCreateValue = { sessionId, agentPreset? }`

### 3.2 `@Remote` 方法必须传 AbortSignal（实测坑）

`@Remote` 包装层会对第二个参数直接调 `signal.throwIfAborted()`。漏传即抛：
```
TypeError: Cannot read properties of undefined (reading 'throwIfAborted')
```
**实测**：`conversation_send` 连续 3 次复现（与 `mode` 无关）。**所有** `prompt` / `page` / `list` / `projections` 调用都要传。
v1 源码已修（`signalOf(exec)`），但**线上装的是旧代码**。

### 3.3 压缩的真实行为：只换表面，不删日志（这是"翻书"可行的根因）

来源：`@deepseek-ai/dsh-compaction-basic/lib/index.js` 与 `@deepseek-ai/dsh-session/lib/index.js`

- 压缩**追加**三个事件：`compaction/start`、`compaction/summary`（含摘要正文）、`compaction/end`；
- 另追加一条 **checkpoint 消息**：`session.append("user/message", checkpointMessage, { surfaceOp: { op: "replace", startSeq, endSeq } })`；
- `dsh-session` 里的 `SurfaceManager` 是 `new SurfaceManager(this.log, ...)` —— **surface 由 log 派生**；
- ⇒ **原文一条不删**，只是从"模型可见表面"里被换掉了。

**推论**：`page()` 读的是原日志（按 seq 索引），所以**能翻到被压缩掉的内容**。
`SessionWireEvent` 带 `surfaceOp?`，所以**能识别出哪条是压缩 checkpoint**。

### 3.4 `page()` 的语义（翻书的数据源）

来源：`@deepseek-ai/dsh-api-session-controller/lib/index.js` 的 `page()`（约 1410-1438）与 `paginate()`（约 1652-1682）

- 请求：`{ address, throughSeq, beforeSeq?, maxMessages?, turnWindow? }`
  - `address = { kind:'session', sessionId }`（另有 `kind:'subagent'` 形式，见 §6.3）
- 返回：`{ records: [{type:'event', event: SessionWireEvent}], hasMore }`

**✅ 已确认（头号未知已解决）**：`paginate` 从后往前扫，`if (!MESSAGE_TYPES.has(type) || !isAppendSurfaceEvent(event)) continue;`
**只跳过计数、不跳过切片**；最终 `events.slice(cut, end)` 把区间内**所有**事件都返回。
⇒ `compaction/start`、`compaction/summary`、`compaction/end`、`tool/call` 等非消息事件**都会回来**，
可信度判定与压缩点识别据此实现。

**❌ 已确认的坑：`throughSeq: -1` 返回空页，不是"最新一页"。**
`paginate` 里 `end = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1)`；
`-1 + 1 = 0` ⇒ `slice(cut, 0)` ⇒ **空数组**。
（v1 的 `conversation_read` 就用了 `-1`，所以它对任何非空会话都读不出东西——e2e 那次
"还没有可读消息"有两个原因叠加。）

**✅ 正确姿势**：先拿 `sourceCursor` = 该会话日志最后一个事件的 seq，再
`page({ address, throughSeq: sourceCursor, maxMessages: N })`。校验规则（同函数）：
`throughSeq > sourceCursor` 报 `gateway/bad-request`；`throughSeq >= 0` 且 `sourceLog[throughSeq].seq !== throughSeq` 报 `gateway/internal`。
`beforeSeq` 是**向后翻更早**的游标，配合 `hasMore` 使用。

**拿 `sourceCursor` 的两条途径与取舍**：

| 途径 | 代价 | 精确度 | 用于 |
|---|---|---|---|
| `list()` → `summary.projections.asOfSeq` | 便宜 | 可能缺字段 / 偏旧（缓存） | 日常读最新一页 |
| `inspect(sessionId)` → `events.at(-1).seq` | 读**全量**事件前缀，大会话很贵 | 精确 | 需要精确游标时，**按会话缓存** |

两侧都是只读通道，都不会唤醒对方。

### 3.5 上下文占用怎么读（不唤醒）

`contextPressure` 投影（`@deepseek-ai/dsh-token-meter`）：

- 原始 state：`{ contextWindow?, pressureTokens?, surfaceTokens, sampledSurfaceTokens?, claim? }`
- wire 视图：`{ contextWindow?, pressureTokens?, projectedTokens? }`
  其中 `projectedTokens = max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)`
- 读法：
  - **当前对话**（有 Session 对象）：`ctx.sessionProjections.stateOf(session, 'contextPressure')`
  - **别的对话**（只读）：`sessionController.projections({sessionId})` → `values.contextPressure`
    （该投影缓存对冷会话可能是 `cached`，必须把来源标注出来：`source: 'live' | 'cached'`）
- 兜底：`ctx.tokenMeter.measure(session).totalTokens`，窗口取 `session.requestContext()?.contextWindow`

### 3.6 子 agent 的归属围栏（决定了"回问优先"是架构必然）

来源：`@deepseek-ai/dsh-api-session-controller/lib/index.js`

- `hasApiSessionSubagentOwner(...)` 在 `resolve()` 的多个位置命中（行 223/236/240/259/263/271/375/401/405/415/425），
  并据此返回 `apiSessionSubagentOwnershipError(sessionId)`；
- `prompt()` 走 `resolveAgent()` ⇒ **对 subagent 会话直接被拒**；
- 唯一窄例外在 `updateQueue`（行 951-953）：仅"当前 projection identity 为 continuable 且来自自身非 seed suffix 的在线 child"。

⇒ **外部插件无法回问子 agent**。要子 agent 手里的活结论，**只能通过它的主对话**。
⇒ 这也是"主 agent 能调度它名下的子 agent"这条优势的**唯一实现通道**。

### 3.7 会话树信息（建树不需要额外服务）

`SessionSummary` 带：`sessionId / agentAvailable / updatedAt / running / blank / parentSessionId? / origin? / cwd? / projections?`
`SessionHeader` 带：`parentSession? / origin?: 'subagent' / delegationDepth? / agentPreset? / cwd?`

⇒ 用 `list()` 就能建出父子树与深度。**不需要** `ctx.subagents.listChildren()`（那个偏 continuable 语义）。

### 3.8 事件与生命周期（插件挂点）

- `ctx.on('session/event', (session, event) => ...)` —— 全局，post-commit，可拿到原始事件（压缩点判定可复用）；
- `ctx.on('agent/created' | 'agent/disposed')`、`ctx.on('session/disposed')`；
- `ctx.agents.get(sessionId)` —— 取**活** agent（判断"对方此刻是否在线"）；
- 水位提醒的触发事件集（v1 已实测有效）：`assistant/message`、`assistant/attempt`、`request/context`、`tool/result`、`turn/end`。
  注意 `request/context` **只在路由/窗口变化时**才写，不能当每轮信号。

### 3.9 工具与插件的工程约束（v1 实测）

- 工具定义用**原始 ToolDefinition**（本包**不 import 任何 `@deepseek-ai/*`**，profile 的 `node_modules/@deepseek-ai` 只有 `cosmokit`/`schemastery`）：
  ```
  { name, description, parameters, output: { schema, render(args, value) }, execute(args, exec) }
  ```
  `tools.register` 会校验 `output.schema` 属受支持子集，缺 `output` 直接抛。
- JSON Schema 子集：`type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const` + 注解（`description`/`title`）。
  **不支持** `format`、`default`、type 数组。子 schema 必须显式带 `type`。
- `ctx` 服务用 `ctx.get('<name>')` 取（可缺省时返回 undefined），硬依赖才写进 `inject`。
- **★ 不要在 `apply` 里用 `ctx.get()` 探测服务是否可用**（2026-10-04 真机踩到，已在 v2 修正）：
  冷启动时 Cordis 的加载顺序**不保证** `sessionController` 已注册，探测会得到 `undefined`，
  于是工具被**静默跳过**。现象极具误导性——
  `plugin_manager list_plugins` 显示该 entry `enabled: true` / `fiberPhase: "active"`（挂载成功），
  但 `Tool.listTools` 里**一个工具都没有**；只有翻宿主日志才能看到那句降级警告。
  正确做法：`ctx.inject(['sessionController'], (scoped) => { ... 在 scoped.tools 上注册 ... })`，
  让注册发生在服务就绪之后；不依赖会话服务的本地工具（交接件读写）立即注册。
- **排查插件是否真的加载了**：宿主日志在 `<宿主日志根>\logs\host\dsh-<日期>.log`
  （错误另见 `dsh-<日期>.error.log`），插件自己的 `ctx.logger.*` 行带 `[<插件名>]` 前缀，可直接搜。
  比 `list_plugins` 的 `fiberPhase` 更能说明"到底跑没跑、跑成什么样"。
- **★ 会话的分组归属只由 `workspaceId` 决定**（2026-10-04 真机，用户指出侧栏里新对话落在"未分组"）：
  `sessionController.create({ cwd })` 能得到正确的工作目录，但**不会把会话挂到任何 workspace**，
  于是在侧栏显示为"未分组"；而 `create` 明确要求 **`workspaceId` 与 `cwd` 互斥**（同时给会报
  `gateway/bad-request`）。正确做法：
  ```js
  const workspace = await ctx.get('workspaceRegistry')?.resolveByPath(session.header.cwd)
  const request = workspace ? { workspaceId: workspace.id } : { cwd }
  ```
  `resolveByPath` 只按**规范路径**查已登记的 workspace（未登记的目录返回 `undefined`，目录不存在则 reject），
  失败时退回 `cwd`（会话仍能建，只是不归组）。`Workspace` 形状：
  `{ id, path, title, createdAt, updatedAt, sessionIds, setTitle, attachSession, insertSessionBefore, detachSession, status }`。
- **插件作用域陷阱**：`buildTools(api, config)` 是模块级函数，**里面没有 `ctx`**。
  在工具实现里写 `ctx.get(...)` 会抛 `ReferenceError`；若外面还包着 `try/catch` 做降级，
  就会**静默退化**成兜底行为（本次就是：分组解析失败退成"未分组"，冒烟测试才抓出来）。
  要用的宿主能力一律挂到传进去的 `api` 上（getter 形式，保持惰性）。

### 3.10 真机验收（2026-10-04，第 2 次重启后）暴露的四条

验收由子 agent 全量跑完 9 步，以下四条**用宿主日志 + 插件自身代码取证**，不是推测。

- **★ 工具返回值必须是无损 JSON，否则整个结果被作废。**
  `messageOf` 对缺 `source.rpcId` 的 `user/message` 写了 `rpcId: undefined` ⇒ 宿主报
  `tool "conversation_read" returned invalid output: value is not lossless JSON`，
  **整页消息全丢**。表现极具迷惑性：渲染文本完全正常、页越小越好读（小页里恰好没有人类 user 消息），
  且 `limit` 的成败边界随内容漂移。⇒ 所有工具输出统一过 `jsonSafe()`（清 `undefined`/`NaN`/`Infinity`），
  且**缺省字段一律不写键**而不是写 `undefined`。
- **★ 子 agent 会话不能按 `{kind:'session'}` 读**：宿主直接拒
  `subagent Sessions require their durable parent address`。必须用
  `{kind:'subagent', parentSessionId, childSessionId, mode}`；`mode` 未知时按
  `unknown → continuable → one-shot` 逐个试探并记住赢家。
  更麻烦的是：`projections()` 与 `inspect()` **都没有传父地址的入口**（签名里只有 `sessionId`），
  所以子 agent 会话**拿不到精确游标**——退路是用 `list()` 摘要里带的 `asOfSeq`（`resolveCursor` 路径三）。
  占用投影同样读不到 ⇒ `conversation_context` 对子 agent 会话如实报 `available:false`，不抛错。
- **`atSeq` 必须精确**：原实现用 `page({throughSeq: atSeq, maxMessages: 1})` 再"找不到就取页里最后一条"，
  于是**静默返回别的位置**（真机：请求 1411→返回 1405）。`atSeq` 指向的很可能是 `tool/call`、
  轮次边界这类非消息事件。⇒ 找不到就**报错**并给出附近最近的可读 seq，让调用方改用
  `conversation_search` 的命中位置（那一定是消息 seq）。
- **`conversation_context` 的"0 个压缩点"必须带范围**：它只扫尾部若干页，而压缩点可能在很前面
  （真机：某会话 59 轮、压缩点在 seq 3299，工具报 0）。⇒ 返回值与渲染都带上
  `scannedRange {fromSeq, toSeq, pages, reachedStart}`，"没找到"只代表"这段里没有"。
  另外 `compaction/summary.data.summary` 可能为空，此时用同范围的 checkpoint 消息正文回填 `head`。
- 交接件**写入返回绝对路径、回读却要求同一个 cwd** 是不对称的（真机回读被拒）。
  ⇒ `readHandoff` 放行两种情况：在当前目标目录内，或路径本身就在本插件自己的
  `<任意目录>/.dsh-conversation-bridge/handoffs/` 下；其它绝对路径仍然拒绝。
- 插件清单：`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml` 插入一行；`apply(ctx, config)` 导出 `name` / `inject`。
- 安装：`plugin_manager install_bundle`，target 传**包名**（传绝对路径二次安装会报 `ambiguous-install`）。
- 已装包重装返回 `application: "restart-required"` ⇒ **代码与配置改动都要重启才生效**。
- `Config.listConfigs` 目录里的 `status: "absent"` 指的是**该插件没有声明 Config schema**，
  **不是**"没挂载"——别被它误导（v2 未导出 `Config`，所以是 `absent`）。

---

## 4. 设计

### 4.1 决策：回问优先，翻书回退

| | 回问（首选） | 翻书（回退） |
|---|---|---|
| 触发 | 默认路径 | `trust != clean`、对方答不上来、超时无答复、深度超限 |
| 拿到什么 | 现在综合后的结论 + 可借它调度子 agent | 日志原文（含被压缩掉的工具结果与弯路） |
| 可信度 | 由 §5 的可信度读数给出 | **原始事实，恒可信**（但可能很长、需要自己筛） |
| 代价 | 对方 +1 轮 → 可能触发压缩 | 只烧自己的上下文 |

**为什么回问优先仍然安全**：因为可信度是回问的**副产品**（§5）——我们不会在"不知道结果可不可信"的情况下使用它。

### 4.2 工具清单（v2，共 9 个）

| 工具 | 只读？ | 一句话 |
|---|---|---|
| `conversation_list` | ✅ | 列出对话（可展开某棵子 agent 子树） |
| `conversation_context` | ✅ | 占用 + 阈值 + 历史压缩点 |
| `conversation_start` | 写 | 开新对话并投递交接件（**唯一开窗入口，不自动开**） |
| `conversation_send` | 唤醒 | **跨对话发消息（唯一的管道工具，两个方向都走它）**：提问 / 回信 / 只通知 |
| `conversation_read` | ✅ | 读答复（先看 `answered` 再看 `trust`）／按 `atSeq` 取原文块 |
| `conversation_outline` | ✅ | 旧书目录（Tier-0） |
| `conversation_search` | ✅ | 旧书检索（Tier-1），支持子树检索 |
| `conversation_handoffs` | ✅ | **交接件目录/正文**（结论层，本插件自持文件，不依赖任何插件） |
| `conversation_handoff_write` | 写 | **写交接件**（固定四段校验 + 原子落盘），可用 `handoff.toolEnabled` 关掉 |

#### 4.2.1 `conversation_list`

```
参数：{
  limit?: integer,               // 默认 30，上限 100
  rootsOnly?: boolean,           // 默认 false
  parentSessionId?: string,      // 给了就展开这棵树
  includeSubagents?: boolean     // 默认 true（v1 是 false，改掉）
}
返回：{
  total, conversations: [{
    sessionId, title, cwd, origin, parentSessionId, depth,
    running, blank, agentAvailable,
    occupancyPercent, occupancySource,   // 'live' | 'cached' | 'unknown'
    compactionCount,                     // 历史压缩点数（只读扫得）
    current                              // 是否当前对话
  }]
}
```

#### 4.2.2 `conversation_context`

```
参数：{ sessionId?: string }      // 默认当前对话
返回：{
  sessionId, available,
  tokens, contextWindow, percent, thresholdPercent, overThreshold,
  occupancySource,                 // 'live' (当前) | 'cached' (别的对话)
  compactionPoints: [{ summarySeq, startSeq, endSeq, time }],
  archiveStats: { totalEvents?, firstSeq?, lastSeq? }
}
```
**必须只读**：别的对话走 `projections()` + `page()`，**禁止** `resolveAgent`。

#### 4.2.3 `conversation_start`

```
参数：{ message?, title?, cwd?, agentPreset?, workspaceId?, handoffFile? }
行为：create() → 可选 rename() → prompt(mode:'steer')（新会话本来空闲，steer 与 queue 等价，但 steer 语义更准）
开场消息 = [接力头] + 用户给的 message
接力头自动包含：
  · **交接人（上一段对话）的 sessionId** + 它的标题/工作目录（标题查本对话自己的，不拿新对话的 title 顶上）
  · 本次交接件文件路径 + 交接件目录的用法
  · 管道用法：「要问它/回给它用 `conversation_send`（sessionId 指对方；答复类传 reply=true）」
  · 取答复用法：「`conversation_read`（messageId=上一步的 messageId），**先看 answered 再看 trust**」
  · 回退用法：「`conversation_outline` → `conversation_search` → `conversation_read`（atSeq）」翻原文
  · 若模型自己想把结论再存一份到别处，那是它的事；**本插件不提示、不指路、不参与**
返回：{ sessionId, cwd, workspaceId, grouped, title, parentSessionId, messageSent, note }
```

#### 4.2.4 `conversation_send`（跨对话发消息：唯一的管道工具）

**v2 收尾时把 `conversation_ask` 与 `conversation_reply` 合并成这一个。**
理由：两者在宿主侧是同一个动作——`sessionController.prompt(sessionId, mode, content)`，
差别只在信封（要不要窄指令）与护栏（同对冷却、环路）。
管道只有一条，两个工具名反而在暗示存在两种管道；参数化的公共能力（模式、唤醒、落款）也不必写两遍。

**不收"要不要对方回答"这种参数**：回不回是收信人自己的决定，发信人能表达的只有"怎么投"和"正文里想要什么"。
曾经短暂有过的 `expectReply` 已删除——它既替收信人做了决定，又逼出两套落款文案。
**B 觉得 A 问得不清楚而反问 A，走的还是这一个工具**（`conversation_send(sessionId=A, ...)`），
和新提问是同一个动作，没有第二套机制。

```
参数：{
  sessionId: string,             // 必填：塞给哪个对话
  text: string,                  // 必填：要说的内容（提问 / 结论 / 追问 / 反问 / "不用再回我"）
  reply?: boolean,               // 默认 false：这一条是对既有消息的答复
                                 //   true → 不包窄指令，且不受同对冷却与环路护栏约束（护栏只拦"提问引发提问"的接力）
  mode?: 'steer'|'queue',        // 默认 'steer'：插进对方当前回合的下一步；'queue' 等它本轮结束
  wake?: boolean                 // 默认 true；false 时只入队不唤醒（此时 mode 降级为 queue）
}
事前读数（随返回）：
  occupancyBefore: { tokens, contextWindow, percent, source }
  projectedAfterPercent            // 加上这一条之后的预计占用
  compactionRisk: 'low'|'likely'   // 预计越线 → 'likely'
  messageId: string                // = 本次 prompt 的 requestId，之后用 read 的 `messageId` 参数精确定位答复窗口
  depth: number                    // 本条投递之后的依赖跳数
  narrow: boolean                  // 本条是否包了窄指令（提问包、答复不包）
返回：{ sessionId, messageId, accepted, mode, woken, depth, narrow, compactionRisk, occupancyBefore, projectedAfterPercent, hint }
```

- **默认必须是 `steer`（插入）**：宿主里 `steer` = 入队到 `next-step` + 唤醒，
  对方**正在思考或跑工具时下一步就能看到**；`queue` = 入队到 `next-turn`，等它本轮结束。
  真机实测曾经的默认 `queue` 是"像同步、像干等"的一半原因（另一半见 §4.2.5 游标）。
- **发信人身份只能由插件写进正文**：宿主消息模型没有发信人概念（`source` 只有 `kind` 与 `rpcId`），
  所以 `replyGuide` 落款（可配置）是收信方唯一能知道"该回给谁"的来源。
  少了它，对方就算装了本插件也不知道往哪回——真机第一次复验就撞到这个。
- **窄指令模板**（可配置），要点：只回答这个问题；不要复盘、不要改文件、不要展开、不要重做；
  若结论在你开过的子 agent 手里，**直接让那个子 agent 回结论**，不要自己重跑。
- **护栏分工**：新提问（`reply` 不为 true）走同对冷却 + 环路 + 深度；
  回信/通知（`reply=true`）只走深度。环路护栏防的是"提问引发提问"的接力，
  拦"把结论答回去"是拦错了对象。
- **投递围栏（宿主硬规则，插件绕不过）**：会话本身是子 agent（`origin==='subagent'`），
  或它**正被一个活着的子 agent 持有**（宿主 `hasApiSessionSubagentOwner`），宿主都拒绝 `prompt` 投递。
  插件在投递前用会话摘要先判第一种（不浪费一次投递），第二种只能靠投递失败时把宿主的
  `session/agent-busy`（"owned by subagent routing"）**翻译成人话 + 给退路**：
  等它那个子 agent 跑完再来投，或改用只读翻书看它的最新输出。
  真机实测撞到过：新对话在回答问题时正跑着自己的子 agent，它想回信给上一段对话，回不出去。
- 若 `compactionRisk='likely'` ⇒ **不拒绝**，但返回里明确劝阻 + 给出翻书入口建议（软门，按用户裁定）。

#### 4.2.5 `conversation_read`

```
参数：{
  sessionId: string,
  messageId?: string,                // 给了 → 用 rpcId 精确定位这一次发消息的答复窗口（推荐；值取 send 的 messageId）
  atSeq?: number,                // 给了 → 取该 seq 的原文块（Tier-2）
  limit?: integer,               // 默认 30
  includeTools?: boolean,        // 默认 true（v1 只取 text，丢工具结果是缺陷）
  parentSessionId?: string,      // 子 agent 会话必填：它只能按其 durable 父地址读
  mode?: string                  // 子 agent 地址模式，默认 unknown（自动试探）
}
返回（读答复模式）：{
  sessionId, messages: [{ seq, role, text, kind }],
  // kind: 'user' | 'assistant' | 'tool' | 'compaction-summary'
  answered: boolean,             // **对方答完了没**：只有"提问之后、不含工具调用、文本非空"的助手帧才算答复
  reason: string,                // 'ok' | 'no-message-id' | 'message-not-found' | 'no-reply-yet'
                                 // | 'reply-pending-tool-call'（最近的助手帧只有工具调用，它还在干活）
                                 // | 'empty-session' | 'concurrent-input' | 'compaction-before-reply' | 'earlier-compaction'
  trust: 'clean' | 'compacted_by_ask' | 'compacted_earlier' | 'unknown',
  pendingToolCall?: true,        // 出现过"只有工具调用"的助手帧
  questionSeq, replySeq,         // 锚点：提问落在哪、答复落在哪
  compactionPoints: [{ summarySeq, startSeq, endSeq, time, head }],
  occupancyAfter: {...}
}
返回（取原文模式）：{ sessionId, block: { seq, role, kind, text }, requestedSeq, actualSeq }
```
- **`answered` 才管"答没答完"，`trust` 只表示表面可不可信**。
  `answered:false` 时 `trust` 恒为 `unknown`；`trust:'clean'` 不代表答复已完成、也不代表快照是最新的
  （真机实测：对方还在跑工具时报 `clean`，调用方以为拿到答案了）。
- **答复锚点只认提问之后的助手帧**（`event.seq > questionSeq`），且跳过含 `tool-call` 的帧。
  翻页窗口里带着提问之前的旧答复是常态（同一目标被问过不止一次），
  把旧答复当成这一次的答复等于答非所问；把 `[工具调用 pwsh]` 当成答复则等于"它答了个空"。
- `messageId` 省略时**不猜**：返回 `reason:'no-message-id'`，由调用方显式给 `messageId` 或 `atSeq`。
- **读答复必须拿实时游标**（`fresh`，绕过游标缓存）：缓存游标会把对方刚落盘的答复挡在外面。
  真机事故：答复已落盘 11 秒，read 仍给旧快照（根因是游标缓存无 TTL 命中即用旧值）。
- **读答复必须走 `page({throughSeq: sourceCursor})`**（§3.4），不能用 `-1`。

#### 4.2.6 `conversation_outline`（Tier-0 旧书目录）

```
参数：{ sessionId, fromSeq?, toSeq?, maxTurns? }   // maxTurns 默认 50，上限 200
返回：{ sessionId, title, turns: [{
  turn, startSeq, time,
  userHead,                      // 首行，截断
  hasToolCalls, toolFailures,
  compacted                      // 该轮是否被压缩点覆盖
}], compactedRanges: [{startSeq,endSeq,summarySeq}], totalTurns, truncated }
```

#### 4.2.7 `conversation_search`（Tier-1 旧书检索）

```
参数：{
  sessionId?: string,
  parentSessionId?: string,      // 子树检索（含全部后代）
  query: string,                 // 必填
  roles?: ('user'|'assistant'|'tool')[],
  sinceSeq?: integer, untilSeq?: integer,
  limit?: integer                // 默认 20，上限 50
}
返回：{
  scanned: { sessions, events, truncated },
  hits: [{ sessionId, seq, time, role, kind, snippet, matched, score }]
}
```
- **查询预算**：单次扫描事件数上限（默认 3000），超限即 `truncated:true` 并提示缩小范围。
- 叶子块截断到 `maxChars`。
- 排序：命中词数 → 时间倒序。

#### 4.2.8 `conversation_handoffs`（结论层：交接件）

```
参数：{
  file?: string,                 // 给了 → 读该交接件全文；否则只给目录页
  cwd?: string,                  // 只列该工作目录下的交接件（默认当前会话的 cwd）
  limit?: integer,               // 默认 20，上限 100
  sinceMs?: integer              // 只列最近 N 毫秒内创建的
}
返回（目录页）：{
  dir, total,
  handoffs: [{ file, createdAt, fromSessionId, cwd, percent, heads: {任务状态,目标,已试方案与失败原因,进度与下一步}, malformed? }]
}
返回（读全文）：{ file, createdAt, fromSessionId, sections: {四段} , raw }
```

#### 4.2.9 `conversation_handoff_write`（写交接件）

```
参数：{
  title?: string,
  sections: {                    // 全部必填，逐字标题由插件负责渲染
    任务状态, 目标, 已试方案与失败原因, 进度与下一步     // 每段有最小长度
  },
  cwd?: string                   // 默认当前会话 cwd
}
行为：校验四段（缺段/过短直接拒绝并说明）→ 渲染 Markdown（含头部元信息）→ 原子写（tmp+rename）→ 返回路径
返回：{ file, dir, bytes, sectionChars }
```
- 该工具可用 `handoff.toolEnabled: false` 关掉（此时提醒文案改为"用你惯用的写文件工具，按固定四段落盘"）。
- **本工具不调用、不依赖、不提及任何记忆插件**；它只负责把交接件按固定形状落到本插件自己的目录里。

---

## 5. 可信度判定（核心算法，回问的副产品）

### 5.1 原理

回问会让对方**多走一轮**。如果这一轮把它推过压缩线，它用来生成答复的**表面**已经是摘要了
——答复就是"看着自己的摘要回答你"。

所以：**在 `[发问前游标, 答复]` 这个窗口里找压缩点**，并比较压缩点与答复的**先后**。

### 5.2 四态

| trust | 条件 | 含义 | 建议动作 |
|---|---|---|---|
| `clean` | 窗口内无压缩点 | 答复基于真实表面 | 直接用 |
| `compacted_by_ask` | 窗口内有压缩点，且 `compactionSeq < replySeq` | **这一问把它推过线了**，答复基于刚替换的表面 | **高优先**翻书比对 |
| `compacted_earlier` | 窗口内无，但更早日志里有 | 答复是"早就压缩过的视角"，不是这次问坏的 | 低优先核对 |
| `unknown` | 窗口读不全 / 拿不到 replySeq | 不可判定 | 按可疑处理 |

### 5.3 实现要点（**不需要事前游标**，用 `rpcId` 定位窗口）

回问时我们**自己生成 requestId**，而 `sessionController.prompt` 会把它写进日志：
```
const source = { kind: "user", rpcId: request.requestId, ... }   // 控制器源码
createUserMessage({ content, source })  →  session.append("user/message", message)
```
⇒ **我们能在日志里按 `event.data.source.rpcId` 精确找到"自己问的那一条"**，它的 seq 就是窗口起点。

1. `conversation_send` 生成 `requestId`（返回给调用方当 `messageId`）；**插件不替调用方猜窗口**，
   读的时候必须把这个 id 显式传给 `conversation_read` 的 `messageId`——省略就不猜（`reason:'no-message-id'`）。
2. `conversation_read` 翻最近若干页，找 `event.data.source.rpcId === messageId` 的 `user/message` → `questionSeq`。
3. 窗口 = `(questionSeq, 现在]`。找窗口内**不含 `tool-call`** 的、最后一条有文本块的 `assistant/message` → `replySeq`。
   含 `tool-call` 的助手帧只记 `pendingToolCall`（说明它还在干活），不算答复。
4. 找窗口内的 `compaction/summary`（或带 `surfaceOp.replace` 的 checkpoint）→ `compactionSeq`：
   - `compactionSeq` 存在且 `< replySeq` ⇒ **`compacted_by_ask`**（答复基于刚替换的表面）
   - 窗口内无、但更早的页里有 ⇒ **`compacted_earlier`**
   - 都没有 ⇒ **`clean`**
5. 压缩 checkpoint 消息在渲染时标成 `kind:'compaction-summary'`，并附
   `[压缩摘要 seq=N，覆盖 seq=A..B；原文仍可翻]` —— **防止新对话把摘要误当原始事实**。

> 这条路比"事前记游标"更稳：不依赖"ask 与 read 之间的游标没被别的输入推走"，
> 也不需要在 ask 时就做一次额外的只读读取。

### 5.4 边界

- 答复延迟可能跨多个页：`read` 若 `hasMore`，先继续翻再判 trust。
- 若对方**根本没用模型**（例如直接由别处写入），`replySeq` 可能找不到 ⇒ `unknown`。
- 判定只覆盖"这一轮"。对方如果有**并发**其它输入，噪声会进窗口 ⇒ 保守判 `unknown`（宁可多翻一次书）。

---

## 6. 翻书（底线通道）

### 6.1 三层下探（借 dsh-auto-memory 的 Tier 思路，逐层给、不同时给）

| 层 | 工具 | 预算 | 何时给 |
|---|---|---|---|
| Tier-0 目录 | `conversation_outline` | 每轮一行；`maxTurns` 50 | 先给，让新对话知道"书里有什么" |
| Tier-1 摘要 | `conversation_search` | 命中 ≤ 20；扫描 ≤ 3000 事件 | 目录看不出在哪才下探 |
| Tier-2 原文 | `conversation_read({atSeq})` | 单块 ≤ 2400 字符 | 确认要证据才取 |

### 6.2 覆盖范围（v1 的缺陷要修）

- **必须包含 `tool/result`**：压缩最容易丢的就是工具输出与失败原因；v1 只取 `text` 块。
- **包含 assistant 的非文本块**：至少标注"此处有工具调用/推理"，不静默丢弃。
- **压缩点可见**（§5.3 第 5 条）。

### 6.3 子 agent 的"书"

- 用 `list()` + `parentSessionId` 建树；`conversation_list({parentSessionId})` 展开一棵子树。
- `page()` 的 `address` 有 `{ kind:'subagent', parentSessionId, childSessionId, mode }` 形式；
  **待实测**：对 subagent 会话是否 `page` 可用（若不可用则退化为用主会话 id + seq 范围读）。
  ⇒ **这是 P1 的第一个待验证点**，见 §9。
- 子 agent **不可回问**（§3.6），所以对它们只有翻书一条路；要活结论走它们的主对话。

---

## 7. 递归护栏（防止"问→翻→问"雪崩）

### 7.1 状态（进程内，不持久化）

```
askGraph: Map<sessionId, {
  depth: number,                  // 该会话"被问到"的层级
  askedBy: Set<sessionId>,
  lastAskAt: Map<opponentSessionId, timestamp>
  askCount: number
}>
recentAsks: 环形缓冲（全局频率限制）
```

**护栏不靠模型传参**：hop 由插件根据 `askGraph` 自己算，模型忘了带也不会绕过。

### 7.2 规则

| 规则 | 默认 | 违反时 |
|---|---|---|
| 深度上限 | 3 跳 | 拒绝，返回"已达回问深度上限，请改为翻书，或把该留下的写进交接件" |
| 环路禁止 | 开 | 拒绝（A 问 B 后，B 不能再问 A） |
| 同对会话冷却 | 10 分钟 | 拒绝并给出剩余等待时间 |
| 全局频率 | 30 次/分钟 | 拒绝并提示 |
| 翻书查询预算 | 3000 事件 / 次 | 截断 + 提示缩小范围（**不拒绝**） |

**翻书不加深度限制**（只读、无对方成本），但要守查询预算，避免"翻书把新对话撑爆"。

### 7.3 深度怎么算

- `conversation_start(A→B)` 记 `handoffParent[B] = A`；
- `conversation_send(B→A)` 记 `askGraph[A].depth = askGraph[B].depth + 1`（B 的 depth 默认 0）；
- 若目标已在**本次 ask 链**的祖先里 ⇒ 环路，拒。

---

## 8. 交接链

### 8.1 水位提醒

沿用 v1 已验证的机制（`contextPressure` + 阈值 + 武装/回落/冷却），改进：
- 提醒文案改成"**先把该留下的落成交接件（固定四段）→ 再开新对话**"；
- 交接件采用**固定四段**（借 dsh-auto-memory 的硬门思路）：任务状态 / 目标 / 已试方案与失败原因 / 进度与下一步；
- **"交接件写到哪、由谁写"由本插件自己负责**（§8.2），不外包给任何插件。

### 8.2 自持交接件（本插件的核心产物，零依赖）

| 项 | 设计 |
|---|---|
| 目录 | `handoff.dir`，默认 `<会话 cwd>/.dsh-conversation-bridge/handoffs/`；支持绝对路径与 `~` 展开 |
| 文件 | `handoff-<YYYYMMDD-HHmmss>-<来源 session 短 id>.md` |
| 形状 | **固定四段、逐字标题**：`## 任务状态` / `## 目标` / `## 已试方案与失败原因` / `## 进度与下一步`；每段有最小字符数；不达标**拒绝写入**并回执写出原因 |
| 头部 | 文件首部写 YAML-ish 元信息：来源 sessionId、cwd、创建时间、水位百分比 |
| **无额外索引文件** | 不维护可变的 `index.json`（避免读-改-写竞争与原子写复杂度）。目录本身就是索引：读时**扫目录**，按文件名解析时间与来源 id |
| 写入通道 | 工具 `conversation_handoff_write`（模型填内容，插件校验形状 + 原子落盘 tmp+rename + 返回路径） |
| 读取通道 | 工具 `conversation_handoffs`（扫目录给目录页：文件名/时间/来源/四段首行；带 `file` 则读全文） |

**为什么自持**：会话是**可能被归档甚至删除**的（部署可能开了自动归档/自动删除）。交接件是
**结论层**，必须活得比会话久；它是"已经合上的旧书"的**目录页 + 读后感**，而会话日志是正文。

### 8.3 与记忆层的关系：没有关系

- **不探测、不指路、不写入、不读取、不提及**任何记忆插件或记忆工具。
- 理由：记忆插件有自己的运转逻辑与自维护手段，**不需要本插件接入**；
  本插件只关心**自己要留存的东西**（交接件）与**自己要去的地方**（宿主会话日志）。
- 结果：**有无记忆插件，本插件的行为完全一致**——这正是"可以独立发布"的含义。

### 8.4 开窗：不自动

- 默认只**提醒**；`conversation_start` 是唯一开窗入口，**由模型/用户触发**；
- 不做倒计时确认卡（本插件无 UI 面；让宿主/用户做决定更简单）；
- 阈值默认 0.70（压在宿主 0.80 压缩线下）。

### 8.5 不做的事
- 不自己决定压缩（宿主地盘）；
- 不搬移/归档会话；
- 不写别人的记忆文件、不建索引库、不做会话归档副本。

---

## 9. 实施计划（带验收判据，做完打勾）

> **顺序有依赖**：P0 是共享底层，P1/P2 都建在它上面；先做 P2 会返工。

### P0 · 只读骨架（共享底层）✅ 已完成
- [x] `readOnly` 封装：见 `lib/host.js`（listSummaries / resolveCursor / readPressureById / readPage / readPagesBackwards）
- [x] `resolveCursor()`：优先 `projections().asOfSeq`，缺失再 `inspect()` —— **解掉了 §3.4 的空页坑**
- [x] 压缩点解析器：见 `lib/scan.js` 的 `collectCompactionPoints`（summary 的 `shadowedRange` + checkpoint 兜底）
- [x] 会话树构建：`buildTree` + `collectSubtree`
- [x] **验收通过**（冒烟测试第 2/3/10 组）：非空会话能读回消息；`throughSeq` 断言**永不等于 -1**；
      夹具里放了 `resolveAgent` 间谍，只读路径全程未被调用

### P1 · 翻书三件套 ✅ 已完成
- [x] `conversation_outline`（Tier-0，按轮折目录、标压缩点与工具失败）
- [x] `conversation_search`（Tier-1，AND 关键词、角色过滤、预算截断）
- [x] `conversation_read`（`atSeq` 取原文块 / `limit` / `includeTools` / 压缩点标注）
- [x] **待验证点**：subagent 会话的 `page` 是否可用 —— **仍未实测**，见 §12 风险 3
- [x] **验收通过**（第 4/5/6 组）：被压缩覆盖的 `tool/result` 能被搜到（seq=4）并能取回原文块

### P2 · 回问与可信度 ✅ 已完成
- [x] `conversation_send`（窄指令 + 事前读数 + messageId + 压缩风险预警）
- [x] `conversation_read` 的 `trust` 四态（用 `rpcId` 定位窗口，§5.3）
- [x] `conversation_context` 改走只读通道（修掉 v1 的唤醒缺陷）
- [x] **验收通过**（第 8 组）：clean / compacted_earlier / compacted_by_ask / unknown（无答复、并发噪声、无 messageId）全部命中

### P3 · 护栏 ✅ 已完成
- [x] `dependsOn` 图 + 深度 / 环路 / 同对冷却 / 全局频率
- [x] **验收通过**（第 9 组）：自问、环路、深度超限、冷却四种拒绝都能触发且给出可操作提示

### P4 · 交接链（自持落盘）✅ 已完成
- [x] `conversation_handoff_write`：四段校验（缺段/过短直接拒） + 原子写（tmp+rename，探测后改名，绝不覆盖） + 头部元信息
- [x] `conversation_handoffs`：扫目录给目录页（无索引文件，避免读-改-写竞争）
- [x] 水位提醒文案（"先把该留下的落成交接件 → 再开新对话"）
- [x] `conversation_start` 的开场消息（两条路 + 优先级 + `handoffFile` 路径）
- [x] **验收通过**（第 14/15/16 组）：四段硬契约会拒绝非法输入；交接件落盘、目录页、全文可读、
      路径越界被拒；水位提醒注入一次、不重复、回落后重新武装、子 agent 跳过、写完交接件后本对话静默
- [x] 修掉一个真缺陷：文件名同秒撞车会**静默覆盖**前一份交接件（改为时间戳带毫秒 + 随机尾巴 + 写前探测）

### P5 · 打包与发布物
- [ ] 冒烟测试更新（**必须覆盖**：prompt 漏传 signal 会被假宿主抛错、服务缺失必须降级、
      四段校验拒绝非法输入、trust 四态、护栏拒绝）
- [ ] 按 **§14 发布物清单** 补齐：去掉 `private`、`repository`/`license`/`engines`、
      `README.md`（明确写"只管交接，不与任何记忆插件集成"）、`CHANGELOG.md`、`LICENSE`、`icon.svg`、`locale/*.json`
- [ ] `cordis.patch.yml` 配置项与注释补齐（对齐 §11）
- [ ] 安装并**重启后**验证；把"线上装的是哪一版"记进 §10
- [ ] **验收**：重启后 9 个工具在册；§P1/P2/P4 的验收在真机上重跑通过；
      **且在一台只有 DSH、没装任何记忆插件的环境里，三条通道全部可用**

---

## 10. 进度与未落账（每完成一步回来更新）

| 日期 | 事项 | 状态 |
|---|---|---|
| 2026-10-04 | v1 插件建成并装进 desktop profile（5 工具） | 已装，**线上是旧代码** |
| 2026-10-04 | 发现并修复 `prompt` 漏传 `AbortSignal` | 源码已修，**未重装** |
| 2026-10-04 | e2e 实测：`conversation_send` 因上述 bug 100% 失败；其余工具正常 | 已取证 |
| 2026-10-04 | 调研 dsh-auto-memory / dsh-mnemon 并定架构 | 完成 |
| 2026-10-04 | 本设计文档 v2 | 完成 |
| 2026-10-04 | 读源码确认 `page()` 会返回非消息事件（压缩点可见） | ✅ 已解决头号未知 |
| 2026-10-04 | **发现 `throughSeq:-1` 返回空页** ⇒ v1 `conversation_read` 对非空会话全失效 | ✅ 设计已修正（`resolveCursor`），v1 代码待重写 |
| 2026-10-04 | 发现可用 `rpcId` 精确定位回问窗口 ⇒ 免去事前游标 | ✅ 设计已简化（§5.3） |
| 2026-10-04 | **架构修正：去掉 mnemon 依赖，改为可独立发布的通用插件** | ✅ 设计已改（§2.2/§8.2/§14）；工具数 7→9 |
| 2026-10-04 | **二次修正：删掉"可选接头/探测记忆工具"**——"通用"= 不管它，而不是给它留接口 | ✅ 设计已改（§1.3/§8.3/§13-13） |
| 2026-10-04 | 建 git 仓库（`main`，首个提交 `09920c5`） | ✅ |
| 2026-10-04 | **P0 / P1 / P2 / P3 实现并本地验收通过**（`lib/host.js`、`lib/scan.js`、7 个工具） | ✅ 提交 `5f00aca` |
| 2026-10-04 | **P4 实现并本地验收通过**（`lib/handoff.js` + 2 个工具 + 水位提醒），工具数 7→9 | ✅ 提交待做 |
| 2026-10-04 | **P5 发布物**：`package.json`（去 `private`）、README / CHANGELOG / LICENSE / icon.svg | ✅ 提交 `d8db545` |
| 2026-10-04 | `install_bundle` 装到 desktop profile | ✅ 返回 `restart-required` |
| 2026-10-04 | **第 1 次重启后的真机结果**：entry `enabled:true / fiberPhase:active`，但 **9 个工具一个都没注册**；日志实锤 `当前部署没有 sessionController 服务` | ❌ 定位为设计缺陷（§3.9 已记录） |
| 2026-10-04 | **顺利的一半**：水位提醒真机生效——日志 `已向 session-<省略>… 注入交接提醒（70.1%）` | ✅ |
| 2026-10-04 | 修复：`ctx.inject(['sessionController'], …)` + 本地工具立即注册 + 两种加载顺序都覆盖 | ✅ 提交 `52830b9` / `15b9317` |
| 2026-10-04 | 修正：`conversation_start` 按 workspace 归组（用户发现落在"未分组"） | ✅ 提交 `a260381` |
| 2026-10-04 | **第 2 次重启 → 子 agent 全量验收（9 步）**：7 项通过、发现 8 处问题（无损 JSON / 子 agent 地址 / atSeq / scannedRange / 交接件路径 / 渲染缺字段 / 列表总数） | ✅ 修复提交 `7d7686b`；机制记入 §3.10 |
| 2026-10-04 | **第 3 次重启 → 复验 8 项**：7 项通过；剩下 trust 噪声规则（真 bug）与 search 渲染 | ✅ 修复提交 `13811c4` |
| 2026-10-04 | **第 4 次重启 → 复验最后 2 项：全部通过** | ✅ 功能完工 |
| 2026-10-04 | 水位提醒在**本对话自身**触发两次（70.0% / 71.5%），并暴露"提醒让模型调一个本会话不可见的工具"⇒ 文案改为工具无关的兜底写法 | ✅ 真机验证 |

**最后一次验收的结论（第 4 次重启后）**：
- `conversation_search` 渲染带上 `scannedRange`（0 命中与有命中两种情况都在）✅
- 回问后 `trust=clean`（不再被 `<goal_round>` 这类非真人 user 消息误判）✅

**测试遗留物（待用户清理）**：侧栏"未分组"里的 `bridge-e2e-test`、`bridge-live-acceptance-2`、
`bridge-trust-check` 等测试对话（`bridge-reverify` 已正确落在 `project` 分组）。

**外部阻塞**：无。

---

## 11. 配置项（v2 计划）

```yaml
# 工具开关
exposeTools: true

# 回问
ask:
  maxDepth: 3
  pairCooldownMs: 600000
  globalPerMinute: 30
  defaultMode: queue
  narrow: true
  narrowTemplate: |        # {{question}} 会被替换
    只回答下面这个问题，不要复盘、不要改文件、不要展开、不要重做已做过的工作。
    如果结论在你开过的子 agent 手里，直接让那个子 agent 把结论给你，不要自己重跑。
    问题：{{question}}

# 翻书预算
archive:
  maxScanEvents: 3000
  maxHits: 20
  maxBlockChars: 2400
  outlineMaxTurns: 50
  includeToolResults: true
  pageSize: 30

# 交接
handoff:
  enabled: true
  threshold: 0.7
  rearmBelow: 0.55
  cooldownMs: 600000
  handoffQuietMs: 1800000
  deliver: steer            # steer | queue
  skipSubagents: true
  toolEnabled: true         # 关掉 conversation_handoff_write（提醒改为"用你惯用的写文件工具"）
  dir: ""                   # 空 = <会话 cwd>/.dsh-conversation-bridge/handoffs/；支持绝对路径与 ~
  sections: ["任务状态", "目标", "已试方案与失败原因", "进度与下一步"]   # 固定四段，逐字标题
  minSectionChars: 40       # 每段最小长度，不达标拒绝写入
  inheritCwd: true
  inheritPreset: true
```

---

## 12. 风险与开放问题

| # | 风险 / 未知 | 影响 | 处置 |
|---|---|---|---|
| 1 | ~~压缩点判定依赖 `page` 返回非消息事件~~ | — | **✅ 已解决**（源码确认 `slice(cut,end)` 全量返回，见 §3.4） |
| 2 | **`throughSeq: -1` 返回空页**（不是"最新"） | v1 `conversation_read` 对**任何非空会话都读不出**；设计若照抄会全盘失效 | **✅ 已修正**：一律先取 `sourceCursor` 再传（§3.4）。**P0 第一条就要实现 `resolveCursor()`** |
| 3 | subagent 会话的 `page` 是否可用（`address.kind='subagent'`） | 影响子树翻书 | P1 实测；退化路径：用主会话 id + seq 范围 |
| 4 | 冷会话占用只能拿缓存投影（可能过期） | 事前读数不准 | 一律标注 `occupancySource`，不给假精度 |
| 5 | 回问的答复是异步的，`read` 可能早于答复落库 | trust 误判 | 返回 `answered:false` 且 `trust:'unknown'`，提示稍后再读 |
| 6 | 对方有并发输入时窗口有噪声 | 误判 `clean` | 保守：窗口内出现**非本次 messageId** 的 user 消息 ⇒ 降为 `unknown` |
| 7 | 新对话用翻书把自己撑爆 | 防丢手段反成负担 | 全部返回硬上限 + 目录优先下探 |
| 8 | 改动需重启才生效，调试周期长 | 迭代慢 | 每阶段先本地冒烟（假宿主）再装；一次装完多改 |
| 9 | `inspect()` 读全量事件前缀，大会话很贵 | 取精确游标代价高 | 优先用 `list().projections.asOfSeq`；`inspect` 结果**按会话缓存**，只在必要时用 |
| 10 | **宿主服务可能缺失**（headless / 精简 profile 没有 `sessionController`） | 插件不该因此崩溃 | 全部服务走 `ctx.get()` 可缺省获取；缺失即**降级并只保留能做的部分**，启动时 log 一行说明（§2.2） |
| 11 | **用户可能装了 / 没装记忆插件** | 任何形式的耦合都会破坏"可独立发布" | 与记忆层**零耦合**：不探测、不指路、不读取、不写入。有无记忆插件，行为完全一致（§8.3） |
| 12 | 交接件目录写在会话 cwd 下，可能污染用户仓库 | 用户观感 | 默认目录名 `.dsh-conversation-bridge/`（带点、可 gitignore）；`handoff.dir` 可指向仓库外 |
| 13 | 与部署里别的插件是否有投影/事件冲突 | 未知 | 不注册投影、不新增 Session 事件类型、只读宿主数据 ⇒ 结构上不可能冲突；P5 装机后看日志确认 |

---

## 13. 与 v1 的差异清单（重写时逐条对照）

| # | v1 行为 | v2 要求 |
|---|---|---|
| 1 | `conversation_send` 漏传 signal ⇒ 必失败 | 全部 `@Remote` 调用传 signal（已修源码） |
| 2 | `conversation_read` 用 `throughSeq:-1` ⇒ **空页** | 先 `resolveCursor()` 再 `page({throughSeq: sourceCursor})`（§3.4） |
| 3 | `conversation_context({sessionId})` 走 `resolveAgent` ⇒ 唤醒对方 | 改走 `projections()`，只读 |
| 4 | `conversation_read` 只取 `text` 块 | 必须含 `tool/result`；非文本块标注 |
| 5 | `conversation_list` 默认过滤子 agent | 默认包含，支持 `parentSessionId` 展开 |
| 6 | 无检索，只有"取最近 N 条" | 加 outline / search / atSeq 三层下探 |
| 7 | 无压缩点识别 | 标 `compaction-summary` + `[原文仍可翻]` |
| 8 | 无护栏 | askGraph 深度/环路/冷却/频率 |
| 9 | 无可信度 | `trust` 四态（用 `rpcId` 定位窗口，§5.3） |
| 10 | 提醒文案只讲"开新对话" | 讲"交接件自持落盘 + 两条路优先级" |
| 11 | 工具数 5 | 9（新增 outline / search / handoffs / handoff_write；`send` 更名 `ask`） |
| 12 | 交接件依赖外部记忆插件 | **去掉依赖**：本插件自持落盘 + 目录即索引；**不与记忆层有任何形式的集成** |
| 13 | 设计里曾出现"可选接头 / 探测记忆工具" | 那是多余的抽象 | **已删除**：本插件只管交接，记忆层归别人（§8.3） |

---

## 14. 发布物清单（可独立发布的判据）

| 项 | 要求 |
|---|---|
| `package.json` | **`private` 必须关掉**（v1 是 `true`，这是"定制产品"的痕迹）；`version` / `license` / `repository` / `keywords` / `engines` 齐备 |
| `dependencies` | **必须为空**（零第三方依赖；唯一 import 是 Node 内建） |
| `peerDependencies` | 不声明任何东西（宿主能力靠 `ctx.get()` 运行时探测，不靠包管理器保证） |
| 入口 | `exports["."]` → `./index.js`（`type: "module"`，无构建步骤） |
| 清单 | `dsh.bundle.patch` → `cordis.patch.yml`（含全部默认配置与注释） |
| 文档 | `README.md`（安装 / 配置 / 工具一览；明确写"只管交接，不与任何记忆插件集成"） |
| 变更 | `CHANGELOG.md` |
| 许可 | `LICENSE`（建议 MIT） |
| 元信息 | `icon.svg` + `locale/*.json`（插件页显示用，可选但建议） |
| 冒烟 | `test/smoke.mjs`（假宿主，覆盖：服务缺失降级、signal 必传、四段校验、trust 四态、护栏拒绝） |
| 安装 | `plugin_manager install_bundle`；README 里同时给 CLI 与"AI 时代安装法" |
| **验收** | 在一台**只有 DSH、没装任何记忆插件**的环境里装上并走通三条通道 |
