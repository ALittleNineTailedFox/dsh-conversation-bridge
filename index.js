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
import { DEFAULT_SECTIONS, listHandoffs, readHandoff, resolveDir, writeHandoff } from './lib/handoff.js'
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

const DEFAULT_REMINDER = `<context_handoff level="warning">
⚠️ 本对话上下文已用到 {{percent}}%（约 {{tokens}} / {{window}} tokens，阈值 {{threshold}}%）。

请按顺序做三件事：
1. **把这件该留下的落成交接件**（四段都要写实、写具体：${DEFAULT_SECTIONS.join(' / ')}）。
   若 \`conversation_handoff_write\` 可用就直接调用它；**不可用（例如本会话看不到该工具）就用你惯用的写文件工具**，
   写到 \`{{handoffDir}}\` 下，四段标题要逐字对上。写不下的细节不怕，原文留在日志里，下个对话能翻回来。
2. **开新对话接上**：调用 conversation_start，把交接件全文放进 message，并传 handoffFile = 交接件路径。
   本对话 sessionId = \`{{sessionId}}\`，工作目录 = \`{{cwd}}\`。
3. **告诉用户**：已交接、新对话的 sessionId 是返回值里的那个、本对话仍可被回问。

下个对话的取数顺序是「先回问本对话拿结论；trust 不是 clean 时再翻本对话的日志原文」，
开场消息里已经写好，不用你重复交代。

如果当前改动正处在不能中断的中途，先把它落到安全状态（落盘/提交）再交接，不要带着未落盘的风险停手。
</context_handoff>`

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
  handoff: Object.freeze({
    enabled: true,
    threshold: 0.7,
    rearmBelow: 0.55,
    cooldownMs: 600000,
    handoffQuietMs: 1800000,
    deliver: 'steer',
    skipSubagents: true,
    toolEnabled: true,
    dir: '',
    sections: DEFAULT_SECTIONS,
    minSectionChars: 40,
    inheritCwd: true,
    inheritPreset: true,
    reminderText: DEFAULT_REMINDER,
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

function readRatio(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  if (value <= 0 || value >= 1) return fallback
  return value
}

function readSections(value, fallback) {
  if (!Array.isArray(value) || value.length !== fallback.length) return fallback
  const titles = value.map((item) => (typeof item === 'string' ? item.trim() : ''))
  return titles.every((item) => item.length > 0) ? titles : fallback
}

function readText(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback
}

/** patch 里的 config 会整体替换默认 config，所以逐字段合并而不是直接采用。 */
export function resolveConfig(input) {
  const raw = isRecord(input) ? input : {}
  const askRaw = isRecord(raw.ask) ? raw.ask : {}
  const archiveRaw = isRecord(raw.archive) ? raw.archive : {}
  const handoffRaw = isRecord(raw.handoff) ? raw.handoff : {}
  const threshold = readRatio(handoffRaw.threshold, DEFAULTS.handoff.threshold)
  // 重新武装的线必须严格低于阈值，否则"超过阈值"与"回落"同时成立，提醒会被反复触发。
  const rearmBelow = Math.max(0, Math.min(
    readRatio(handoffRaw.rearmBelow, DEFAULTS.handoff.rearmBelow),
    threshold - 0.01,
    threshold * 0.9,
  ))
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
    handoff: {
      enabled: readBoolean(handoffRaw.enabled, DEFAULTS.handoff.enabled),
      threshold,
      rearmBelow,
      cooldownMs: readInteger(handoffRaw.cooldownMs, DEFAULTS.handoff.cooldownMs, 0, 24 * 3600 * 1000),
      handoffQuietMs: readInteger(handoffRaw.handoffQuietMs, DEFAULTS.handoff.handoffQuietMs, 0, 7 * 24 * 3600 * 1000),
      deliver: handoffRaw.deliver === 'queue' ? 'queue' : 'steer',
      skipSubagents: readBoolean(handoffRaw.skipSubagents, DEFAULTS.handoff.skipSubagents),
      toolEnabled: readBoolean(handoffRaw.toolEnabled, DEFAULTS.handoff.toolEnabled),
      dir: typeof handoffRaw.dir === 'string' ? handoffRaw.dir.trim() : DEFAULTS.handoff.dir,
      sections: readSections(handoffRaw.sections, DEFAULTS.handoff.sections),
      minSectionChars: readInteger(handoffRaw.minSectionChars, DEFAULTS.handoff.minSectionChars, 0, 10000),
      inheritCwd: readBoolean(handoffRaw.inheritCwd, DEFAULTS.handoff.inheritCwd),
      inheritPreset: readBoolean(handoffRaw.inheritPreset, DEFAULTS.handoff.inheritPreset),
      reminderText: readText(handoffRaw.reminderText, DEFAULTS.handoff.reminderText),
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

/**
 * 工具返回值必须是**无损 JSON**。
 *
 * 真机事故（2026-10-04）：`messageOf` 对缺 rpcId 的 user 消息写了 `rpcId: undefined`，
 * 于是**整个工具结果**被判 `value is not lossless JSON` 而作废——渲染文本明明正常，
 * 调用方只看到一个错。表现极具迷惑性：页越小越好读（小页里恰好没有人类 user 消息）。
 * 现在所有工具输出统一过这一层，`undefined` / `NaN` / `Infinity` / 函数一律清掉。
 */
function jsonSafe(value, depth = 0) {
  if (depth > 40) return null
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') return undefined
  if (Array.isArray(value)) {
    return value.map((item) => {
      const safe = jsonSafe(item, depth + 1)
      return safe === undefined ? null : safe
    })
  }
  if (type === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const safe = jsonSafe(item, depth + 1)
      if (safe !== undefined) out[key] = safe
    }
    return out
  }
  return undefined
}

function tool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: { schema: options.output.schema, render: options.output.render },
    // 默认按"需要会话服务"处理：这类工具要等 sessionController 就绪再注册。
    // 纯文件类工具显式传 requiresController: false。
    requiresController: options.requiresController !== false,
    async execute(args, exec) {
      const value = await options.execute(isRecord(args) ? args : {}, exec)
      const safe = jsonSafe(value)
      return safe === undefined ? {} : safe
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
      ...(options.addressHint === undefined ? {} : { addressHint: options.addressHint }),
    }, signalOf(exec))
    const events = eventsOf(result.records)
    const truncated = events.length > config.archive.maxScanEvents
    return {
      cursor,
      events: truncated ? events.slice(events.length - config.archive.maxScanEvents) : events,
      hasMore: result.hasMore === true,
      truncated,
      // 实际扫到的范围：调用方必须知道"没找到压缩点"只代表"这段里没有"
      ...(Number.isSafeInteger(result.fromSeq) ? { fromSeq: result.fromSeq } : {}),
      ...(Number.isSafeInteger(result.toSeq) ? { toSeq: result.toSeq } : {}),
      pages: result.pages,
    }
  }

  /** 子 agent 会话必须带父地址；调用方可用 parentSessionId/mode 显式给出。 */
  function addressHintOf(args) {
    const parentSessionId = readText(args?.parentSessionId, '')
    if (parentSessionId === '') return undefined
    return { parentSessionId, mode: args?.mode }
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
            ? `没有找到对话（匹配 ${value.total} 个）。`
            : `匹配 ${value.total} 个，显示 ${value.conversations.length} 个`
              + `${value.total > value.conversations.length ? '（被 limit 截断，要更多请调大 limit 或传 parentSessionId 展开子树）' : ''}：\n`
              + value.conversations.map((row) => [
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
          parentSessionId: { type: 'string', description: '仅子 agent 会话需要：它的 durable 父会话 id（普通会话别传）' },
          mode: { type: 'string', enum: ['one-shot', 'continuable', 'unknown'], description: '子 agent 地址的模式，默认 unknown（插件会自己试探）' },
          maxPages: { type: 'integer', description: '最多向后翻几页来扫压缩点，默认 3' },
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
            ? `读不到 ${value.sessionId} 的上下文占用（可能还没发起过模型请求；子 agent 会话的占用投影本身读不到）。`
            : `对话 ${value.sessionId} 上下文占用：${value.percent}%（约 ${value.tokens} / ${value.contextWindow} tokens，来源 ${value.source}）。\n`
              + renderScannedRange(value.scannedRange)
              + `该范围内压缩点 ${value.compactionPoints.length} 个`
              + (value.compactionPoints.length === 0
                ? `${value.scannedRange?.reachedStart === false ? '（**未扫到会话开头**，更早处可能还有）' : ''}。`
                : `：\n${value.compactionPoints.map(renderPointLine).join('\n')}`),
        }],
      },
      async execute(args, exec) {
        requireHost()
        const requested = typeof args.sessionId === 'string' && args.sessionId.trim().length > 0
          ? args.sessionId.trim()
          : selfSessionId(exec)
        if (requested === '') throw new Error(`${PLUGIN}: 没有可用的 sessionId`)
        const pressure = await host.readPressureById(requested, signalOf(exec))
        const scan = await scanSession(requested, exec, {
          maxPages: readInteger(args.maxPages, 3, 1, 50),
          ...(addressHintOf(args) === undefined ? {} : { addressHint: addressHintOf(args) }),
        })
        const points = collectCompactionPoints(scan.events, { headChars: 120 })
        return {
          sessionId: requested,
          available: pressure !== undefined,
          tokens: pressure?.tokens ?? 0,
          contextWindow: pressure?.contextWindow ?? 0,
          percent: pressure?.percent ?? 0,
          source: pressure?.source ?? 'unknown',
          // 报告实际扫到的范围：不报范围的话，"0 个压缩点"会被误读成"这个会话从没压缩过"
          scannedRange: {
            ...(Number.isSafeInteger(scan.fromSeq) ? { fromSeq: scan.fromSeq } : {}),
            ...(Number.isSafeInteger(scan.toSeq) ? { toSeq: scan.toSeq } : {}),
            pages: scan.pages ?? 0,
            reachedStart: scan.hasMore !== true,
          },
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
          parentSessionId: { type: 'string', description: '仅子 agent 会话需要：它的 durable 父会话 id' },
          mode: { type: 'string', enum: ['one-shot', 'continuable', 'unknown'], description: '子 agent 地址的模式，默认 unknown' },
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
              ].join('')).join('\n')
              + `\n${renderScannedRange(value.scannedRange)}`
              + `该范围内压缩点 ${value.compactionPoints.length} 个`
              + (value.compactionPoints.length === 0
                ? `${value.scannedRange?.reachedStart === false ? '（**未扫到会话开头**，更早处可能还有）' : ''}。`
                : `：\n${value.compactionPoints.map(renderPointLine).join('\n')}`),
        }],
      },
      async execute(args, exec) {
        requireHost()
        const sessionId = readText(args.sessionId, '')
        if (sessionId === '') throw new Error(`${PLUGIN}: conversation_outline 需要 sessionId`)
        const scan = await scanSession(sessionId, exec, {
          maxPages: args.maxPages,
          ...(addressHintOf(args) === undefined ? {} : { addressHint: addressHintOf(args) }),
        })
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
          scannedRange: {
            ...(Number.isSafeInteger(scan.fromSeq) ? { fromSeq: scan.fromSeq } : {}),
            ...(Number.isSafeInteger(scan.toSeq) ? { toSeq: scan.toSeq } : {}),
            pages: scan.pages ?? 0,
            reachedStart: scan.hasMore !== true,
          },
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
          parentSessionId: { type: 'string', description: '仅子 agent 会话需要：它的 durable 父会话 id' },
          mode: { type: 'string', enum: ['one-shot', 'continuable', 'unknown'], description: '子 agent 地址的模式，默认 unknown' },
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
          text: (value.hits.length === 0
            ? `对话 ${value.sessionId} 里没有命中（扫描 ${value.scanned} 条消息${value.truncated ? '，且已达到扫描上限' : ''}）。\n`
            : `对话 ${value.sessionId} 命中 ${value.hits.length} 条：\n\n`
              + value.hits.map((hit) => `[seq=${hit.seq} ${hit.role}] ${hit.snippet}`).join('\n\n')
              + '\n')
            + renderScannedRange(value.scannedRange)
            + `扫描到 ${value.scanned} 条消息`
            + (value.scannedRange?.reachedStart === false ? '；**未扫到会话开头**，更早处可能还有' : '')
            + (value.truncated ? '；已达到扫描上限，请缩小范围或加大 maxPages' : ''),
        }],
      },
      async execute(args, exec) {
        requireHost()
        const sessionId = readText(args.sessionId, '')
        const query = readText(args.query, '')
        if (sessionId === '') throw new Error(`${PLUGIN}: conversation_search 需要 sessionId`)
        if (query === '') throw new Error(`${PLUGIN}: conversation_search 需要 query`)
        const scan = await scanSession(sessionId, exec, {
          maxPages: args.maxPages,
          ...(addressHintOf(args) === undefined ? {} : { addressHint: addressHintOf(args) }),
        })
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
          scannedRange: {
            ...(Number.isSafeInteger(scan.fromSeq) ? { fromSeq: scan.fromSeq } : {}),
            ...(Number.isSafeInteger(scan.toSeq) ? { toSeq: scan.toSeq } : {}),
            pages: scan.pages ?? 0,
            reachedStart: scan.hasMore !== true,
          },
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
          parentSessionId: { type: 'string', description: '仅子 agent 会话需要：它的 durable 父会话 id（宿主会拒绝对子会话按普通会话读）' },
          mode: { type: 'string', enum: ['one-shot', 'continuable', 'unknown'], description: '子 agent 地址的模式，默认 unknown' },
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

        // ③ 取原文块：**必须是那一个 seq**，静默给别的位置比报错更有害
        if (Number.isSafeInteger(args.atSeq)) {
          const page = await host.readPage({
            sessionId,
            throughSeq: args.atSeq,
            maxMessages: config.archive.pageSize,
            ...(addressHintOf(args) === undefined ? {} : { addressHint: addressHintOf(args) }),
          }, signalOf(exec))
          const events = eventsOf(page.records)
          const messages = extractMessages(events, { roles, maxChars })
          const block = messages.find((message) => message.seq === args.atSeq)
          if (block === undefined) {
            const nearest = messages
              .map((message) => message.seq)
              .sort((left, right) => Math.abs(left - args.atSeq) - Math.abs(right - args.atSeq))[0]
            throw new Error(
              `${PLUGIN}: seq=${args.atSeq} 处不是可读消息（该位置可能是工具调用、轮次边界等非消息事件）。`
              + `${nearest === undefined ? '' : `附近最近的可读消息 seq=${nearest}。`}`
              + '请用 conversation_search 的命中位置（那一定是消息 seq）下探。',
            )
          }
          return { sessionId, block, messages: [block], requestedSeq: args.atSeq, actualSeq: block.seq }
        }

        // ①② 读最新一页 / 读某次回问的答复
        const hint = addressHintOf(args)
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
          ...(hint === undefined ? {} : { addressHint: hint }),
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
          text: `已向对话 ${value.sessionId} 回问：accepted=${value.accepted}，mode=${value.mode}，askDepth=${value.askDepth}`
            + `，窄指令=${value.narrowed}\n`
            + `askId=${value.askId}（读答复要用它）\n`
            + `对方占用${value.occupancyBefore?.percent === undefined ? '未知（该项目标没有可读的占用投影）' : ` ${value.occupancyBefore.percent}%（来源 ${value.occupancyBefore.source}）`}`
            + `${value.projectedAfterPercent === undefined ? '' : `，加上这一问预计 ${value.projectedAfterPercent}%`}`
            + `，compactionRisk=${value.compactionRisk}\n`
            + `${value.compactionRisk === 'likely' ? '⚠️ 这一问很可能把它推过压缩线，答复可能失真——拿到后看 trust，必要时翻旧书比对。\n' : ''}`
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
        + '默认归入**当前对话所在的分组**（workspace）；只给 cwd 会落到"未分组"，所以优先按工作目录解析 workspace。'
        + '阈值提醒只负责提醒，开窗由你或用户决定。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', description: '新对话的第一条消息（交接时放交接件全文）' },
          handoffFile: { type: 'string', description: '本次交接件的文件路径（由 conversation_handoff_write 返回）' },
          title: { type: 'string', description: '给新对话起的标题' },
          cwd: { type: 'string', description: '新对话的工作目录，默认继承当前对话；同时用它决定归入哪个分组' },
          workspaceId: { type: 'string', description: '显式指定归入哪个分组（workspace）。给了它就不要再用 cwd 决定分组' },
          agentPreset: { type: 'string', description: '新对话使用的 agent preset，默认继承当前对话' },
        },
      },
      output: {
        schema: looseSchema({
          sessionId: STRING,
          cwd: STRING,
          workspaceId: STRING,
          grouped: BOOLEAN,
          title: STRING,
          parentSessionId: STRING,
          messageSent: BOOLEAN,
          note: STRING,
        }),
        render: (_args, value) => [{
          type: 'text',
          text: `已开启新对话 sessionId=${value.sessionId}${value.cwd ? `（cwd=${value.cwd}）` : ''}`
            + `${value.grouped ? `，已归入分组 workspaceId=${value.workspaceId}` : '（**未归入任何分组，会显示在"未分组"里**）'}。`
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

        // 分组归属只由 workspaceId 决定，且 create 里 workspaceId 与 cwd 互斥：
        // 只传 cwd 会得到正确的工作目录，却落到"未分组"。所以先按目录解析 workspace。
        const requestedWorkspace = readText(args.workspaceId, '')
        let workspaceId = requestedWorkspace
        if (workspaceId === '' && cwd !== '') {
          try {
            const registry = api.workspaceRegistry
            const workspace = await registry?.resolveByPath?.(cwd)
            if (workspace?.id !== undefined) workspaceId = String(workspace.id)
          } catch (error) {
            // 目录不存在 / 未登记为 workspace → 退回只给 cwd（会显示未分组，但不阻断开窗）
            api.warn(`按 ${cwd} 解析分组失败，将不归入分组: ${String(error)}`)
          }
        }

        const request = {}
        if (workspaceId !== '') request.workspaceId = workspaceId
        else if (cwd !== '') request.cwd = cwd
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
            handoffFile: readText(args.handoffFile, ''),
          })
          await api.sessionController.prompt({
            requestId: randomUUID(),
            sessionId,
            mode: 'queue',
            content: textBlocks(`${header}${body}`),
          }, signalOf(exec))
          messageSent = true
        }

        // 报告真实生效的工作目录：走 workspaceId 建会话时，cwd 是那个 workspace 的路径。
        let effectiveCwd = cwd
        if (workspaceId !== '') {
          try {
            const path = api.workspaceRegistry?.get?.(workspaceId)?.path
            if (typeof path === 'string' && path.length > 0) effectiveCwd = path
          } catch {
            /* 取不到就报我们算出来的 cwd */
          }
        }

        return {
          sessionId,
          cwd: effectiveCwd,
          workspaceId,
          grouped: workspaceId !== '',
          title,
          parentSessionId,
          messageSent,
          note: '需要它回答就给它发消息；它有问题时可用 conversation_ask 回问本对话，或用 conversation_outline/search/read 翻本对话的日志。',
        }
      },
    }),

    /* ---------------------------------------------------------------- *
     * conversation_handoffs（结论层：本插件自持的交接件）
     * ---------------------------------------------------------------- */
    tool({
      name: 'conversation_handoffs',
      requiresController: false,
      description:
        '读本插件自己留存的交接件。不给 file 时给目录页（每个交接件的创建时间、来源对话、四段首行）；'
        + '给 file 时读全文。这是"已经合上的旧书"的读后感，配合 conversation_outline/search 翻正文。'
        + '只读本地文件，不碰任何记忆插件。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', description: '交接件文件名或绝对路径；给了就读全文' },
          cwd: { type: 'string', description: '按该工作目录找交接件，默认当前对话的工作目录' },
          limit: { type: 'integer', description: '目录页最多列多少个，默认 20' },
          sinceMs: { type: 'integer', description: '只列最近这么多毫秒内创建的' },
        },
      },
      output: {
        schema: looseSchema({
          dir: STRING,
          total: INTEGER,
          handoffs: { type: 'array', items: { type: 'object', additionalProperties: true } },
          file: STRING,
          heads: { type: 'object', additionalProperties: true },
          sectionText: { type: 'object', additionalProperties: true },
          raw: STRING,
        }),
        render: (_args, value) => [{
          type: 'text',
          text: value.file !== undefined
            ? `交接件 ${value.file}\n\n${value.raw}`
            : (value.handoffs.length === 0
              ? `还没有交接件（目录：${value.dir}）。`
              : `交接件目录 ${value.dir}（共 ${value.total} 个，列 ${value.handoffs.length} 个）：\n`
                + value.handoffs.map((item) => `\n【${item.name}】${item.createdAt} 来源=${item.fromSessionId} 水位=${item.percent}%\n`
                  + Object.entries(item.heads ?? {}).map(([title, head]) => `  ${title}：${head}`).join('\n')).join('\n')),
        }],
      },
      async execute(args, exec) {
        const session = exec?.agent?.session
        const cwd = readText(args.cwd, typeof session?.header?.cwd === 'string' ? session.header.cwd : '')
        if (typeof args.file === 'string' && args.file.trim().length > 0) {
          const value = await readHandoff({ dir: config.handoff.dir, cwd, file: args.file.trim() })
          return {
            dir: resolveDir(config.handoff.dir, cwd),
            file: value.file,
            heads: value.heads,
            sectionText: value.sectionText,
            raw: value.raw,
          }
        }
        const limit = readInteger(args.limit, 20, 1, 200)
        const listed = await listHandoffs({
          dir: config.handoff.dir,
          cwd,
          limit,
          sinceMs: Number.isSafeInteger(args.sinceMs) ? args.sinceMs : undefined,
        })
        return { dir: listed.dir, total: listed.total, handoffs: listed.handoffs }
      },
    }),

    /* ---------------------------------------------------------------- *
     * conversation_handoff_write（写交接件：四段是硬契约）
     * ---------------------------------------------------------------- */
    tool({
      name: 'conversation_handoff_write',
      requiresController: false,
      description:
        '把该留下的写成交接件（固定四段，逐字标题由插件负责渲染）。四段都要写实、写具体；'
        + '某段为空或过短会被**拒绝写入**并告诉你缺哪段。写完后把返回的文件路径传给 conversation_start 的 handoffFile。'
        + '文件落在本插件自己的目录里，与任何记忆插件无关。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['taskState', 'goals', 'deadEnds', 'nextSteps'],
        properties: {
          taskState: { type: 'string', description: `${config.handoff.sections[0]}：现在停在哪、有哪些产物/未落盘风险` },
          goals: { type: 'string', description: `${config.handoff.sections[1]}：要达成的目标与判据` },
          deadEnds: { type: 'string', description: `${config.handoff.sections[2]}：试过什么、为什么不行（这条最省下个对话的时间）` },
          nextSteps: { type: 'string', description: `${config.handoff.sections[3]}：进度与明确的下一步` },
          title: { type: 'string', description: '交接件标题，便于之后在目录里认出来' },
          cwd: { type: 'string', description: '写进哪个工作目录的交接件目录，默认当前对话的工作目录' },
        },
      },
      output: {
        schema: looseSchema({ file: STRING, dir: STRING, bytes: INTEGER, chars: INTEGER, createdAt: STRING }),
        render: (_args, value) => [{
          type: 'text',
          text: `交接件已落盘：${value.file}（${value.bytes} 字节）。\n`
            + `下一步：调用 conversation_start，把交接件全文放进 message，并传 handoffFile=上面这个路径。`,
        }],
      },
      async execute(args, exec) {
        const session = exec?.agent?.session
        const cwd = readText(args.cwd, typeof session?.header?.cwd === 'string' ? session.header.cwd : '')
        const pressure = host.readOwnPressure(session)
        const value = await writeHandoff({
          dir: config.handoff.dir,
          cwd,
          titles: config.handoff.sections,
          minChars: config.handoff.minSectionChars,
          title: readText(args.title, ''),
          fromSessionId: session?.id === undefined ? '' : String(session.id),
          percent: pressure?.percent,
          sections: {
            taskState: args.taskState,
            goals: args.goals,
            deadEnds: args.deadEnds,
            nextSteps: args.nextSteps,
          },
        })
        api.markHandedOff(session?.id)
        return value
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
    ...(Number.isSafeInteger(point.summarySeq) ? { summarySeq: point.summarySeq } : {}),
    ...(Number.isSafeInteger(point.checkpointSeq) ? { checkpointSeq: point.checkpointSeq } : {}),
    ...(Number.isSafeInteger(point.startSeq) ? { startSeq: point.startSeq } : {}),
    ...(Number.isSafeInteger(point.endSeq) ? { endSeq: point.endSeq } : {}),
    time: point.time,
    ...(Number.isFinite(point.tokenCount) ? { tokenCount: point.tokenCount } : {}),
    head: typeof point.head === 'string' ? point.head : '',
  }
}

function renderScannedRange(range) {
  if (!isRecord(range)) return ''
  const from = Number.isSafeInteger(range.fromSeq) ? range.fromSeq : '?'
  const to = Number.isSafeInteger(range.toSeq) ? range.toSeq : '?'
  return `实际扫描范围：seq ${from}..${to}（${range.pages ?? 0} 页`
    + `${range.reachedStart === false ? '，**未到会话开头**' : '，已到会话开头'}）\n`
}

function renderPointLine(point) {
  return `  · seq=${point.seq} 覆盖 seq=${point.startSeq ?? '?'}..${point.endSeq ?? '?'}`
    + `${Number.isFinite(point.tokenCount) ? ` 折叠 ${point.tokenCount} tokens` : ''}`
    + `${point.head ? `｜${point.head.slice(0, 80)}` : ''}`
}

function renderHandoffHeader(vars) {
  return `[接力对话] 这是一段由交接产生的新对话，接替上一段对话。
- 上一段对话 sessionId = \`${vars.parentSessionId}\`${vars.parentTitle ? `（标题：${vars.parentTitle}）` : ''}${vars.parentCwd ? `，工作目录：${vars.parentCwd}` : ''}
${vars.handoffFile ? `- 本次交接件：\`${vars.handoffFile}\`（可用 conversation_handoffs 传 file 再读一遍）\n` : ''}- **首选**：向它回问 —— \`conversation_ask\`（sessionId=\`${vars.parentSessionId}\`，question=你的问题），
  然后 \`conversation_read\`（sessionId + askId）读答复；**看 trust**：
  - \`clean\` → 直接用；
  - \`compacted_by_ask\` / \`compacted_earlier\` / \`unknown\` → 结果可能失真，去翻它的原文比对。
- **回退**：翻旧书（只读、不给对方加压）—— \`conversation_outline\` 看目录 →
  \`conversation_search\` 找位置 → \`conversation_read\`（atSeq）取原文块。
- 交接件正文在下面的消息里；真相以工作区文件与日志为准，不要只信摘要。

---

`
}

function renderReadResult(value) {
  if (value.block !== undefined) {
    const mismatch = Number.isSafeInteger(value.requestedSeq) && value.requestedSeq !== value.block.seq
      ? `（请求 seq=${value.requestedSeq}，实际 seq=${value.block.seq}）`
      : ''
    return `[seq=${value.block.seq} ${value.block.role}/${value.block.kind}]${mismatch}\n${value.block.text}`
  }
  const lines = []
  if (value.trust !== undefined) {
    lines.push(value.trust === 'clean'
      ? '可信度：clean —— 答复基于真实表面，可直接使用。'
      : `可信度：${value.trust}${value.reason ? `（${value.reason}）` : ''}`
        + `${value.answered === false ? '；**对方还没回**，稍后再读' : ' —— 答复可能失真，建议翻旧书比对原文。'}`)
  }
  if (value.questionSeq !== undefined || value.replySeq !== undefined) {
    lines.push(`定位：提问 seq=${value.questionSeq ?? '?'} → 答复 seq=${value.replySeq ?? '（尚无）'}`)
  }
  if (Array.isArray(value.compactionPoints) && value.compactionPoints.length > 0) {
    lines.push(`窗口内压缩点：\n${value.compactionPoints.map(renderPointLine).join('\n')}`)
  }
  if (value.occupancyAfter !== undefined) {
    lines.push(`对方当前占用：${value.occupancyAfter.percent}%（来源 ${value.occupancyAfter.source}）`)
  }
  const body = value.messages.length === 0
    ? '（没有可读消息）'
    : value.messages.map((message) =>
      `[seq=${message.seq} ${message.role}/${message.kind}] ${message.text}`).join('\n\n')
  return `${lines.length > 0 ? `${lines.join('\n')}\n\n` : ''}${body}`
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

  /* ---- 每会话的提醒状态（进程内，不持久化） ---- */
  const handoffStates = new Map()
  function handoffStateFor(sessionId) {
    const key = String(sessionId)
    let state = handoffStates.get(key)
    if (state === undefined) {
      state = { armed: true, lastRemindedAt: 0, handedOffAt: 0 }
      handoffStates.set(key, state)
    }
    return state
  }

  const api = {
    host,
    guard,
    config,
    get sessionController() {
      return ctx.get('sessionController')
    },
    /** 分组归属要看它：create 只认 workspaceId（见 conversation_start）。 */
    get workspaceRegistry() {
      return ctx.get('workspaceRegistry')
    },
    warn(message) {
      try {
        ctx.logger?.warn?.(`${PLUGIN}: ${message}`)
      } catch {
        /* 日志失败不影响功能 */
      }
    },
    info(message) {
      try {
        ctx.logger?.info?.(`${PLUGIN}: ${message}`)
      } catch {
        /* 日志失败不影响功能 */
      }
    },
    /** 交接件写出去之后，本对话在该时长内不再被提醒。 */
    markHandedOff(sessionId) {
      const id = sessionId === undefined || sessionId === null ? '' : String(sessionId)
      if (id === '') return
      const state = handoffStateFor(id)
      state.handedOffAt = Date.now()
      state.armed = false
    },
  }

  /* ---- 水位提醒（独立于工具开关） ---- */
  if (config.handoff.enabled) {
    // 每个模型步骤都会提交 assistant/message（有正文）或 assistant/attempt（只有工具调用）；
    // request/context 只在路由/窗口变化时写；tool/result 会长大上下文表面。
    const watched = new Set(['assistant/message', 'assistant/attempt', 'request/context', 'tool/result', 'turn/end'])

    const evaluate = (session) => {
      if (session === undefined || session === null) return
      if (config.handoff.skipSubagents && session.header?.origin === 'subagent') return
      const agent = ctx.get('agents')?.get?.(session.id)
      if (agent === undefined) return
      const pressure = host.readOwnPressure(agent.session)
      if (pressure === undefined) return

      const state = handoffStateFor(session.id)
      if (pressure.ratio <= config.handoff.rearmBelow) state.armed = true
      if (pressure.ratio < config.handoff.threshold || !state.armed) return

      const now = Date.now()
      if (now - state.lastRemindedAt < config.handoff.cooldownMs) return
      if (now - state.handedOffAt < config.handoff.handoffQuietMs) return

      const controller = api.sessionController
      if (controller === undefined) return

      state.armed = false
      state.lastRemindedAt = now
      const cwd = typeof session.header?.cwd === 'string' ? session.header.cwd : ''
      // 提醒里给出真实落盘目录：即使本会话看不到交接件工具，模型也能用惯用的写文件工具落到这里
      const handoffDir = resolveDir(config.handoff.dir, cwd)
      const text = render(config.handoff.reminderText, {
        percent: pressure.percent,
        tokens: pressure.tokens,
        window: pressure.contextWindow,
        threshold: Math.round(config.handoff.threshold * 1000) / 10,
        sessionId: String(session.id),
        cwd: cwd === '' ? '（未设置）' : cwd,
        writeTool: config.handoff.toolEnabled
          ? '`conversation_handoff_write`（四段各写一段）'
          : '你惯用的写文件工具（把四段写成 Markdown 小节）',
        handoffDir,
      })
      queueMicrotask(() => {
        controller.prompt({
          requestId: randomUUID(),
          sessionId: session.id,
          mode: config.handoff.deliver,
          content: textBlocks(text),
        }, idleSignal()).then(
          () => ctx.logger?.info?.(`${PLUGIN}: 已向 ${String(session.id)} 注入交接提醒（${pressure.percent}%）`),
          (error) => api.warn(`向 ${String(session.id)} 注入提醒失败: ${String(error)}`),
        )
      })
    }

    ctx.on('session/event', (session, event) => {
      if (!watched.has(event?.type)) return
      try {
        evaluate(session)
      } catch (error) {
        api.warn(`水位检查失败: ${String(error)}`)
      }
    })
    ctx.on('session/disposed', (session) => {
      handoffStates.delete(String(session?.id))
    })
  }

  /* ---- 工具 ---- */
  //
  // 重要教训（2026-10-04 真机）：**不要在 apply 里用 ctx.get() 探测服务是否可用**。
  // 冷启动时 Cordis 的加载顺序不保证 sessionController 已注册，探测会得到 undefined，
  // 于是工具被静默跳过（现象：entry 的 fiberPhase=active，但一个工具都没注册）。
  // 正确做法是用 ctx.inject([...], cb) 等服务就绪再注册。
  if (config.exposeTools) {
    const definitions = buildTools(api, config)
    const fileTools = definitions.filter((definition) => definition.requiresController !== true)
    const sessionTools = definitions.filter((definition) => definition.requiresController === true)

    for (const definition of fileTools) ctx.tools.register(definition)
    if (fileTools.length > 0) api.info(`已注册 ${fileTools.length} 个本地工具（无会话服务依赖）`)

    // 两种加载顺序都要覆盖，且不重复注册：
    //   · 服务已就绪（HMR 重载 / 后加载的插件）→ 立即注册
    //   · 冷启动时服务后到 → ctx.inject 回调里补注册
    // 注册一律落在插件自己的 ctx.tools 上（效果归属插件），不依赖 scoped 上下文。
    const registeredNames = new Set()
    const registerSessionTools = () => {
      let added = 0
      for (const definition of sessionTools) {
        if (registeredNames.has(definition.name)) continue
        registeredNames.add(definition.name)
        ctx.tools.register(definition)
        added += 1
      }
      if (added > 0) api.info(`sessionController 就绪，已注册 ${added} 个跨对话工具`)
    }
    if (ctx.get('sessionController') !== undefined) registerSessionTools()
    ctx.inject(['sessionController'], registerSessionTools)
  }

  ctx.logger?.info?.(
    `${PLUGIN}: 已启用（水位提醒 ${config.handoff.enabled ? `${Math.round(config.handoff.threshold * 100)}%` : '关'}；`
    + `交接件目录 ${config.handoff.dir === '' ? '（跟随会话工作目录）' : config.handoff.dir}）`,
  )
}

/** 供冒烟测试使用的具名导出（宿主只认 name / inject / apply / Config）。 */
export { collectSubtree as __collectSubtree, renderHandoffHeader as __renderHandoffHeader }

export const __idleSignal = idleSignal
