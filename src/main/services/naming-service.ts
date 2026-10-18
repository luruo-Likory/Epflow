import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, EpisodeRecord, FinalInfo } from '@shared/types'
import { renderReleaseName } from '@shared/release-name'
import { sanitizeFileName } from '@shared/filename'
import { nowIso } from '@shared/time'
import { openStore } from '../store/repository'
import { existsLong, toLongPath, timestamp, uniquePath } from '../util/paths'
import { sha256File } from '../util/hash'
import { scoped } from '../util/logger'
import { requireGate } from './gate-service'
import { broadcast } from '../ipc/events'

const log = scoped('naming')

export function buildFinalName(
  settings: AppSettings,
  project: { releaseNameTemplate: string; outputMode: 'episode-output' | 'project-release' },
  ep: EpisodeRecord,
  ext: string
): string {
  const rendered = renderReleaseName(project.releaseNameTemplate, ep.releaseNo)
  const cleaned = sanitizeFileName(rendered, { collapseSpaces: true })
  const suffix = ext.startsWith('.') ? ext : `.${ext}`
  return `${cleaned}${suffix}`
}

function extensionFor(ep: EpisodeRecord): '.mp4' | '.mkv' {
  if (ep.transcode?.ok && ep.transcode.to && existsLong(ep.transcode.to)) return '.mp4'
  return '.mkv'
}

function freeSpaceMb(dir: string): number | null {
  try {
    const stat = fs.statfsSync(toLongPath(dir))
    return Math.round((stat.bavail * stat.bsize) / (1024 * 1024))
  } catch {
    return null
  }
}

export async function renameToRelease(
  rootPath: string,
  localNo: string,
  settings: AppSettings,
  conflict: 'suffix' | 'trash' = settings.naming.conflict === 'trash' ? 'trash' : 'suffix'
): Promise<EpisodeRecord> {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  await requireGate(rootPath, localNo, 'rename', settings)

  const source = ep.transcode?.ok ? ep.transcode.to : ep.encode?.outputPath
  if (!source || !existsLong(source)) throw new Error('找不到待命名的成品文件')

  const ext = extensionFor(ep)
  const fileName = buildFinalName(settings, store.project, ep, ext)
  const targetDir = store.project.outputMode === 'project-release'
    ? path.join(store.project.rootPath, 'release')
    : path.dirname(source)
  fs.mkdirSync(toLongPath(targetDir), { recursive: true })

  let target = path.join(targetDir, fileName)
  const sameDir = path.resolve(path.dirname(source)).toLowerCase() === path.resolve(targetDir).toLowerCase()
  const sameName = path.basename(source).toLowerCase() === fileName.toLowerCase()

  if (existsLong(target) && !(sameDir && sameName)) {
    if (conflict === 'trash') {
      const trashDir = path.join(targetDir, '_trash', timestamp())
      fs.mkdirSync(toLongPath(trashDir), { recursive: true })
      const moved = path.join(trashDir, path.basename(target))
      fs.renameSync(toLongPath(target), toLongPath(moved))
      store.appendAudit('naming.trash', { from: target, to: moved }, ep.id, settings.operator)
    } else {
      target = uniquePath(target)
    }
  }

  const size = fs.statSync(toLongPath(source)).size
  if (!sameDir) {
    const targetDrive = path.resolve(targetDir).slice(0, 2).toLowerCase()
    const sourceDrive = path.resolve(path.dirname(source)).slice(0, 2).toLowerCase()
    if (targetDrive !== sourceDrive) {
      const freeTarget = freeSpaceMb(targetDir)
      if (freeTarget !== null && freeTarget < (size / (1024 * 1024)) * 1.05) {
        throw new Error(`目标磁盘剩余空间不足（需约 ${Math.round(size / 1024 / 1024)}MB，剩余 ${freeTarget}MB）`)
      }
    }
  }

  if (!(sameDir && sameName)) {
    try {
      fs.renameSync(toLongPath(source), toLongPath(target))
    } catch (err) {
      // 跨盘 rename 会失败，退化为复制 + 删除
      try {
        fs.copyFileSync(toLongPath(source), toLongPath(target))
        fs.unlinkSync(toLongPath(source))
      } catch {
        throw new Error(`重命名失败（文件可能被占用）：${(err as Error).message}`)
      }
    }
  }

  let hash: string | null = null
  if (size < 200 * 1024 * 1024) {
    try {
      hash = await sha256File(target)
    } catch {
      hash = null
    }
  }

  const final: FinalInfo = {
    path: target,
    size,
    sha256: hash,
    at: nowIso(),
    namingTemplateVersion: `tpl-${store.project.releaseNameTemplate.length}-${store.project.releaseEpisodeBase}`,
    format: ext === '.mp4' ? 'mp4' : 'mkv'
  }
  store.updateEpisode(localNo, {
    final,
    encode: ep.encode ? { ...ep.encode, outputPath: target } : ep.encode
  })
  if (ep.state !== 'NAMED' && ep.state !== 'DONE') {
    store.transition(localNo, 'NAMED', 'naming.done', { path: target, size }, settings.operator)
  } else {
    store.appendAudit('naming.done', { path: target, size }, ep.id, settings.operator)
  }
  store.writeSnapshots()
  broadcast('encode:progress', { localNo, phase: 'named', message: '已按发布名命名' })
  log.info('renamed', { localNo, target })
  return store.getEpisode(localNo)
}

export function markDone(rootPath: string, localNo: string, actor: string): EpisodeRecord {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  if (ep.state !== 'NAMED') {
    if (ep.state === 'DONE') return ep
    throw new Error(`当前状态为 ${ep.state}，需先完成命名`)
  }
  store.transition(localNo, 'DONE', 'episode.done', { final: ep.final?.path ?? null }, actor)
  store.writeSnapshots()
  return store.getEpisode(localNo)
}

export function previewFinalName(
  rootPath: string,
  localNo: string,
  settings: AppSettings
): { name: string; dir: string; conflict: boolean } {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  const ext = extensionFor(ep)
  const name = buildFinalName(settings, store.project, ep, ext)
  const source = ep.transcode?.ok ? ep.transcode.to : ep.encode?.outputPath
  const dir = store.project.outputMode === 'project-release'
    ? path.join(store.project.rootPath, 'release')
    : source
      ? path.dirname(source)
      : path.join(ep.dir, 'output')
  return { name, dir, conflict: existsLong(path.join(dir, name)) }
}
