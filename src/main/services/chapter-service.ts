import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, Chapter, ChapterDraftInfo, ChapterInfo, EpisodeRecord } from '@shared/types'
import { buildChapters, chaptersToXml, validateChapters } from '@shared/chapter-builder'
import { parseAss } from '@shared/ass-parser'
import { nowIso } from '@shared/time'
import { openStore } from '../store/repository'
import { existsLong, toLongPath } from '../util/paths'
import { sha256File } from '../util/hash'
import { writeFileAtomic } from '../store/atomic'
import { scoped } from '../util/logger'
import { requireGate } from './gate-service'
import { resolveTool } from '../integrations/tools'
import { probeMedia } from '../integrations/ffprobe'

const log = scoped('chapter')

export interface ChapterView {
  chapters: Chapter[]
  xml: string
  locked: boolean
  draft: ChapterDraftInfo | null
  lockedInfo: ChapterInfo | null
  stale: boolean
  durationMs: number | null
}

function chaptersConfig(settings: AppSettings) {
  const c = settings.chapter
  return {
    gapThresholdMs: c.gapThresholdMs,
    minChapterLenMs: c.minChapterLenMs,
    maxChapterLenMs: c.maxChapterLenMs,
    maxChapters: c.maxChapters,
    minChapters: c.minChapters,
    detectOpEd: c.detectOpEd,
    firstChapterAtZero: c.firstChapterAtZero
  }
}

function durationOf(rootPath: string, localNo: string, settings: AppSettings): Promise<number | null> {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  const source = ep.encode?.outputPath
  const ffprobe = resolveTool('ffprobe')
  if (!source || !existsLong(source) || !ffprobe.exists) return Promise.resolve(null)
  return probeMedia(source, ffprobe.path).then((probe) => probe?.durationMs ?? null)
}

export async function generateChapterDraft(
  rootPath: string,
  localNo: string,
  settings: AppSettings,
  overrides?: Partial<ReturnType<typeof chaptersConfig>>
): Promise<ChapterView> {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  await requireGate(rootPath, localNo, 'generate-chapters', settings)
  if (!ep.subtitle?.path || !existsLong(ep.subtitle.path)) throw new Error('该集尚未导入字幕')

  const text = fs.readFileSync(toLongPath(ep.subtitle.path), 'utf8')
  const doc = parseAss(text)
  const durationMs = (await durationOf(rootPath, localNo, settings)) ?? Math.max(0, ...doc.events.map((e) => e.endMs))
  const cfg = { ...chaptersConfig(settings), ...(overrides ?? {}) }
  const events = doc.events.map((e) => ({
    startMs: e.startMs,
    endMs: e.endMs,
    text: e.plain,
    isComment: e.isComment
  }))
  const chapters = buildChapters(events, durationMs, cfg)
  const errors = validateChapters(chapters, durationMs || null)
  if (errors.length > 0) throw new Error(`章节校验失败：${errors.join('；')}`)

  const xml = chaptersToXml(chapters, { language: settings.chapter.language })
  const draftPath = path.join(ep.subDir, `${ep.workName}.chapters.draft.xml`)
  writeFileAtomic(draftPath, xml)

  const draft: ChapterDraftInfo = {
    path: draftPath,
    updatedAt: nowIso(),
    chapterCount: chapters.length,
    stale: false,
    chapters
  }
  store.updateEpisode(localNo, { chapterDraft: draft, chapters: null })
  const current = store.getEpisode(localNo)
  if (current.state === 'HUMAN_PASSED') {
    store.transition(localNo, 'CHAPTER_DRAFT', 'chapter.generate', { count: chapters.length }, settings.operator)
  } else {
    store.appendAudit('chapter.generate', { count: chapters.length }, ep.id, settings.operator)
  }
  log.info('chapters generated', { localNo, count: chapters.length })
  return {
    chapters,
    xml,
    locked: false,
    draft,
    lockedInfo: null,
    stale: false,
    durationMs
  }
}

export function saveChapterDraft(
  rootPath: string,
  localNo: string,
  chapters: Chapter[],
  settings: AppSettings
): ChapterView {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  if (ep.chapters) throw new Error('章节已锁定，需先解锁（重新生成）才能修改')
  const errors = validateChapters(chapters, null)
  if (errors.length > 0) throw new Error(`章节校验失败：${errors.join('；')}`)
  const xml = chaptersToXml(chapters, { language: settings.chapter.language })
  const draftPath = ep.chapterDraft?.path ?? path.join(ep.subDir, `${ep.workName}.chapters.draft.xml`)
  writeFileAtomic(draftPath, xml)
  const draft: ChapterDraftInfo = {
    path: draftPath,
    updatedAt: nowIso(),
    chapterCount: chapters.length,
    stale: false,
    chapters
  }
  store.updateEpisode(localNo, { chapterDraft: draft })
  store.appendAudit('chapter.save', { count: chapters.length }, ep.id, settings.operator)
  return { chapters, xml, locked: false, draft, lockedInfo: null, stale: false, durationMs: null }
}

export async function lockChapters(
  rootPath: string,
  localNo: string,
  checklist: string[],
  settings: AppSettings
): Promise<EpisodeRecord> {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  await requireGate(rootPath, localNo, 'lock-chapters', settings)
  if (!ep.chapterDraft) throw new Error('尚未生成章节草稿')
  if (ep.chapterDraft.stale) throw new Error('章节草稿已过期，请重新生成')

  const required = ['章节切点与剧情段落一致', '标题/编号无误', '已确认首章从 0 开始']
  const missing = required.filter((item) => !checklist.includes(item))
  if (missing.length > 0) throw new Error(`请逐项确认：${missing.join('、')}`)

  const chapters = ep.chapterDraft.chapters
  const errors = validateChapters(chapters, null)
  if (errors.length > 0) throw new Error(`章节校验失败：${errors.join('；')}`)

  const xml = chaptersToXml(chapters, { language: settings.chapter.language })
  const finalPath = path.join(ep.dir, `${ep.workName}.chapters.xml`)
  writeFileAtomic(finalPath, xml)
  const hash = await sha256File(finalPath)

  const info: ChapterInfo = {
    path: finalPath,
    sha256: hash,
    reviewedAt: nowIso(),
    reviewedBy: settings.operator,
    chapterCount: chapters.length
  }
  store.updateEpisode(localNo, { chapters: info, chapterDraft: { ...ep.chapterDraft, stale: false } })
  const current = store.getEpisode(localNo)
  if (current.state === 'CHAPTER_DRAFT' || current.state === 'CHAPTER_REVIEWING') {
    store.transition(localNo, 'CHAPTER_LOCKED', 'chapter.lock', { count: chapters.length, hash }, settings.operator)
  } else {
    store.appendAudit('chapter.lock', { count: chapters.length, hash }, ep.id, settings.operator)
  }
  store.writeSnapshots()
  log.info('chapters locked', { localNo, count: chapters.length })
  return store.getEpisode(localNo)
}

export function readChapters(rootPath: string, localNo: string, settings: AppSettings): ChapterView {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  const locked = Boolean(ep.chapters)
  const chapters = ep.chapters
    ? ep.chapterDraft?.chapters ?? []
    : ep.chapterDraft?.chapters ?? []
  const xmlPath = ep.chapters?.path ?? ep.chapterDraft?.path ?? null
  const xml = xmlPath && existsLong(xmlPath) ? fs.readFileSync(toLongPath(xmlPath), 'utf8') : ''
  if (locked && chapters.length === 0 && xml) {
    return {
      chapters: parseChaptersFromXml(xml),
      xml,
      locked,
      draft: ep.chapterDraft,
      lockedInfo: ep.chapters,
      stale: false,
      durationMs: null
    }
  }
  return {
    chapters,
    xml,
    locked,
    draft: ep.chapterDraft,
    lockedInfo: ep.chapters,
    stale: ep.chapterDraft?.stale ?? false,
    durationMs: null
  }
  void settings
}

export function parseChaptersFromXml(xml: string): Chapter[] {
  const out: Chapter[] = []
  const atomRe = /<ChapterAtom>([\s\S]*?)<\/ChapterAtom>/g
  for (const m of xml.matchAll(atomRe)) {
    const body = m[1] ?? ''
    const time = /<ChapterTimeStart>([^<]+)<\/ChapterTimeStart>/.exec(body)?.[1] ?? ''
    const title = /<ChapterString>([\s\S]*?)<\/ChapterString>/.exec(body)?.[1] ?? ''
    const uid = /<ChapterUID>([^<]+)<\/ChapterUID>/.exec(body)?.[1] ?? ''
    out.push({
      startMs: chapterTimeToMs(time),
      title: decodeXml(title),
      source: /^(OP|ED)$/i.test(decodeXml(title)) ? (decodeXml(title).toUpperCase() === 'OP' ? 'op' : 'ed') : 'auto',
      uid
    })
  }
  return out
}

function chapterTimeToMs(value: string): number {
  const m = /^(\d+):(\d{2}):(\d{2})\.(\d{1,9})$/.exec(value.trim())
  if (!m) return 0
  const [, h, mi, s, frac] = m
  const nano = Number((frac ?? '0').padEnd(9, '0').slice(0, 9))
  return ((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1000 + Math.round(nano / 1_000_000)
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
