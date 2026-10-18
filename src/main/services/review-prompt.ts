import type { AssEvent } from '@shared/ass-parser'
import { formatTimecode } from '@shared/time'

export const PROMPT_VERSION = 'review-v1'

export interface PromptContext {
  anime: string
  release: string
  localNo: string
  glossary: string
  recap: string
}

export function formatEventRows(events: AssEvent[]): string {
  return events
    .map((e) => `${e.index}\t${formatTimecode(e.startMs)} --> ${formatTimecode(e.endMs)}\t${e.plain.replace(/\s*\n\s*/g, ' / ')}`)
    .join('\n')
}

export const PROMPT_TEMPLATE = `你是专业的番剧字幕审阅助手，负责在人工校对前做结构化检查。

# 任务
审阅给定的 ASS 字幕对白表。表格三列：行号、时间轴、文本（已去除 ASS 标签）。
只报告你有把握的问题，每条问题必须给出精确的行号（表格第一列）。

# 审阅维度（category 取值）
- typo 错别字/用词
- grammar 语法/通顺
- accuracy 翻译准确性
- term 术语/人名一致性
- punctuation 标点/排版
- timing 时间轴（重叠、负时长、过短 <0.5s、过长 >8s）
- ass_tag ASS 标签（标签未闭合、样式不存在、\\\\N 误用）
- omission 漏翻/空对白/行数异常
- style 样式/特效
- context 上下文不符

# 严重度（severity）
- blocker 必须修复，否则不可发布（错译造成误导、时间轴错位严重、漏译整句）
- major 重要问题（错别字、病句、术语不一致、时间轴异常）
- minor 建议（标点、排版、可读性）
- info 提示（风格建议）

# 上下文
番名：{anime}
发布集数：{release}（本地第 {local} 集）
术语表：
{glossary}
前情摘要：
{recap}

# 输出格式（严格遵守，只输出 JSON，不要任何解释文字，不要 markdown 代码块）
{
  "schema_version": "1.0",
  "verdict": "pass 或 fail",
  "summary": "一句话总结",
  "issues": [
    {
      "id": "AI-0001",
      "severity": "blocker|major|minor|info",
      "category": "typo|grammar|accuracy|term|punctuation|timing|ass_tag|omission|style|context",
      "line": 42,
      "start_ms": 12345,
      "end_ms": 15000,
      "original": "原文对白",
      "suggestion": "建议改为……",
      "reason": "为什么是问题",
      "confidence": 0.92
    }
  ],
  "stats": { "blocker": 0, "major": 0, "minor": 0, "info": 0 }
}

# 字幕对白表
{rows}
`

export function buildPrompt(ctx: PromptContext, rows: string): string {
  return PROMPT_TEMPLATE.replace('{anime}', ctx.anime)
    .replace('{release}', ctx.release)
    .replace('{local}', ctx.localNo)
    .replace('{glossary}', ctx.glossary.trim() || '（无）')
    .replace('{recap}', ctx.recap.trim() || '（无）')
    .replace('{rows}', rows)
}

/** 按字符预算切分事件表（保留行号，AI 用绝对行号返回） */
export function chunkEvents(events: AssEvent[], maxChars = 24_000): AssEvent[][] {
  const chunks: AssEvent[][] = []
  let current: AssEvent[] = []
  let size = 0
  for (const e of events) {
    const rowSize = e.plain.length + 40
    if (current.length > 0 && size + rowSize > maxChars) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(e)
    size += rowSize
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}
