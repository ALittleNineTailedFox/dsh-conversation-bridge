/**
 * 日志扫描层：把宿主返回的页记录折成"看得懂的东西"。
 *
 * 本模块是**纯函数**集合，不碰任何宿主服务 —— 便于用假数据做冒烟测试。
 *
 * 事件形状（§3.3/§3.4 已核验）：
 *   compaction/summary  data: { summary, shadowedRange:{start,end}, shadowedTokenCount, ... }
 *   压缩 checkpoint     user/message，带 surfaceOp:{op:'replace',startSeq,endSeq}
 *
 * @module dsh-conversation-bridge/scan
 */

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function clip(text, max) {
  if (typeof text !== 'string') return ''
  return text.length > max ? `${text.slice(0, max)}…（已截断，原文 ${text.length} 字）` : text
}

/** 从页记录里取出事件数组（records: [{type:'event', event}]）。 */
export function eventsOf(records) {
  if (!Array.isArray(records)) return []
  const events = []
  for (const record of records) {
    const event = isRecord(record) ? record.event : undefined
    if (isRecord(event) && typeof event.type === 'string' && Number.isSafeInteger(event.seq)) events.push(event)
  }
  events.sort((left, right) => left.seq - right.seq)
  return events
}

/* ------------------------------------------------------------------ *
 * 内容块 → 文本
 * ------------------------------------------------------------------ */

/** 把 content 块拼成纯文本；工具调用只留名字，推理默认丢弃。 */
export function contentToText(content, options = {}) {
  if (!Array.isArray(content)) return ''
  const max = Number.isSafeInteger(options.maxChars) ? options.maxChars : 2400
  const parts = []
  for (const block of content) {
    if (!isRecord(block)) continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
        break
      case 'tool-call':
        parts.push(`[工具调用 ${typeof block.name === 'string' ? block.name : '?'}]`)
        break
      case 'tool-addition':
      case 'tool-removal':
        break
      case 'reasoning':
        if (options.includeReasoning === true && typeof block.text === 'string') parts.push(`[推理] ${block.text}`)
        break
      case 'image':
        parts.push('[图片]')
        break
      case 'file':
        parts.push(`[文件 ${isRecord(block.attachment) && typeof block.attachment.name === 'string' ? block.attachment.name : ''}]`)
        break
      default:
        break
    }
  }
  return clip(parts.join('\n').trim(), max)
}

/* ------------------------------------------------------------------ *
 * 事件 → 消息
 * ------------------------------------------------------------------ */

function toolResultText(data, maxChars) {
  const body = contentToText(data?.message?.content, { maxChars })
  const error = isRecord(data?.error) ? data.error : undefined
  if (error === undefined) return body
  const reason = typeof error.reason === 'string' ? error.reason : ''
  const name = typeof error.name === 'string' ? error.name : 'error'
  const code = typeof error.code === 'string' ? error.code : ''
  const head = `[工具失败 ${name}${code ? `/${code}` : ''}${reason ? `: ${reason}` : ''}]`
  return body.length > 0 ? `${head}\n${body}` : head
}

/**
 * 把一条事件折成"可见消息"；不是可见消息就返回 undefined。
 * kind 取值：user | assistant | tool | developer | system | compaction-summary
 */
export function messageOf(event, options = {}) {
  if (!isRecord(event)) return undefined
  const maxChars = Number.isSafeInteger(options.maxChars) ? options.maxChars : 2400
  const base = { seq: event.seq, time: Number.isFinite(event.time) ? event.time : 0 }
  switch (event.type) {
    case 'user/message': {
      const summary = isRecord(event.surfaceOp) && event.surfaceOp.op === 'replace'
      const kind = summary ? 'compaction-summary' : 'user'
      const text = summary
        ? renderCompactionCheckpoint(event)
        : contentToText(event.data?.content, { maxChars })
      // rpcId 必须**缺省即不写键**：写 `undefined` 会让整个工具结果被判「非无损 JSON」而作废
      // （真机事故：含人类 user 消息的页 100% 读不出来，见 DESIGN §3.9）。
      const rpcId = readRpcId(event)
      return {
        ...base,
        role: 'user',
        kind,
        text,
        ...(rpcId === undefined ? {} : { rpcId }),
      }
    }
    case 'assistant/message': {
      const text = contentToText(event.data?.message?.content, { ...options, maxChars })
      if (text.length === 0) return undefined
      return { ...base, role: 'assistant', kind: 'assistant', text, hasText: true }
    }
    case 'tool/result':
      return { ...base, role: 'tool', kind: 'tool', text: toolResultText(event.data, maxChars) }
    case 'developer/message': {
      const text = contentToText(event.data?.message?.content, { maxChars })
      return text.length === 0 ? undefined : { ...base, role: 'developer', kind: 'developer', text }
    }
    case 'system/message': {
      const text = contentToText(event.data?.message?.content, { maxChars })
      return text.length === 0 ? undefined : { ...base, role: 'system', kind: 'system', text }
    }
    default:
      return undefined
  }
}

function renderCompactionCheckpoint(event) {
  const op = isRecord(event.surfaceOp) ? event.surfaceOp : {}
  const from = Number.isSafeInteger(op.startSeq) ? op.startSeq : '?'
  const to = Number.isSafeInteger(op.endSeq) ? op.endSeq : '?'
  const body = contentToText(event.data?.content, { maxChars: 600 })
  return `[压缩摘要 seq=${event.seq}，覆盖 seq=${from}..${to}；原文仍可翻]\n${body}`
}

/** 回问用的定位锚：prompt 会把我们的 requestId 写成 source.rpcId。 */
export function readRpcId(event) {
  const source = isRecord(event?.data?.source) ? event.data.source : undefined
  const rpcId = source?.rpcId
  return typeof rpcId === 'string' && rpcId.length > 0 ? rpcId : undefined
}

/**
 * 这条 user 角色消息是不是**真人输入**？
 * 只有 `source.kind === 'user'` 才算。其余（模型切换提示 `model-selection`、
 * 目标轮次 `goal`、插件注入等）也是 user 角色，但它们不是"别人又插了一句话"。
 */
export function isHumanInput(event) {
  const source = isRecord(event?.data?.source) ? event.data.source : undefined
  return source?.kind === 'user'
}

export function extractMessages(events, options = {}) {
  const roles = Array.isArray(options.roles) ? new Set(options.roles) : new Set(['user', 'assistant', 'tool'])
  const skipCompactionCheckpoints = options.skipCompactionCheckpoints === true
  const messages = []
  for (const event of events) {
    const message = messageOf(event, options)
    if (message === undefined) continue
    if (!roles.has(message.role)) continue
    if (skipCompactionCheckpoints && message.kind === 'compaction-summary') continue
    messages.push(message)
  }
  return messages
}

/* ------------------------------------------------------------------ *
 * 压缩点
 * ------------------------------------------------------------------ */

/**
 * 收集压缩点。主来源是 compaction/summary（带覆盖范围与摘要），
 * checkpoint（surfaceOp.replace）作为没有 summary 时的兜底标记。
 */
export function collectCompactionPoints(events, options = {}) {
  const headMax = Number.isSafeInteger(options.headChars) ? options.headChars : 200
  const points = []
  const checkpoints = []
  for (const event of events) {
    if (event.type === 'compaction/summary') {
      const range = isRecord(event.data?.shadowedRange) ? event.data.shadowedRange : {}
      // 摘要正文可能在 data.summary，也可能只在 checkpoint 消息里；先留空，后面回填。
      const head = typeof event.data?.summary === 'string' ? clip(event.data.summary, headMax) : ''
      points.push({
        summarySeq: event.seq,
        time: Number.isFinite(event.time) ? event.time : 0,
        ...(Number.isSafeInteger(range.start) ? { startSeq: range.start } : {}),
        ...(Number.isSafeInteger(range.end) ? { endSeq: range.end } : {}),
        ...(Number.isFinite(event.data?.shadowedTokenCount) ? { tokenCount: event.data.shadowedTokenCount } : {}),
        head,
      })
    } else if (event.type === 'user/message' && isRecord(event.surfaceOp) && event.surfaceOp.op === 'replace') {
      checkpoints.push({
        checkpointSeq: event.seq,
        time: Number.isFinite(event.time) ? event.time : 0,
        ...(Number.isSafeInteger(event.surfaceOp.startSeq) ? { startSeq: event.surfaceOp.startSeq } : {}),
        ...(Number.isSafeInteger(event.surfaceOp.endSeq) ? { endSeq: event.surfaceOp.endSeq } : {}),
        text: contentToText(event.data?.content, { maxChars: headMax }),
      })
    }
  }
  for (const checkpoint of checkpoints) {
    const covered = points.some((point) =>
      point.summarySeq !== undefined && point.summarySeq <= checkpoint.checkpointSeq
      && (checkpoint.startSeq === undefined || point.endSeq === undefined || point.endSeq >= checkpoint.startSeq - 1))
    if (!covered) {
      points.push({
        checkpointSeq: checkpoint.checkpointSeq,
        time: checkpoint.time,
        ...(checkpoint.startSeq === undefined ? {} : { startSeq: checkpoint.startSeq }),
        ...(checkpoint.endSeq === undefined ? {} : { endSeq: checkpoint.endSeq }),
        head: checkpoint.text,
      })
    }
  }
  // 回填空 head：摘要事件本身没有正文时，用同范围的 checkpoint 消息正文顶上
  for (const point of points) {
    if (point.head !== '' || point.summarySeq === undefined) continue
    const sameRange = checkpoints.find((checkpoint) =>
      checkpoint.startSeq !== undefined && checkpoint.startSeq === point.startSeq)
    if (sameRange !== undefined && sameRange.text.length > 0) point.head = sameRange.text
  }
  points.sort((left, right) => pointSeq(left) - pointSeq(right))
  return points
}

/** 压缩点用于先后比较的序号。 */
export function pointSeq(point) {
  return Number.isSafeInteger(point?.summarySeq)
    ? point.summarySeq
    : (Number.isSafeInteger(point?.checkpointSeq) ? point.checkpointSeq : -1)
}

/* ------------------------------------------------------------------ *
 * 旧书目录（Tier-0）
 * ------------------------------------------------------------------ */

/**
 * 按 turn 折目录。返回**最后** maxTurns 轮（最新的更有用），并报告被截断的总轮数。
 */
export function buildOutline(events, options = {}) {
  const maxTurns = Number.isSafeInteger(options.maxTurns) ? options.maxTurns : 50
  const headMax = Number.isSafeInteger(options.headChars) ? options.headChars : 80
  const points = collectCompactionPoints(events, { headChars: headMax })
  const turns = []
  let current
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        current = {
          turn: Number.isFinite(event.data?.turn) ? event.data.turn : turns.length + 1,
          startSeq: event.seq,
          endSeq: event.seq,
          time: Number.isFinite(event.time) ? event.time : 0,
          userHead: '',
          hasToolCalls: false,
          toolFailures: 0,
          compacted: false,
        }
        turns.push(current)
        break
      case 'tool/call':
        if (current !== undefined) {
          current.hasToolCalls = true
          current.endSeq = event.seq
        }
        break
      default: {
        if (current === undefined) break
        current.endSeq = event.seq
        if (event.type === 'user/message' && !(isRecord(event.surfaceOp) && event.surfaceOp.op === 'replace') && current.userHead === '') {
          current.userHead = clip(contentToText(event.data?.content, { maxChars: headMax }).split('\n')[0] ?? '', headMax)
        } else if (event.type === 'tool/result' && isRecord(event.data?.error)) {
          current.toolFailures += 1
        }
        break
      }
    }
  }
  for (const turn of turns) {
    turn.compacted = points.some((point) => {
      const seq = pointSeq(point)
      const from = Number.isSafeInteger(point.startSeq) ? point.startSeq : seq
      return seq >= 0 && from <= turn.endSeq && seq >= turn.startSeq
    })
  }
  const totalTurns = turns.length
  const shown = totalTurns > maxTurns ? turns.slice(totalTurns - maxTurns) : turns
  return {
    turns: shown,
    totalTurns,
    truncated: totalTurns > maxTurns,
    compactionPoints: points,
  }
}

/* ------------------------------------------------------------------ *
 * 检索（Tier-1）
 * ------------------------------------------------------------------ */

function termsOf(query) {
  return String(query ?? '')
    .split(/\s+/)
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0)
}

function snippetAround(text, term, width) {
  const index = text.toLowerCase().indexOf(term)
  if (index < 0) return clip(text, width * 2)
  const start = Math.max(0, index - width)
  const end = Math.min(text.length, index + term.length + width)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end)}${suffix}`
}

export function searchEvents(events, query, options = {}) {
  const terms = termsOf(query)
  if (terms.length === 0) return { hits: [], scanned: 0, terms }
  const limit = Number.isSafeInteger(options.limit) ? options.limit : 20
  const maxChars = Number.isSafeInteger(options.maxChars) ? options.maxChars : 2400
  const roles = Array.isArray(options.roles) ? new Set(options.roles) : new Set(['user', 'assistant', 'tool'])
  const hits = []
  let scanned = 0
  for (const event of events) {
    const message = messageOf(event, { maxChars, includeReasoning: options.includeReasoning === true })
    if (message === undefined || !roles.has(message.role)) continue
    scanned += 1
    const haystack = message.text.toLowerCase()
    let matched = 0
    for (const term of terms) {
      if (haystack.includes(term)) matched += 1
      else {
        matched = -1
        break
      }
    }
    if (matched <= 0) continue
    hits.push({
      sessionId: options.sessionId === undefined ? '' : String(options.sessionId),
      seq: message.seq,
      time: message.time,
      role: message.role,
      kind: message.kind,
      snippet: clip(snippetAround(message.text, terms[0], 120), maxChars),
      matched,
    })
  }
  hits.sort((left, right) => right.matched - left.matched || right.seq - left.seq)
  return { hits: hits.slice(0, limit), scanned, terms }
}

/* ------------------------------------------------------------------ *
 * 可信度（§5）
 * ------------------------------------------------------------------ */

/**
 * 判定"这一问拿到的答复可不可信"。
 *
 * 用 rpcId 精确定位我们问的那一条（prompt 会把 requestId 写成 source.rpcId），
 * 于是窗口起点不需要事前记游标。
 *
 * @param events - 覆盖"提问之前到现在"的事件数组（越全越准）
 * @param askId - conversation_ask 返回的 askId
 */
export function assessTrust(events, askId) {
  const id = typeof askId === 'string' ? askId : ''
  let questionSeq
  let noise = false
  let replySeq
  for (const event of events) {
    if (event.type === 'user/message') {
      const rpcId = readRpcId(event)
      if (id.length > 0 && rpcId === id) questionSeq = event.seq
      else if (questionSeq !== undefined
        && !(isRecord(event.surfaceOp) && event.surfaceOp.op === 'replace')
        && isHumanInput(event)) {
        // 只有**真人输入**才算并发噪声。模型切换提示（source.kind='model-selection'）、
        // 目标轮次、插件注入等也是 user 角色消息，把它们算成并发会让 trust 恒为 unknown，
        // 直接废掉"先回问拿结论"这条路（真机复验就撞到了）。
        noise = true
      }
    } else if (event.type === 'assistant/message' && questionSeq !== undefined) {
      const text = contentToText(event.data?.message?.content, { maxChars: 200 })
      if (text.length > 0) replySeq = event.seq
    }
  }
  const points = collectCompactionPoints(events, { headChars: 120 })
  const inWindow = questionSeq === undefined
    ? []
    : points.filter((point) => pointSeq(point) > questionSeq)

  if (questionSeq === undefined) {
    return { trust: 'unknown', answered: replySeq !== undefined, reason: 'ask-not-found', questionSeq, replySeq, points: [] }
  }
  if (replySeq === undefined) {
    return { trust: 'unknown', answered: false, reason: 'no-reply-yet', questionSeq, replySeq, points: inWindow }
  }
  if (noise) {
    return { trust: 'unknown', answered: true, reason: 'concurrent-input', questionSeq, replySeq, points: inWindow }
  }
  const beforeReply = inWindow.filter((point) => pointSeq(point) < replySeq)
  if (beforeReply.length > 0) {
    return { trust: 'compacted_by_ask', answered: true, reason: 'compaction-before-reply', questionSeq, replySeq, points: inWindow }
  }
  const beforeQuestion = questionSeq === undefined
    ? []
    : points.filter((point) => pointSeq(point) < questionSeq)
  if (inWindow.length > 0 || beforeQuestion.length > 0) {
    return { trust: 'compacted_earlier', answered: true, reason: 'earlier-compaction', questionSeq, replySeq, points: inWindow }
  }
  return { trust: 'clean', answered: true, reason: 'ok', questionSeq, replySeq, points: inWindow }
}
