// dsh-conversation-bridge 冒烟测试：假宿主，忠实复刻宿主的 page/paginate 行为。
// 运行：node test/smoke.mjs
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, resolveConfig, name, inject } from '../index.js'

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/* ------------------------------------------------------------------ *
 * 忠实复刻：宿主的 page / paginate（字段与语义同 dsh-api-session-controller）
 * ------------------------------------------------------------------ */

const MESSAGE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message', 'developer/message'])
const isAppendSurface = (event) => event.surfaceOp === undefined || event.surfaceOp === 'append'

function paginate(events, beforeSeq, maxMessages, throughSeq) {
  const end = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1)
  let count = 0
  let cut = 0
  for (let index = end - 1; index >= 0; index--) {
    const event = events[index]
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurface(event)) continue
    count++
    let groupStart = event.seq
    if (Array.isArray(event.sourceEventSeqs)) {
      for (const source of event.sourceEventSeqs) if (source < groupStart) groupStart = source
    }
    if (count >= maxMessages) {
      cut = groupStart
      break
    }
  }
  return { events: events.slice(cut, end), hasMore: cut > 0 }
}

/* ------------------------------------------------------------------ *
 * 一段真实的日志形状：两轮 → 一次压缩 → 第三轮（含我们的一次回问）
 * ------------------------------------------------------------------ */

function seedLog() {
  return [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 1001, data: { content: [{ type: 'text', text: '第一轮提问：把发布流程跑一遍' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, time: 1002, data: { message: { content: [{ type: 'text', text: '第一轮回答：先编译再打包' }] } } },
    { type: 'tool/call', seq: 3, time: 1003, data: { name: 'pwsh' } },
    { type: 'tool/result', seq: 4, time: 1004, data: { message: { content: [{ type: 'text', text: '关键细节：构建产物哈希 X=42' }] } } },
    { type: 'turn/end', seq: 5, time: 1005, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 6, time: 1006, data: { turn: 2 } },
    { type: 'user/message', seq: 7, time: 1007, data: { content: [{ type: 'text', text: '第二轮提问：为什么失败了' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 8, time: 1008, data: { message: { content: [{ type: 'text', text: '第二轮回答：因为端口被占用，这条弯路别再走' }] } } },
    { type: 'tool/result', seq: 9, time: 1009, data: { message: { content: [{ type: 'text', text: '错误现场：EADDRINUSE 8080' }] }, error: { name: 'ToolError', code: 'EXIT_1', reason: '端口占用' } } },
    { type: 'turn/end', seq: 10, time: 1010, data: { turn: 2, reason: { kind: 'completed' } } },
    // —— 压缩：只换表面，原文不删 ——
    { type: 'compaction/start', seq: 11, time: 1011, data: { compactionId: 'c1' } },
    { type: 'compaction/summary', seq: 12, time: 1012, data: { compactionId: 'c1', summary: '前两轮摘要：编译打包流程 + 端口占用的弯路', shadowedRange: { start: 1, end: 10 }, shadowedSeqs: [1, 2, 4, 7, 8, 9], shadowedTokenCount: 1234, provider: 'local', model: 'x' } },
    { type: 'user/message', seq: 13, time: 1012, data: { content: [{ type: 'text', text: '前两轮摘要：编译打包流程 + 端口占用的弯路' }] }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 10 }, sourceEventSeqs: [11, 12, 1, 2, 4, 7, 8, 9] },
    { type: 'compaction/end', seq: 14, time: 1013, data: { compactionId: 'c1' } },
    { type: 'turn/start', seq: 15, time: 1014, data: { turn: 3 } },
    { type: 'user/message', seq: 16, time: 1015, data: { content: [{ type: 'text', text: '第三轮提问：接下来做什么' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 17, time: 1016, data: { message: { content: [{ type: 'text', text: '第三轮回答：结论 Y，先修端口' }] } } },
    { type: 'turn/end', seq: 18, time: 1017, data: { turn: 3, reason: { kind: 'completed' } } },
  ]
}

/* ------------------------------------------------------------------ *
 * 假宿主
 * ------------------------------------------------------------------ */

function createHarness(options = {}) {
  const logs = new Map([['session-aaa', seedLog()]])
  // 一个子 agent 会话的日志：宿主规定它只能按 {kind:'subagent', parentSessionId} 地址读
  logs.set('session-sub', [
    { type: 'turn/start', seq: 0, time: 800, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 801, data: { content: [{ type: 'text', text: '子 agent 收到的任务' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, time: 802, data: { message: { content: [{ type: 'text', text: '子 agent 的结论：端口号 8099' }] } } },
    { type: 'turn/end', seq: 3, time: 803, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  // 一个"从未被压缩过"的会话：用来区分 clean 与 compacted_earlier
  logs.set('session-clean', [
    { type: 'turn/start', seq: 0, time: 900, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 901, data: { content: [{ type: 'text', text: '干净会话的问题' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, time: 902, data: { message: { content: [{ type: 'text', text: '干净会话的回答' }] } } },
    { type: 'turn/end', seq: 3, time: 903, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const summaries = [
    { sessionId: 'session-aaa', updatedAt: 5000, running: false, blank: false, agentAvailable: false, cwd: '<工作区>', projections: { kind: 'sequenced', asOfSeq: undefined, values: { title: '旧对话' } } },
    { sessionId: 'session-bbb', updatedAt: 6000, running: false, blank: false, agentAvailable: false, cwd: '<工作区>', projections: { kind: 'cached', asOfSeq: undefined, values: { title: '当前对话' } } },
    { sessionId: 'session-sub', updatedAt: 4000, running: false, blank: true, agentAvailable: false, origin: 'subagent', parentSessionId: 'session-aaa' },
    { sessionId: 'session-sub2', updatedAt: 3000, running: false, blank: true, agentAvailable: false, origin: 'subagent', parentSessionId: 'session-sub' },
  ]
  const calls = { page: [], prompt: [], create: [], rename: [], projections: [], resolveAgent: 0 }
  const liveAgents = new Map()
  let compactionOnNextReply = false
  let replyOnNextPrompt = true
  let bridgeNoiseOnNextPrompt = false
  let noiseOnNextPrompt = false
  let nonHumanNoiseOnNextPrompt = false
  // 复刻真机时序：对方先写一条"只有工具调用、没有文本"的助手帧，下一帧才给答案。
  // 旧判定会把那条工具调用帧当成答复（实测 trust 还报 clean），这里把它钉住。
  let toolCallOnNextReply = false

  const eventsOf$ = (id) => logs.get(id) ?? []
  const cursorOf = (id) => eventsOf$(id).length - 1

  function append(id, event) {
    const list = logs.get(id) ?? []
    event.seq = list.length
    list.push(event)
    logs.set(id, list)
  }

  const controller = {
    async list() {
      return {
        items: summaries.map((row) => ({
          ...row,
          projections: {
            ...row.projections,
            asOfSeq: cursorOf(row.sessionId),
          },
        })),
      }
    },
    async projections(request) {
      if (request?.sessionId === undefined) throw new Error('projections 需要 sessionId')
      calls.projections.push(request.sessionId)
      const row = summaries.find((item) => item.sessionId === request.sessionId)
      // 实测口径：围栏只在 page 上；projections / inspect 对子 agent 会话照样能读
      if (!logs.has(request.sessionId)) return null
      return {
        asOfSeq: cursorOf(request.sessionId),
        values: {
          title: row?.projections?.values?.title ?? '',
          contextPressure: { contextWindow: 100000, pressureTokens: 80000, projectedTokens: 80000 },
        },
      }
    },
    async inspect(sessionId) {
      return { meta: { id: sessionId }, inheritedEventCount: 0, events: eventsOf$(sessionId) }
    },
    async page(request, signal) {
      // 忠实复刻：@Remote 包装层会对 signal 调 throwIfAborted()
      if (signal === undefined || typeof signal.throwIfAborted !== 'function') {
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
      }
      signal.throwIfAborted()
      const address = request?.address ?? {}
      const sessionId = address.childSessionId ?? address.sessionId
      if (!logs.has(sessionId)) throw new Error(`session "${sessionId}" not found`)
      // 忠实复刻宿主围栏：子 agent 会话必须用 {kind:'subagent', parentSessionId} 地址
      const row = summaries.find((item) => item.sessionId === sessionId)
      if (row?.origin === 'subagent'
        && (address.kind !== 'subagent' || address.parentSessionId !== row.parentSessionId)) {
        throw new Error('subagent Sessions require their durable parent address')
      }
      const cursor = cursorOf(sessionId)
      const throughSeq = request.throughSeq === -1 ? -1 : request.throughSeq
      if (throughSeq > cursor) throw new Error(`session page through seq ${throughSeq} is past cursor ${cursor}`)
      calls.page.push({
        sessionId,
        throughSeq,
        maxMessages: request.maxMessages,
        beforeSeq: request.beforeSeq,
        addressKind: address.kind,
        addressMode: address.mode,
      })
      const page = paginate(eventsOf$(sessionId), request.beforeSeq, request.maxMessages ?? 40, throughSeq)
      return { records: page.events.map((event) => ({ type: 'event', event })), hasMore: page.hasMore }
    },
    async prompt(request, signal) {
      if (signal === undefined || typeof signal.throwIfAborted !== 'function') {
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
      }
      // 忠实复刻宿主围栏：子 agent 会话不接受投递（hasApiSessionSubagentOwner）
      const target = summaries.find((item) => item.sessionId === request.sessionId)
      if (target?.origin === 'subagent' || options.heldTarget === request.sessionId) {
        throw new Error(`session "${request.sessionId}" is owned by subagent routing`)
      }
      calls.prompt.push(request)
      append(request.sessionId, {
        type: 'user/message', time: 2000,
        data: { content: request.content, source: { kind: 'user', rpcId: request.requestId } },
      })
      if (replyOnNextPrompt) {
        if (compactionOnNextReply) {
          append(request.sessionId, { type: 'compaction/start', time: 2001, data: { compactionId: 'c9' } })
          append(request.sessionId, { type: 'compaction/summary', time: 2002, data: { summary: '回问把它推过线了', shadowedRange: { start: 1, end: 20 }, shadowedTokenCount: 999 } })
          append(request.sessionId, { type: 'user/message', time: 2002, data: { content: [{ type: 'text', text: '回问把它推过线了' }] }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 20 } })
          append(request.sessionId, { type: 'compaction/end', time: 2003, data: { compactionId: 'c9' } })
        }
        if (noiseOnNextPrompt) {
          append(request.sessionId, { type: 'user/message', time: 2004, data: { content: [{ type: 'text', text: '用户同时插了一句话' }], source: { kind: 'user', rpcId: 'someone-else' } } })
        }
        if (nonHumanNoiseOnNextPrompt) {
          // 复刻真实宿主会写的模型切换提示：user 角色，但 source.kind 不是 user
          append(request.sessionId, { type: 'user/message', time: 2004, data: { content: [{ type: 'text', text: '[model changed: ...]' }], source: { kind: 'model-selection', form: 'notice' } } })
        }
        if (bridgeNoiseOnNextPrompt) {
          // 另一条**由本插件投递**的跨对话消息：user 角色 + rpcId 带桥前缀。
          // 它不该被算成"真人并发插话"，否则多轮往返会把上一条提问的 trust 打成 unknown。
          append(request.sessionId, { type: 'user/message', time: 2004, data: { content: [{ type: 'text', text: '另一条跨对话消息' }], source: { kind: 'user', rpcId: 'bridge-other-id' } } })
        }
        if (toolCallOnNextReply) {
          // 只落工具调用帧、本轮不给文本：真实场景里对方正在跑工具、还没答
          append(request.sessionId, { type: 'assistant/message', time: 2004, data: { message: { content: [{ type: 'tool-call', name: 'pwsh', arguments: '{}' }] } } })
        } else {
          append(request.sessionId, { type: 'assistant/message', time: 2005, data: { message: { content: [{ type: 'text', text: '答复：结论 Z' }] } } })
        }
      }
      return { accepted: true }
    },
    async create(request) {
      calls.create.push(request)
      return { sessionId: 'session-new', agentPreset: request.agentPreset }
    },
    async rename(request) {
      calls.rename.push(request)
      return { title: request.title, seq: 0 }
    },
    // 故意提供：一旦被调用就说明"只读路径唤醒了对方"，测试必须失败
    async resolveAgent() {
      calls.resolveAgent += 1
      throw new Error('只读路径不得调用 resolveAgent')
    },
  }

  const tools = []
  const listeners = new Map()
  const pendingInjections = []
  /** 哪些服务"此刻已注册"——用来复刻冷启动时服务后到的情况。 */
  const live = new Set(options.bare === true
    ? []
    : ['sessionController', 'agents', 'sessionProjections', 'tokenMeter', 'workspaceRegistry'])
  let pressureState
  const agentsService = {
    get: (id) => liveAgents.get(String(id)),
    list: () => [...liveAgents.values()],
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    /** 复刻 Cordis：依赖满足才跑回调，否则挂起等依赖就绪。 */
    inject(names, callback) {
      if (names.every((name) => live.has(name))) {
        callback(ctx)
        return () => {}
      }
      pendingInjections.push({ names, callback })
      return () => {}
    },
    get(key) {
      if (!live.has(key)) return undefined
      if (key === 'sessionController') return controller
      if (key === 'agents') return agentsService
      if (key === 'sessionProjections') {
        return { stateOf: (_session, projectionKey) => (projectionKey === 'contextPressure' ? pressureState : undefined) }
      }
      if (key === 'tokenMeter') return { measure: () => ({ totalTokens: 80000 }) }
      if (key === 'workspaceRegistry') {
        if (options.noWorkspaceRegistry === true) return undefined
        return {
          // 复刻宿主：只有已登记为 workspace 的规范路径才解析得到
          async resolveByPath(path) {
            return path === '<工作区>' ? { id: 'ws-project', path: '<工作区>' } : undefined
          },
          get: (id) => (id === 'ws-project' ? { id: 'ws-project', path: '<工作区>' } : undefined),
        }
      }
      return undefined
    },
  }

  const harness = {
    ctx, calls, logs, liveAgents, tools,
    flags: {
      set compactionOnNextReply(value) { compactionOnNextReply = value },
      set replyOnNextPrompt(value) { replyOnNextPrompt = value },
      set noiseOnNextPrompt(value) { noiseOnNextPrompt = value },
      set bridgeNoiseOnNextPrompt(value) { bridgeNoiseOnNextPrompt = value },
      set nonHumanNoiseOnNextPrompt(value) { nonHumanNoiseOnNextPrompt = value },
      set toolCallOnNextReply(value) { toolCallOnNextReply = value },
    },
    /** 设置当前会话的 live 上下文压力（readOwnPressure 走这条）。 */
    setPressure(state) { pressureState = state },
    /** 让某个宿主服务"现在才注册"（复刻冷启动顺序），并跑掉因此就绪的注入。 */
    setLive(name, value) {
      if (value) live.add(name)
      else live.delete(name)
      if (!value) return
      for (let index = pendingInjections.length - 1; index >= 0; index--) {
        const entry = pendingInjections[index]
        if (entry.names.every((dependency) => live.has(dependency))) {
          pendingInjections.splice(index, 1)
          entry.callback(ctx)
        }
      }
    },
    /** 触发 session/event（水位提醒靠它）。 */
    fire(session, type) {
      for (const listener of listeners.get('session/event') ?? []) listener(session, { type })
    },
  }
  return harness
}

function toolMap(tools) {
  return new Map(tools.map((definition) => [definition.name, definition]))
}

function firstLog(harness) {
  return harness.logs.get('session-aaa')
}

/* ================================================================== *
 * 断言
 * ================================================================== */

assert.equal(name, 'conversation-bridge')
assert.deepEqual(inject, ['tools'])

/* 1. 工具注册与形状 */
{
  const harness = createHarness()
  apply(harness.ctx, {})
  const tools = toolMap(harness.tools)
  assert.deepEqual(
    [...tools.keys()].sort(),
    [
      'conversation_context',
      'conversation_handoff_write',
      'conversation_handoffs',
      'conversation_list',
      'conversation_outline',
      'conversation_read',
      'conversation_search',
      'conversation_send',
      'conversation_start',
    ],
  )
  for (const definition of tools.values()) {
    assert.equal(typeof definition.description, 'string')
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(definition.parameters.type, 'object')
  }
}

/* 2. P0 头号验收：非空会话必须能读回消息；throughSeq 绝不能是 -1 */
{
  const harness = createHarness()
  apply(harness.ctx, {})
  const tools = toolMap(harness.tools)
  const exec = { agent: { session: { id: 'session-bbb', header: {} } } }
  const value = await tools.get('conversation_read').execute({ sessionId: 'session-aaa' }, exec)
  assert.ok(value.messages.length > 0, '非空会话必须读回消息（v1 的 throughSeq:-1 会返回空页）')
  assert.ok(value.messages.some((message) => message.text.includes('第三轮回答')), '最新一页要包含最新的回答')
  for (const call of harness.calls.page) {
    assert.notEqual(call.throughSeq, -1, 'throughSeq 不能是 -1（那是空页）')
  }
  assert.equal(harness.calls.page[0].throughSeq, firstLog(harness).length - 1, '游标必须是最后一个事件的 seq')
}

/* 3. 压缩点解析：summary 的覆盖范围要拿到 */
{
  const harness = createHarness()
  apply(harness.ctx, {})
  const tools = toolMap(harness.tools)
  const value = await tools.get('conversation_context').execute({ sessionId: 'session-aaa' }, {})
  assert.equal(value.available, true)
  assert.equal(value.percent, 80)
  assert.equal(value.compactionPoints.length, 1)
  assert.equal(value.compactionPoints[0].summarySeq, 12)
  assert.equal(value.compactionPoints[0].startSeq, 1)
  assert.equal(value.compactionPoints[0].endSeq, 10)
  assert.equal(value.compactionPoints[0].tokenCount, 1234)
}

/* 4. 被压缩掉的原文仍然能翻到；checkpoint 标成 compaction-summary */
{
  const harness = createHarness()
  apply(harness.ctx, {})
  const tools = toolMap(harness.tools)
  const value = await tools.get('conversation_read').execute({ sessionId: 'session-aaa', limit: 50 }, {})
  const summary = value.messages.find((message) => message.kind === 'compaction-summary')
  assert.ok(summary !== undefined, 'checkpoint 必须被标成 compaction-summary')
  assert.match(summary.text, /原文仍可翻/)
  assert.ok(value.messages.some((message) => message.text.includes('关键细节：构建产物哈希 X=42')), '被压缩覆盖的 tool 结果仍应可读')
}

/* 5. Tier-1 检索：能搜到被压缩掉的内容；Tier-2 取原文块 */
{
  const harness = createHarness()
  apply(harness.ctx, {})
  const tools = toolMap(harness.tools)
  const found = await tools.get('conversation_search').execute({ sessionId: 'session-aaa', query: 'X=42' }, {})
  assert.equal(found.hits.length, 1)
  assert.equal(found.hits[0].seq, 4)
  assert.equal(found.hits[0].role, 'tool')
  const block = await tools.get('conversation_read').execute({ sessionId: 'session-aaa', atSeq: 4 }, {})
  assert.equal(block.block.seq, 4)
  assert.match(block.block.text, /X=42/)
  const miss = await tools.get('conversation_search').execute({ sessionId: 'session-aaa', query: '不存在的词' }, {})
  assert.equal(miss.hits.length, 0)
}

/* 6. Tier-0 目录：三轮、前两轮被标为含压缩点 */
{
  const harness = createHarness()
  apply(harness.ctx, {})
  const tools = toolMap(harness.tools)
  const value = await tools.get('conversation_outline').execute({ sessionId: 'session-aaa' }, {})
  assert.equal(value.totalTurns, 3)
  assert.equal(value.turns[0].compacted, true)
  assert.equal(value.turns[1].compacted, true)
  assert.equal(value.turns[2].compacted, false)
  assert.equal(value.turns[1].toolFailures, 1, '工具失败要计入')
  assert.match(value.turns[0].userHead, /把发布流程跑一遍/)
}

/* 7. 会话树：子 agent 默认包含，parentSessionId 能展开子树 */
{
  const harness = createHarness()
  apply(harness.ctx, {})
  const tools = toolMap(harness.tools)
  const all = await tools.get('conversation_list').execute({}, { agent: { session: { id: 'session-bbb' } } })
  assert.equal(all.total, 4)
  assert.equal(all.conversations.find((row) => row.sessionId === 'session-bbb').current, true)
  const subtree = await tools.get('conversation_list').execute({ parentSessionId: 'session-aaa' }, {})
  assert.deepEqual(subtree.conversations.map((row) => row.sessionId).sort(), ['session-aaa', 'session-sub', 'session-sub2'])
  assert.equal(subtree.conversations.find((row) => row.sessionId === 'session-sub2').depth, 2)
  const roots = await tools.get('conversation_list').execute({ rootsOnly: true }, {})
  assert.deepEqual(roots.conversations.map((row) => row.sessionId).sort(), ['session-aaa', 'session-bbb'])
}

/* 8. 可信度四态 */
{
  const harness = createHarness()
  // 同一目标要连续问几次：关掉同对冷却，免得测到冷却而不是测到语义
  apply(harness.ctx, { ask: { pairCooldownMs: 0 } })
  const tools = toolMap(harness.tools)
  const exec = { agent: { session: { id: 'session-bbb', header: {} } } }
  const as = (id) => ({ agent: { session: { id, header: {} } } })

  // clean：对方从未被压缩过
  const askedClean = await tools.get('conversation_send').execute({ sessionId: 'session-clean', text: '结论是什么' }, exec)
  assert.equal(askedClean.accepted, true)
  assert.match(harness.calls.prompt.at(-1).content[0].text, /只回答下面这个问题/, '提问默认要包窄指令')
  assert.equal(askedClean.narrow, true)
  // 默认必须走插入：对方正在思考/跑工具时，这条插进它下一步就能看到；
  // 排在"本轮结束之后"会让发送方看起来在干等，且对方思考中根本收不到（用户裁定）
  assert.equal(askedClean.mode, 'steer', '默认投递必须是插入式 steer')
  assert.equal(harness.calls.prompt.at(-1).mode, 'steer')
  // 发信人身份必须随消息走：宿主不提供发信人概念，收信方唯一来源就是这段约定
  assert.match(harness.calls.prompt.at(-1).content[0].text, /sessionId=session-bbb/, '正文必须写明这条来自哪个对话')
  assert.match(harness.calls.prompt.at(-1).content[0].text, /conversation_send/, '正文必须写明回信方法')
  assert.equal(askedClean.compactionRisk, 'likely', '对方已在 80% → 事前就要预警')
  assert.equal(askedClean.occupancyBefore.source, 'cached')
  assert.match(askedClean.messageId, /^bridge-/, '跨对话投递的 rpcId 必须带桥前缀（收信侧靠它识别"这是插件发的"）')
  const clean = await tools.get('conversation_read').execute({ sessionId: 'session-clean', messageId: askedClean.messageId }, exec)
  assert.equal(clean.trust, 'clean')
  assert.equal(clean.answered, true)

  // compacted_earlier：对方早就被压缩过（不是这一问问坏的 → 低优先核对）
  const askedEarlier = await tools.get('conversation_send').execute({ sessionId: 'session-aaa', text: '给个结论' }, exec)
  const earlier = await tools.get('conversation_read').execute({ sessionId: 'session-aaa', messageId: askedEarlier.messageId }, exec)
  assert.equal(earlier.trust, 'compacted_earlier')

  // 尚无答复
  harness.flags.replyOnNextPrompt = false
  const asked2 = await tools.get('conversation_send').execute({ sessionId: 'session-aaa', text: '还没答的那问' }, as('session-ccc'))
  const pending = await tools.get('conversation_read').execute({ sessionId: 'session-aaa', messageId: asked2.messageId }, exec)
  assert.equal(pending.answered, false)
  assert.equal(pending.trust, 'unknown')
  assert.equal(pending.reason, 'no-reply-yet')
  harness.flags.replyOnNextPrompt = true

  // 这一问触发压缩 → compacted_by_ask（高优先：去翻旧书比对）
  harness.flags.compactionOnNextReply = true
  const asked3 = await tools.get('conversation_send').execute({ sessionId: 'session-aaa', text: '会越线的问题' }, as('session-ddd'))
  const compacted = await tools.get('conversation_read').execute({ sessionId: 'session-aaa', messageId: asked3.messageId }, exec)
  assert.equal(compacted.trust, 'compacted_by_ask')
  assert.equal(compacted.reason, 'compaction-before-reply')
  assert.ok(compacted.compactionPoints.some((point) => point.seq < compacted.replySeq), '压缩点必须早于答复')
  harness.flags.compactionOnNextReply = false

  // 有并发输入（真人插话）→ unknown（宁可多翻一次书）
  harness.flags.noiseOnNextPrompt = true
  const asked4 = await tools.get('conversation_send').execute({ sessionId: 'session-aaa', text: '有噪声的问题' }, as('session-eee'))
  const noisy = await tools.get('conversation_read').execute({ sessionId: 'session-aaa', messageId: asked4.messageId }, exec)
  assert.equal(noisy.trust, 'unknown')
  assert.equal(noisy.reason, 'concurrent-input')
  harness.flags.noiseOnNextPrompt = false

  // 但**非真人**的 user 角色消息（模型切换提示等）不得算成并发噪声
  harness.flags.nonHumanNoiseOnNextPrompt = true
  const asked5 = await tools.get('conversation_send').execute({ sessionId: 'session-aaa', text: '有系统注入的问题' }, as('session-fff'))
  const injected = await tools.get('conversation_read').execute({ sessionId: 'session-aaa', messageId: asked5.messageId }, exec)
  assert.notEqual(injected.trust, 'unknown', '模型切换提示这类注入不得把 trust 打成 unknown')
  harness.flags.nonHumanNoiseOnNextPrompt = false

  // 本插件自己投递的另一条跨对话消息（rpcId 带 bridge- 前缀）也不得算成真人并发：
  // 否则多轮往返（A问B → B反问A → A回B）会把上一条提问的 trust 打成 unknown —— 插件自我污染
  harness.flags.bridgeNoiseOnNextPrompt = true
  const asked6b = await tools.get('conversation_send').execute({ sessionId: 'session-aaa', text: '多轮往返里的另一问' }, as('session-iii'))
  const afterBridgeNoise = await tools.get('conversation_read').execute({ sessionId: 'session-aaa', messageId: asked6b.messageId }, exec)
  assert.notEqual(afterBridgeNoise.trust, 'unknown', '带 bridge- 前缀的跨对话消息不得被算成真人并发插话')
  assert.notEqual(afterBridgeNoise.reason, 'concurrent-input')
  harness.flags.bridgeNoiseOnNextPrompt = false

  // 不给 messageId → 只能给 unknown，不得假装可信
  const bare = await tools.get('conversation_read').execute({ sessionId: 'session-aaa' }, exec)
  assert.equal(bare.trust, 'unknown')
  assert.equal(bare.reason, 'no-message-id')

  // 真机时序：对方先落一条"只有工具调用、没有文本"的助手帧，再落答案。
  // 旧判定把工具调用帧当成答复（还报 clean），调用方以为拿到答案了。
  harness.flags.toolCallOnNextReply = true
  const asked6 = await tools.get('conversation_send').execute({ sessionId: 'session-clean', text: '先跑工具再答' }, as('session-ggg'))
  // 只保留了工具调用那一帧：绝不能算"已答"
  harness.flags.replyOnNextPrompt = false
  const midStep = await tools.get('conversation_read').execute({ sessionId: 'session-clean', messageId: asked6.messageId }, exec)
  assert.equal(midStep.answered, false, `只有工具调用帧时绝不能算"已答"（reason=${midStep.reason} trust=${midStep.trust} q=${midStep.questionSeq} r=${midStep.replySeq}）`)
  assert.equal(midStep.reason, 'reply-pending-tool-call', '要把"它还在跑工具"和"它还没开始答"区分开')
  // 再问一次：这次会话里已有"提问→答复"历史，验证不会把**提问之前**的旧答复当成这次的答复
  harness.flags.replyOnNextPrompt = true
  harness.flags.toolCallOnNextReply = false
  const asked7 = await tools.get('conversation_send').execute({ sessionId: 'session-clean', text: '又问一次' }, as('session-hhh'))
  const done = await tools.get('conversation_read').execute({ sessionId: 'session-clean', messageId: asked7.messageId }, exec)
  assert.equal(done.answered, true, `这次提问有自己的答复 → 算答完（reason=${done.reason} trust=${done.trust} q=${done.questionSeq} r=${done.replySeq} 消息数=${done.messages.length} 日志长度=${harness.logs.get('session-clean').length}）`)
  assert.ok(done.replySeq > done.questionSeq, '答复锚点必须落在提问之后')
  assert.match(done.messages.map((message) => message.text).join('\n'), /答复：结论 Z/, '要能读到真正的答复文本')
  harness.flags.toolCallOnNextReply = false
}

/* 9. 护栏：自问 / 环路 / 深度 / 冷却 */
{
  const harness = createHarness()
  apply(harness.ctx, { ask: { maxDepth: 3, pairCooldownMs: 0 } })
  const tools = toolMap(harness.tools)
  const asB = { agent: { session: { id: 'session-bbb', header: {} } } }
  const asA = { agent: { session: { id: 'session-aaa', header: {} } } }

  await assert.rejects(() => tools.get('conversation_send').execute({ sessionId: 'session-bbb', text: 'q' }, asB), /不能给自己发消息/)

  await tools.get('conversation_send').execute({ sessionId: 'session-aaa', text: '第一次' }, asB)
  await assert.rejects(() => tools.get('conversation_send').execute({ sessionId: 'session-bbb', text: '回信回来' }, asA), /环路/)

  // 深度：maxDepth=0 时任何回问都超限
  const shallow = createHarness()
  apply(shallow.ctx, { ask: { maxDepth: 0 } })
  const shallowTools = toolMap(shallow.tools)
  await assert.rejects(
    () => shallowTools.get('conversation_send').execute({ sessionId: 'session-aaa', text: 'q' }, asB),
    /深度上限/,
  )

  // 冷却
  const cooled = createHarness()
  apply(cooled.ctx, { ask: { pairCooldownMs: 600000 } })
  const cooledTools = toolMap(cooled.tools)
  await cooledTools.get('conversation_send').execute({ sessionId: 'session-aaa', text: '第一次' }, asB)
  await assert.rejects(() => cooledTools.get('conversation_send').execute({ sessionId: 'session-aaa', text: '又来' }, asB), /刚问过/)
}

/* 9b. 双向管道：任意两个对话之间互塞消息（A→B 提问、B→A 回信，同一个工具） */
{
  const harness = createHarness()
  apply(harness.ctx, { ask: { pairCooldownMs: 600000 } })
  const tools = toolMap(harness.tools)
  const asA = { agent: { session: { id: 'session-aaa', header: {} } } }
  const asB = { agent: { session: { id: 'session-bbb', header: {} } } }
  const send = tools.get('conversation_send')

  // A 问过 B 之后，B 回信不得被"刚问过这个对话"的同对冷却拦住（回信是答复，不是新提问）
  await send.execute({ sessionId: 'session-aaa', text: '把结论给我' }, asB)
  const back = await send.execute({ sessionId: 'session-bbb', text: '结论 Z 已验证', reply: true }, asA)
  assert.equal(back.accepted, true)
  assert.equal(back.mode, 'steer', '回信默认也是插入式（插进对方下一步）')
  assert.equal(back.woken, true)
  assert.ok(back.messageId.length > 0, '每次投递都要给锚点，供之后 read')
  const sent = harness.calls.prompt.at(-1)
  assert.equal(sent.mode, 'steer')
  assert.equal(sent.sessionId, 'session-bbb')
  assert.match(sent.content[0].text, /结论 Z 已验证/)
  assert.match(sent.content[0].text, /sessionId=session-aaa/, '正文要写明是谁发的，对方才知道怎么回')

  // reply=true：这是答复（不是新提问）—— 不包窄指令、落款仍然告诉对方要回时怎么回
  const notice = await send.execute({ sessionId: 'session-bbb', text: '进度：还在跑', reply: true }, asA)
  assert.equal(notice.narrow, false, '答复不包窄指令')
  const noticeBody = harness.calls.prompt.at(-1).content[0].text
  assert.doesNotMatch(noticeBody, /只回答下面这个问题/, '答复不得包窄指令')
  assert.match(noticeBody, /conversation_send/, '落款要写明要回时怎么回')

  // wake:false → 只入队不唤醒，模式降级为 queue
  const quiet = await send.execute({ sessionId: 'session-bbb', text: '进度：还在跑', reply: true, wake: false }, asA)
  assert.equal(quiet.woken, false)
  assert.equal(harness.calls.prompt.at(-1).mode, 'queue')

  await assert.rejects(() => send.execute({ sessionId: 'session-bbb', text: 'x' }, asB), /不能给自己发消息/)
  await assert.rejects(() => send.execute({ sessionId: 'session-aaa', text: '   ' }, asB), /需要 text/)

  // 发送方自己是**子 agent 会话**时：落款里的回信地址必须换成它的父对话。
  // 子 agent 收不到任何投递，照它自己的 sessionId 回信会被宿主围栏拒——真机实测的闭环断点就在这里。
  const asSub = { agent: { session: { id: 'session-sub', header: { origin: 'subagent', parentSession: 'session-aaa' } } } }
  const fromSub = await send.execute({ sessionId: 'session-bbb', text: '子 agent 的结论：端口 8099' }, asSub)
  assert.equal(fromSub.relayed, true, '要标记发生了中继')
  assert.equal(fromSub.replyTo, 'session-aaa', '回信地址必须是父对话')
  const subBody = harness.calls.prompt.at(-1).content[0].text
  assert.match(subBody, /sessionId=session-aaa/, '落款必须指向父对话，否则对方回信必被拒')
  assert.match(subBody, /\[中继说明\]/, '要说明这条是子 agent 发出的')
  assert.doesNotMatch(subBody, /回它：用 `conversation_send`（sessionId=session-sub）/, '不能把子 agent 自己当回信地址')

  // B 觉得 A 问得不清楚 → 反问 A → A 答回去 → B 再给结论。
  // 反问与新提问走的是同一个动作，区别只在 reply 标记；护栏不该拦这条链。
  const harness3 = createHarness()
  apply(harness3.ctx, { ask: { pairCooldownMs: 600000, maxDepth: 3 } })
  const tools3 = toolMap(harness3.tools)
  const execA = { agent: { session: { id: 'session-aaa', header: {} } } }
  const execB = { agent: { session: { id: 'session-bbb', header: {} } } }
  const q1 = await tools3.get('conversation_send').execute({ sessionId: 'session-bbb', text: '上个报错的根因是什么' }, execA)
  const clarify = await tools3.get('conversation_send').execute({ sessionId: 'session-aaa', text: '你指的是哪个模块的报错？', reply: true }, execB)
  assert.equal(clarify.accepted, true, 'B 反问 A 必须能发出去（冷却/环路不得拦答复）')
  const answer = await tools3.get('conversation_send').execute({ sessionId: 'session-bbb', text: '就是缓存游标那条', reply: true }, execA)
  assert.equal(answer.accepted, true, 'A 答回去也必须能发出去')
  const conclusion = await tools3.get('conversation_send').execute({ sessionId: 'session-aaa', text: '根因是缓存游标没过期', reply: true }, execB)
  assert.equal(conclusion.accepted, true, 'B 最后给结论也必须能发出去')
  // 四次投递都落在各自的会话日志里，锚点各不相同
  const ids = [q1.messageId, clarify.messageId, answer.messageId, conclusion.messageId]
  assert.equal(new Set(ids).size, 4, '每条消息都要有自己的锚点')

  // 两个普通对话（都不是对方的子会话）来回传话：这正是"任意 agent 之间"的管道
  const harness2 = createHarness()
  apply(harness2.ctx, { ask: { pairCooldownMs: 0 } })
  const tools2 = toolMap(harness2.tools)
  const execX = { agent: { session: { id: 'session-X', header: {} } } }
  const execY = { agent: { session: { id: 'session-Y', header: {} } } }
  // 两边都是日志里没有的新会话：send 走 prompt 会现场建出它们
  const asked = await tools2.get('conversation_send').execute({ sessionId: 'session-Y', text: 'X 问 Y' }, execX)
  assert.equal(asked.accepted, true)
  const replied = await tools2.get('conversation_send').execute({ sessionId: 'session-X', text: 'Y 回 X', reply: true }, execY)
  assert.equal(replied.accepted, true)
}

/* 9c. 投递围栏：子 agent 会话 / 被活子 agent 持有的会话都不能投，且要说人话 */
{
  const harness = createHarness()
  apply(harness.ctx, { ask: { maxDepth: 3, pairCooldownMs: 0 } })
  const tools = toolMap(harness.tools)
  const asB = { agent: { session: { id: 'session-bbb', header: {} } } }

  // 目标是子 agent 会话 → 提前拒，且不浪费一次 prompt
  const before = harness.calls.prompt.length
  await assert.rejects(
    () => tools.get('conversation_send').execute({ sessionId: 'session-sub', text: '在吗' }, asB),
    /由子 agent 路由持有/,
  )
  assert.equal(harness.calls.prompt.length, before, '预检命中时不应真去投递')

  // 目标正被一个活着的子 agent 持有 → 宿主会拒，插件要把宿主的话翻译成可操作提示
  const held = createHarness({ heldTarget: 'session-aaa' })
  apply(held.ctx, { ask: { maxDepth: 3, pairCooldownMs: 0 } })
  const heldSend = toolMap(held.tools).get('conversation_send')
  await assert.rejects(
    () => heldSend.execute({ sessionId: 'session-aaa', text: '在吗' }, asB),
    /由子 agent 路由持有|等它那个子 agent 跑完/,
  )
}

/* 10. 只读不唤醒：只读工具全程不得碰 resolveAgent */
{
  const harness = createHarness()
  apply(harness.ctx, {})
  const tools = toolMap(harness.tools)
  const before = harness.calls.resolveAgent
  const exec = { agent: { session: { id: 'session-bbb', header: {} } } }
  await tools.get('conversation_list').execute({}, exec)
  await tools.get('conversation_context').execute({ sessionId: 'session-aaa' }, exec)
  await tools.get('conversation_outline').execute({ sessionId: 'session-aaa' }, exec)
  await tools.get('conversation_search').execute({ sessionId: 'session-aaa', query: 'X=42' }, exec)
  await tools.get('conversation_read').execute({ sessionId: 'session-aaa', atSeq: 4 }, exec)
  assert.equal(harness.calls.resolveAgent, before, '只读路径绝不能调用 resolveAgent（那会唤醒对方）')
}

/* 11. conversation_start：建对话 + 接力头 + 改标题 + **归入正确分组** */
{
  const harness = createHarness()
  apply(harness.ctx, {})
  const tools = toolMap(harness.tools)
  const exec = { agent: { session: { id: 'session-aaa', header: { cwd: '<工作区>', agentPreset: 'code' } } } }
  const value = await tools.get('conversation_start').execute({ title: '接力-2', message: '交接件正文' }, exec)
  assert.equal(value.sessionId, 'session-new')
  assert.equal(value.parentSessionId, 'session-aaa')
  assert.equal(value.messageSent, true)
  // 关键：必须先按目录解析出 workspace，再传 workspaceId —— 只传 cwd 会落到"未分组"
  assert.deepEqual(harness.calls.create.at(-1), { workspaceId: 'ws-project', agentPreset: 'code' })
  assert.equal(value.grouped, true)
  assert.equal(value.workspaceId, 'ws-project')
  assert.equal(value.cwd, '<工作区>', '报告的工作目录应来自 workspace 的路径')
  const body = harness.calls.prompt.at(-1).content[0].text
  assert.match(body, /\[接力对话\]/)
  assert.match(body, /conversation_send/)
  assert.match(body, /conversation_search/)
  assert.match(body, /交接件正文/)
  assert.doesNotMatch(body, /mnemon|memorySinks|记忆插件/, '绝不能提及任何记忆插件')
  assert.equal(value.relayed, false, '普通对话开窗不发生中继')
  assert.equal(value.contactSessionId, 'session-aaa')

  // 发起开窗的本身是**子 agent 会话**：接力头里的回信地址必须换成它的父对话，
  // 否则新对话照接力头回信会被宿主围栏拒（子 agent 会话收不到投递）
  const subExec = {
    agent: {
      session: {
        id: 'session-sub',
        header: { cwd: '<工作区>', origin: 'subagent', parentSession: 'session-aaa', agentPreset: 'code' },
      },
    },
  }
  const subStart = await tools.get('conversation_start').execute({ title: '子-agent 交接', message: '交接件正文' }, subExec)
  assert.equal(subStart.relayed, true, '要标记发生了中继')
  assert.equal(subStart.parentSessionId, 'session-sub', '交接人仍如实记为发起者')
  assert.equal(subStart.contactSessionId, 'session-aaa', '回信地址必须是父对话')
  const subBody = harness.calls.prompt.at(-1).content[0].text
  assert.match(subBody, /sessionId=`session-aaa`/, '接力头回信地址必须是父对话')
  assert.match(subBody, /子 agent 会话/, '要说明为什么地址不是它自己')
  assert.doesNotMatch(subBody, /conversation_send`（sessionId=`session-sub`）/, '不能把子 agent 自己当回信地址')

  // 解析不到 workspace（目录未登记 / 没有 registry）→ 退回只给 cwd，且如实报告未分组
  const loose = createHarness({ noWorkspaceRegistry: true })
  apply(loose.ctx, {})
  const looseTools = toolMap(loose.tools)
  const fallback = await looseTools.get('conversation_start').execute({ title: '无分组' }, {
    agent: { session: { id: 'session-aaa', header: { cwd: '<工作区>' } } },
  })
  assert.deepEqual(loose.calls.create.at(-1), { cwd: '<工作区>' })
  assert.equal(fallback.grouped, false)
  assert.match(looseTools.get('conversation_start').output.render({}, fallback)[0].text, /未分组/)

  // 显式 workspaceId 优先于按目录解析（agent preset 仍继承）
  const explicit = await tools.get('conversation_start').execute({ workspaceId: 'ws-other' }, exec)
  assert.deepEqual(harness.calls.create.at(-1), { workspaceId: 'ws-other', agentPreset: 'code' })
  assert.equal(explicit.grouped, true)
  assert.equal(explicit.cwd, '<工作区>', '查不到该 workspace 路径时退回算出来的 cwd')

  // 未登记为 workspace 的目录 → 不硬塞分组
  const other = await tools.get('conversation_start').execute({ cwd: 'D:\\somewhere-else' }, exec)
  assert.deepEqual(harness.calls.create.at(-1), { cwd: 'D:\\somewhere-else', agentPreset: 'code' })
  assert.equal(other.grouped, false)
}

/* 12. 降级与"服务后到"：
   a) 完全没有宿主服务 → 只留不依赖会话服务的本地工具（交接件读写），不抛错
   b) sessionController 冷启动时未就绪 → 本地工具先注册，服务就绪后跨对话工具补上
   —— (b) 是真机上踩到的坑：apply 里用 ctx.get() 探测会把工具静默丢掉 */
{
  const bare = createHarness({ bare: true })
  apply(bare.ctx, {})
  assert.deepEqual(
    bare.tools.map((definition) => definition.name).sort(),
    ['conversation_handoff_write', 'conversation_handoffs'],
    '没有宿主服务时应保留本地交接件工具',
  )

  const late = createHarness()
  late.setLive('sessionController', false)
  apply(late.ctx, { handoff: { cooldownMs: 0 } })
  assert.deepEqual(
    late.tools.map((definition) => definition.name).sort(),
    ['conversation_handoff_write', 'conversation_handoffs'],
    'sessionController 未就绪时，跨对话工具不得注册，但本地工具必须已经注册',
  )
  late.setLive('sessionController', true)
  const names = late.tools.map((definition) => definition.name)
  assert.equal(names.length, 9, 'sessionController 就绪后应补齐跨对话工具')
  assert.ok(names.includes('conversation_send'))
  assert.ok(names.includes('conversation_send'), '管道工具对所有对话可见（工具是全局注册，不是给谁单独装的）')
  assert.equal(new Set(names).size, 9, '不得重复注册')
}

/* 13. 配置合并 */
{
  assert.equal(resolveConfig({}).ask.maxDepth, 3)
  assert.equal(resolveConfig({ ask: { maxDepth: 1 } }).ask.maxDepth, 1)
  assert.equal(resolveConfig({ ask: { maxDepth: 1 } }).archive.maxHits, 20, '局部覆盖不得清掉兄弟字段')
  assert.equal(resolveConfig({ ask: { defaultMode: 'queue' } }).ask.defaultMode, 'queue', '显式 queue 要保留（不打断对方当前回合）')
  assert.equal(resolveConfig({ ask: { defaultMode: 'nope' } }).ask.defaultMode, 'steer', '非法值回落默认：插入式')
  assert.equal(resolveConfig({}).ask.defaultMode, 'steer', '默认必须是插入式，且与 cordis.patch.yml 一致')
  assert.match(resolveConfig({}).ask.replyGuide, /\{\{fromSessionId\}\}/, '回信指引必须留发信人占位符')
  assert.equal(resolveConfig({ ask: { maxDepth: 999 } }).ask.maxDepth, 20, '越界值收敛到上限')
  assert.match(resolveConfig({ ask: { narrowTemplate: 'Q: {{question}}' } }).ask.narrowTemplate, /\{\{question\}\}/)
}

/* 14. 交接件：四段是硬契约（缺段/过短必须被拒），合法则原子落盘 */
const tmpDirs = []
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'cb-handoff-'))
  tmpDirs.push(dir)
  return dir
}
{
  const dir = await tempDir()
  const harness = createHarness()
  apply(harness.ctx, { handoff: { dir } })
  const write = toolMap(harness.tools).get('conversation_handoff_write')
  const exec = { agent: { session: { id: 'session-aaa', header: { cwd: dir } } } }
  const long = (tag) => `${tag}`.repeat(40)

  await assert.rejects(
    () => write.execute({ taskState: long('状态'), goals: long('目标'), deadEnds: '', nextSteps: long('下一步') }, exec),
    /缺少段落：已试方案与失败原因/,
  )
  await assert.rejects(
    () => write.execute({ taskState: long('状态'), goals: long('目标'), deadEnds: '太短', nextSteps: long('下一步') }, exec),
    /段落太短/,
  )

  const written = await write.execute({
    taskState: long('状态'), goals: long('目标'), deadEnds: long('弯路'), nextSteps: long('下一步'), title: '演示交接',
  }, exec)
  assert.match(written.file, /handoff-\d{8}-\d{9}-[a-z0-9]+-[a-z0-9]{4}\.md$/, '文件名要带时间戳(含毫秒)、来源短 id 与防撞尾巴')
  assert.ok(written.bytes > 200)

  const raw = await readFile(written.file, 'utf8')
  assert.match(raw, /^---\n/, '必须带头部元信息')
  assert.match(raw, /fromSessionId: session-aaa/)
  for (const heading of ['任务状态', '目标', '已试方案与失败原因', '进度与下一步']) {
    assert.match(raw, new RegExp(`## ${heading}`), `四个标题必须逐字渲染：${heading}`)
  }
  assert.match(raw, /# 演示交接/)

  // 同一目录重复写不冲突；目录页按时间倒序列出
  const second = await write.execute({
    taskState: long('状态2'), goals: long('目标2'), deadEnds: long('弯路2'), nextSteps: long('下一步2'), title: '第二份',
  }, exec)
  const list = toolMap(harness.tools).get('conversation_handoffs')
  const page = await list.execute({ limit: 10 }, exec)
  assert.equal(page.total, 2)
  assert.equal(page.handoffs.length, 2)
  assert.equal(page.handoffs[0].fromSessionId, 'session-aaa')
  assert.match(page.handoffs[0].heads['任务状态'], /状态/)

  const full = await list.execute({ file: second.file }, exec)
  assert.match(full.raw, /## 进度与下一步/)
  assert.equal(full.sectionText['目标'].startsWith('目标2'), true)

  await assert.rejects(() => list.execute({ file: 'C:\\Windows\\win.ini' }, exec), /必须位于/)
}

/* 15. 水位提醒：注入一次、不重复、回落后重新武装、交接后静默、子 agent 跳过 */
{
  const harness = createHarness()
  apply(harness.ctx, { handoff: { cooldownMs: 0, handoffQuietMs: 60000 } })
  const session = { id: 'session-live', header: { cwd: '<工作区>', origin: 'session' } }
  harness.liveAgents.set('session-live', { id: 'session-live', session })
  harness.setPressure({ contextWindow: 100000, pressureTokens: 80000, surfaceTokens: 0, sampledSurfaceTokens: 0 })

  const before = harness.calls.prompt.length
  harness.fire(session, 'assistant/message')
  await settle()
  assert.equal(harness.calls.prompt.length, before + 1, '超阈值应当注入一条提醒')
  const reminder = harness.calls.prompt.at(-1)
  assert.equal(reminder.sessionId, 'session-live')
  assert.equal(reminder.mode, 'steer')
  assert.match(reminder.content[0].text, /context_handoff/)
  assert.match(reminder.content[0].text, /80%/)
  assert.match(reminder.content[0].text, /conversation_handoff_write/)
  assert.doesNotMatch(reminder.content[0].text, /mnemon|记忆插件/, '提醒里不得提任何记忆插件')

  harness.fire(session, 'assistant/message')
  await settle()
  assert.equal(harness.calls.prompt.length, before + 1, '未重新武装前不得重复注入')

  // 回落到 rearmBelow 以下 → 重新武装 → 再次提醒（cooldown 为 0）
  harness.setPressure({ contextWindow: 100000, pressureTokens: 20000, surfaceTokens: 0, sampledSurfaceTokens: 0 })
  harness.fire(session, 'turn/end')
  harness.setPressure({ contextWindow: 100000, pressureTokens: 90000, surfaceTokens: 0, sampledSurfaceTokens: 0 })
  harness.fire(session, 'assistant/message')
  await settle()
  assert.equal(harness.calls.prompt.length, before + 2, '占比回落后应重新武装，再次提醒')

  // 子 agent 会话不提醒
  const sub = { id: 'session-subx', header: { origin: 'subagent', cwd: '<工作区>' } }
  harness.liveAgents.set('session-subx', { id: 'session-subx', session: sub })
  harness.fire(sub, 'assistant/message')
  await settle()
  assert.equal(harness.calls.prompt.length, before + 2, '子 agent 会话不提醒')
}

/* 16. 交接后静默：写完交接件，本对话不再被提醒 */
{
  const dir = await tempDir()
  const harness = createHarness()
  apply(harness.ctx, { handoff: { dir, cooldownMs: 0, handoffQuietMs: 600000 } })
  const session = { id: 'session-owner', header: { cwd: dir, origin: 'session' } }
  harness.liveAgents.set('session-owner', { id: 'session-owner', session })
  harness.setPressure({ contextWindow: 100000, pressureTokens: 85000, surfaceTokens: 0, sampledSurfaceTokens: 0 })

  const long = (tag) => `${tag}`.repeat(40)
  const write = toolMap(harness.tools).get('conversation_handoff_write')
  await write.execute({ taskState: long('状态'), goals: long('目标'), deadEnds: long('弯路'), nextSteps: long('下一步') }, { agent: { session } })

  const before = harness.calls.prompt.length
  harness.fire(session, 'assistant/message')
  await settle()
  assert.equal(harness.calls.prompt.length, before, '写完交接件后本对话应进入静默')
}

/* 17. 输出必须是无损 JSON（真机事故的回归）：任何 undefined/NaN 都会让整个工具结果作废 */
{
  const hasBadValue = (value, path = '$') => {
    if (value === undefined) return `${path} 是 undefined`
    if (typeof value === 'number' && !Number.isFinite(value)) return `${path} 是 ${value}`
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return `${path} 是 ${typeof value}`
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const bad = hasBadValue(value[index], `${path}[${index}]`)
        if (bad !== null) return bad
      }
      return null
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        const bad = hasBadValue(item, `${path}.${key}`)
        if (bad !== null) return bad
      }
    }
    return null
  }

  const harness = createHarness()
  apply(harness.ctx, {})
  const tools = toolMap(harness.tools)
  const exec = { agent: { session: { id: 'session-bbb', header: {} } } }

  // 夹具里的 user 消息没有 source.rpcId —— 正是让真机整页作废的那种消息
  const read = await tools.get('conversation_read').execute({ sessionId: 'session-aaa', limit: 50 }, exec)
  assert.ok(read.messages.some((message) => message.role === 'user'), '夹具里应当有人类 user 消息')
  assert.equal(hasBadValue(read), null, `工具输出必须无损 JSON：${hasBadValue(read)}`)
  assert.ok(!('rpcId' in read.messages.find((message) => message.role === 'user')), '缺 rpcId 时不得写出该键')

  // 其它工具的常见返回值也过一遍
  for (const [name, args] of [
    ['conversation_list', { withOccupancy: true }],
    ['conversation_context', { sessionId: 'session-aaa' }],
    ['conversation_outline', { sessionId: 'session-aaa' }],
    ['conversation_search', { sessionId: 'session-aaa', query: 'X=42' }],
    ['conversation_read', { sessionId: 'session-aaa', limit: 5 }],
  ]) {
    const value = await tools.get(name).execute(args, exec)
    assert.equal(hasBadValue(value), null, `${name} 的输出必须无损 JSON：${hasBadValue(value)}`)
  }
}

/* 18. 子 agent 会话：必须用 {kind:'subagent'} 地址读（真机报 subagent Sessions require their durable parent address） */
{
  const harness = createHarness()
  apply(harness.ctx, {})
  const tools = toolMap(harness.tools)
  const exec = { agent: { session: { id: 'session-bbb', header: {} } } }

  // 自动识别：session-sub 在摘要里是 origin=subagent，插件应自己换成 subagent 地址
  const value = await tools.get('conversation_read').execute({ sessionId: 'session-sub', limit: 10 }, exec)
  assert.ok(value.messages.some((message) => message.text.includes('端口号 8099')), '子 agent 会话的日志应能读到')
  const subCall = harness.calls.page.find((call) => call.sessionId === 'session-sub')
  assert.equal(subCall.addressKind, 'subagent', '必须用 subagent 地址，否则宿主拒绝')
  assert.ok(['unknown', 'continuable', 'one-shot'].includes(subCall.addressMode))

  // 显式给父地址也应工作
  const explicit = await tools.get('conversation_read').execute(
    { sessionId: 'session-sub', parentSessionId: 'session-aaa', mode: 'continuable', limit: 10 }, exec)
  assert.ok(explicit.messages.length > 0)

  // 占用：实测口径是围栏只在 page 上，projections 照样能读（返回 cached 值）
  const context = await tools.get('conversation_context').execute({ sessionId: 'session-sub' }, exec)
  assert.equal(context.available, true)
  assert.equal(context.source, 'cached')
  assert.equal(context.scannedRange.reachedStart, true)
}

/* 19. atSeq 必须精确：指到非消息事件时报错，不许静默给别的位置 */
{
  const harness = createHarness()
  apply(harness.ctx, {})
  const tools = toolMap(harness.tools)
  const exec = { agent: { session: { id: 'session-bbb', header: {} } } }
  // seq=3 是 tool/call（非消息事件）
  await assert.rejects(
    () => tools.get('conversation_read').execute({ sessionId: 'session-aaa', atSeq: 3 }, exec),
    /不是可读消息/,
  )
  const hit = await tools.get('conversation_read').execute({ sessionId: 'session-aaa', atSeq: 4 }, exec)
  assert.equal(hit.requestedSeq, 4)
  assert.equal(hit.actualSeq, 4)
}

/* 20. 交接件：写入返回的绝对路径可以直接回读（不必再传 cwd） */
{
  const dir = await tempDir()
  const harness = createHarness()
  apply(harness.ctx, { handoff: { dir } })
  const tools = toolMap(harness.tools)
  const long = (tag) => `${tag}`.repeat(40)
  const other = { agent: { session: { id: 'session-aaa', header: { cwd: 'D:\\somewhere-else' } } } }
  const written = await tools.get('conversation_handoff_write').execute(
    { taskState: long('状态'), goals: long('目标'), deadEnds: long('弯路'), nextSteps: long('下一步') }, other)
  const full = await tools.get('conversation_handoffs').execute({ file: written.file }, other)
  assert.match(full.raw, /## 进度与下一步/)
  // 但仍不得读到插件目录之外的任意文件
  await assert.rejects(
    () => tools.get('conversation_handoffs').execute({ file: 'C:\\Windows\\win.ini' }, other),
    /交接件必须位于/,
  )
}

for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true })

console.log('smoke ok: 9 个工具 + 双向管道(steer 插话/回信) + 压缩点/可信度四态(含工具调用帧与旧答复) + 护栏 + 只读不唤醒 + 交接件硬契约 + 水位提醒 + 降级 + 配置合并 + 无损 JSON + 子 agent 地址 + atSeq 精确')
