# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased] · 0.1.0（未发布）

首个公开版本。按 `DESIGN.md` 的 v2 设计实现。

### 取数通道
- **跨对话发消息（唯一管道）**：`conversation_send` 向指定对话塞一条消息，两个方向都走它——
  提问、回信、反问、只通知。默认 `mode: 'steer'`：**插进对方当前回合的下一步**（对方正在跑也能看到），
  不是等它整轮输出完再追加；返回 `messageId` 与事前读数（对方占用、预计压缩风险），
  `conversation_read` 用 `messageId=messageId` 读答复。
  合并前的 `conversation_ask` / `conversation_reply` 已删除（两者在宿主侧是同一个 `prompt`，
  差别只在信封与护栏；管道只有一条，不该有两个工具名）。
- **发信人身份随消息走**：宿主消息模型没有发信人概念（`source` 只有 `kind` / `rpcId`），
  所以每条消息的正文都带一段可配置落款，写明"本条来自哪个对话、要回时用 `conversation_send` 回哪"。
  少了它，对方就算装了本插件也不知道往哪回。
- **`answered` 与 `trust` 分工明确**：`answered` 才算"对方答完了"——只有**提问之后**、
  **不含工具调用**、文本非空的助手帧才算答复；`trust` 只表示表面可不可信。
  真机事故：对方先落一条 `[工具调用 pwsh]`，旧判定把它当答复还报 `clean`，调用方以为拿到答案了；
  现在这种情况返回 `answered:false` + `reason:'reply-pending-tool-call'`。
- **可信度是发消息的副产品**：`trust` 四态（`clean` / `compacted_by_ask` /
  `compacted_earlier` / `unknown`），用 `rpcId` 精确定位"自己问的那一条"来判定窗口，
  不需要事前记游标。
- **翻旧书回退**：`conversation_outline`（Tier-0 目录）→ `conversation_search`
  （Tier-1 检索，含被压缩掉的工具结果）→ `conversation_read`（`atSeq` 取原文块，Tier-2）。
  全程只读，**不唤醒对方**。读答复时不使用缓存的游标（`fresh`）——
  真机事故：答复已落盘 11 秒，read 仍返回旧快照。
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
- **`conversation_send` / `conversation_read` 渲染补齐**：`accepted` / `depth` / 预计占用 /
  `answered` / `reason` / 定位 seq / 窗口内压缩点 —— 模型只能看到渲染文本，结构化字段必须可读。
- **`conversation_start` 按 workspace 归组**（见下）：不再落到"未分组"。

### 修复（第 1 次真机验收后）
- **冷启动时工具被静默跳过**：`apply` 里用 `ctx.get('sessionController')` 探测可用性，
  而该服务在应用启动后约 18 秒才就绪 ⇒ 9 个跨对话工具一个都没注册（entry 却显示
  `fiberPhase: active`）。改用 `ctx.inject([...])` 等服务就绪再注册，并让不依赖会话服务的
  本地工具立即注册。
- `conversation_start` 改为先按工作目录 `resolveByPath` 解析 workspace 再传 `workspaceId`；
  只传 `cwd` 会落到"未分组"。

### 变更（v2 收尾轮：双向管道 + 兜底可用性）
- **两个工具合并成一个**：`conversation_ask` + `conversation_reply` → `conversation_send`。
  依据：两者在宿主侧都是 `sessionController.prompt(sessionId, mode, content)`，
  差别只在信封与护栏；管道只有一条。**不再收"要不要对方回答"这类参数**——
  回不回是收信人自己的决定（它可能答、可能反问、可能只记下），
  发信人能表达的只有"怎么投"（`mode` / `wake`）与"正文里想要什么"。
- **默认投递改为 `steer`（插入）**：原先默认 `queue` 要等对方本轮结束才追加，
  是"看着像同步、像干等"的一半原因。`steer` 会插进对方当前回合的下一步。
- **护栏只拦"提问引发提问"的接力**：答复/反问（`reply=true`）不受同对冷却与环路约束，
  深度上限仍是兜底。B 觉得 A 问得不清楚而反问 A，走的就是同一个工具。
- **`conversation_start` 开场消息带上交接人 sessionId 与其标题/工作目录**，
  并写清"要问它/回给它用 `conversation_send`、取答复先看 `answered` 再看 `trust`"。
- **投递围栏可见化**：目标是子 agent 会话时提前拒（不浪费一次投递）；目标正被活着的子 agent
  持有时，把宿主的 `owned by subagent routing` 翻译成"等它跑完再来投，或改用只读翻书看它的最新输出"，
  不再把宿主的原始拒绝信息砸给调用方。
- **闭环修复：子 agent 发消息时，落款里的回信地址换成它的父对话**。
  子 agent 会话收不到任何投递，原先照它自己的 sessionId 回信会被宿主围栏拒——
  真机实测的断点就是"子 agent 问了对话、对话答完想回信却回不进去"。
  现在落款指向父对话并附 `[中继说明]`，闭环由父对话收口（子 agent 的结论本来也要回到父对话）；
  返回里新增 `relayed` / `replyTo` 如实报告。
- **同源缺口补全：`conversation_start` 的接力头也换成"收得到"的回信地址**。
  真机闭环验证时发现：发起开窗的若是子 agent 会话，接力头把"交接人"写成那个子 agent，
  新对话照它回信照样会被宿主围栏拒。现在接力头/返回值都用父对话作回信地址并注明缘由，
  `relayed` / `contactSessionId` 如实报告（与 `conversation_send` 的落款口径一致）。
- **跨对话消息的 `rpcId` 加 `bridge-` 前缀，不再被算成「真人并发插话」**。
  宿主把 `prompt` 投递的消息一律写成 `{kind:user, rpcId}`，与真人输入无从区分，
  于是多轮往返时插件自己发的反问/回信会把上一条提问的 `trust` 打成 `unknown`（自我污染）。
  现在发信侧用 `bridge-<uuid>` 作 `rpcId`，收信侧判「真人输入」时排除该前缀；
  前缀只落在 `source.rpcId` 上（消息 `id` 由宿主生成，不受影响）。边界：需通信双方都装本插件。
- **水位提醒降载**：只挂 `assistant/message` 与 `turn/end` 两个轮次级事件，
  并新增每会话评估节流 `handoff.evalMinIntervalMs`（默认 1000ms，可配置）。
  原先还挂着 `assistant/attempt` / `request/context` / `tool/result`——每个工具调用、每次请求都会触发一次压力评估，
  启动期（大量会话恢复 + 投影写入）叠加起来是纯白烧，而水位本来就只需要轮次级判断。
- **落款明确要求答复时传 `reply=true`，护栏拒绝文案点明出路**。真机闭环验证时撞到：
  对方回信漏传 `reply=true` ⇒ 被当成新提问（正文被包窄指令）；若"对方问过你"，该回信还会被环路护栏直接拒。
  现在落款写明 `reply=true` 及其理由，环路/冷却的拒绝文案也补上"如果你是在答复，传 reply: true 再发"。
  冒烟测试补断言：落款含 `reply=true`；环路被拒时错误里含出路提示；同一场景传 `reply:true` 必须放行。
- **修环路误判（真机事故）**：A 开新对话 B → B 回问 A → A 想回 B 被"检测到消息环路"拒 → **两边全停**。
  根因：`guard.record()` 把**答复也记进依赖图**，"一问一答"累积成"互相依赖"，之后任何一封都被判环。
  两处修：① `record()` 只记新提问（`reply=true` 不进依赖链）；
  ② 环路只在**双向依赖**时拦——单向（目标问过我、我没问过它）= 我在回话给它，放行。
  冒烟测试：单向回话必须放行；双向再问必须拦（且错误里含 `reply: true` 出路）；答复必须能穿过环路护栏。
- **删掉冷却 / 环路检测 / 深度上限，只留全局频率**（真机事故后的复盘）。
  事故：A 开新对话 B → B 回问 A → **A 想回 B 被"检测到消息环路"拒** → 两边全停。
  根因一：环路拦在"投递"层，而投递**无法区分提问与答复**，只能靠调用方声明 `reply` —— 它不知道该声明。
  根因二：**"无限接力"是臆想的坏场景**（模型调工具带明确预期），而"多轮协作"是高频好场景
  （追问→再答→再追问，四五轮常见）。为臆想的坏场景加门禁、代价是破坏正常协作，方向反了。
  设计锚点改为宿主自己的 `send_message`（主子 agent 通信）：两个参数、一条语句、**零门禁**。
  现在只剩：空 id / 发给自己 / 全局频率（30 次每分钟，挡代码死循环）。
  冒烟测试：连跑 4 轮往返必须全部畅通；限频仍生效。
