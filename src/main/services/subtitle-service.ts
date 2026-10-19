import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, EpisodeRecord, SubtitleInfo } from '@shared/types'
import { nowIso } from '@shared/time'
import { parseAss, type AssDocument } from '@shared/ass-parser'
import { ProjectStore, openStore } from '../store/repository'
import { ensureDir, existsLong, toLongPath } from '../util/paths'
import { sha256File } from '../util/hash'
import { normalizeToUtf8, looksLikeAss, stripUtf8Bom, withUtf8Bom } from '../util/encoding'
import { scoped } from '../util/logger'
import { writeFileAtomic } from '../store/atomic'

const log = scoped('subtitle')

export interface SubtitleReadResult {
  info: SubtitleInfo | null
  document: AssDocument | null
  exists: boolean
  currentHash: string | null
}

function assertAss(text: string, fileName: string): void {
  if (!looksLikeAss(text)) {
    throw new Error(`不是有效的 ASS/SSA 字幕（缺少 [Script Info] 或 [Events]）：${fileName}`)
  }
}

/**
 * 导入字幕：编码规范化 → .orig 备份 → 复制到字幕目录（默认集目录）→ 哈希 → SUB_IMPORTED
 */
export async function importSubtitle(
  rootPath: string,
  localNo: string,
  sourceFile: string,
  settings: AppSettings
): Promise<EpisodeRecord> {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  if (!existsLong(sourceFile)) throw new Error(`字幕文件不存在：${sourceFile}`)
  if (ep.state === 'ENCODING') throw new Error('该集正在压制中，请先「取消等待」再导入新字幕')
  const ext = path.extname(sourceFile).toLowerCase()
  if (ext !== '.ass' && ext !== '.ssa') throw new Error('v1 仅支持 .ass / .ssa 字幕')

  const buf = fs.readFileSync(toLongPath(sourceFile))
  const { text, encoding } = normalizeToUtf8(buf)
  assertAss(text, sourceFile)

  ensureDir(ep.subDir)
  const target = path.join(ep.subDir, `${ep.workName}.ass`)
  const orig = `${target}.orig`

  if (existsLong(target)) {
    fs.copyFileSync(toLongPath(target), toLongPath(orig))
  }
  writeFileAtomic(target, withUtf8Bom(text))
  const hash = await sha256File(target)
  const doc = parseAss(text)

  const subtitle: SubtitleInfo = {
    path: target,
    sha256: hash,
    importedAt: nowIso(),
    sourceName: path.basename(sourceFile),
    encoding: 'utf-8-bom',
    lineCount: doc.events.length
  }

  // 新字幕导入 = 下游全部失效
  const prev = ep.subtitle?.sha256 ?? null
  store.updateEpisode(localNo, {
    subtitle,
    aiRunId: null,
    aiVerdict: null,
    human: null,
    chapters: null,
    chapterDraft: null,
    staleReasons: []
  })
  if (ep.state !== 'SUB_IMPORTED') {
    const targetState = 'SUB_IMPORTED'
    if (ep.state === 'INIT' || ep.state === 'TEMPLATE_READY') {
      store.updateEpisode(localNo, { state: targetState })
    } else {
      store.updateEpisode(localNo, { state: targetState })
    }
  }
  store.appendAudit(
    'subtitle.import',
    { path: target, hash, encoding, sourceName: path.basename(sourceFile), prevHash: prev },
    ep.id,
    settings.operator
  )
  store.writeSnapshots()
  log.info('subtitle imported', { localNo, hash, encoding })
  return store.getEpisode(localNo)
}

export async function readSubtitle(rootPath: string, localNo: string): Promise<SubtitleReadResult> {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  if (!ep.subtitle?.path || !existsLong(ep.subtitle.path)) {
    return { info: ep.subtitle, document: null, exists: false, currentHash: null }
  }
  const text = fs.readFileSync(toLongPath(ep.subtitle.path), 'utf8')
  const document = parseAss(text)
  const currentHash = await sha256File(ep.subtitle.path)
  return { info: ep.subtitle, document, exists: true, currentHash }
}

/** 读取字幕原始文本（用于导出/查找替换）；BOM 由写入层统一补，不暴露给调用方 */
export function readSubtitleText(rootPath: string, localNo: string): string | null {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  if (!ep.subtitle?.path || !existsLong(ep.subtitle.path)) return null
  return stripUtf8Bom(fs.readFileSync(toLongPath(ep.subtitle.path), 'utf8'))
}

/**
 * 检查某集字幕哈希是否与记录一致；不一致时做级联失效。
 * 返回 true 表示发生了失效。
 */
export async function checkSubtitleIntegrity(
  rootPath: string,
  localNo: string,
  actor: string,
  reason = '字幕文件已被修改'
): Promise<boolean> {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  if (!ep.subtitle?.path || !existsLong(ep.subtitle.path)) return false
  const current = await sha256File(ep.subtitle.path)
  if (current === ep.subtitle.sha256) return false
  const previousHash = ep.subtitle.sha256
  store.updateEpisode(localNo, {
    subtitle: { ...ep.subtitle, sha256: current }
  })
  store.invalidateDownstream(localNo, [reason], 'subtitle.changed', actor)
  log.warn('subtitle hash changed, downstream invalidated', { localNo, from: previousHash, to: current })
  return true
}

/** 全量校验（启动时） */
export async function verifyAllSubtitles(rootPath: string, actor: string): Promise<string[]> {
  const store = openStore(rootPath)
  const changed: string[] = []
  for (const ep of store.episodes) {
    if (!ep.subtitle?.path) continue
    if (!existsLong(ep.subtitle.path)) {
      changed.push(ep.localNo)
      continue
    }
    const current = await sha256File(ep.subtitle.path)
    if (current !== ep.subtitle.sha256) {
      store.updateEpisode(ep.localNo, { subtitle: { ...ep.subtitle, sha256: current } })
      store.invalidateDownstream(ep.localNo, ['启动校验发现字幕变化'], 'subtitle.changed', actor)
      changed.push(ep.localNo)
    }
  }
  return changed
}

/** 写入字幕文本（查找替换后调用），保留历史备份 */
export function writeSubtitleText(rootPath: string, localNo: string, text: string, actor: string): void {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  if (!ep.subtitle?.path) throw new Error('该集尚未导入字幕')
  writeFileAtomic(ep.subtitle.path, withUtf8Bom(text))
  store.appendAudit('subtitle.edit', { path: ep.subtitle.path }, ep.id, actor)
}

export function subtitlePathOf(rootPath: string, localNo: string): string | null {
  const store = openStore(rootPath)
  return store.getEpisode(localNo).subtitle?.path ?? null
}

export interface BomFixResult {
  fixed: boolean
  hash: string | null
}

/**
 * 压制前兜底：字幕若是「UTF-8 无 BOM」，VSFilter/TextSubMod 会按系统 ANSI(GBK) 解码导致整片乱码。
 * 这里在内容未变（哈希与记录一致）的前提下补 BOM，并同步字幕哈希与人工审阅哈希。
 * 只在门禁通过后调用，避免掩盖外部改动。
 */
export async function ensureUtf8BomForEncode(
  rootPath: string,
  localNo: string,
  actor: string
): Promise<BomFixResult> {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  const file = ep.subtitle?.path
  if (!file || !existsLong(file)) return { fixed: false, hash: null }
  const buf = fs.readFileSync(toLongPath(file))
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { fixed: false, hash: null }
  const text = stripUtf8Bom(buf.toString('utf8'))
  writeFileAtomic(file, withUtf8Bom(text))
  const hash = await sha256File(file)
  store.updateEpisode(localNo, {
    subtitle: { ...ep.subtitle!, sha256: hash, encoding: 'utf-8-bom' },
    human: ep.human ? { ...ep.human, subtitleHash: hash } : null
  })
  store.appendAudit('subtitle.bom-fix', { path: file, from: ep.subtitle?.sha256, to: hash }, ep.id, actor)
  log.info('subtitle BOM added before encode', { localNo, hash })
  return { fixed: true, hash }
}

export function openSubtitleWithExternal(rootPath: string, localNo: string, aegisubPath: string): string {
  const target = subtitlePathOf(rootPath, localNo)
  if (!target) throw new Error('该集尚未导入字幕')
  return aegisubPath && existsLong(aegisubPath) ? aegisubPath : ''
}

export function updateSubtitleLineCount(rootPath: string, localNo: string, lineCount: number): void {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  if (!ep.subtitle) return
  store.updateEpisode(localNo, { subtitle: { ...ep.subtitle, lineCount } })
}

export function ensureSubtitleDirs(store: ProjectStore): void {
  for (const ep of store.episodes) ensureDir(ep.subDir)
}
