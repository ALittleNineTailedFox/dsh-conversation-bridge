/**
 * 自持交接件：本插件**唯一的可变产物**。
 *
 * 设计约束（见 DESIGN.md §8.2）：
 *   - 固定四段、逐字标题、每段有最小长度，不达标**拒绝写入**（这是"能被解析"的前提）；
 *   - **不维护索引文件**：目录本身就是索引，读时扫目录（避免读-改-写竞争与原子写复杂度）；
 *   - 原子落盘（tmp + rename）；
 *   - 不写别人的地盘、不接记忆插件、不建归档副本。
 *
 * @module dsh-conversation-bridge/handoff
 */

import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** 四段契约的参数名（顺序即渲染顺序）。 */
export const SECTION_KEYS = ['taskState', 'goals', 'deadEnds', 'nextSteps']

export const DEFAULT_SECTIONS = ['任务状态', '目标', '已试方案与失败原因', '进度与下一步']

export const DEFAULT_DIR_NAME = '.dsh-conversation-bridge'

function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/** 解析交接件目录；`dir` 为空则用 `<cwd>/.dsh-conversation-bridge/handoffs/`。 */
export function resolveDir(dir, cwd) {
  if (typeof dir === 'string' && dir.trim().length > 0) return resolve(expandHome(dir.trim()))
  const base = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : homedir()
  return resolve(join(base, DEFAULT_DIR_NAME, 'handoffs'))
}

function stamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`
}

/** 文件名的短随机尾巴：同一毫秒内也不可能撞名。 */
function token() {
  return randomUUID().replace(/-/g, '').slice(0, 4)
}

function shortId(sessionId) {
  const cleaned = String(sessionId ?? '').replace(/[^A-Za-z0-9]/g, '')
  return (cleaned.slice(-8) || 'unknown').toLowerCase()
}

/* ------------------------------------------------------------------ *
 * 校验与渲染
 * ------------------------------------------------------------------ */

/**
 * 校验四段。返回 { ok, sections } 或 { ok:false, missing, tooShort }。
 * @param input - 模型给的四段文本。
 * @param titles - 渲染用的标题（默认四段中文标题）。
 * @param minChars - 每段最小字符数。
 */
export function validateSections(input, titles, minChars) {
  const headings = Array.isArray(titles) && titles.length === SECTION_KEYS.length ? titles : DEFAULT_SECTIONS
  const missing = []
  const tooShort = []
  const values = {}
  for (let index = 0; index < SECTION_KEYS.length; index++) {
    const key = SECTION_KEYS[index]
    const raw = input?.[key]
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (text.length === 0) {
      missing.push(headings[index])
      continue
    }
    if (text.length < minChars) tooShort.push({ section: headings[index], chars: text.length, minChars })
    values[key] = text
  }
  if (missing.length > 0 || tooShort.length > 0) return { ok: false, missing, tooShort, titles: headings }
  return { ok: true, values, titles: headings }
}

function renderDocument({ values, titles, meta, title }) {
  const lines = [
    '---',
    `createdAt: ${meta.createdAt}`,
    `fromSessionId: ${meta.fromSessionId}`,
    `cwd: ${meta.cwd}`,
    `percent: ${meta.percent}`,
    `source: dsh-conversation-bridge`,
    '---',
    '',
    `# ${title.length > 0 ? title : '交接件'}`,
    '',
  ]
  for (let index = 0; index < SECTION_KEYS.length; index++) {
    lines.push(`## ${titles[index]}`, '', values[SECTION_KEYS[index]], '')
  }
  lines.push('<!-- 本文件由 dsh-conversation-bridge 生成；四段标题是契约，请勿改动 -->', '')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * 写
 * ------------------------------------------------------------------ */

/**
 * 原子写一个交接件。
 * @returns { file, dir, bytes, chars }
 */
export async function writeHandoff({ dir, cwd, sections, titles, minChars, title, fromSessionId, percent }) {
  const targetDir = resolveDir(dir, cwd)
  const checked = validateSections(sections, titles, minChars)
  if (!checked.ok) {
    const problems = []
    if (checked.missing.length > 0) problems.push(`缺少段落：${checked.missing.join('、')}`)
    if (checked.tooShort.length > 0) {
      problems.push(`段落太短：${checked.tooShort.map((item) => `${item.section}(${item.chars}/${item.minChars})`).join('、')}`)
    }
    const error = new Error(`交接件不符合四段契约：${problems.join('；')}`)
    error.code = 'HANDOFF_SECTIONS_INVALID'
    error.details = checked
    throw error
  }

  const createdAt = new Date().toISOString()
  const meta = {
    createdAt,
    fromSessionId: String(fromSessionId ?? ''),
    cwd: String(cwd ?? ''),
    percent: Number.isFinite(percent) ? percent : '',
  }
  const body = renderDocument({
    values: checked.values,
    titles: checked.titles,
    meta,
    title: typeof title === 'string' ? title.trim() : '',
  })

  await mkdir(targetDir, { recursive: true })
  const base = `handoff-${stamp()}-${shortId(fromSessionId)}`
  let file
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = join(targetDir, `${base}-${token()}.md`)
    const temporary = join(targetDir, `.${base}.${process.pid}.${attempt}.tmp`)
    await writeFile(temporary, body, 'utf8')
    try {
      // rename 到已存在的文件在 Windows 会失败、在 POSIX 会静默覆盖 —— 先探测再改，
      // 保证"要么写成新文件，要么报错"，绝不悄悄覆盖别人的交接件。
      const handle = await open(candidate, 'wx')
      await handle.close()
      await unlink(candidate)
      await rename(temporary, candidate)
      file = candidate
      break
    } catch (error) {
      lastError = error
      await unlink(temporary).catch(() => {})
    }
  }
  if (file === undefined) throw lastError ?? new Error('交接件落盘失败')
  return {
    file,
    dir: targetDir,
    bytes: Buffer.byteLength(body, 'utf8'),
    chars: body.length,
    createdAt,
  }
}

/* ------------------------------------------------------------------ *
 * 读
 * ------------------------------------------------------------------ */

function parseDocument(raw) {
  const meta = {}
  let body = raw
  if (raw.startsWith('---\n')) {
    const end = raw.indexOf('\n---', 4)
    if (end > 0) {
      for (const line of raw.slice(4, end).split('\n')) {
        const at = line.indexOf(':')
        if (at > 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim()
      }
      body = raw.slice(end + 4).replace(/^\n+/, '')
    }
  }
  const heads = {}
  const sectionText = {}
  let current
  const buffer = []
  const flush = () => {
    if (current === undefined) return
    const text = buffer.join('\n').trim()
    sectionText[current] = text
    heads[current] = text.split('\n')[0].slice(0, 120)
  }
  for (const line of body.split('\n')) {
    if (line.startsWith('## ')) {
      flush()
      current = line.slice(3).trim()
      buffer.length = 0
      continue
    }
    if (line.startsWith('# ')) continue
    if (current !== undefined) buffer.push(line)
  }
  flush()
  return { meta, heads, sectionText }
}

/** 扫目录给目录页。不维护索引文件：目录本身就是索引。 */
export async function listHandoffs({ dir, cwd, limit, sinceMs }) {
  const targetDir = resolveDir(dir, cwd)
  let names
  try {
    names = await readdir(targetDir)
  } catch (error) {
    if (error?.code === 'ENOENT') return { dir: targetDir, total: 0, handoffs: [] }
    throw error
  }
  const files = names.filter((item) => item.startsWith('handoff-') && item.endsWith('.md')).sort().reverse()
  const now = Date.now()
  const handoffs = []
  for (const name of files) {
    const file = join(targetDir, name)
    let info
    try {
      info = await stat(file)
    } catch {
      continue
    }
    if (Number.isFinite(sinceMs) && now - info.mtimeMs > sinceMs) continue
    let parsed = { meta: {}, heads: {}, sectionText: {} }
    let malformed
    try {
      parsed = parseDocument(await readFile(file, 'utf8'))
    } catch (error) {
      malformed = String(error?.message ?? error)
    }
    handoffs.push({
      file,
      name,
      bytes: info.size,
      mtime: info.mtimeMs,
      createdAt: parsed.meta.createdAt ?? '',
      fromSessionId: parsed.meta.fromSessionId ?? '',
      cwd: parsed.meta.cwd ?? '',
      percent: parsed.meta.percent === undefined ? '' : parsed.meta.percent,
      heads: parsed.heads,
      ...(malformed === undefined ? {} : { malformed }),
    })
    if (Number.isFinite(limit) && handoffs.length >= limit) break
  }
  return { dir: targetDir, total: files.length, handoffs }
}

/** 读一个交接件全文（file 可以是绝对路径，也可以是目录下的文件名）。 */
export async function readHandoff({ dir, cwd, file }) {
  const targetDir = resolveDir(dir, cwd)
  const name = String(file ?? '')
  const path = /^([A-Za-z]:[\\/]|[\\/])/.test(name) ? resolve(name) : resolve(join(targetDir, name))
  // 安全边界不能只认"当前 cwd 推导出的那一个目录"：写入返回的是绝对路径，
  // 调用方很可能来自别的工作目录（真机事故：写入给的路径回读被拒）。
  // 因此放行两种情况：① 在当前目标目录内；② 路径本身就是本插件自己的交接件目录。
  const marker = `${DEFAULT_DIR_NAME}${sep}handoffs${sep}`
  const normalizedPath = `${path}${sep}`.replaceAll('/', sep).toLowerCase()
  const insideTarget = `${path}${sep}`.startsWith(`${targetDir}${sep}`)
  const ownArtifact = normalizedPath.includes(marker.toLowerCase())
  if (!insideTarget && !ownArtifact) throw new Error(`交接件必须位于 ${targetDir} 之内，或本插件自己的交接件目录里`)
  const raw = await readFile(path, 'utf8')
  const parsed = parseDocument(raw)
  return { file: path, ...parsed, raw }
}

/** 供验收用：读一个已存在文件的头部若干字节（判断是否为空）。 */
export async function readHead(file, bytes = 512) {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}
