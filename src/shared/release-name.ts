/**
 * 发布名集数位识别（§7.1）
 *
 * 目标：在一整条发布名里找出「哪一个数字是集数」，并只替换它，
 * 绝不误伤 1080p / 5.1 / x264 / S01E13 的季号 / Part.2 等数字。
 */

export type ReleasePattern = 'bracket' | 'dash' | 'cn' | 'en' | 'bare'

export interface ReleaseCandidate {
  /** 数字在原文中的起止位置（左闭右开），仅覆盖数字本身 */
  start: number
  end: number
  digits: string
  value: number
  pattern: ReleasePattern
  /** 越小越可信 */
  priority: number
  /** 上下文片段，便于 UI 展示 */
  context: string
}

const PRIORITY: Record<ReleasePattern, number> = {
  bracket: 1,
  dash: 2,
  cn: 3,
  en: 4,
  bare: 5
}

const NON_EPISODE = new Set([
  '1080',
  '720',
  '2160',
  '480',
  '576',
  '264',
  '265',
  '10',
  '8',
  '12',
  '16',
  '24',
  '30',
  '60',
  '120',
  '5',
  '7',
  '2'
])

/** 排除明显不是集数的裸数字 */
function bareLooksWrong(text: string, start: number, end: number): boolean {
  const digits = text.slice(start, end)
  const value = Number(digits)
  const before = text[start - 1] ?? ''
  const after = text[end] ?? ''
  const beforeTwo = text.slice(Math.max(0, start - 6), start)
  const afterFew = text.slice(end, end + 4)

  // 分辨率/编码/帧率/声道
  if (/^\s*(p|i|bit|fps|hz|k|kb|mb|gb|ch|x)$/i.test(after)) return true
  if (/[x×]\s*$/i.test(beforeTwo)) return true
  if (/^\s*[x×]\s*\d+$/i.test(afterFew)) return true
  if (/(x264|x265|h264|h265|hevc|avc|av1|vp9|opus|aac|flac|ddp|aac\d)/i.test(beforeTwo + afterFew)) return true
  // 小数（5.1 / 7.1 / Part.2 / 2.0）
  if (before === '.' || after === '.') return true
  if (/part\.?\s*$/i.test(beforeTwo)) return true
  // 年份
  if (/^(19|20)\d{2}$/.test(digits)) return true
  // 季号：S01 / Season 1
  if (/(s|season\s*)$/i.test(beforeTwo)) return true
  // 明显噪声
  if (NON_EPISODE.has(digits) && !/[\[第集话話]/.test(before + after)) {
    // 仅在裸匹配时保守排除，避免把 [05] 之类放过
    if (value <= 16 && /^\s*$/.test(before) && /^\s*$/.test(after)) return true
  }
  return false
}

function contextOf(text: string, start: number, end: number): string {
  const from = Math.max(0, start - 12)
  const to = Math.min(text.length, end + 12)
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`
}

function push(
  out: ReleaseCandidate[],
  text: string,
  start: number,
  end: number,
  pattern: ReleasePattern
): void {
  const digits = text.slice(start, end)
  if (!/^\d{1,4}$/.test(digits)) return
  // 已存在重叠候选则跳过（同一位置只保留优先级最高者，见后续排序）
  out.push({
    start,
    end,
    digits,
    value: Number(digits),
    pattern,
    priority: PRIORITY[pattern],
    context: contextOf(text, start, end)
  })
}

/** 找出一段文本中所有可能的集数位 */
export function findReleaseCandidates(text: string): ReleaseCandidate[] {
  if (!text) return []
  const out: ReleaseCandidate[] = []

  // 1. 方括号内 1–3 位数字：[01] [13]
  for (const m of text.matchAll(/\[(\d{1,3})\]/g)) {
    if (m.index === undefined) continue
    const digits = m[1] ?? ''
    const start = m.index + 1
    push(out, text, start, start + digits.length, 'bracket')
  }

  // 2. 分隔符 + 数字： - 01 / – 13
  for (const m of text.matchAll(/(?:\s[-–—]\s|\s-\s)(\d{1,3})(?=$|[\s\]\[(（)）])/g)) {
    if (m.index === undefined) continue
    const digits = m[1] ?? ''
    const start = m.index + m[0].length - digits.length
    push(out, text, start, start + digits.length, 'dash')
  }

  // 3. 第01集 / 第13话
  for (const m of text.matchAll(/第\s*(\d{1,3})\s*(?:集|话|話|期)/g)) {
    if (m.index === undefined) continue
    const digits = m[1] ?? ''
    const start = m.index + m[0].indexOf(digits)
    push(out, text, start, start + digits.length, 'cn')
  }

  // 4. E01 / EP01 / S01E01（取最后一组数字）
  for (const m of text.matchAll(/(?:\bEP?|\bS\d{1,2}EP?)[\s._-]?(\d{1,3})\b/gi)) {
    if (m.index === undefined) continue
    const digits = m[1] ?? ''
    const start = m.index + m[0].length - digits.length
    push(out, text, start, start + digits.length, 'en')
  }

  // 5. 独立数字 token
  for (const m of text.matchAll(/(?:^|[\s._\-–—])(\d{1,3})(?=[\s._\-–—\]]|$)/g)) {
    if (m.index === undefined) continue
    const digits = m[1] ?? ''
    const start = m.index + m[0].length - digits.length
    const end = start + digits.length
    if (bareLooksWrong(text, start, end)) continue
    push(out, text, start, end, 'bare')
  }

  // 同一区间去重（保留优先级最高）
  const bySpan = new Map<string, ReleaseCandidate>()
  for (const c of out) {
    const key = `${c.start}-${c.end}`
    const prev = bySpan.get(key)
    if (!prev || c.priority < prev.priority) bySpan.set(key, c)
  }

  return [...bySpan.values()].sort((a, b) => a.priority - b.priority || a.start - b.start)
}

/** 默认选中：优先级最高（同优先级取靠前者） */
export function chooseDefaultCandidate(candidates: ReleaseCandidate[]): ReleaseCandidate | null {
  if (candidates.length === 0) return null
  return [...candidates].sort((a, b) => a.priority - b.priority || a.start - b.start)[0] ?? null
}

/** 把选中位置替换为 {release}，得到发布名模板 */
export function applyReleaseTemplate(text: string, candidate: ReleaseCandidate): string {
  return `${text.slice(0, candidate.start)}{release}${text.slice(candidate.end)}`
}

/** 若文本已含 {release}，直接返回 */
export function toReleaseTemplate(text: string, candidate?: ReleaseCandidate | null): string {
  if (text.includes('{release}')) return text
  const chosen = candidate ?? chooseDefaultCandidate(findReleaseCandidates(text))
  return chosen ? applyReleaseTemplate(text, chosen) : text
}

/** 按宽度补零 */
export function formatRelease(value: number | string, width = 2): string {
  const str = String(value)
  if (str.length >= width) return str
  return str.padStart(width, '0')
}

/** 渲染最终发布名 */
export function renderReleaseName(template: string, releaseNo: string): string {
  return template.replace(/\{release\}/g, releaseNo)
}

/** release_no = base + (local - localStart) */
export function computeReleaseNo(base: number, localNo: number, localStart = 1): number {
  return base + (localNo - localStart)
}
