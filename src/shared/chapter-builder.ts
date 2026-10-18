/**
 * 章节自动生成与 Matroska 章节 XML（§FR-07 / §7.6）。
 *
 * 纯函数模块：不依赖 Node / Electron / 浏览器 API，
 * 主进程与渲染层都可以直接调用（UID 生成因此不使用 crypto）。
 */

import { formatChapterTime } from './time'
import type { Chapter, ChapterSource } from './types'

export interface ChapterConfig {
  /** 相邻对白间隔达到该值即可作为候选切点，默认 2000 */
  gapThresholdMs: number
  /** 相邻章节的最小长度，默认 90000 */
  minChapterLenMs: number
  /** 单章最大长度，超出时在内部最大 gap 处补切，默认 480000 */
  maxChapterLenMs: number
  /** 章节数上限，默认 10 */
  maxChapters: number
  /** 章节数下限，默认 3 */
  minChapters: number
  /** 识别 OP / ED，默认 true */
  detectOpEd: boolean
  /** 首章固定从 0 开始，默认 true */
  firstChapterAtZero: boolean
}

export interface ChapterInputEvent {
  startMs: number
  endMs: number
  /** 纯文本（已去 ASS 标签） */
  text: string
  isComment: boolean
}

interface NormalizedEvent {
  startMs: number
  endMs: number
}

interface Interval {
  start: number
  end: number
}

interface CutPoint {
  /** 切点时间（= 前一条对白的 endMs） */
  at: number
  /** 切点处的对白间隔 */
  gap: number
}

interface ChapterPoint {
  at: number
  isCut: boolean
}

const DEFAULT_CONFIG: ChapterConfig = {
  gapThresholdMs: 2000,
  minChapterLenMs: 90000,
  maxChapterLenMs: 480000,
  maxChapters: 10,
  minChapters: 3,
  detectOpEd: true,
  firstChapterAtZero: true
}

/** 降阈值重试时的绝对下限 */
const MIN_RETRY_GAP_MS = 800
/** 相邻章节的硬性最小间隔（仅校验用） */
const MIN_CHAPTER_GAP_MS = 5000

const UID_MASK = (1n << 64n) - 1n
let uidSeq = 0

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function normalizeConfig(cfg: ChapterConfig): ChapterConfig {
  const maxChapters = Math.max(1, Math.floor(finiteOr(cfg?.maxChapters, DEFAULT_CONFIG.maxChapters)))
  const minChapterLenMs = Math.max(0, finiteOr(cfg?.minChapterLenMs, DEFAULT_CONFIG.minChapterLenMs))
  const maxChapterLenMs = Math.max(
    minChapterLenMs,
    Math.max(1, finiteOr(cfg?.maxChapterLenMs, DEFAULT_CONFIG.maxChapterLenMs))
  )
  return {
    gapThresholdMs: Math.max(0, finiteOr(cfg?.gapThresholdMs, DEFAULT_CONFIG.gapThresholdMs)),
    minChapterLenMs,
    maxChapterLenMs,
    maxChapters,
    minChapters: Math.min(maxChapters, Math.max(1, Math.floor(finiteOr(cfg?.minChapters, DEFAULT_CONFIG.minChapters)))),
    detectOpEd: cfg?.detectOpEd !== false,
    firstChapterAtZero: cfg?.firstChapterAtZero !== false
  }
}

function normalizeEvents(events: ChapterInputEvent[]): NormalizedEvent[] {
  const out: NormalizedEvent[] = []
  for (const event of events) {
    if (!event || event.isComment) continue
    const text = typeof event.text === 'string' ? event.text : ''
    if (text.trim() === '') continue
    const startMs = Math.max(0, finiteOr(event.startMs, 0))
    const endMs = Math.max(startMs, finiteOr(event.endMs, startMs))
    out.push({ startMs, endMs })
  }
  out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  return out
}

/** 合并对白区间，用于「切点不得落在对白内」的判定 */
function mergeIntervals(events: NormalizedEvent[]): Interval[] {
  const out: Interval[] = []
  for (const event of events) {
    if (event.endMs <= event.startMs) continue
    const last = out[out.length - 1]
    if (last && event.startMs <= last.end) {
      if (event.endMs > last.end) last.end = event.endMs
    } else {
      out.push({ start: event.startMs, end: event.endMs })
    }
  }
  return out
}

/** 严格位于对白内部（不包含首尾端点） */
function insideDialogue(cut: number, intervals: Interval[]): boolean {
  let lo = 0
  let hi = intervals.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const interval = intervals[mid]
    if (interval && interval.start < cut) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (found < 0) return false
  const interval = intervals[found]
  return interval !== undefined && cut < interval.end
}

/**
 * 生成 64 位无符号整数的十进制 UID。
 * 使用时间戳 + 进程内计数器 + 随机数混合，避免 Collision；
 * 同一 used 集合内保证不重复。
 */
function nextUid(used: Set<string>): string {
  for (let attempt = 0; attempt < 4096; attempt += 1) {
    uidSeq = (uidSeq + 1) % 0x1000000
    const time = BigInt(Date.now())
    const random = BigInt(Math.floor(Math.random() * 0x100000000))
    const mixed = ((time << 22n) ^ (BigInt(uidSeq) << 12n) ^ random) & UID_MASK
    const uid = (mixed === 0n ? 1n : mixed).toString(10)
    if (!used.has(uid)) {
      used.add(uid)
      return uid
    }
  }
  // 极端碰撞兜底：从时间戳开始顺序找空位
  let fallback = BigInt(Date.now()) & UID_MASK
  for (let attempt = 0; attempt < 4096; attempt += 1) {
    const uid = (fallback === 0n ? 1n : fallback).toString(10)
    if (!used.has(uid)) {
      used.add(uid)
      return uid
    }
    fallback = (fallback + 1n) & UID_MASK
  }
  // 理论上到不了这里
  return ((BigInt(Date.now()) + BigInt(uidSeq)) & UID_MASK).toString(10)
}

/* ------------------------------------------------------------------ */
/* 切点计算                                                            */
/* ------------------------------------------------------------------ */

/**
 * 在 (start, end) 内找最大对白间隔处补切点。
 * 同 gap 时取最靠近段中点者，避免连续对白被切成大量碎片。
 */
function findInternalCut(
  start: number,
  end: number,
  events: NormalizedEvent[],
  intervals: Interval[],
  used: Set<number>
): CutPoint | null {
  const middle = (start + end) / 2
  let best: (CutPoint & { distance: number }) | null = null

  for (let i = 0; i < events.length - 1; i += 1) {
    const current = events[i]
    const next = events[i + 1]
    if (!current || !next) continue
    const cut = current.endMs
    if (cut <= start || cut >= end) continue
    // 只考虑段内相邻事件之间的 gap
    if (next.startMs > end) continue
    if (used.has(cut)) continue
    if (insideDialogue(cut, intervals)) continue

    const gap = next.startMs - current.endMs
    const distance = Math.abs(cut - middle)
    if (
      !best ||
      gap > best.gap ||
      (gap === best.gap && (distance < best.distance || (distance === best.distance && cut < best.at)))
    ) {
      best = { at: cut, gap, distance }
    }
  }

  return best ? { at: best.at, gap: best.gap } : null
}

/**
 * 第一步：按 gap 阈值与最小章节长度取相邻切点；
 * 第二步：对超过 maxChapterLenMs 的段补切，直到所有段都不超长或无法再切。
 */
function collectCuts(
  events: NormalizedEvent[],
  intervals: Interval[],
  cfg: ChapterConfig,
  thresholdMs: number,
  anchor: number
): CutPoint[] {
  const cuts: CutPoint[] = []
  let lastCut = anchor

  for (let i = 0; i < events.length - 1; i += 1) {
    const current = events[i]
    const next = events[i + 1]
    if (!current || !next) continue
    const gap = next.startMs - current.endMs
    const cut = current.endMs
    if (gap < thresholdMs) continue
    if (cut <= lastCut) continue
    if (cut - lastCut < cfg.minChapterLenMs) continue
    if (insideDialogue(cut, intervals)) continue
    cuts.push({ at: cut, gap })
    lastCut = cut
  }

  // 超长段补切
  const contentEnd = events[events.length - 1]?.endMs ?? anchor
  const used = new Set(cuts.map((cut) => cut.at))
  const guard = events.length + 2

  for (let round = 0; round < guard; round += 1) {
    const boundaries = [anchor, ...cuts.map((cut) => cut.at)].sort((a, b) => a - b)
    let added = false
    for (let i = 0; i < boundaries.length; i += 1) {
      const start = boundaries[i]
      if (start === undefined) continue
      const end = boundaries[i + 1] ?? Math.max(contentEnd, start)
      if (end - start <= cfg.maxChapterLenMs) continue
      const cut = findInternalCut(start, end, events, intervals, used)
      if (!cut) continue
      cuts.push(cut)
      used.add(cut.at)
      added = true
      break
    }
    if (!added) break
  }

  return cuts
}

/** 去重、按时间升序；候选过多时保留 gap 最大的 maxChapters - 1 个切点 */
function assemblePoints(anchor: number, cuts: CutPoint[], cfg: ChapterConfig): ChapterPoint[] {
  const byTime = new Map<number, CutPoint>()
  for (const cut of cuts) {
    if (!byTime.has(cut.at)) byTime.set(cut.at, cut)
  }

  let sorted = [...byTime.values()].sort((a, b) => a.at - b.at)
  if (sorted.length + 1 > cfg.maxChapters) {
    sorted = sorted
      .slice()
      .sort((a, b) => b.gap - a.gap || a.at - b.at)
      .slice(0, cfg.maxChapters - 1)
      .sort((a, b) => a.at - b.at)
  }

  const points: ChapterPoint[] = [{ at: anchor, isCut: false }]
  for (const cut of sorted) {
    if (cut.at <= anchor) continue
    points.push({ at: cut.at, isCut: true })
  }
  points.sort((a, b) => a.at - b.at)
  return points
}

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

/** 依据对白事件生成章节列表（至少 1 章） */
export function buildChapters(
  events: ChapterInputEvent[],
  durationMs: number,
  cfg: ChapterConfig
): Chapter[] {
  const config = normalizeConfig(cfg)
  const normalized = normalizeEvents(Array.isArray(events) ? events : [])
  const anchor = normalized.length === 0
    ? 0
    : config.firstChapterAtZero
      ? 0
      : Math.max(0, Math.round(normalized[0]?.startMs ?? 0))

  const intervals = mergeIntervals(normalized)
  let points: ChapterPoint[] = []

  if (normalized.length === 0) {
    points = [{ at: 0, isCut: false }]
  } else {
    const base = config.gapThresholdMs
    const thresholds = [base]
    for (const factor of [0.75, 0.5]) {
      const retry = Math.max(MIN_RETRY_GAP_MS, base * factor)
      if (retry < base && !thresholds.includes(retry)) thresholds.push(retry)
    }

    for (const threshold of thresholds) {
      const cuts = collectCuts(normalized, intervals, config, threshold, anchor)
      points = assemblePoints(anchor, cuts, config)
      if (points.length >= config.minChapters) break
    }
  }

  if (points.length === 0) points = [{ at: 0, isCut: false }]
  if (points.length > config.maxChapters) points = points.slice(0, config.maxChapters)
  if (points.length === 0) points = [{ at: 0, isCut: false }]

  const duration = Math.max(0, finiteOr(durationMs, 0))
  const sources: ChapterSource[] = points.map(() => 'auto')
  const titles = points.map((_, index) => `Chapter ${String(index + 1).padStart(2, '0')}`)

  if (config.detectOpEd) {
    let opIndex = -1
    for (let i = 1; i < points.length; i += 1) {
      const point = points[i]
      if (point && point.isCut && point.at >= 45_000 && point.at <= 240_000) {
        opIndex = i
        break
      }
    }

    let edIndex = -1
    const edFrom = duration - 240_000
    const edTo = duration - 30_000
    for (let i = 1; i < points.length; i += 1) {
      const point = points[i]
      if (point && point.isCut && point.at >= edFrom && point.at <= edTo) {
        edIndex = i
        break
      }
    }

    if (opIndex >= 0) {
      titles[opIndex] = 'OP'
      sources[opIndex] = 'op'
    }
    // OP 优先：同一个切点已标记 OP 时不再改成 ED
    if (edIndex >= 0 && edIndex !== opIndex) {
      titles[edIndex] = 'ED'
      sources[edIndex] = 'ed'
    }
  }

  const usedUids = new Set<string>()
  return points.map((point, index) => ({
    startMs: point.at,
    title: titles[index] ?? `Chapter ${String(index + 1).padStart(2, '0')}`,
    source: sources[index] ?? 'auto',
    uid: nextUid(usedUids)
  }))
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 生成 Matroska chapters XML */
export function chaptersToXml(
  chapters: Chapter[],
  opts: { language?: string; editionUid?: string } = {}
): string {
  const language = opts.language ?? 'und'
  const ordered = [...chapters].sort((a, b) => a.startMs - b.startMs)
  const usedUids = new Set(ordered.map((chapter) => chapter.uid))
  const providedEdition = typeof opts.editionUid === 'string' ? opts.editionUid.trim() : ''
  const editionUid = providedEdition !== '' ? providedEdition : nextUid(usedUids)

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Chapters>',
    '  <EditionEntry>',
    `    <EditionUID>${escapeXml(editionUid)}</EditionUID>`
  ]

  for (const chapter of ordered) {
    lines.push('    <ChapterAtom>')
    lines.push(`      <ChapterTimeStart>${formatChapterTime(chapter.startMs)}</ChapterTimeStart>`)
    lines.push('      <ChapterDisplay>')
    lines.push(`        <ChapterString>${escapeXml(chapter.title)}</ChapterString>`)
    lines.push(`        <ChapterLanguage>${escapeXml(language)}</ChapterLanguage>`)
    lines.push(`        <ChapLanguageIETF>${escapeXml(language)}</ChapLanguageIETF>`)
    lines.push('      </ChapterDisplay>')
    lines.push(`      <ChapterUID>${escapeXml(chapter.uid)}</ChapterUID>`)
    lines.push('    </ChapterAtom>')
  }

  lines.push('  </EditionEntry>', '</Chapters>')
  return `${lines.join('\n')}\n`
}

/** 校验章节列表，返回中文错误信息（空数组表示通过） */
export function validateChapters(chapters: Chapter[], durationMs?: number | null): string[] {
  const errors: string[] = []
  if (chapters.length === 0) {
    errors.push('至少需要 1 个章节')
    return errors
  }

  const seenUids = new Set<string>()

  for (let i = 0; i < chapters.length; i += 1) {
    const chapter = chapters[i]
    if (!chapter) continue
    const no = i + 1

    if (!Number.isFinite(chapter.startMs)) {
      errors.push(`第 ${no} 章起始时间无效（${String(chapter.startMs)}）`)
    } else {
      if (chapter.startMs < 0) {
        errors.push(`第 ${no} 章起始时间不得早于 0（${chapter.startMs} ms）`)
      }
      if (i > 0) {
        const prev = chapters[i - 1]
        if (prev && Number.isFinite(prev.startMs)) {
          if (chapter.startMs <= prev.startMs) {
            errors.push(
              `第 ${no} 章起始时间必须严格递增（第 ${no - 1} 章 ${prev.startMs} ms → 第 ${no} 章 ${chapter.startMs} ms）`
            )
          } else {
            const gap = chapter.startMs - prev.startMs
            if (gap < MIN_CHAPTER_GAP_MS) {
              errors.push(`第 ${no - 1} 章与第 ${no} 章间隔不足 ${MIN_CHAPTER_GAP_MS}ms（${Math.round(gap)} ms）`)
            }
          }
        }
      }
    }

    const uid = typeof chapter.uid === 'string' ? chapter.uid.trim() : ''
    if (uid === '') {
      errors.push(`第 ${no} 章 UID 不能为空`)
    } else if (seenUids.has(uid)) {
      errors.push(`章节 UID 重复：${uid}`)
    } else {
      seenUids.add(uid)
    }
  }

  if (durationMs !== null && durationMs !== undefined && Number.isFinite(durationMs)) {
    const last = chapters[chapters.length - 1]
    if (last && Number.isFinite(last.startMs) && last.startMs > durationMs + 1000) {
      errors.push(`最后一章起始时间超出时长上限（${last.startMs} ms > ${durationMs + 1000} ms）`)
    }
  }

  return errors
}
