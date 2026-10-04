/**
 * 只读宿主适配层。
 *
 * 本模块是"绝不唤醒对方"这条铁律的**唯一实现点**：
 * 只用 list / inspect / page / projections 四条只读通道，**任何地方都不出现 resolveAgent**。
 *
 * 同时它也是"可独立发布"的降级点：宿主服务缺失时返回 undefined / 空，
 * 由调用方决定降级行为，而不是抛错。
 *
 * @module dsh-conversation-bridge/host
 */

/** 这两条接口的 @Remote 包装层会对 signal 调 throwIfAborted()，漏传即抛 TypeError。 */
export function idleSignal() {
  return new AbortController().signal
}

/** 工具执行上下文里有信号就透传（工具被中止时同步中止宿主调用），否则用兜底信号。 */
export function signalOf(exec) {
  return exec?.signal ?? idleSignal()
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toId(value) {
  return value === undefined || value === null ? '' : String(value)
}

/**
 * 创建一个只读宿主门面。
 * @param ctx - 插件上下文。
 */
export function createHost(ctx) {
  /** 会话 id → 最近一次解析到的游标（避免同一轮里反复 inspect）。 */
  const cursorCache = new Map()
  /** 会话摘要的短缓存：地址判定要用它，别为每次读取再调一次 list。 */
  let summaryCache = { at: 0, rows: [] }
  /** 子 agent 会话 id → 探测成功的地址 mode，避免每次重试。 */
  const subagentModeCache = new Map()

  const SUMMARY_TTL_MS = 10000
  const SUBAGENT_MODES = ['unknown', 'continuable', 'one-shot']

  function controller() {
    return ctx.get('sessionController')
  }

  function available() {
    return controller() !== undefined
  }

  /* ------------------------------------------------------------------ *
   * list：全部会话摘要（只读，不激活任何 Agent）
   * ------------------------------------------------------------------ */

  async function listSummaries(signal) {
    const api = controller()
    if (api === undefined) return []
    const value = await api.list({}, signal ?? idleSignal())
    const items = Array.isArray(value?.items) ? value.items : []
    const rows = items.filter(isRecord).map(normalizeSummary)
    summaryCache = { at: Date.now(), rows }
    return rows
  }

  /** 带短 TTL 的摘要列表（只读；用于判定"这个会话是不是子 agent"）。 */
  async function cachedSummaries(signal) {
    if (Date.now() - summaryCache.at < SUMMARY_TTL_MS && summaryCache.rows.length > 0) return summaryCache.rows
    try {
      return await listSummaries(signal)
    } catch {
      return summaryCache.rows
    }
  }

  /**
   * 组装 page 的 address。
   *
   * 真机教训：**子 agent 会话不能按 `{kind:'session'}` 读**，宿主直接拒（
   * `subagent Sessions require their durable parent address`）；必须用
   * `{kind:'subagent', parentSessionId, childSessionId, mode}`。
   * 父地址从会话摘要里拿（`origin==='subagent'` + `parentSessionId`）；
   * mode 未知时按候选逐个试探并记住赢家。
   */
  async function resolveAddress(sessionId, signal, hint) {
    const explicitParent = isRecord(hint) ? toId(hint.parentSessionId) : ''
    if (explicitParent !== '') {
      return {
        kind: 'subagent',
        parentSessionId: explicitParent,
        childSessionId: sessionId,
        mode: modeOf(hint?.mode),
      }
    }
    const rows = await cachedSummaries(signal)
    const found = rows.find((row) => row.sessionId === sessionId)
    if (found === undefined || found.origin !== 'subagent' || found.parentSessionId === '') {
      return { kind: 'session', sessionId }
    }
    return {
      kind: 'subagent',
      parentSessionId: found.parentSessionId,
      childSessionId: sessionId,
      mode: subagentModeCache.get(sessionId) ?? 'unknown',
    }
  }

  function modeOf(value) {
    return value === 'one-shot' || value === 'continuable' ? value : 'unknown'
  }

  /**
   * 读一页历史。调用方**必须**先拿到游标（见 resolveCursor）。
   * @returns { records, hasMore, empty }
   */
  async function readPage(options, signal) {
    const api = controller()
    const sessionId = toId(options?.sessionId)
    if (api === undefined || sessionId === '') return { records: [], hasMore: false, empty: true }

    let throughSeq = options?.throughSeq
    if (!Number.isSafeInteger(throughSeq)) throughSeq = await resolveCursor(sessionId, signal)
    if (!Number.isSafeInteger(throughSeq)) return { records: [], hasMore: false, unreadable: true }
    // -1 是"无事件"哨兵：直接返回空，**绝不能**把它传进 page（那会拿到空页且看起来像"没消息"）
    if (throughSeq < 0) return { records: [], hasMore: false, empty: true }

    const address = await resolveAddress(sessionId, signal, options?.addressHint)
    const request = {
      address,
      throughSeq,
      maxMessages: Number.isSafeInteger(options?.maxMessages) && options.maxMessages > 0
        ? options.maxMessages
        : PAGE_SIZE,
    }
    if (Number.isSafeInteger(options?.beforeSeq)) request.beforeSeq = options.beforeSeq
    if (isRecord(options?.turnWindow)) request.turnWindow = options.turnWindow

    // 子 agent 且 mode 是猜的：逐个候选试探（只读调用，失败就换下一个）
    const modes = address.kind === 'subagent' && !subagentModeCache.has(sessionId)
      ? SUBAGENT_MODES
      : [address.mode]
    let lastError
    for (const mode of modes) {
      try {
        const page = await api.page({ ...request, address: { ...address, mode } }, signal ?? idleSignal())
        if (address.kind === 'subagent') subagentModeCache.set(sessionId, mode)
        const records = Array.isArray(page?.records) ? page.records : []
        return { records, hasMore: page?.hasMore === true, empty: records.length === 0, address }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }

  function normalizeSummary(item) {
    const hints = isRecord(item.projections) ? item.projections : undefined
    const values = isRecord(hints?.values) ? hints.values : undefined
    const title = typeof values?.title === 'string' ? values.title : ''
    return {
      sessionId: toId(item.sessionId),
      title,
      cwd: typeof item.cwd === 'string' ? item.cwd : '',
      origin: typeof item.origin === 'string' ? item.origin : 'session',
      parentSessionId: toId(item.parentSessionId),
      running: item.running === true,
      blank: item.blank === true,
      agentAvailable: item.agentAvailable === true,
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
      pressure: normalizePressureView(values?.contextPressure, 'cached'),
      projectionsAsOf: Number.isSafeInteger(hints?.asOfSeq) ? hints.asOfSeq : undefined,
      cached: hints?.kind === 'cached',
    }
  }

  /**
   * 用 parentSessionId 算出深度与树形标记。
   * 父不在集合里的（例如被归档/删除，或只列了子树）标 orphanParent。
   */
  function buildTree(summaries) {
    const byId = new Map(summaries.map((item) => [item.sessionId, item]))
    const depthOf = new Map()
    const compute = (item, seen) => {
      const known = depthOf.get(item.sessionId)
      if (known !== undefined) return known
      const parentId = item.parentSessionId
      if (parentId === '' || parentId === item.sessionId || seen.has(parentId)) {
        depthOf.set(item.sessionId, 0)
        return 0
      }
      const parent = byId.get(parentId)
      if (parent === undefined) {
        depthOf.set(item.sessionId, 0)
        return 0
      }
      seen.add(item.sessionId)
      const depth = compute(parent, seen) + 1
      depthOf.set(item.sessionId, depth)
      return depth
    }
    return summaries.map((item) => ({
      ...item,
      depth: compute(item, new Set()),
      orphanParent: item.parentSessionId !== '' && !byId.has(item.parentSessionId),
    }))
  }

  /* ------------------------------------------------------------------ *
   * 游标：page() 的 throughSeq 不能传 -1（那是空页），必须先拿到真实 seq
   * ------------------------------------------------------------------ */

  /**
   * 解析某会话的日志游标（= 最后一个事件的 seq）。
   * @returns 游标；**-1 表示该会话没有任何事件**；undefined 表示读不到。
   */
  async function resolveCursor(sessionId, signal, hint) {
    const id = toId(sessionId)
    if (id === '') return undefined
    if (Number.isSafeInteger(hint) && hint >= 0) {
      cursorCache.set(id, hint)
      return hint
    }
    const api = controller()
    if (api === undefined) return undefined

    // 路径一（便宜）：projections 是 live-preferred 的只读观察，给出 asOfSeq
    try {
      const baseline = await api.projections({ sessionId: id }, signal ?? idleSignal())
      const asOf = baseline?.asOfSeq
      if (Number.isSafeInteger(asOf) && asOf >= -1) {
        cursorCache.set(id, asOf)
        return asOf
      }
    } catch {
      /* 会话不存在 / 读不到 → 走 inspect 兜底 */
    }

    // 路径二（精确但贵）：inspect 返回完整事件前缀
    try {
      const info = await api.inspect(id, signal ?? idleSignal())
      const events = Array.isArray(info?.events) ? info.events : undefined
      if (events !== undefined) {
        const last = events[events.length - 1]
        const cursor = events.length === 0 ? -1 : (Number.isSafeInteger(last?.seq) ? last.seq : -1)
        cursorCache.set(id, cursor)
        return cursor
      }
    } catch {
      /* 读不到 */
    }
    // 路径三：子 agent 会话走不了上面两条（它们没有传父地址的入口），
    // 但 list() 的摘要里带 asOfSeq —— 冷启动之外这是唯一能拿到的游标。
    try {
      const rows = await cachedSummaries(signal)
      const found = rows.find((row) => row.sessionId === id)
      if (found !== undefined && Number.isSafeInteger(found.projectionsAsOf)) {
        cursorCache.set(id, found.projectionsAsOf)
        return found.projectionsAsOf
      }
    } catch {
      /* 读不到 */
    }
    return cursorCache.get(id)
  }

  /** 供测试断言用：清掉游标缓存。 */
  function clearCursorCache() {
    cursorCache.clear()
  }

  /* ------------------------------------------------------------------ *
   * page：消息对齐的历史页（只读，cold-safe）
   * ------------------------------------------------------------------ */

  /** 一页能装的消息数上限（宿主侧默认值未知，我们一律显式传）。 */
  const PAGE_SIZE = 40

  /**
   * 向后翻页直到收集够或没有更多。
   * 翻书场景用：预算由 budget 控制，绝不无限翻。
   */
  async function readPagesBackwards(options, signal) {
    const maxPages = Number.isSafeInteger(options?.maxPages) && options.maxPages > 0 ? options.maxPages : 5
    const collected = []
    let cursor = Number.isSafeInteger(options?.throughSeq) ? options.throughSeq : undefined
    let hasMore = false
    /** 报告**实际扫到的**范围：调用方必须知道"没找到"只代表"这段里没有"。 */
    const finish = (result) => {
      const seqs = collected
        .map((record) => record?.event?.seq)
        .filter((seq) => Number.isSafeInteger(seq))
      return {
        ...result,
        records: collected,
        ...(seqs.length === 0 ? {} : { fromSeq: Math.min(...seqs), toSeq: Math.max(...seqs) }),
      }
    }
    for (let index = 0; index < maxPages; index++) {
      const page = await readPage({ ...options, throughSeq: cursor }, signal)
      if (page.unreadable === true) return finish({ hasMore, unreadable: true, pages: index })
      if (page.empty === true) return finish({ hasMore: false, pages: index + 1 })
      collected.unshift(...page.records)
      hasMore = page.hasMore
      if (!hasMore) return finish({ hasMore: false, pages: index + 1 })
      const seqs = page.records.map((record) => record?.event?.seq).filter((seq) => Number.isSafeInteger(seq))
      const firstSeq = seqs.length > 0 ? Math.min(...seqs) : undefined
      if (firstSeq === undefined || firstSeq <= 0) return finish({ hasMore: true, pages: index + 1 })
      cursor = firstSeq - 1
    }
    return finish({ hasMore, pages: maxPages })
  }

  /* ------------------------------------------------------------------ *
   * 上下文占用
   * ------------------------------------------------------------------ */

  /** wire 视图：{ contextWindow?, pressureTokens?, projectedTokens? } */
  function normalizePressureView(view, source) {
    if (!isRecord(view)) return undefined
    const tokens = Number.isFinite(view.projectedTokens)
      ? view.projectedTokens
      : (Number.isFinite(view.pressureTokens) ? view.pressureTokens : undefined)
    return finishPressure(tokens, view.contextWindow, source)
  }

  /** 原始投影 state：{ contextWindow?, pressureTokens?, surfaceTokens, sampledSurfaceTokens? } */
  function normalizePressureState(state, source) {
    if (!isRecord(state)) return undefined
    let tokens
    if (Number.isFinite(state.pressureTokens)) {
      const surface = Number.isFinite(state.surfaceTokens) ? state.surfaceTokens : 0
      const sampled = Number.isFinite(state.sampledSurfaceTokens) ? state.sampledSurfaceTokens : 0
      tokens = Math.max(0, state.pressureTokens + surface - sampled)
    }
    return finishPressure(tokens, state.contextWindow, source)
  }

  function finishPressure(tokens, contextWindow, source) {
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined
    if (!Number.isFinite(tokens)) return undefined
    const ratio = tokens / contextWindow
    return {
      tokens: Math.max(0, Math.round(tokens)),
      contextWindow: Math.round(contextWindow),
      ratio,
      percent: Math.round(ratio * 1000) / 10,
      source,
    }
  }

  /** 当前会话（有 Session 对象）：走 live 投影，最准。 */
  function readOwnPressure(session) {
    if (session === undefined || session === null) return undefined
    try {
      const state = ctx.get('sessionProjections')?.stateOf(session, 'contextPressure')
      const fromState = normalizePressureState(state, 'live')
      if (fromState !== undefined) return fromState
    } catch {
      /* 投影未注册 */
    }
    try {
      const window = session.requestContext?.()?.contextWindow
      const tokens = ctx.get('tokenMeter')?.measure(session)?.totalTokens
      return finishPressure(tokens, window, 'live')
    } catch {
      return undefined
    }
  }

  /** 任意会话（没有 Session 对象）：走只读 projections，不激活 Agent。 */
  async function readPressureById(sessionId, signal) {
    const id = toId(sessionId)
    if (id === '') return undefined
    const liveAgent = ctx.get('agents')?.get?.(id)
    if (liveAgent?.session !== undefined) {
      const own = readOwnPressure(liveAgent.session)
      if (own !== undefined) return own
    }
    const api = controller()
    if (api === undefined) return undefined
    try {
      const baseline = await api.projections({ sessionId: id }, signal ?? idleSignal())
      const view = baseline?.values?.contextPressure
      const live = liveAgent !== undefined
      const normalized = normalizePressureView(view, live ? 'live' : 'cached')
      if (normalized !== undefined) return normalized
    } catch {
      /* 读不到 */
    }
    return undefined
  }

  /* ------------------------------------------------------------------ *
   * 其它只读观察
   * ------------------------------------------------------------------ */

  /** 活 agent 数量：验收"只读路径不唤醒"的证据来源。 */
  function liveAgentCount() {
    try {
      const agents = ctx.get('agents')?.list?.()
      return Array.isArray(agents) ? agents.length : -1
    } catch {
      return -1
    }
  }

  return {
    available,
    listSummaries,
    buildTree,
    resolveCursor,
    clearCursorCache,
    readPage,
    readPagesBackwards,
    readOwnPressure,
    readPressureById,
    liveAgentCount,
  }
}
