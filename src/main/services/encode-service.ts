import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { AppSettings, EpisodeRecord, MediaProbe } from '@shared/types'
import { nowIso } from '@shared/time'
import { openStore } from '../store/repository'
import { existsLong, listDirs, listFiles, listFilesRecursive, statLong, toLongPath } from '../util/paths'
import { scoped } from '../util/logger'
import { requireGate } from './gate-service'
import { resolveTool } from '../integrations/tools'
import { runProcess } from '../integrations/process-runner'
import { probeMedia } from '../integrations/ffprobe'
import { broadcast } from '../ipc/events'
import { sha256File } from '../util/hash'

const log = scoped('encode')

export interface OutputCandidate {
  path: string
  size: number
  mtimeMs: number
  dirCreatedMs: number
}

const OUTPUT_DIR_RE = /^[0-9A-Fa-f]{8}-\d{2}$/
const EXCLUDED_SUFFIX = ['.lwi', '.part', '.tmp']
const EXCLUDED_NAME = /(^~)|(\.before-chapters\.mkv$)/i

export function isOutputDirName(name: string): boolean {
  return OUTPUT_DIR_RE.test(name)
}

/** §7.5 成品识别：返回按「最可能」排序的候选 */
export async function findOutputCandidates(
  ep: EpisodeRecord,
  startedAtMs: number,
  options: { minSizeMb: number; checkStability?: boolean }
): Promise<OutputCandidate[]> {
  const roots = [
    path.join(ep.dir, 'output'),
    path.join(ep.dir, 'output', 'D_'),
    path.join(ep.dir, 'D_')
  ]
  const minSize = Math.max(0, options.minSizeMb) * 1024 * 1024
  const candidates: OutputCandidate[] = []

  const collect = (dir: string) => {
    const stat = statLong(dir)
    const dirCreatedMs = stat?.birthtimeMs ?? stat?.mtimeMs ?? 0
    for (const file of listFiles(dir, '.mkv')) {
      const name = path.basename(file)
      if (EXCLUDED_NAME.test(name)) continue
      if (EXCLUDED_SUFFIX.some((s) => name.toLowerCase().endsWith(s))) continue
      const st = statLong(file)
      if (!st || !st.isFile()) continue
      if (st.size < minSize) continue
      // 若该输出目录是本次压制后新建的，忽略 mtime 限制（§FR-10）
      const dirIsNew = dirCreatedMs >= startedAtMs - 5_000
      if (!dirIsNew && st.mtimeMs < startedAtMs - 1_000) continue
      candidates.push({ path: file, size: st.size, mtimeMs: st.mtimeMs, dirCreatedMs })
    }
  }

  for (const root of roots) {
    for (const dir of listDirs(root)) {
      if (!isOutputDirName(path.basename(dir))) continue
      collect(dir)
    }
  }
  // 兼容更深一层布局
  for (const root of roots) collect(root)
  for (const file of listFilesRecursive(path.join(ep.dir, 'output'), '.mkv', 3)) {
    const name = path.basename(file)
    if (EXCLUDED_NAME.test(name)) continue
    if (candidates.some((c) => c.path.toLowerCase() === file.toLowerCase())) continue
    const st = statLong(file)
    if (!st || st.size < minSize) continue
    if (st.mtimeMs < startedAtMs - 1_000) continue
    const dir = path.dirname(file)
    const dirStat = statLong(dir)
    candidates.push({
      path: file,
      size: st.size,
      mtimeMs: st.mtimeMs,
      dirCreatedMs: dirStat?.birthtimeMs ?? 0
    })
  }

  const workName = ep.workName.toLowerCase()
  candidates.sort((a, b) => {
    const aName = path.basename(a.path).toLowerCase()
    const bName = path.basename(b.path).toLowerCase()
    const aHit = aName.includes(workName) ? 1 : 0
    const bHit = bName.includes(workName) ? 1 : 0
    if (aHit !== bHit) return bHit - aHit
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs
    return b.size - a.size
  })

  if (options.checkStability) {
    const stable: OutputCandidate[] = []
    for (const candidate of candidates.slice(0, 5)) {
      if (await isStable(candidate.path)) stable.push(candidate)
    }
    return stable
  }
  return candidates
}

/** 大小连续两次采样不变 + 可独占打开 */
export async function isStable(file: string, intervalMs = 2000): Promise<boolean> {
  const first = statLong(file)
  if (!first) return false
  await new Promise((resolve) => setTimeout(resolve, intervalMs))
  const second = statLong(file)
  if (!second || second.size !== first.size) return false
  try {
    const fd = fs.openSync(toLongPath(file), 'r+')
    fs.closeSync(fd)
    return true
  } catch {
    // 只读打开也可能因为被占用失败，这里退化为只读尝试
    try {
      const fd = fs.openSync(toLongPath(file), 'r')
      fs.closeSync(fd)
      return true
    } catch {
      return false
    }
  }
}

const timers = new Map<string, NodeJS.Timeout>()

function monitorKey(rootPath: string, localNo: string): string {
  return `${rootPath.toLowerCase()}::${localNo}`
}

export function stopMonitor(rootPath: string, localNo: string): void {
  const key = monitorKey(rootPath, localNo)
  const timer = timers.get(key)
  if (timer) clearInterval(timer)
  timers.delete(key)
}

export interface StartEncodeResult {
  episode: EpisodeRecord
  okeguiPath: string
}

export async function isOkeguiRunning(): Promise<boolean> {
  const res = await runProcess('tasklist', ['/FI', 'IMAGENAME eq OKEGui.exe', '/NH'], { timeoutMs: 15_000 })
  return /OKEGui\.exe/i.test(res.stdout)
}

export async function startEncode(
  rootPath: string,
  localNo: string,
  settings: AppSettings
): Promise<StartEncodeResult> {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  await requireGate(rootPath, localNo, 'encode', settings)

  const okegui = resolveTool('okegui')
  if (!okegui.exists) {
    throw new Error('未找到 OKEGui.exe，请在设置中指定路径')
  }
  if (await isOkeguiRunning()) {
    throw new Error('检测到 OKEGui 已在运行，请先完成当前压制任务')
  }
  if (settings.encode.requireSourceVideo && ep.templateJson) {
    const json = JSON.parse(fs.readFileSync(toLongPath(ep.templateJson), 'utf8')) as { InputFiles?: string[] }
    const missing = (json.InputFiles ?? []).filter((f) => !existsLong(f))
    if (missing.length > 0) throw new Error(`源视频缺失：${missing.map((m) => path.basename(m)).join('、')}`)
  }

  const startedAt = nowIso()
  const startedAtMs = Date.now()

  try {
    const child = spawn(okegui.path, [], {
      cwd: ep.dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    })
    child.unref()
  } catch (err) {
    throw new Error(`启动 OKEGui 失败：${(err as Error).message}`)
  }

  // 帮助用户在资源管理器中定位该集 json（不自动载入）
  if (ep.templateJson && existsLong(ep.templateJson)) {
    void runProcess('explorer.exe', [`/select,${ep.templateJson}`], { timeoutMs: 5_000 })
  }

  store.updateEpisode(localNo, {
    encode: {
      startedAt,
      okeguiPath: okegui.path,
      outputPath: null,
      outputSize: null,
      outputMtime: null,
      outputSha256: null,
      probe: null,
      failedReason: null,
      cancelledAt: null
    }
  })
  store.transition(localNo, 'ENCODING', 'encode.start', { okegui: okegui.path, startedAt }, settings.operator)
  broadcast('encode:progress', { localNo, phase: 'waiting', message: '等待 OKEGui 完成压制…' })

  startMonitor(rootPath, localNo, settings, startedAtMs)
  return { episode: store.getEpisode(localNo), okeguiPath: okegui.path }
}

function startMonitor(rootPath: string, localNo: string, settings: AppSettings, startedAtMs: number): void {
  stopMonitor(rootPath, localNo)
  const key = monitorKey(rootPath, localNo)
  const timer = setInterval(() => {
    void tick(rootPath, localNo, settings, startedAtMs)
  }, Math.max(1000, settings.encode.pollIntervalMs))
  timers.set(key, timer)
}

async function tick(rootPath: string, localNo: string, settings: AppSettings, startedAtMs: number): Promise<void> {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  if (ep.state !== 'ENCODING') {
    stopMonitor(rootPath, localNo)
    return
  }
  if (Date.now() - startedAtMs > settings.encode.timeoutMs) {
    stopMonitor(rootPath, localNo)
    store.updateEpisode(localNo, {
      encode: {
        ...(ep.encode ?? {
          startedAt: nowIso(),
          okeguiPath: '',
          outputPath: null,
          outputSize: null,
          outputMtime: null,
          outputSha256: null,
          probe: null,
          failedReason: null,
          cancelledAt: null
        }),
        failedReason: `等待成品超时（${Math.round(settings.encode.timeoutMs / 60000)} 分钟）`
      }
    })
    store.transition(localNo, 'ENCODE_FAILED', 'encode.timeout', null, settings.operator)
    broadcast('encode:progress', { localNo, phase: 'failed', message: '等待成品超时，可重新扫描或手动指定' })
    return
  }

  const candidates = await findOutputCandidates(ep, startedAtMs, {
    minSizeMb: settings.encode.minSizeMb,
    checkStability: true
  })
  if (candidates.length === 0) return

  if (candidates.length > 1) {
    broadcast('encode:progress', {
      localNo,
      phase: 'multiple',
      message: `发现 ${candidates.length} 个候选成品，请选择`,
      candidates: candidates.map((c) => ({ path: c.path, size: c.size }))
    })
    return
  }
  await acceptOutput(rootPath, localNo, candidates[0]!.path, settings)
}

export async function acceptOutput(
  rootPath: string,
  localNo: string,
  filePath: string,
  settings: AppSettings
): Promise<EpisodeRecord> {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  if (!existsLong(filePath)) throw new Error(`成品文件不存在：${filePath}`)
  const stat = statLong(filePath)
  if (!stat) throw new Error('无法读取成品信息')

  const ffprobe = resolveTool('ffprobe')
  let probe: MediaProbe | null = null
  if (ffprobe.exists) probe = await probeMedia(filePath, ffprobe.path)

  let hash: string | null = null
  if (stat.size < 200 * 1024 * 1024) {
    try {
      hash = await sha256File(filePath)
    } catch {
      hash = null
    }
  }

  stopMonitor(rootPath, localNo)
  store.updateEpisode(localNo, {
    encode: {
      startedAt: ep.encode?.startedAt ?? nowIso(),
      okeguiPath: ep.encode?.okeguiPath ?? '',
      outputPath: filePath,
      outputSize: stat.size,
      outputMtime: new Date(stat.mtimeMs).toISOString(),
      outputSha256: hash,
      probe,
      failedReason: null,
      cancelledAt: null
    }
  })
  if (ep.state === 'ENCODING' || ep.state === 'ENCODE_FAILED') {
    store.transition(localNo, 'ENCODED', 'encode.detected', { path: filePath, size: stat.size }, settings.operator)
  }
  broadcast('encode:progress', { localNo, phase: 'done', message: '成品已识别', path: filePath })
  log.info('output detected', { localNo, filePath, size: stat.size })
  return store.getEpisode(localNo)
}

export async function rescanOutput(
  rootPath: string,
  localNo: string,
  settings: AppSettings
): Promise<OutputCandidate[]> {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  const startedAtMs = ep.encode?.startedAt ? Date.parse(ep.encode.startedAt) : 0
  return findOutputCandidates(ep, startedAtMs, {
    minSizeMb: settings.encode.minSizeMb,
    checkStability: false
  })
}

export function cancelEncode(rootPath: string, localNo: string, actor: string): EpisodeRecord {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  stopMonitor(rootPath, localNo)
  store.updateEpisode(localNo, {
    encode: ep.encode ? { ...ep.encode, cancelledAt: nowIso() } : null
  })
  if (ep.state === 'ENCODING' || ep.state === 'ENCODE_FAILED') {
    store.transition(localNo, 'CHAPTER_LOCKED', 'encode.cancel', null, actor)
  }
  return store.getEpisode(localNo)
}

/** 手动指定成品 */
export async function setOutputManually(
  rootPath: string,
  localNo: string,
  filePath: string,
  settings: AppSettings
): Promise<EpisodeRecord> {
  return acceptOutput(rootPath, localNo, filePath, settings)
}
