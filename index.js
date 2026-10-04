/**
 * dsh-conversation-bridge —— 只管"交接"这一个问题的 DSH 插件。
 *
 * 三条取数通道（设计见 DESIGN.md）：
 *   1. 交接件（自持落盘，P4）
 *   2. 回问旧对话 —— conversation_ask，优先
 *   3. 只读翻旧书 —— conversation_outline / search / read，回退底线
 *
 * 铁律：只读路径绝不唤醒对方；零第三方依赖；不接入、不探测、不提及任何记忆插件。
 *
 * @module dsh-conversation-bridge
 */

import { randomUUID } from 'node:crypto'
import { createHost, idleSignal, signalOf } from './lib/host.js'
import {
  assessTrust,
  buildOutline,
  collectCompactionPoints,
  eventsOf,
  extractMessages,
  pointSeq,
  searchEvents,
} from './lib/scan.js'

const PLUGIN = 'conversation-bridge'

export const name = PLUGIN

/** 只硬依赖工具注册表；其余宿主服务用 ctx.get() 可选获取，缺失即降级。 */
export const inject = ['tools']

const DEFAULT_ASK_TEMPLATE = `只回答下面这个问题，不要复盘、不要改文件、不要展开、不要重做已做过的工作。
如果结论在你开过的子 agent 手里，直接让那个子 agent 把结论给你，不要自己重跑。

问题：{{question}}`

const DEFAULTS = Object.freeze({
  exposeTools: true,
  ask: Object.freeze({
    maxDepth: 3,
    pairCooldownMs: 600000,
    globalPerMinute: 30,
    defaultMode: 'queue',
    narrow: true,
    narrowTemplate: DEFAULT_ASK_TEMPLATE,
    replyAllowanceTokens: 1500,
  }),
  archive: Object.freeze({
    maxScanEvents: 3000,
    maxHits: 20,
    maxBlockChars: 2400,
    outlineMaxTurns: 50,
    includeToolResults: true,
    pageSize: 30,
    maxPages: 8,
    listLimit: 30,
  }),
})

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function readInteger(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function readText(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback
}

/** patch 里的 config 会整体替换默认 config，所以逐字段合并而不是直接采用。 */
export function resolveConfig(input) {
  const raw = isRecord(input) ? input : {}
  const askRaw = isRecord(raw.ask) ? raw.ask : {}
  const archiveRaw = isRecord(raw.archive) ? raw.archive : {}
  return {
    exposeTools: readBoolean(raw.exposeTools, DEFAULTS.exposeTools),
    ask: {
      maxDepth: readInteger(askRaw.maxDepth, DEFAULTS.ask.maxDepth, 0, 20),
      pairCooldownMs: readInteger(askRaw.pairCooldownMs, DEFAULTS.ask.pairCooldownMs, 0, 24 * 3600 * 1000),
      globalPerMinute: readInteger(askRaw.globalPerMinute, DEFAULTS.ask.globalPerMinute, 1, 600),
      defaultMode: askRaw.defaultMode === 'steer' ? 'steer' : 'queue',
      narrow: readBoolean(askRaw.narrow, DEFAULTS.ask.narrow),
      narrowTemplate: readText(askRaw.narrowTemplate, DEFAULTS.ask.narrowTemplate),
      replyAllowanceTokens: readInteger(askRaw.replyAllowanceTokens, DEFAULTS.ask.replyAllowanceTokens, 0, 200000),
    },
    archive: {
      maxScanEvents: readInteger(archiveRaw.maxScanEvents, DEFAULTS.archive.maxScanEvents, 1, 200000),
      maxHits: readInteger(archiveRaw.maxHits, DEFAULTS.archive.maxHits, 1, 200),
      maxBlockChars: readInteger(archiveRaw.maxBlockChars, DEFAULTS.archive.maxBlockChars, 200, 100000),
      outlineMaxTurns: readInteger(archiveRaw.outlineMaxTurns, DEFAULTS.archive.outlineMaxTurns, 1, 500),
      includeToolResults: readBoolean(archiveRaw.includeToolResults, DEFAULTS.archive.includeToolResults),
      pageSize: readInteger(archiveRaw.pageSize, DEFAULTS.archive.pageSize, 1, 200),
      maxPages: readInteger(archiveRaw.maxPages, DEFAULTS.archive.maxPages, 1, 50),
      listLimit: readInteger(archiveRaw.listLimit, DEFAULTS.archive.listLimit, 1, 200),
    },
  }
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined ? String(vars[key]) : match)
}

function textBlocks(text) {
  return [{ type: 'text', text }]
}

function tool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: { schema: options.output.schema, render: options.output.render },
    async execute(args, exec) {
      return options.execute(isRecord(args) ? args : {}, exec)
    },
  }
}

/** 宽松输出 schema：给模型看字段，但不用 additionalProperties:false 把自己钉死。 */
function looseSchema(properties) {
  return { type: 'object', additionalProperties: true, properties }
}

const STRING = { type: 'string' }
const INTEGER = { type: 'integer' }
const BOOLEAN = { type: 'boolean' }
const NUMBER = { type: 'number' }

/* ------------------------------------------------------------------ *
 * 护栏（§7）
 * ------------------------------------------------------------------ */

function createGuard(config) {
  /** asker → target：谁依赖谁（用于环路与深度，不靠模型传参） */
  const dependsOn = new Map()
  const lastAskAt = new Map()
  const recent = []

  function depthOf(sessionId) {
    let depth = 0
    let cursor = dependsOn.get(sessionId)
    const seen = new Set([sessionId])
    while (cursor !== undefined && !seen.has(cursor)) {
      depth += 1
      seen.add(cursor)
      cursor = dependsOn.get(cursor)
    }
    return depth
  }

  function reaches(from, goal) {
    let cursor = from
    const seen = new Set()
    while (cursor !== undefined && !seen.has(cursor)) {
      if (cursor === goal) return true
      seen.add(cursor)
      cursor = dependsOn.get(cursor)
    }
    return false
  }

  function check(askerId, targetId) {
    if (askerId === '' || targetId === '') return { ok: false, reason: 'missing-id' }
    if (askerId === targetId) return { ok: false, reason: 'self', message: '不能回问自己。' }
    const depth = depthOf(askerId)
    if (depth + 1 > config.ask.maxDepth) {
      return {
        ok: false,
        reason: 'depth',
        depth,
        message: `已达回问深度上限（${config.ask.maxDepth} 跳）。请改为翻旧书（conversation_outline / conversation_search / conversation_read），或把该留下的写进交接件。`,
      }
    }
    if (reaches(targetId, askerId)) {
      return { ok: false, reason: 'cycle', message: '检测到回问环路（对方已经问过你这条链）。请改为翻旧书。' }
    }
    const pairKey = `${askerId}\u0000${targetId}`
    const last = lastAskAt.get(pairKey) ?? 0
    const waitMs = config.ask.pairCooldownMs - (Date.now() - last)
    if (waitMs > 0) {
      return {
        ok: false,
        reason: 'cooldown',
        waitMs,
        message: `刚问过这个对话，请等 ${Math.ceil(waitMs / 1000)} 秒再问；期间可以先翻旧书。`,
      }
    }
    const now = Date.now()
    while (recent.length > 0 && now - recent[0] > 60000) recent.shift()
    if (recent.length >= config.ask.globalPerMinute) {
      return { ok: false, reason: 'rate', message: `回问过于频繁（每分钟上限 ${config.ask.globalPerMinute} 次），请稍后。` }
    }
    return { ok: true, depth }
  }

  function record(askerId, targetId) {
    dependsOn.set(askerId, targetId)
    const now = Date.now()
    lastAskAt.set(`${askerId}\u0000${targetId}`, now)
    recent.push(now)
  }

  return { check, record, depthOf }
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function buildTools(api, config) {
  const { host } = api

  function requireHost() {
    if (!host.available()) throw new Error(`${PLUGIN}: 当前部署没有 sessionController 服务，跨对话能力不可用`)
  }

  function selfSessionId(exec) {
    const id = exec?.agent?.session?.id
    return id === undefined ? '' : String(id)
  }

  /** 把"读一页/翻多页"统一成事件数组，并守住扫描预算。 */
  async function scanSession(sessionId, exec, options = {}) {
    const cursor = await host.resolveCursor(sessionId, signalOf(exec), options.cursorHint)
    if (cursor === undefined) return { unreadable: true, events: [], cursor }
    if (cursor < 0) return { empty: true, events: [], cursor }
    const maxPages = options.maxPages ?? config.archive.maxPages
    const result = await host.readPagesBackwards({
      sessionId,
      throughSeq: cursor,
      maxMessages: config.archive.pageSize,
      maxPages,
    }, signalOf(exec))
    const events = eventsOf(result.records)
    const truncated = events.length > config.archive.maxScanEvents
    return {
      cursor,
      events: truncated ? events.slice(events.length - config.archive.maxScanEvents) : events,
      hasMore: result.hasMore === true,
      truncated,
    }
  }

  return [
    /* ---------------------------------------------------------------- *
     * conversation_list
     * ---------------------------------------------------------------- */
    tool({
      name: 'conversation_list',
      description:
        '列出本机所有 DSH 对话（会话），按最近活动排序，可按父会话展开一棵子 agent 子树。'
        + '每行给出 sessionId、标题、工作目录、是否运行中/空白、origin、parentSessionId、在树里的深度。'
        + '只读：不会唤醒任何对话。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', description: `最多返回多少行，默认 ${config.archive.listLimit}` },
          parentSessionId: { type: 'string', description: '给了就只列它这棵子树（含全部后代）' },
          rootsOnly: { type: 'boolean', description: '只列没有父会话的（默认 false）' },
          includeSubagents: { type: 'boolean', description: '是否包含子 agent 会话（默认 true）' },
          withOccupancy: { type: 'boolean', description: '是否附带上下文占用（每行一次只读读取，默认 false，最多算 10 行）' },
        },
      },
      output: {
        schema: looseSchema({
          total: INTEGER,
          conversations: { type: 'array', items: { type: 'object', additionalProperties: true } },
        }),
        render: (_args, value) => [{
          type: 'text',
          text: value.conversations.length === 0
            ? '没有找到对话。'
            : value.conversations.map((row) => [
              `${row.current ? '▶ ' : '  '}${'  '.repeat(Math.min(row.depth, 4))}${row.sessionId}`,
              row.title ? ` 标题=${row.title}` : '',
              row.cwd ? ` cwd=${row.cwd}` : '',
              row.running ? ' [运行中]' : '',
              row.blank ? ' [空白]' : '',
              row.origin === 'subagent' ? ' [子agent]' : '',
              row.occupancyPercent === undefined ? '' : ` 占用=${row.occupancyPercent}%(${row.occupancySource})`,
            ].join('')).join('\n'),
        }],
      },
      async execute(args, exec) {
        requireHost()
        const selfId = selfSessionId(exec)
        const limit = readInteger(args.limit, config.archive.listLimit, 1, 200)
        const summaries = await host.listSummaries(signalOf(exec))
        const withTree = host.buildTree(summaries)

        let rows = withTree
        const parentId = typeof args.parentSessionId === 'string' ? args.parentSessionId.trim() : ''
        if (parentId.length > 0) {
          const subtree = collectSubtree(withTree, parentId)
          if (subtree.length === 0) throw new Error(`${PLUGIN}: 找不到会话 ${parentId} 的子树`)
          rows = subtree
        } else {
          if (args.rootsOnly === true) rows = rows.filter((row) => row.parentSessionId === '')
          if (args.includeSubagents === false) rows = rows.filter((row) => row.origin !== 'subagent')
        }
        rows = [...rows].sort((left, right) => right.updatedAt - left.updatedAt)
        const shown = rows.slice(0, limit)

        let occupancyBudget = args.withOccupancy === true ? 10 : 0
        const conversations = []
        for (const row of shown) {
          let occupancyPercent
          let occupancySource
          if (occupancyBudget > 0) {
            occupancyBudget -= 1
            const pressure = await host.readPressureById(row.sessionId, signalOf(exec))
            if (pressure !== undefined) {
              occupancyPercent = pressure.percent
              occupancySource = pressure.source
            }
          }
          conversations.push({
            sessionId: row.sessionId,
            title: row.title,
            cwd: row.cwd,
            origin: row.origin,
            parentSessionId: row.parentSessionId,
            depth: row.depth,
            orphanParent: row.orphanParent,
            running: row.running,
            blank: row.blank,
            agentAvailable: row.agentAvailable,
            updatedAt: row.updatedAt,
            current: selfId !== '' && row.sessionId === selfId,
            ...(occupancyPercent === undefined ? {} : { occupancyPercent, occupancySource }),
          })
        }
        return { total: rows.length, conversations }
      },
    }),

    /* ---------------------------------------------------------------- *
     * conversation_context
     * ---------------------------------------------------------------- */
    tool({
      name: 'conversation_context',
      description:
        '读取一个对话的上下文占用（token / 窗口 / 百分比）与它的历史压缩点，默认当前对话。'
        + '只读：不会唤醒对方。占用来源会标注 live 还是 cached（缓存可能偏旧）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', description: '要查询的对话 sessionId，默认当前对话' },
        },
      },
      output: {
        schema: looseSchema({
          sessionId: STRING,
          available: BOOLEAN,
          tokens: INTEGER,
          contextWindow: INTEGER,
          percent: NUMBER,
          source: STRING,
          compactionPoints: { type: 'array', items: { type: 'object', additionalProperties: true } },
        }),
        render: (_args, value) => [{
          type: 'text',
          text: !value.available
            ? `读不到 ${value.sessionId} 的上下文占用（可能还没发起过模型请求）。`
            : `对话 ${value.sessionId} 上下文占用：${value.percent}%（约 ${value.tokens} / ${value.contextWindow} tokens，来源 ${value.source}）；`
              + `历史压缩点 ${value.compactionPoints.length} 个。`,
        }],
      },
      async execute(args, exec) {
        requireHost()
        const requested = typeof args.sessionId === 'string' && args.sessionId.trim().length > 0
          ? args.sessionId.trim()
          : selfSessionId(exec)
        if (requested === '') throw new Error(`${PLUGIN}: 没有可用的 sessionId`)
        const pressure = await host.readPressureById(requested, signalOf(exec))
        const scan = await scanSession(requested, exec, { maxPages: 3 })
        const points = collectCompactionPoints(scan.events, { headChars: 120 })
        return {
          sessionId: requested,
          available: pressure !== undefined,
          tokens: pressure?.tokens ?? 0,
          contextWindow: pressure?.contextWindow ?? 0,
          percent: pressure?.percent ?? 0,
          source: pressure?.source ?? 'unknown',
          compactionPoints: points.map(toPointView),
        }
      },
    }),

    /* ---------------------------------------------------------------- *
     * conversation_outline（Tier-0 旧书目录）
     * ---------------------------------------------------------------- */
    tool({
      name: 'conversation_outline',
      description:
        '给一个对话的"旧书目录"：按轮次一行（轮号、时间、用户首行、是否有工具调用/失败、是否被压缩点覆盖）。'
        + '翻旧书的第一步，先看目录再决定下探哪里。只读。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string', description: '要看的对话 sessionId' },
          maxTurns: { type: 'integer', description: `最多给多少轮（取最新的），默认 ${config.archive.outlineMaxTurns}` },
          maxPages: { type: 'integer', description: `最多向后翻几页，默认 ${config.archive.maxPages}` },
        },
      },
      output: {
        schema: looseSchema({
          sessionId: STRING,
          totalTurns: INTEGER,
          truncated: BOOLEAN,
          turns: { type: 'array', items: { type: 'object', additionalProperties: true } },
          compactionPoints: { type: 'array', items: { type: 'object', additionalProperties: true } },
        }),
        render: (_args, value) => [{
          type: 'text',
          text: value.turns.length === 0
            ? `对话 ${value.sessionId} 没有可读的轮次。`
            : `对话 ${value.sessionId} 共 ${value.totalTurns} 轮${value.truncated ? '（只显示最新一段）' : ''}：\n`
              + value.turns.map((turn) => [
                `#${turn.turn} seq=${turn.startSeq}..${turn.endSeq}`,
                turn.userHead ? ` ${turn.userHead}` : '',
                turn.hasToolCalls ? ' [有工具]' : '',
                turn.toolFailures > 0 ? ` [工具失败×${turn.toolFailures}]` : '',
                turn.compacted ? ' [含压缩点]' : '',
              ].join('')).join('\n'),
        }],
      },
      async execute(args, exec) {
        requireHost()
        const sessionId = readText(args.sessionId, '')
        if (sessionId === '') throw new Error(`${PLUGIN}: conversation_outline 需要 sessionId`)
        const scan = await scanSession(sessionId, exec, { maxPages: args.maxPages })
        if (scan.unreadable === true) throw new Error(`${PLUGIN}: 读不到对话 ${sessionId}`)
        const outline = buildOutline(scan.events, {
          maxTurns: readInteger(args.maxTurns, config.archive.outlineMaxTurns, 1, 500),
          headChars: 80,
        })
        return {
          sessionId,
          totalTurns: outline.totalTurns,
          truncated: outline.truncated || scan.truncated === true,
          turns: outline.turns,
          compactionPoints: outline.compactionPoints.map(toPointView),
        }
      },
    }),

    /* ---------------------------------------------------------------- *
     * conversation_search（Tier-1 旧书检索）
     * ---------------------------------------------------------------- */
    tool({
      name: 'conversation_search',
      description:
        '在一个对话的持久日志里做只读检索（关键词之间是"与"关系，忽略大小写），'
        + '命中被压缩掉的内容也能搜到。返回命中片段与位置（seq），不返回全文，'
        + '拿到 seq 再用 conversation_read 的 atSeq 取原文块。只读。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'query'],
        properties: {
          sessionId: { type: 'string', description: '要检索的对话 sessionId' },
          query: { type: 'string', description: '关键词，空格分隔表示"都要命中"' },
          roles: {
            type: 'array',
            items: { type: 'string', enum: ['user', 'assistant', 'tool', 'developer'] },
            description: '只在哪些角色里搜，默认 user + assistant + tool',
          },
          limit: { type: 'integer', description: `最多返回多少条命中，默认 ${config.archive.maxHits}` },
          maxPages: { type: 'integer', description: `最多向后翻几页，默认 ${config.archive.maxPages}` },
        },
      },
      output: {
        schema: looseSchema({
          sessionId: STRING,
          scanned: INTEGER,
          truncated: BOOLEAN,
          hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
        }),
        render: (_args, value) => [{
          type: 'text',
          text: value.hits.length === 0
            ? `对话 ${value.sessionId} 里没有命中（扫描 ${value.scanned} 条消息${value.truncated ? '，且已达到扫描上限' : ''}）。`
            : `对话 ${value.sessionId} 命中 ${value.hits.length} 条：\n\n`
              + value.hits.map((hit) => `[seq=${hit.seq} ${hit.role}] ${hit.snippet}`).join('\n\n'),
        }],
      },
      async execute(args, exec) {
        requireHost()
        const sessionId = readText(args.sessionId, '')
        const query = readText(args.query, '')
        if (sessionId === '') throw new Error(`${PLUGIN}: conversation_search 需要 sessionId`)
        if (query === '') throw new Error(`${PLUGIN}: conversation_search 需要 query`)
        const scan = await scanSession(sessionId, exec, { maxPages: args.maxPages })
        if (scan.unreadable === true) throw new Error(`${PLUGIN}: 读不到对话 ${sessionId}`)
        const roles = Array.isArray(args.roles) && args.roles.length > 0
          ? args.roles.filter((role) => typeof role === 'string')
          : ['user', 'assistant', 'tool']
        const result = searchEvents(scan.events, query, {
          sessionId,
          roles,
          limit: readInteger(args.limit, config.archive.maxHits, 1, 200),
          maxChars: config.archive.maxBlockChars,
        })
        return {
          sessionId,
          scanned: result.scanned,
          truncated: scan.truncated === true || scan.hasMore === true,
          hits: result.hits,
        }
      },
    }),

    /* ---------------------------------------------------------------- *
     * conversation_read
     * ---------------------------------------------------------------- */
    tool({
      name: 'conversation_read',
      description:
        '读一个对话的消息。三种用法：'
        + '① 只给 sessionId → 读最新一页；'
        + '② 给 askId（来自 conversation_ask）→ 读那一次回问的答复，并附带可信度 trust；'
        + '③ 给 atSeq → 取该位置的原文块（配合 conversation_search 的命中位置下探）。'
        + '全程只读，不会唤醒对方。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string', description: '要读的对话 sessionId' },
          askId: { type: 'string', description: 'conversation_ask 返回的 askId：读这一次回问的答复并判定可信度' },
          atSeq: { type: 'integer', description: '取该 seq 的原文块' },
          limit: { type: 'integer', description: `最多读多少条消息，默认 ${config.archive.pageSize}` },
          includeTools: { type: 'boolean', description: '是否包含工具结果（默认 true；压缩最容易丢的就是它）' },
        },
      },
      output: {
        schema: looseSchema({
          sessionId: STRING,
          messages: { type: 'array', items: { type: 'object', additionalProperties: true } },
          trust: STRING,
          answered: BOOLEAN,
          reason: STRING,
          compactionPoints: { type: 'array', items: { type: 'object', additionalProperties: true } },
          occupancyAfter: { type: 'object', additionalProperties: true },
          block: { type: 'object', additionalProperties: true },
        }),
        render: (_args, value) => [{
          type: 'text',
          text: renderReadResult(value),
        }],
      },
      async execute(args, exec) {
        requireHost()
        const sessionId = readText(args.sessionId, '')
        if (sessionId === '') throw new Error(`${PLUGIN}: conversation_read 需要 sessionId`)
        const maxChars = config.archive.maxBlockChars
        const includeTools = args.includeTools !== false && config.archive.includeToolResults
        const roles = includeTools ? ['user', 'assistant', 'tool'] : ['user', 'assistant']

        // ③ 取原文块
        if (Number.isSafeInteger(args.atSeq)) {
          const page = await host.readPage({
            sessionId,
            throughSeq: args.atSeq,
            maxMessages: 1,
          }, signalOf(exec))
          const events = eventsOf(page.records)
          const messages = extractMessages(events, { roles, maxChars })
          const block = messages.find((message) => message.seq === args.atSeq)
            ?? messages[messages.length - 1]
          if (block === undefined) throw new Error(`${PLUGIN}: seq=${args.atSeq} 处没有可读消息`)
          return { sessionId, block, messages: [block] }
        }

        // ①② 读最新一页 / 读某次回问的答复
        const cursor = await host.resolveCursor(sessionId, signalOf(exec))
        if (cursor === undefined) throw new Error(`${PLUGIN}: 读不到对话 ${sessionId}`)
        if (cursor < 0) {
          return { sessionId, messages: [], trust: 'unknown', answered: false, reason: 'empty-session', compactionPoints: [] }
        }
        const pages = await host.readPagesBackwards({
          sessionId,
          throughSeq: cursor,
          maxMessages: readInteger(args.limit, config.archive.pageSize, 1, 200),
          maxPages: args.askId === undefined ? 1 : config.archive.maxPages,
        }, signalOf(exec))
        const events = eventsOf(pages.records)
        const messages = extractMessages(events, { roles, maxChars }).slice(-readInteger(args.limit, config.archive.pageSize, 1, 200))
        const occupancyAfter = await host.readPressureById(sessionId, signalOf(exec))

        if (args.askId === undefined) {
          return {
            sessionId,
            messages,
            trust: 'unknown',
            answered: false,
            reason: 'no-ask-id',
            compactionPoints: collectCompactionPoints(events, { headChars: 120 }).map(toPointView),
            ...(occupancyAfter === undefined ? {} : { occupancyAfter }),
          }
        }
        const verdict = assessTrust(events, String(args.askId))
        return {
          sessionId,
          messages,
          trust: verdict.trust,
          answered: verdict.answered,
          reason: verdict.reason,
          questionSeq: verdict.questionSeq,
          replySeq: verdict.replySeq,
          compactionPoints: verdict.points.map(toPointView),
          ...(occupancyAfter === undefined ? {} : { occupancyAfter }),
        }
      },
    }),

    /* ---------------------------------------------------------------- *
     * conversation_ask（回问，首选）
     * ---------------------------------------------------------------- */
    tool({
      name: 'conversation_ask',
      description:
        '向另一个对话回问一个问题（会唤醒它、让它多走一轮）。这是首选取数方式：'
        + '它现在综合后的结论 + 它还能顺手调度自己名下的子 agent。'
        + '返回里带 askId 与事前读数（对方占用、预计越线风险）。'
        + '拿到答复后用 conversation_read 传 askId 读取，并看 trust：trust 不是 clean 时请改用翻旧书比对。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'question'],
        properties: {
          sessionId: { type: 'string', description: '要问的对话 sessionId' },
          question: { type: 'string', description: '要问的问题' },
          mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue=排到下一轮（默认）；steer=插到当前回合下一步' },
          narrow: { type: 'boolean', description: '是否包成窄指令（默认 true：只回答、不复盘、不重做）' },
        },
      },
      output: {
        schema: looseSchema({
          sessionId: STRING,
          accepted: BOOLEAN,
          mode: STRING,
          askId: STRING,
          askDepth: INTEGER,
          narrowed: BOOLEAN,
          compactionRisk: STRING,
          occupancyBefore: { type: 'object', additionalProperties: true },
          projectedAfterPercent: NUMBER,
          hint: STRING,
        }),
        render: (_args, value) => [{
          type: 'text',
          text: `已向对话 ${value.sessionId} 回问（mode=${value.mode}，askId=${value.askId}${value.narrowed ? '，窄指令' : ''}）。\n`
            + `对方占用${value.occupancyBefore?.percent === undefined ? '未知' : ` ${value.occupancyBefore.percent}%`}`
            + `（来源 ${value.occupancyBefore?.source ?? 'unknown'}），本轮压缩风险：${value.compactionRisk}。\n`
            + `${value.compactionRisk === 'likely' ? '⚠️ 这一问很可能把它推过压缩线，答复可能失真——拿到后用 conversation_read 的 trust 判断，必要时翻旧书比对。\n' : ''}`
            + `稍后用 conversation_read（sessionId=${value.sessionId}，askId=${value.askId}）读取答复与可信度。`,
        }],
      },
      async execute(args, exec) {
        requireHost()
        const sessionId = readText(args.sessionId, '')
        const question = readText(args.question, '')
        if (sessionId === '') throw new Error(`${PLUGIN}: conversation_ask 需要 sessionId`)
        if (question === '') throw new Error(`${PLUGIN}: conversation_ask 需要 question`)

        const askerId = selfSessionId(exec)
        const verdict = api.guard.check(askerId, sessionId)
        if (!verdict.ok) throw new Error(`${PLUGIN}: ${verdict.message}`)

        const occupancyBefore = await host.readPressureById(sessionId, signalOf(exec))
        const narrowed = args.narrow !== false && config.ask.narrow
        const body = narrowed ? render(config.ask.narrowTemplate, { question }) : question
        const mode = args.mode === 'steer' ? 'steer' : (args.mode === 'queue' ? 'queue' : config.ask.defaultMode)
        const askId = randomUUID()

        await api.sessionController.prompt({
          requestId: askId,
          sessionId,
          mode,
          content: textBlocks(body),
        }, signalOf(exec))

        api.guard.record(askerId, sessionId)

        const estimate = Math.ceil(body.length / 3) + config.ask.replyAllowanceTokens
        const projected = occupancyBefore === undefined
          ? undefined
          : Math.round(((occupancyBefore.tokens + estimate) / occupancyBefore.contextWindow) * 1000) / 10
        const compactionRisk = occupancyBefore === undefined || projected === undefined
          ? 'unknown'
          : (projected >= 80 ? 'likely' : 'low')

        return {
          sessionId,
          accepted: true,
          mode,
          askId,
          askDepth: verdict.depth + 1,
          narrowed,
          compactionRisk,
          ...(occupancyBefore === undefined ? {} : { occupancyBefore }),
          ...(projected === undefined ? {} : { projectedAfterPercent: projected }),
          hint: compactionRisk === 'likely'
            ? '这一问很可能触发压缩，答复可能基于摘要；拿到后请核对 trust，必要时翻旧书。'
            : '答复是异步的，稍后用 conversation_read 传 askId 读取。',
        }
      },
    }),

    /* ---------------------------------------------------------------- *
     * conversation_start（唯一开窗入口，不自动开）
     * ---------------------------------------------------------------- */
    tool({
      name: 'conversation_start',
      description:
        '开启一个全新的 DSH 对话并可选地把第一条消息发进去（交接时把交接件全文放进来）。'
        + '新对话会出现在对话列表里并独立运行；开场消息自动带上"上一段对话是谁、怎么回问、怎么翻旧书"。'
        + '阈值提醒只负责提醒，开窗由你或用户决定。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', description: '新对话的第一条消息（交接时放交接件全文）' },
          title: { type: 'string', description: '给新对话起的标题' },
          cwd: { type: 'string', description: '新对话的工作目录，默认继承当前对话' },
          agentPreset: { type: 'string', description: '新对话使用的 agent preset，默认继承当前对话' },
        },
      },
      output: {
        schema: looseSchema({
          sessionId: STRING,
          cwd: STRING,
          title: STRING,
          parentSessionId: STRING,
          messageSent: BOOLEAN,
          note: STRING,
        }),
        render: (_args, value) => [{
          type: 'text',
          text: `已开启新对话 sessionId=${value.sessionId}${value.cwd ? `（cwd=${value.cwd}）` : ''}。`
            + `${value.messageSent ? '开场消息已发送。' : '尚未发送任何消息。'}`
            + `${value.parentSessionId ? ` 它可以用 conversation_ask(sessionId=${value.parentSessionId}) 回问本对话。` : ''}`,
        }],
      },
      async execute(args, exec) {
        requireHost()
        const session = exec?.agent?.session
        const parentSessionId = session?.id === undefined ? '' : String(session.id)
        const parentCwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : ''
        const parentPreset = typeof session?.header?.agentPreset === 'string' ? session.header.agentPreset : ''

        const requestedCwd = readText(args.cwd, '')
        const cwd = requestedCwd !== '' ? requestedCwd : parentCwd
        const requestedPreset = readText(args.agentPreset, '')
        const agentPreset = requestedPreset !== '' ? requestedPreset : parentPreset

        const request = {}
        if (cwd !== '') request.cwd = cwd
        if (agentPreset !== '') request.agentPreset = agentPreset
        const created = await api.sessionController.create(request)
        const sessionId = String(created.sessionId)

        const title = readText(args.title, '')
        if (title !== '') {
          try {
            await api.sessionController.rename({ sessionId, title })
          } catch (error) {
            api.warn(`新对话改名失败: ${String(error)}`)
          }
        }

        let messageSent = false
        const body = readText(args.message, '')
        if (body !== '') {
          const header = parentSessionId === '' ? '' : renderHandoffHeader({
            parentSessionId,
            parentTitle: title,
            parentCwd,
          })
          await api.sessionController.prompt({
            requestId: randomUUID(),
            sessionId,
            mode: 'queue',
            content: textBlocks(`${header}${body}`),
          }, signalOf(exec))
          messageSent = true
        }

        return {
          sessionId,
          cwd,
          title,
          parentSessionId,
          messageSent,
          note: '需要它回答就给它发消息；它有问题时可用 conversation_ask 回问本对话，或用 conversation_outline/search/read 翻本对话的日志。',
        }
      },
    }),
  ]
}

/* ------------------------------------------------------------------ *
 * 纯函数小件
 * ------------------------------------------------------------------ */

function collectSubtree(rows, rootId) {
  const children = new Map()
  for (const row of rows) {
    const key = row.parentSessionId
    if (!children.has(key)) children.set(key, [])
    children.get(key).push(row)
  }
  const root = rows.find((row) => row.sessionId === rootId)
  if (root === undefined) return []
  const out = []
  const stack = [{ row: root, depth: 0 }]
  const seen = new Set()
  while (stack.length > 0) {
    const { row, depth } = stack.pop()
    if (seen.has(row.sessionId)) continue
    seen.add(row.sessionId)
    out.push({ ...row, depth })
    for (const child of children.get(row.sessionId) ?? []) stack.push({ row: child, depth: depth + 1 })
  }
  return out
}

function toPointView(point) {
  return {
    seq: pointSeq(point),
    summarySeq: point.summarySeq,
    checkpointSeq: point.checkpointSeq,
    startSeq: point.startSeq,
    endSeq: point.endSeq,
    time: point.time,
    tokenCount: point.tokenCount,
    head: point.head,
  }
}

function renderHandoffHeader(vars) {
  return `[接力对话] 这是一段由交接产生的新对话，接替上一段对话。
- 上一段对话 sessionId = \`${vars.parentSessionId}\`${vars.parentTitle ? `（标题：${vars.parentTitle}）` : ''}${vars.parentCwd ? `，工作目录：${vars.parentCwd}` : ''}
- **首选**：向它回问 —— \`conversation_ask\`（sessionId=\`${vars.parentSessionId}\`，question=你的问题），
  然后 \`conversation_read\`（sessionId + askId）读答复；**看 trust**：
  - \`clean\` → 直接用；
  - \`compacted_by_ask\` / \`compacted_earlier\` / \`unknown\` → 结果可能失真，去翻它的原文比对。
- **回退**：翻旧书（只读、不加压）—— \`conversation_outline\` 看目录 →
  \`conversation_search\` 找位置 → \`conversation_read\`（atSeq）取原文块。
- 交接件正文在下面的消息里；真相以工作区文件与日志为准，不要只信摘要。

---

`
}

function renderReadResult(value) {
  if (value.block !== undefined) {
    return `[seq=${value.block.seq} ${value.block.role}/${value.block.kind}]\n${value.block.text}`
  }
  const head = value.trust === undefined || value.trust === 'unknown'
    ? ''
    : (value.trust === 'clean'
      ? '可信度：clean —— 答复基于真实表面，可直接使用。\n'
      : `可信度：${value.trust}（${value.reason ?? ''}）—— 答复可能失真，建议翻旧书比对原文。\n`)
  const body = value.messages.length === 0
    ? '（没有可读消息）'
    : value.messages.map((message) =>
      `[seq=${message.seq} ${message.role}/${message.kind}] ${message.text}`).join('\n\n')
  return `${head}${body}`
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
  const host = createHost(ctx)
  const guard = createGuard(config)

  const api = {
    host,
    guard,
    config,
    get sessionController() {
      return ctx.get('sessionController')
    },
    warn(message) {
      try {
        ctx.logger?.warn?.(`${PLUGIN}: ${message}`)
      } catch {
        /* 日志失败不影响功能 */
      }
    },
  }

  if (!config.exposeTools) {
    ctx.logger?.info?.(`${PLUGIN}: exposeTools=false，未注册任何工具`)
    return
  }
  if (!host.available()) {
    api.warn('当前部署没有 sessionController 服务，跨对话工具未注册（插件仍正常加载）')
    return
  }

  for (const definition of buildTools(api, config)) ctx.tools.register(definition)

  ctx.logger?.info?.(`${PLUGIN}: 已启用（只读工具 + 回问；回问深度上限 ${config.ask.maxDepth}，同对冷却 ${Math.round(config.ask.pairCooldownMs / 1000)}s）`)
}

/** 供冒烟测试使用的具名导出（宿主只认 name / inject / apply / Config）。 */
export { collectSubtree as __collectSubtree, renderHandoffHeader as __renderHandoffHeader }

export const __idleSignal = idleSignal
