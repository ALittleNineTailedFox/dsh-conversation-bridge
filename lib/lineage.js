/**
 * 交接关系账：本插件自己记的"谁开了谁"。
 *
 * **为什么需要它**：宿主对**普通会话**不记录"B 是 A 建出来的"——`sessionController.create` 落盘的 meta
 * 只有 `{cwd, agentPreset}`，没有 `parentSession`。而本插件的产品边界是"只服务交接链"：
 * 只允许**直接交接边**（caller 拉起 target，或 target 拉起 caller）上的两个对话互相投递。
 * 这条边既然宿主没有，就由插件在 `conversation_start` 成功时自己记一笔。
 *
 * **为什么不从日志里推断**：子会话的第一条消息里确实有我们的接力头，但读"第一条消息"要反向翻页到
 * seq 0（会话越长越贵），而且"不带开场消息开窗"的对话根本没有那条头。账本一次读一个文件就够。
 *
 * **边界**：这里只记关系（两个 sessionId 之间有一条交接边），不记任何内容——内容在会话日志里，
 * 账本删了也不丢东西，只是这些边需要重新建立（再用 conversation_start 开一次窗即可）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 默认位置（**惰性求值**：`homedir()` 在调用时才读，测试/环境改动才不会被模块加载时序吃掉）。 */
export function defaultLineageFile() {
  return join(homedir(), '.dsh-conversation-bridge', 'lineage.json')
}

/** 账本上限：只保留最近的 N 条边，超出的丢最旧（历史会话被删后这些记录也没用了）。 */
export const DEFAULT_LINEAGE_LIMIT = 200

/** 把 `~` / 相对路径展开成绝对路径；空值用默认位置。 */
export function resolveLineageFile(file) {
  if (typeof file === 'string' && file.trim().length > 0) {
    const value = file.trim()
    if (value === '~') return resolve(homedir(), 'lineage.json')
    if (value.startsWith('~/') || value.startsWith('~\\')) return resolve(join(homedir(), value.slice(2)))
    return resolve(value)
  }
  return defaultLineageFile()
}

function toId(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function isEdge(value) {
  return value !== null && typeof value === 'object'
    && toId(value.opener) !== '' && toId(value.child) !== '' && value.opener !== value.child
}

/** 无序对键：边是双向的（谁开的不影响"能互相说话"）。 */
function edgeKey(left, right) {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`
}

/**
 * 打开（或创建）一本关系账。
 * @param {{ file?: string, limit?: number, logger?: { warn?: (message: string) => void } }} options
 *   存储位置、条数上限、以及"脏数据不静默"用的日志口。
 * @returns {{ file: string, record: Function, has: Function, entries: Function }}
 */
export function createLineage(options = {}) {
  const file = resolveLineageFile(options.file)
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0
    ? options.limit
    : DEFAULT_LINEAGE_LIMIT
  const warn = typeof options.logger?.warn === 'function' ? options.logger.warn.bind(options.logger) : () => {}

  let loaded = false
  let edges = []
  const known = new Set()

  async function load() {
    if (loaded) return
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      const list = Array.isArray(parsed?.edges) ? parsed.edges : []
      edges = list.filter(isEdge).map(edge => ({
        opener: toId(edge.opener),
        child: toId(edge.child),
        at: Number.isFinite(edge.at) ? edge.at : 0,
      })).slice(-limit)
    } catch (error) {
      // 文件不存在是首次使用；其余情况（损坏/无权限）当空处理，但必须说出来而不是静默
      if (error?.code !== 'ENOENT') {
        warn(`交接关系账读取失败（${file}），按空处理：${String(error)}`)
      }
      edges = []
    }
    for (const edge of edges) known.add(edgeKey(edge.opener, edge.child))
    loaded = true
  }

  async function flush() {
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.tmp`
    await writeFile(temp, `${JSON.stringify({ version: 1, edges }, null, 2)}\n`, 'utf8')
    await rename(temp, file)
  }

  return {
    file,

    /**
     * 记一条交接边（幂等）。写盘失败不当场抛：投递本身不该因为账本而失败。
     * @returns {Promise<boolean>} 是否新增了一条。
     */
    async record(opener, child) {
      const left = toId(opener)
      const right = toId(child)
      if (left === '' || right === '' || left === right) return false
      await load()
      const key = edgeKey(left, right)
      if (known.has(key)) return false
      edges.push({ opener: left, child: right, at: Date.now() })
      edges = edges.slice(-limit)
      known.add(key)
      try {
        await flush()
      } catch (error) {
        warn(`交接关系写入失败（${file}）：${String(error)}`)
      }
      return true
    },

    /** 这两个会话之间有没有直接交接边（双向）。 */
    async has(left, right) {
      const a = toId(left)
      const b = toId(right)
      if (a === '' || b === '' || a === b) return false
      await load()
      return known.has(edgeKey(a, b))
    },

    /** 账本的只读快照（诊断用）。 */
    async entries() {
      await load()
      return edges.slice()
    },
  }
}
