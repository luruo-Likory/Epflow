/**
 * ASS / SSA 解析（§FR-04）。纯函数，无文件 IO。
 * 只做「够用于审阅、章节与标签校验」的解析：Script Info、Styles、Events。
 */

import { parseAssTime } from './time'

export interface AssStyle {
  name: string
  fontname: string
  fontsize: number
  primaryColour: string
  outline: number
  shadow: number
  alignment: number
  marginL: number
  marginR: number
  marginV: number
  encoding: number | null
  raw: Record<string, string>
}

export interface AssEvent {
  /** 1-based，按 [Events] 中出现顺序（含 Comment） */
  index: number
  /** 文件行号，1-based */
  lineNo: number
  type: 'dialogue' | 'comment'
  layer: number
  startMs: number
  endMs: number
  style: string
  name: string
  effect: string
  /** 原始文本（含 ASS 覆盖标签） */
  text: string
  /** 去标签后的纯文本 */
  plain: string
  isComment: boolean
}

export interface AssDocument {
  info: Record<string, string>
  styles: AssStyle[]
  styleNames: string[]
  events: AssEvent[]
  playResX: number
  playResY: number
  wrapStyle: number
  format: {
    styles: string[]
    events: string[]
  }
  lineCount: number
  /** 原始文本（保留用于写回） */
  raw: string
}

const DEFAULT_EVENT_FORMAT = [
  'Layer',
  'Start',
  'End',
  'Style',
  'Name',
  'MarginL',
  'MarginR',
  'MarginV',
  'Effect',
  'Text'
]

const DEFAULT_STYLE_FORMAT = [
  'Name',
  'Fontname',
  'Fontsize',
  'PrimaryColour',
  'SecondaryColour',
  'OutlineColour',
  'BackColour',
  'Bold',
  'Italic',
  'Underline',
  'StrikeOut',
  'ScaleX',
  'ScaleY',
  'Spacing',
  'Angle',
  'BorderStyle',
  'Outline',
  'Shadow',
  'Alignment',
  'MarginL',
  'MarginR',
  'MarginV',
  'Encoding'
]

export function stripAssTags(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N/gi, '\n')
    .replace(/\\n/gi, '\n')
    .replace(/\\h/gi, ' ')
}

/** 估算一行文本的显示宽度（以像素计）：CJK 按 1 字宽，拉丁按 0.55 */
export function estimateTextWidth(plain: string, fontSize: number): number {
  let units = 0
  for (const ch of plain) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x2e80) units += 1
    else if (/\s/.test(ch)) units += 0.3
    else units += 0.55
  }
  return units * fontSize
}

function parseNumber(value: string | undefined, fallback = 0): number {
  if (value === undefined) return fallback
  const n = Number(value.trim())
  return Number.isFinite(n) ? n : fallback
}

function formatFromLine(line: string): string[] | null {
  const idx = line.indexOf(':')
  if (idx < 0) return null
  return line
    .slice(idx + 1)
    .split(',')
    .map((s) => s.trim())
}

function pick(raw: Record<string, string>, key: string): string {
  const found = Object.keys(raw).find((k) => k.toLowerCase() === key.toLowerCase())
  return found ? (raw[found] as string) : ''
}

export function parseAss(text: string): AssDocument {
  const raw = text
  const normalized = text.replace(/^\uFEFF/, '')
  const lines = normalized.split(/\r?\n/)

  const info: Record<string, string> = {}
  const styles: AssStyle[] = []
  const events: AssEvent[] = []
  let section = ''
  let eventFormat = DEFAULT_EVENT_FORMAT
  let styleFormat = DEFAULT_STYLE_FORMAT
  let playResX = 0
  let playResY = 0
  let wrapStyle = 0
  let eventCounter = 0

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      section = trimmed.slice(1, -1).toLowerCase()
      continue
    }

    if (section === 'script info') {
      const idx = line.indexOf(':')
      if (idx > 0) {
        const key = line.slice(0, idx).trim()
        const value = line.slice(idx + 1).trim()
        info[key] = value
        if (/^playresx$/i.test(key)) playResX = parseNumber(value)
        if (/^playresy$/i.test(key)) playResY = parseNumber(value)
        if (/^wrapstyle$/i.test(key)) wrapStyle = parseNumber(value)
      }
      continue
    }

    if (section === 'v4+ styles' || section === 'v4 styles') {
      if (/^format\s*:/i.test(trimmed)) {
        styleFormat = formatFromLine(trimmed) ?? DEFAULT_STYLE_FORMAT
        continue
      }
      if (/^style\s*:/i.test(trimmed)) {
        const values = line.slice(line.indexOf(':') + 1).split(',')
        const record: Record<string, string> = {}
        styleFormat.forEach((key, idx) => {
          record[key] = (values[idx] ?? '').trim()
        })
        styles.push({
          name: pick(record, 'Name'),
          fontname: pick(record, 'Fontname'),
          fontsize: parseNumber(pick(record, 'Fontsize'), 0),
          primaryColour: pick(record, 'PrimaryColour'),
          outline: parseNumber(pick(record, 'Outline')),
          shadow: parseNumber(pick(record, 'Shadow')),
          alignment: parseNumber(pick(record, 'Alignment'), 2),
          marginL: parseNumber(pick(record, 'MarginL')),
          marginR: parseNumber(pick(record, 'MarginR')),
          marginV: parseNumber(pick(record, 'MarginV')),
          encoding: record.Encoding !== undefined ? parseNumber(record.Encoding) : null,
          raw: record
        })
      }
      continue
    }

    if (section === 'events') {
      if (/^format\s*:/i.test(trimmed)) {
        eventFormat = formatFromLine(trimmed) ?? DEFAULT_EVENT_FORMAT
        continue
      }
      const isDialogue = /^dialogue\s*:/i.test(trimmed)
      const isComment = /^comment\s*:/i.test(trimmed)
      if (!isDialogue && !isComment) continue

      const body = line.slice(line.indexOf(':') + 1)
      const parts = splitEvent(body, eventFormat.length)
      const record: Record<string, string> = {}
      eventFormat.forEach((key, idx) => {
        record[key] = idx === eventFormat.length - 1 ? (parts[idx] ?? '') : (parts[idx] ?? '').trim()
      })

      const startMs = parseAssTime(pick(record, 'Start'))
      const endMs = parseAssTime(pick(record, 'End'))
      const textValue = pick(record, 'Text')
      eventCounter += 1
      events.push({
        index: eventCounter,
        lineNo: i + 1,
        type: isDialogue ? 'dialogue' : 'comment',
        layer: parseNumber(pick(record, 'Layer')),
        startMs: Number.isFinite(startMs) ? startMs : 0,
        endMs: Number.isFinite(endMs) ? endMs : 0,
        style: pick(record, 'Style'),
        name: pick(record, 'Name'),
        effect: pick(record, 'Effect'),
        text: textValue,
        plain: stripAssTags(textValue).replace(/\r/g, ''),
        isComment: isComment
      })
    }
  }

  return {
    info,
    styles,
    styleNames: styles.map((s) => s.name),
    events,
    playResX: playResX || 1920,
    playResY: playResY || 1080,
    wrapStyle,
    format: { styles: styleFormat, events: eventFormat },
    lineCount: lines.length,
    raw
  }
}

/** 事件行按 Format 定义的字段数切分，文本字段可能含逗号 */
function splitEvent(body: string, fieldCount: number): string[] {
  const out: string[] = []
  let rest = body
  for (let i = 0; i < fieldCount - 1; i += 1) {
    const idx = rest.indexOf(',')
    if (idx < 0) {
      out.push(rest)
      rest = ''
    } else {
      out.push(rest.slice(0, idx))
      rest = rest.slice(idx + 1)
    }
  }
  out.push(rest)
  return out
}

export function dialogueEvents(doc: AssDocument): AssEvent[] {
  return doc.events.filter((e) => !e.isComment)
}

export function totalDurationMs(doc: AssDocument): number {
  let max = 0
  for (const e of doc.events) if (e.endMs > max) max = e.endMs
  return max
}

export interface ReplaceOptions {
  regex?: boolean
  caseSensitive?: boolean
  onlyDialogue?: boolean
  limit?: number
}

export interface ReplaceResult {
  text: string
  count: number
}

/** 在 ASS 事件文本中查找替换（不触碰样式与 Info 段） */
export function replaceInAss(text: string, find: string, replace: string, options: ReplaceOptions = {}): ReplaceResult {
  if (!find) return { text, count: 0 }
  const lines = text.split(/\r?\n/)
  let count = 0
  const flags = options.caseSensitive ? 'g' : 'gi'
  const pattern = options.regex ? new RegExp(find, flags) : null
  const literal = options.caseSensitive ? find : find.toLowerCase()
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (!/^(dialogue|comment)\s*:/i.test(line)) continue
    if (options.onlyDialogue && /^comment\s*:/i.test(line)) continue
    const idx = line.indexOf(':')
    const body = line.slice(idx + 1)
    const fields = splitEvent(body, 10)
    const textPart = fields[9] ?? ''
    let replaced = textPart
    if (pattern) {
      replaced = textPart.replace(pattern, replace)
    } else if (literal) {
      let result = ''
      let rest = textPart
      for (;;) {
        const haystack = options.caseSensitive ? rest : rest.toLowerCase()
        const pos = haystack.indexOf(literal)
        if (pos < 0) {
          result += rest
          break
        }
        result += rest.slice(0, pos) + replace
        rest = rest.slice(pos + find.length)
        count += 1
        if (count >= limit) {
          result += rest
          break
        }
      }
      replaced = result
    }
    if (replaced !== textPart) {
      if (pattern) {
        const matches = textPart.match(pattern)
        if (matches) count += matches.length
      }
      fields[9] = replaced
      lines[i] = `${line.slice(0, idx + 1)}${fields.join(',')}`
    }
  }

  return { text: lines.join('\n'), count }
}

/** 校验 ASS 覆盖标签：花括号不配对、样式引用、\N 数量 */
export interface AssTagIssue {
  kind: 'unbalanced-brace' | 'unknown-style' | 'too-many-newlines' | 'empty-text' | 'invalid-time'
  line: number
  detail: string
}

export function validateAssStructure(doc: AssDocument, playResX = doc.playResX): AssTagIssue[] {
  const issues: AssTagIssue[] = []
  const knownStyles = new Set(doc.styles.map((s) => s.name))
  for (const e of doc.events) {
    const opens = (e.text.match(/\{/g) ?? []).length
    const closes = (e.text.match(/\}/g) ?? []).length
    if (opens !== closes) {
      issues.push({ kind: 'unbalanced-brace', line: e.index, detail: `花括号不配对（{ ×${opens}，} ×${closes}）` })
    }
    if (e.style && knownStyles.size > 0 && !knownStyles.has(e.style)) {
      issues.push({ kind: 'unknown-style', line: e.index, detail: `样式 "${e.style}" 未在 [V4+ Styles] 中定义` })
    }
    const newlines = (e.text.match(/\\N/gi) ?? []).length
    if (newlines > 2) {
      issues.push({ kind: 'too-many-newlines', line: e.index, detail: `单行含 ${newlines} 个硬换行` })
    }
    if (!e.isComment && !e.plain.trim()) {
      issues.push({ kind: 'empty-text', line: e.index, detail: '对白文本为空或仅含标签' })
    }
    if (e.endMs <= e.startMs) {
      issues.push({
        kind: 'invalid-time',
        line: e.index,
        detail: `时间轴异常（${e.startMs} → ${e.endMs}）`
      })
    }
    void playResX
  }
  return issues
}
