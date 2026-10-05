#!/usr/bin/env node
/**
 * 宿主补丁：让 `sessionController.prompt` 接受**进程内调用方声明的来源**。
 *
 * 背景（详见 DESIGN.md §7.3）：装好的 DSH Desktop 里，`prompt` 把每条被受理的消息固定写成
 * `{kind:'user', rpcId}`，于是插件投递的跨对话消息与水位提醒在 GUI 里渲染成用户自己的气泡。
 * harness 侧已按上游流程改好源码（含测试），但 `resources/app` 是打包产物，
 * 本机只能在已安装的那份里替换两个构建文件。
 *
 * 这个脚本是那个动作的唯一入口：先核对标记再动手、备份原文件、可回退。
 * **DSH Desktop 升级会覆盖补丁** —— 升级后重跑一次 `apply` 即可。
 *
 * 用法（在 `dsh-conversation-bridge` 目录下）：
 *   node tools/host-prompt-source-patch.mjs status
 *   node tools/host-prompt-source-patch.mjs apply   [--app <resources/app>] [--from <该包的 lib 目录>]
 *   node tools/host-prompt-source-patch.mjs revert  [--app <resources/app>]
 */

import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PACKAGE_PATH = join('node_modules', '@deepseek-ai', 'dsh-api-session-controller', 'lib')
const DEFAULT_APP = 'D:\\software\\DSH Desktop\\resources\\app'
// 已打补丁的构建产物（不再依赖 harness worktree：那边的源码已按用户要求回退到 tag，只剩这份产物）
const DEFAULT_FROM = 'D:\\project\\dsh\\dsh-host-patch-0.2.0-rc.2'
const BACKUP_SUFFIX = '.bridge-orig'

/** 只在原始构建里出现：`prompt` 里写死的 user 来源。 */
const INDEX_ORIGINAL_MARKERS = ['const source = {\n\t\tkind: "user",']

/** 被替换的文件与各自的判别标记。client.js / lib/types 与本改动无关，不动它们，避免混入另一次构建的差异。 */
const FILES = [
  { name: 'index.js', patched: ['promptInjectionSource', 'session/source-reserved'], original: INDEX_ORIGINAL_MARKERS },
  {
    name: 'typert.host.js',
    patched: ["'form': z.union([z.literal(\"relay\"), z.literal(\"notice\")])"],
    original: [],
  },
]

function parseArgs(argv) {
  const options = { action: undefined, app: DEFAULT_APP, from: DEFAULT_FROM }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--app') options.app = argv[index += 1]
    else if (token === '--from') options.from = argv[index += 1]
    else if (!token.startsWith('--') && options.action === undefined) options.action = token
  }
  return options
}

function readOrUndefined(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/** 'missing' | 'patched' | 'original' | 'unknown' */
function classify(file, path) {
  const text = readOrUndefined(path)
  if (text === undefined) return 'missing'
  if (file.patched.every((marker) => text.includes(marker))) return 'patched'
  if (file.original.length === 0 || file.original.some((marker) => text.includes(marker))) return 'original'
  return 'unknown'
}

function libDir(app) {
  return join(resolve(app), PACKAGE_PATH)
}

function status(options) {
  const dir = libDir(options.app)
  console.log(`目标: ${dir}`)
  if (!existsSync(dir)) {
    console.log('  ✗ 目录不存在：这个 --app 里没有装 @deepseek-ai/dsh-api-session-controller')
    return 1
  }
  for (const file of FILES) {
    const state = classify(file, join(dir, file.name))
    const backup = existsSync(join(dir, `${file.name}${BACKUP_SUFFIX}`)) ? '有' : '无'
    console.log(`  ${file.name}: ${state}（备份 ${backup}）`)
  }
  const from = resolve(options.from)
  console.log(`来源目录: ${from}（${existsSync(from) ? '存在' : '不存在'}）`)
  return 0
}

function apply(options) {
  const dir = libDir(options.app)
  if (!existsSync(dir)) throw new Error(`目标目录不存在：${dir}`)
  const from = resolve(options.from)
  if (!existsSync(from)) {
    throw new Error(
      `来源目录不存在：${from}\n`
      + '先按 DESIGN.md §7.3 在 harness worktree 里构建它：'
      + '（根）tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host',
    )
  }
  for (const file of FILES) {
    const source = join(from, file.name)
    if (classify(file, source) !== 'patched') {
      throw new Error(`来源 ${file.name} 不含补丁标记，拒绝拷入（先在 harness worktree 里提交改动并重建）`)
    }
    const target = join(dir, file.name)
    const backup = `${target}${BACKUP_SUFFIX}`
    if (existsSync(backup)) console.log(`  备份已存在，保留不动：${file.name}${BACKUP_SUFFIX}`)
    else {
      copyFileSync(target, backup)
      console.log(`  备份 ${file.name} → ${file.name}${BACKUP_SUFFIX}`)
    }
    copyFileSync(source, target)
    console.log(`  已写 ${file.name}`)
  }
  console.log('完成。**必须重启 DSH** 才生效（插件与宿主都不热重载）。')
  return 0
}

function revert(options) {
  const dir = libDir(options.app)
  let restored = 0
  for (const file of FILES) {
    const backup = join(dir, `${file.name}${BACKUP_SUFFIX}`)
    if (!existsSync(backup)) {
      console.log(`  ${file.name}: 没有备份，跳过`)
      continue
    }
    copyFileSync(backup, join(dir, file.name))
    console.log(`  已还原 ${file.name}`)
    restored += 1
  }
  console.log(restored === 0 ? '没有任何备份可还原。' : '完成。重启 DSH 后回到未打补丁状态。')
  return 0
}

const options = parseArgs(process.argv.slice(2))
if (options.action === 'status') process.exitCode = status(options)
else if (options.action === 'apply') process.exitCode = apply(options)
else if (options.action === 'revert') process.exitCode = revert(options)
else {
  console.log('用法: node tools/host-prompt-source-patch.mjs status|apply|revert [--app <dir>] [--from <lib>]')
  process.exitCode = 2
}
