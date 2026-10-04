// dsh-conversation-bridge 冒烟测试：不连真实 Harness，用一个假 ctx 走通全部代码路径。
// 运行：node test/smoke.mjs
import assert from 'node:assert/strict'
import { apply, resolveConfig, name, inject } from '../index.js'

const calls = { prompt: [], create: [], rename: [], page: [], list: [] }
const listeners = new Map()
const liveAgents = new Map()

const sessionA = {
  id: 'session-aaa',
  header: { cwd: '<工作区>', origin: 'session', agentPreset: 'code' },
  requestContext: () => ({ contextWindow: 100000 }),
}

const LOW = { contextWindow: 100000, pressureTokens: 10000, surfaceTokens: 5000, sampledSurfaceTokens: 5000 }
const HIGH = { contextWindow: 100000, pressureTokens: 80000, surfaceTokens: 0, sampledSurfaceTokens: 0 }
let pressure = LOW

const services = {
  sessionController: {
    async list() {
      return {
        items: [
          { sessionId: 'session-aaa', updatedAt: 200, running: true, blank: false, cwd: '<工作区>', agentAvailable: true, projections: { values: { title: '当前对话' } } },
          { sessionId: 'session-bbb', updatedAt: 300, running: false, blank: false, cwd: '<工作区>', agentAvailable: false, projections: { values: { title: '上一段对话' } } },
          { sessionId: 'session-ccc', updatedAt: 400, running: false, blank: false, origin: 'subagent', agentAvailable: false },
        ],
      }
    },
    async create(request) {
      calls.create.push(request)
      return { sessionId: 'session-new-1', agentPreset: request.agentPreset }
    },
    async rename(request) {
      calls.rename.push(request)
      return { title: request.title, seq: 1 }
    },
    async prompt(request, signal) {
      // 真实宿主：@Remote 包装层会对 signal 调 throwIfAborted()，漏传即抛 TypeError。
      if (signal === undefined || typeof signal.throwIfAborted !== 'function') {
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
      }
      calls.prompt.push(request)
      return { accepted: true }
    },
    async page(request) {
      calls.page.push(request)
      return {
        hasMore: false,
        records: [
          { type: 'event', event: { type: 'user/message', data: { content: [{ type: 'text', text: '问题一' }] } } },
          { type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '想想' }, { type: 'text', text: '答案一' }] } } } },
          { type: 'event', event: { type: 'tool/call', data: { name: 'x' } } },
        ],
      }
    },
    async projections() {
      return { asOfSeq: 10, values: { title: '上一段对话' } }
    },
    async resolveAgent(sessionId) {
      return { agent: { id: sessionId, session: { id: sessionId, header: {}, requestContext: () => ({ contextWindow: 100000 }) } } }
    },
  },
  sessionProjections: {
    stateOf(session, key) {
      assert.equal(key, 'contextPressure')
      return session === sessionA ? pressure : undefined
    },
  },
  tokenMeter: { measure: () => ({ totalTokens: 1234 }) },
  agents: { get: (id) => liveAgents.get(String(id)) },
}

const ctx = {
  logger: { info() {}, warn() {} },
  registered: [],
  tools: {
    register(definition) {
      ctx.registered.push(definition)
      return () => {}
    },
  },
  on(event, listener) {
    const list = listeners.get(event) ?? []
    list.push(listener)
    listeners.set(event, list)
    return () => {}
  },
  get(key) {
    return services[key]
  },
}

const fire = (session, type) => {
  for (const listener of listeners.get('session/event')) listener(session, { type })
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/* ------------------------------------------------------------------ */

assert.equal(name, 'conversation-bridge')
assert.deepEqual(inject, ['tools'])

// cooldownMs=0 让"重复提醒"只受武装状态约束，便于测试；handoffQuietMs 保留默认量级。
apply(ctx, { cooldownMs: 0 })

const defs = new Map(ctx.registered.map((definition) => [definition.name, definition]))
assert.deepEqual(
  [...defs.keys()].sort(),
  ['conversation_context', 'conversation_list', 'conversation_read', 'conversation_send', 'conversation_start'],
)
for (const definition of defs.values()) {
  assert.equal(typeof definition.description, 'string')
  assert.equal(typeof definition.execute, 'function')
  assert.equal(typeof definition.output.render, 'function')
  assert.equal(definition.parameters.type, 'object')
}

const exec = { agent: { id: 'session-aaa', session: sessionA } }
liveAgents.set('session-aaa', exec.agent)

/* 1. conversation_list：默认排除子 agent，按最近活动排序，标出当前对话 */
{
  const value = await defs.get('conversation_list').execute({}, exec)
  assert.equal(value.total, 2)
  assert.equal(value.conversations[0].sessionId, 'session-bbb', '按最近活动排序')
  assert.equal(value.conversations[0].title, '上一段对话')
  assert.equal(value.conversations[1].current, true)
  assert.match(defs.get('conversation_list').output.render({}, value)[0].text, /session-bbb/)
  const withSub = await defs.get('conversation_list').execute({ includeSubagents: true }, exec)
  assert.equal(withSub.total, 3)
}

/* 2. conversation_send：queue / steer / 参数校验 */
{
  await defs.get('conversation_send').execute({ sessionId: 'session-bbb', message: '你好，请回顾' }, exec)
  assert.equal(calls.prompt.at(-1).sessionId, 'session-bbb')
  assert.equal(calls.prompt.at(-1).mode, 'queue')
  assert.equal(calls.prompt.at(-1).content[0].text, '你好，请回顾')
  await defs.get('conversation_send').execute({ sessionId: 'session-bbb', message: '打断一下', mode: 'steer' }, exec)
  assert.equal(calls.prompt.at(-1).mode, 'steer')
  await assert.rejects(() => defs.get('conversation_send').execute({ sessionId: '', message: 'x' }, exec))
  await assert.rejects(() => defs.get('conversation_send').execute({ sessionId: 'session-bbb', message: '  ' }, exec))
}

/* 3. conversation_read：只取 text 块，跳过 reasoning / tool-call */
{
  const value = await defs.get('conversation_read').execute({ sessionId: 'session-bbb' }, exec)
  assert.equal(value.title, '上一段对话')
  assert.deepEqual(value.messages, [
    { role: 'user', text: '问题一' },
    { role: 'assistant', text: '答案一' },
  ])
  assert.equal(calls.page.at(-1).throughSeq, -1)
}

/* 4. conversation_context：当前对话与指定对话 */
{
  pressure = LOW
  const own = await defs.get('conversation_context').execute({}, exec)
  assert.equal(own.available, true)
  assert.equal(own.sessionId, 'session-aaa')
  assert.equal(own.percent, 10)
  assert.equal(own.overThreshold, false)
  assert.equal((await defs.get('conversation_context').execute({ sessionId: 'session-bbb' }, exec)).sessionId, 'session-bbb')
}

/* 5. 功能 2：超过阈值注入一次提醒，且不重复刷屏 */
{
  pressure = HIGH
  const before = calls.prompt.length
  fire(sessionA, 'assistant/message')
  await settle()
  assert.equal(calls.prompt.length, before + 1, '应当注入一条提醒')
  const reminder = calls.prompt.at(-1)
  assert.equal(reminder.sessionId, 'session-aaa')
  assert.equal(reminder.mode, 'steer', '默认落进下一步并唤醒')
  assert.match(reminder.content[0].text, /context_handoff/)
  assert.match(reminder.content[0].text, /80%/)
  assert.match(reminder.content[0].text, /conversation_start/)
  assert.match(reminder.content[0].text, /session-aaa/)

  fire(sessionA, 'assistant/message')
  await settle()
  assert.equal(calls.prompt.length, before + 1, '未重新武装前不得重复注入')
}

/* 6. 占用回落后重新武装 */
{
  const before = calls.prompt.length
  pressure = { contextWindow: 100000, pressureTokens: 20000, surfaceTokens: 0, sampledSurfaceTokens: 0 }
  fire(sessionA, 'turn/end')
  pressure = { contextWindow: 100000, pressureTokens: 90000, surfaceTokens: 0, sampledSurfaceTokens: 0 }
  fire(sessionA, 'assistant/message')
  await settle()
  assert.equal(calls.prompt.length, before + 1, '回落后应当重新武装并再次提醒')
}

/* 7. 子 agent 会话不提醒 */
{
  const subSession = { id: 'session-sub', header: { origin: 'subagent' }, requestContext: () => ({ contextWindow: 1000 }) }
  const before = calls.prompt.length
  fire(subSession, 'assistant/message')
  await settle()
  assert.equal(calls.prompt.length, before, '子 agent 不提醒')
}

/* 8. conversation_start：建对话 + 改名 + 带交接头的开场消息 + 让本对话静默 */
{
  pressure = HIGH
  const value = await defs.get('conversation_start').execute({ title: '接力-2', message: '这里是交接文档全文' }, exec)
  assert.equal(value.sessionId, 'session-new-1')
  assert.equal(value.parentSessionId, 'session-aaa')
  assert.equal(value.messageSent, true)
  assert.deepEqual(calls.create.at(-1), { cwd: '<工作区>', agentPreset: 'code' })
  assert.deepEqual(calls.rename.at(-1), { sessionId: 'session-new-1', title: '接力-2' })
  const prompt = calls.prompt.at(-1)
  assert.equal(prompt.sessionId, 'session-new-1')
  assert.equal(prompt.mode, 'queue')
  assert.match(prompt.content[0].text, /\[接力对话\]/)
  assert.match(prompt.content[0].text, /session-aaa/)
  assert.match(prompt.content[0].text, /这里是交接文档全文/)
  assert.match(prompt.content[0].text, /conversation_send/)
}

/* 9. 交接后本对话保持静默：即使占用回落后再升高，也在 handoffQuietMs 内不打扰 */
{
  const before = calls.prompt.length
  pressure = { contextWindow: 100000, pressureTokens: 20000, surfaceTokens: 0, sampledSurfaceTokens: 0 }
  fire(sessionA, 'turn/end')
  pressure = HIGH
  fire(sessionA, 'assistant/message')
  fire(sessionA, 'request/context')
  await settle()
  assert.equal(calls.prompt.length, before, '交接后 quiet 窗口内不得再提醒本对话')
}

/* 10. 没有 sessionController 的部署：不注册工具、不抛错 */
{
  const bare = {
    logger: { info() {}, warn() {} },
    tools: { register() { throw new Error('不应注册工具') } },
    on() { return () => {} },
    get() { return undefined },
  }
  apply(bare, { enabled: false })
}

/* 11. 配置合并：patch 里的部分字段落在默认值之上 */
{
  const config = resolveConfig({ threshold: 0.5 })
  assert.equal(config.threshold, 0.5)
  assert.equal(config.deliver, 'steer')
  assert.equal(config.enabled, true)
  assert.ok(config.rearmBelow < 0.5)
  assert.equal(resolveConfig({ threshold: 5 }).threshold, 0.7, '非法阈值回落到默认')
  assert.equal(resolveConfig({ deliver: 'queue' }).deliver, 'queue')
  assert.equal(resolveConfig({ deliver: 'inject' }).deliver, 'steer', 'sessionController.prompt 没有 inject 模式')
  assert.equal(resolveConfig({}).reminderText.includes('{{percent}}'), true)
}

console.log('smoke ok: 5 个工具 + 上下文接力提醒 + 配置合并全部通过')
