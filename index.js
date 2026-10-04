/**
 * dsh-conversation-bridge — 跨对话通信 + 上下文接力提醒。
 *
 * 两个能力：
 *  1. 工具（模型可调用）：`conversation_list` / `conversation_start` /
 *     `conversation_send` / `conversation_read` / `conversation_context`
 *     —— 一个对话可以开新对话、向另一个对话发消息、读另一个对话的最新消息。
 *  2. 监听器：当某个对话的上下文占用达到阈值（默认 70%）时，向该对话注入一条
 *     上下文消息，提醒当前 AI 写交接文档并用 `conversation_start` 开启新对话。
 *
 * 依赖说明：本包刻意不 import 任何 `@deepseek-ai/*` 包（profile 的 node_modules
 * 里只有 cosmokit / schemastery），因此：
 *   - 工具用 `ctx.tools.register` 要求的原始 ToolDefinition 形状手写，不复刻 `defineTool`；
 *   - 消息一律通过官方 `ctx.sessionController.prompt` 准入，不复刻 `createUserMessage`。
 * 唯一的 import 是 Node 内建模块。
 *
 * @module dsh-conversation-bridge
 */

import { randomUUID } from 'node:crypto'

const PLUGIN = 'conversation-bridge'

export const name = PLUGIN

/** 只硬依赖工具注册表；其余服务用 ctx.get() 可选获取，缺失时降级而不是让插件不激活。 */
export const inject = ['tools']

const DEFAULT_REMINDER = `<context_handoff level="warning">
⚠️ 本对话上下文占用已达 {{percent}}%（约 {{tokens}} / {{window}} tokens，阈值 {{threshold}}%）。

请立刻做三件事：
1. **写交接文档**：把「当前目标 / 已完成与证据 / 未完成待办 / 关键文件与入口 / 外部阻塞与风险 / 下一步建议 / 本次踩过的坑」写清楚，优先落到工作区里的交接文件（例如 \`_handoff_<主题>.md\`），并在回复里给出摘要。
2. **开新对话交接**：调用 \`conversation_start\`，把交接文档全文作为 \`message\` 传进去。本对话 sessionId = \`{{sessionId}}\`，工作目录 = \`{{cwd}}\`；插件会自动把「如何回问上一段对话」写进新对话的开场消息。
3. **告诉用户**：已交接、新对话的 sessionId 是调用返回值里的那个、本对话可以继续用于关键追问。

若当前任务正处在不能中断的改动中途，先把改动落到安全状态（提交 / 落盘）再交接，不要带着未落盘的风险停手。
</context_handoff>`

const DEFAULT_HANDOFF_HEADER = `[接力对话] 这是一段由上下文接力产生的新对话，接替上一段对话。
- 上一段对话 sessionId = \`{{parentSessionId}}\`（标题：{{parentTitle}}；工作目录：{{parentCwd}}），交接原因：上下文占用 {{percent}}%。
- 需要向上一段对话追问：调用 \`conversation_send\`（sessionId=\`{{parentSessionId}}\`，message=你的问题）。
- 读取它的最新回复：调用 \`conversation_read\`（sessionId=\`{{parentSessionId}}\`）。
- 查看全部对话：\`conversation_list\`。`

const DEFAULTS = Object.freeze({
  exposeTools: true,
  enabled: true,
  threshold: 0.7,
  rearmBelow: 0.55,
  cooldownMs: 600000,
  handoffQuietMs: 1800000,
  deliver: 'steer',
  skipSubagents: true,
  handoffHeader: true,
  inheritCwd: true,
  inheritPreset: true,
  listLimit: 30,
  readLimit: 30,
  maxMessageChars: 4000,
  reminderText: DEFAULT_REMINDER,
  handoffHeaderText: DEFAULT_HANDOFF_HEADER,
})

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function readBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function readInteger(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function readRatio(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  if (value <= 0 || value >= 1) return fallback
  return value
}

function readText(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback
}

/** 用户 patch 里的 config 会整体替换默认 config，所以这里逐字段合并，而不是直接采用它。 */
export function resolveConfig(input) {
  const raw = asRecord(input)
  const threshold = readRatio(raw.threshold, DEFAULTS.threshold)
  // 重新武装的线必须严格低于阈值，否则"超过阈值"与"回落到线以下"会同时成立，提醒会被反复触发。
  const rearmBelow = Math.max(0, Math.min(readRatio(raw.rearmBelow, DEFAULTS.rearmBelow), threshold - 0.01, threshold * 0.9))
  return {
    exposeTools: readBoolean(raw.exposeTools, DEFAULTS.exposeTools),
    enabled: readBoolean(raw.enabled, DEFAULTS.enabled),
    threshold,
    rearmBelow,
    cooldownMs: readInteger(raw.cooldownMs, DEFAULTS.cooldownMs, 0, 24 * 3600 * 1000),
    handoffQuietMs: readInteger(raw.handoffQuietMs, DEFAULTS.handoffQuietMs, 0, 7 * 24 * 3600 * 1000),
    // sessionController.prompt 只支持 queue（下一轮）与 steer（本回合下一步）
    deliver: raw.deliver === 'queue' ? 'queue' : 'steer',
    skipSubagents: readBoolean(raw.skipSubagents, DEFAULTS.skipSubagents),
    handoffHeader: readBoolean(raw.handoffHeader, DEFAULTS.handoffHeader),
    inheritCwd: readBoolean(raw.inheritCwd, DEFAULTS.inheritCwd),
    inheritPreset: readBoolean(raw.inheritPreset, DEFAULTS.inheritPreset),
    listLimit: readInteger(raw.listLimit, DEFAULTS.listLimit, 1, 200),
    readLimit: readInteger(raw.readLimit, DEFAULTS.readLimit, 1, 200),
    maxMessageChars: readInteger(raw.maxMessageChars, DEFAULTS.maxMessageChars, 200, 200000),
    reminderText: readText(raw.reminderText, DEFAULTS.reminderText),
    handoffHeaderText: readText(raw.handoffHeaderText, DEFAULTS.handoffHeaderText),
  }
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function newId() {
  return randomUUID()
}

function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined ? String(vars[key]) : match)
}

function textBlocks(text) {
  return [{ type: 'text', text }]
}

function clip(text, max) {
  if (typeof text !== 'string') return ''
  return text.length > max ? `${text.slice(0, max)}\n…（已截断，原文 ${text.length} 字）` : text
}

/** 把一条消息的 content 块拼成纯文本（只取 text 块，丢掉推理与工具调用）。 */
function contentToText(content, max) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return clip(parts.join('\n').trim(), max)
}

/** 这些调用都很快，不需要把工具超时信号透传下去；用一个永不中止的信号即可。 */
function idleSignal() {
  return new AbortController().signal
}

/**
 * `ctx.sessionController` 的 `@Remote` 方法（prompt / page / list / projections）
 * 在包装层会对第二个 signal 参数直接调用 `signal.throwIfAborted()`，
 * 所以**每一个**这类调用都必须显式传一个 AbortSignal，漏传会抛
 * `Cannot read properties of undefined (reading 'throwIfAborted')`。
 * 工具执行上下文里有信号就透传它（工具被中止时同步中止宿主调用），否则用兜底信号。
 */
function signalOf(exec) {
  return exec?.signal ?? idleSignal()
}

function titleOfSummary(row) {
  const values = asRecord(asRecord(row).projections).values
  const title = asRecord(values).title
  return typeof title === 'string' ? title : ''
}

/* ------------------------------------------------------------------ *
 * 上下文占用
 * ------------------------------------------------------------------ */

/**
 * 读取一个会话当前的上下文占用。
 *
 * 优先使用官方 `contextPressure` 投影（与聊天输入框上方的上下文环同源）：
 * 其 wire 视图的 `projectedTokens = max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)`
 * 就是「下一次请求」的占用估计。投影不可用时退回到 `ctx.tokenMeter.measure()`。
 */
function readOccupancy(api, session) {
  if (session === undefined || session === null) return undefined
  let contextWindow
  let tokens
  try {
    const pressure = api.sessionProjections?.stateOf(session, 'contextPressure')
    if (pressure !== undefined && pressure !== null) {
      if (typeof pressure.contextWindow === 'number') contextWindow = pressure.contextWindow
      if (typeof pressure.pressureTokens === 'number') {
        const surface = typeof pressure.surfaceTokens === 'number' ? pressure.surfaceTokens : 0
        const sampled = typeof pressure.sampledSurfaceTokens === 'number' ? pressure.sampledSurfaceTokens : 0
        tokens = Math.max(0, pressure.pressureTokens + surface - sampled)
      }
    }
  } catch {
    /* 投影未注册或会话未挂载：走下面的兜底 */
  }
  if (contextWindow === undefined) {
    try {
      contextWindow = session.requestContext?.()?.contextWindow
    } catch {
      /* request/context 还没落库 */
    }
  }
  if (tokens === undefined) {
    try {
      tokens = api.tokenMeter?.measure(session)?.totalTokens
    } catch {
      /* 测量失败就当读不到 */
    }
  }
  if (typeof contextWindow !== 'number' || contextWindow <= 0) return undefined
  if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return undefined
  const ratio = tokens / contextWindow
  return {
    tokens: Math.max(0, Math.round(tokens)),
    contextWindow: Math.round(contextWindow),
    ratio,
    percent: Math.round(ratio * 1000) / 10,
  }
}

/* ------------------------------------------------------------------ *
 * 工具定义（原始 ToolDefinition，不依赖 defineTool）
 * ------------------------------------------------------------------ */

function tool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.output.schema,
      render: options.output.render,
    },
    async execute(args, exec) {
      return options.execute(asRecord(args), exec)
    },
  }
}

const CONVERSATION_ROW = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string' },
    title: { type: 'string' },
    cwd: { type: 'string' },
    running: { type: 'boolean' },
    blank: { type: 'boolean' },
    origin: { type: 'string' },
    parentSessionId: { type: 'string' },
    updatedAt: { type: 'integer' },
    current: { type: 'boolean' },
  },
}

function buildTools(api, config) {
  function requireController() {
    const controller = api.sessionController
    if (controller === undefined) throw new Error('conversation-bridge: 当前部署没有 sessionController 服务，跨对话能力不可用')
    return controller
  }

  return [
    /* ---------------- conversation_list ---------------- */
    tool({
      name: 'conversation_list',
      description:
        '列出本机所有 DSH 对话（会话），按最近活动排序，用于找到要发消息 / 要追问的那个对话。'
        + '每行给出 sessionId、标题、工作目录、是否运行中、是否空白、是否子 agent，以及是否就是当前对话。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', description: `最多返回多少行，默认 ${config.listLimit}` },
          includeSubagents: { type: 'boolean', description: '是否包含子 agent 会话（默认 false）' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            total: { type: 'integer' },
            conversations: { type: 'array', items: CONVERSATION_ROW },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.conversations.length === 0
            ? '没有找到对话。'
            : value.conversations.map((row) => [
              `${row.current ? '▶ ' : '  '}${row.sessionId}`,
              row.title ? ` 标题=${row.title}` : '',
              row.cwd ? ` cwd=${row.cwd}` : '',
              row.running ? ' [运行中]' : '',
              row.blank ? ' [空白]' : '',
              row.origin === 'subagent' ? ' [子agent]' : '',
            ].join('')).join('\n'),
        }],
      },
      async execute(args, exec) {
        const controller = requireController()
        const limit = readInteger(args.limit, config.listLimit, 1, 200)
        const value = await controller.list({}, idleSignal())
        const selfId = exec?.agent?.session?.id
        const rows = []
        for (const item of Array.isArray(value?.items) ? value.items : []) {
          if (item === null || typeof item !== 'object') continue
          if (!args.includeSubagents && item.origin === 'subagent') continue
          rows.push({
            sessionId: String(item.sessionId),
            title: titleOfSummary(item),
            cwd: typeof item.cwd === 'string' ? item.cwd : '',
            running: item.running === true,
            blank: item.blank === true,
            origin: typeof item.origin === 'string' ? item.origin : 'session',
            parentSessionId: item.parentSessionId === undefined ? '' : String(item.parentSessionId),
            updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
            current: selfId !== undefined && String(item.sessionId) === String(selfId),
          })
        }
        rows.sort((left, right) => right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId))
        return { total: rows.length, conversations: rows.slice(0, limit) }
      },
    }),

    /* ---------------- conversation_start ---------------- */
    tool({
      name: 'conversation_start',
      description:
        '开启一个全新的 DSH 对话（会话），并可立刻把第一条消息（例如交接文档全文）发进去。'
        + '新对话会出现在界面的对话列表里，并独立运行而不打断当前对话。'
        + '交接时把交接文档全文作为 message 传入；插件会自动在新对话开场消息前加上「如何回问上一段对话」的说明。'
        + '返回新对话的 sessionId 与工作目录。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', description: '新对话的第一条消息（交接时放交接文档全文）。省略则只创建空对话。' },
          title: { type: 'string', description: '给新对话起的标题，便于之后在列表里找到它。' },
          cwd: { type: 'string', description: '新对话的工作目录，默认继承当前对话的工作目录。' },
          agentPreset: { type: 'string', description: '新对话使用的 agent preset，默认继承当前对话。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string' },
            cwd: { type: 'string' },
            title: { type: 'string' },
            parentSessionId: { type: 'string' },
            messageSent: { type: 'boolean' },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `已开启新对话 sessionId=${value.sessionId}${value.cwd ? `（cwd=${value.cwd}）` : ''}。`
            + `${value.messageSent ? '开场消息已发送。' : '尚未发送任何消息。'}`
            + `${value.parentSessionId ? ` 上一段对话 sessionId=${value.parentSessionId}；新对话可用 conversation_send 回问本对话。` : ''}`,
        }],
      },
      async execute(args, exec) {
        const controller = requireController()
        const session = exec?.agent?.session
        const parentSessionId = session?.id === undefined ? '' : String(session.id)
        const parentCwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : ''
        const parentPreset = typeof session?.header?.agentPreset === 'string' ? session.header.agentPreset : ''

        const requestedCwd = typeof args.cwd === 'string' && args.cwd.trim().length > 0 ? args.cwd.trim() : ''
        const cwd = requestedCwd || (config.inheritCwd ? parentCwd : '')
        const requestedPreset = typeof args.agentPreset === 'string' && args.agentPreset.trim().length > 0
          ? args.agentPreset.trim()
          : ''
        const agentPreset = requestedPreset || (config.inheritPreset ? parentPreset : '')

        const request = {}
        if (cwd) request.cwd = cwd
        if (agentPreset) request.agentPreset = agentPreset
        const created = await controller.create(request)
        const sessionId = String(created.sessionId)

        const title = typeof args.title === 'string' && args.title.trim().length > 0 ? args.title.trim() : ''
        if (title) {
          try {
            await controller.rename({ sessionId, title })
          } catch (error) {
            ctxWarn(api, `新对话改名失败: ${String(error)}`)
          }
        }

        let messageSent = false
        const body = typeof args.message === 'string' ? args.message.trim() : ''
        if (body.length > 0) {
          const occupancy = readOccupancy(api, session)
          const header = config.handoffHeader && parentSessionId
            ? `${render(config.handoffHeaderText, {
              parentSessionId,
              parentTitle: title || '（未命名）',
              parentCwd: parentCwd || '（未设置）',
              percent: occupancy === undefined ? '未知' : occupancy.percent,
              sessionId,
              cwd: cwd || '（未设置）',
            })}\n\n---\n\n`
            : ''
          await controller.prompt({
            requestId: newId(),
            sessionId,
            mode: 'queue',
            content: textBlocks(`${header}${body}`),
          }, signalOf(exec))
          messageSent = true
        }

        if (parentSessionId) api.markHandedOff(parentSessionId)

        return {
          sessionId,
          cwd: cwd || '',
          title,
          parentSessionId,
          messageSent,
          note: '新对话已创建；需要它回答时给它发消息，它有问题时可用 conversation_send 回问本对话。',
        }
      },
    }),

    /* ---------------- conversation_send ---------------- */
    tool({
      name: 'conversation_send',
      description:
        '向另一个已存在的 DSH 对话发送一条消息；目标对话若处于冷态会被自动恢复并运行。'
        + 'mode=queue（默认）把消息排到目标对话的下一轮；mode=steer 插到它当前回合的下一步。'
        + '投递是异步的，对方回复不会立刻返回，请稍后用 conversation_read 读取。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'message'],
        properties: {
          sessionId: { type: 'string', description: '目标对话的 sessionId（可用 conversation_list 查）' },
          message: { type: 'string', description: '要发送的消息正文' },
          mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue=排到下一轮（默认）；steer=插到当前回合下一步' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string' },
            mode: { type: 'string' },
            accepted: { type: 'boolean' },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `消息已投递给对话 ${value.sessionId}（mode=${value.mode}）。对方处理完后可用 conversation_read 读取其最新回复。`,
        }],
      },
      async execute(args, exec) {
        const controller = requireController()
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
        const message = typeof args.message === 'string' ? args.message.trim() : ''
        if (sessionId.length === 0) throw new Error('conversation_send: sessionId 不能为空')
        if (message.length === 0) throw new Error('conversation_send: message 不能为空')
        const mode = args.mode === 'steer' ? 'steer' : 'queue'
        await controller.prompt({ requestId: newId(), sessionId, mode, content: textBlocks(message) }, signalOf(exec))
        return {
          sessionId,
          mode,
          accepted: true,
          note: '已投递。回复是异步产生的，请稍后用 conversation_read 读取。',
        }
      },
    }),

    /* ---------------- conversation_read ---------------- */
    tool({
      name: 'conversation_read',
      description:
        '读取另一个 DSH 对话最新的若干条消息（只读，不唤醒、不打断目标对话）。'
        + '用于回问上一段对话后取回它的答复。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string', description: '要读取的对话 sessionId' },
          limit: { type: 'integer', description: `最多读取多少条消息，默认 ${config.readLimit}` },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string' },
            title: { type: 'string' },
            hasMore: { type: 'boolean' },
            messages: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  role: { type: 'string' },
                  text: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.messages.length === 0
            ? `对话 ${value.sessionId} 还没有可读消息。`
            : `对话 ${value.sessionId}${value.title ? `（${value.title}）` : ''} 最近 ${value.messages.length} 条消息：\n\n`
              + value.messages.map((message) => `[${message.role}] ${message.text}`).join('\n\n'),
        }],
      },
      async execute(args) {
        const controller = requireController()
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
        if (sessionId.length === 0) throw new Error('conversation_read: sessionId 不能为空')
        const limit = readInteger(args.limit, config.readLimit, 1, 200)
        const page = await controller.page({
          address: { kind: 'session', sessionId },
          throughSeq: -1,
          maxMessages: limit,
        }, idleSignal())
        const messages = []
        for (const record of Array.isArray(page?.records) ? page.records : []) {
          const event = record?.event
          if (event === null || typeof event !== 'object') continue
          if (event.type === 'user/message') {
            const text = contentToText(event.data?.content, config.maxMessageChars)
            if (text.length > 0) messages.push({ role: 'user', text })
          } else if (event.type === 'assistant/message') {
            const text = contentToText(event.data?.message?.content, config.maxMessageChars)
            if (text.length > 0) messages.push({ role: 'assistant', text })
          }
        }
        let title = ''
        try {
          const baseline = await controller.projections({ sessionId }, idleSignal())
          const value = asRecord(asRecord(baseline).values).title
          if (typeof value === 'string') title = value
        } catch {
          /* 标题只是锦上添花 */
        }
        return { sessionId, title, hasMore: page?.hasMore === true, messages }
      },
    }),

    /* ---------------- conversation_context ---------------- */
    tool({
      name: 'conversation_context',
      description:
        '读取一个对话的上下文占用（token 数、上下文窗口、百分比、是否已超过接力阈值），默认当前对话。'
        + '用于确认是否需要写交接文档、以及交接后确认占用是否已经下降。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', description: '要查询的对话 sessionId，默认当前对话' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string' },
            available: { type: 'boolean' },
            tokens: { type: 'integer' },
            contextWindow: { type: 'integer' },
            percent: { type: 'number' },
            thresholdPercent: { type: 'number' },
            overThreshold: { type: 'boolean' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.available
            ? `上下文占用：${value.percent}%（约 ${value.tokens} / ${value.contextWindow} tokens，接力阈值 ${value.thresholdPercent}%）${value.overThreshold ? ' —— 已超过阈值，请写交接文档并开启新对话。' : ''}`
            : '读不到该对话的上下文占用（可能还没有发起过模型请求）。',
        }],
      },
      async execute(args, exec) {
        const requested = typeof args.sessionId === 'string' && args.sessionId.trim().length > 0
          ? args.sessionId.trim()
          : ''
        let session = exec?.agent?.session
        if (requested.length > 0 && String(session?.id) !== requested) {
          const controller = requireController()
          const resolution = await controller.resolveAgent(requested)
          const resolved = resolution?.agent ?? (resolution?.id === undefined ? undefined : resolution)
          if (resolved?.session !== undefined) session = resolved.session
          else if (resolution?.error !== undefined) throw resolution.error
          else throw new Error(`conversation_context: 找不到对话 ${requested}`)
        }
        const thresholdPercent = Math.round(config.threshold * 1000) / 10
        const occupancy = readOccupancy(api, session)
        if (occupancy === undefined) {
          return {
            sessionId: session?.id === undefined ? '' : String(session.id),
            available: false,
            tokens: 0,
            contextWindow: 0,
            percent: 0,
            thresholdPercent,
            overThreshold: false,
          }
        }
        return {
          sessionId: String(session.id),
          available: true,
          tokens: occupancy.tokens,
          contextWindow: occupancy.contextWindow,
          percent: occupancy.percent,
          thresholdPercent,
          overThreshold: occupancy.ratio >= config.threshold,
        }
      },
    }),
  ]
}

function ctxWarn(api, message) {
  try {
    api.logger?.warn?.(`${PLUGIN}: ${message}`)
  } catch {
    /* 日志失败不影响功能 */
  }
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

/**
 * @param ctx - 插件上下文（`ctx.tools` 由 inject 保证存在）。
 * @param input - cordis.patch.yml 里该行的 config。
 */
export function apply(ctx, input = {}) {
  const config = resolveConfig(input)

  /* ---- 每会话提醒状态（键为 sessionId 字符串） ---- */
  const states = new Map()

  function stateFor(sessionId) {
    const key = String(sessionId)
    let state = states.get(key)
    if (state === undefined) {
      state = { armed: true, lastRemindedAt: 0, handedOffAt: 0 }
      states.set(key, state)
    }
    return state
  }

  const api = {
    get sessionController() {
      return ctx.get('sessionController')
    },
    get sessionProjections() {
      return ctx.get('sessionProjections')
    },
    get tokenMeter() {
      return ctx.get('tokenMeter')
    },
    get logger() {
      return ctx.logger
    },
    /** conversation_start 成功后，本对话在该时长内不再被提醒。 */
    markHandedOff(sessionId) {
      const state = stateFor(sessionId)
      state.handedOffAt = Date.now()
      state.armed = false
    },
  }

  /* ---- 工具 ---- */
  if (config.exposeTools) {
    if (api.sessionController === undefined) {
      ctxWarn(api, '当前部署没有 sessionController 服务，跨对话工具未注册')
    } else {
      for (const definition of buildTools(api, config)) ctx.tools.register(definition)
    }
  }

  /* ---- 上下文接力提醒 ---- */
  if (config.enabled) {
    // 每个模型步骤都会提交 assistant/message（有正文）或 assistant/attempt（只有工具调用）；
    // request/context 只在路由/窗口变化时写；tool/result 会长大上下文表面。四类合起来
    // 足以在回合进行中就把"越过阈值"这件事看见，turn/end 再兜一次底。
    const watched = new Set(['assistant/message', 'assistant/attempt', 'request/context', 'tool/result', 'turn/end'])

    const evaluate = (session, reason) => {
      if (session === undefined || session === null) return
      if (config.skipSubagents && session.header?.origin === 'subagent') return
      const occupancy = readOccupancy(api, session)
      if (occupancy === undefined) return
      const state = stateFor(session.id)
      if (occupancy.ratio <= config.rearmBelow) {
        // 压缩或新对话让占用回落：重新武装，但保留 handedOffAt，
        // 于是刚交接完的对话在 handoffQuietMs 内也不会被再次打扰。
        state.armed = true
      }
      if (occupancy.ratio < config.threshold || !state.armed) return
      const now = Date.now()
      if (now - state.lastRemindedAt < config.cooldownMs) return
      if (now - state.handedOffAt < config.handoffQuietMs) return
      const agents = ctx.get('agents')
      const agent = agents?.get(session.id)
      if (agent === undefined) return
      const controller = api.sessionController
      if (controller === undefined) return

      state.armed = false
      state.lastRemindedAt = now
      const text = render(config.reminderText, {
        percent: occupancy.percent,
        tokens: occupancy.tokens,
        window: occupancy.contextWindow,
        threshold: Math.round(config.threshold * 1000) / 10,
        sessionId: String(session.id),
        cwd: typeof session.header?.cwd === 'string' ? session.header.cwd : '（未设置）',
        reason,
      })
      queueMicrotask(() => {
        controller.prompt({
          requestId: newId(),
          sessionId: session.id,
          mode: config.deliver,
          content: textBlocks(text),
        }, idleSignal()).then(
          () => ctx.logger?.info?.(`${PLUGIN}: 已向 ${String(session.id)} 注入上下文接力提醒（${occupancy.percent}%）`),
          (error) => ctxWarn(api, `向 ${String(session.id)} 注入提醒失败: ${String(error)}`),
        )
      })
    }

    ctx.on('session/event', (session, event) => {
      if (!watched.has(event?.type)) return
      try {
        evaluate(session, event.type)
      } catch (error) {
        ctxWarn(api, `上下文占用检查失败: ${String(error)}`)
      }
    })

    ctx.on('session/disposed', (session) => {
      states.delete(String(session?.id))
    })
  }

  ctx.logger?.info?.(
    `${PLUGIN}: 已启用（工具=${config.exposeTools ? '开' : '关'}，`
    + `接力提醒=${config.enabled ? `${Math.round(config.threshold * 100)}%` : '关'}，deliver=${config.deliver}）`,
  )
}
