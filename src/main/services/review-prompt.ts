import type { AssEvent } from '@shared/ass-parser'
import type { AssEventKind } from '@shared/ass-classify'
import { formatTimecode } from '@shared/time'

export const PROMPT_VERSION = 'review-v2'

export interface PromptContext {
  anime: string
  release: string
  localNo: string
  glossary: string
  recap: string
}

const KIND_LABEL: Record<AssEventKind, string> = {
  dialogue: '对白',
  screen: '屏字',
  effect: '特效'
}

/** 表格列：行号 | 时间轴 | 类型 | 文本 */
export function formatEventRows(events: AssEvent[], kinds?: Map<number, AssEventKind>): string {
  return events
    .map((e) => {
      const kind = KIND_LABEL[kinds?.get(e.index) ?? 'dialogue']
      const text = e.plain.replace(/\s*\n\s*/g, ' / ')
      return `${e.index}\t${formatTimecode(e.startMs)} --> ${formatTimecode(e.endMs)}\t[${kind}]\t${text}`
    })
    .join('\n')
}

export const PROMPT_TEMPLATE = `你是字幕校对助手。本次只做三件事，不要做其它任何检查。

# 输入
下面是一张字幕表格，列为：行号 | 时间轴 | 类型 | 文本。
表格已经过滤：只包含「对白」与「屏幕字」，**不包含特效行**（绘图、字体特效、卡拉OK、动画、定位程序等），也不包含注释行。
行号是 ASS 事件序号，必须原样使用。

# 只检查以下三类
1. **错别字**（category: typo）
   - 同音字、形近字、明显错字、明显用词错误（例如「在/再」「的/得/地」「帐/账」「做/作」）。
2. **不通顺**（category: grammar）
   - 病句、缺主语/谓语、语序混乱、明显读不通、成分残缺、重复啰嗦。
3. **上下排列**（category: layout）
   - 同一时间出现两行（时间轴重叠）却没有上下排列，导致两行会叠在同一个位置。
   - 判定依据表格的时间列与行号：两行时间区间有重叠、且各自是独立事件时，应改为上下排列。
   - 若一行内部已经用 \\N 分成上下两行，说明作者已做排列，不算问题。
   - 报告时 line 填第一行的行号，lines 填 [第一行号, 第二行号]（只填涉及的行，通常是 2 个）。
   - 建议写法：合并成一条对白并用 \\N 上下排列；或给其中一条加对齐/定位（如 \\an7 / \\an9 / \\pos）。

# 不要报告（这些不在本次范围内）
- 特效行、绘图、字体、颜色、描边、阴影、样式、卡拉OK、动画
- 时间轴精度、帧对齐、单行时长、重叠时长本身（除上面第 3 条的排列问题）
- 翻译准确性、与原文/画面是否一致、术语/人名一致性
- 标点风格、空格、全半角、标点中英文
- 漏翻、上下文、剧情连贯性、字幕行数取舍
- 任何"建议优化"的主观润色：只在确有错别字或读不通时报告

# 严重度（severity）
- major：确定的错别字、明显病句、两行叠在同一位置
- minor：轻微不顺或可读性问题
- blocker：仅在整句完全无法理解时使用

# 输出格式（严格 JSON，不要任何解释文字，不要 markdown 代码块）
{
  "schema_version": "1.0",
  "verdict": "pass 或 fail",
  "summary": "一句话总结",
  "issues": [
    {
      "id": "AI-0001",
      "severity": "blocker|major|minor",
      "category": "typo|grammar|layout",
      "line": 42,
      "lines": [42, 43],
      "start_ms": 12345,
      "end_ms": 15000,
      "original": "原文",
      "suggestion": "建议改为……",
      "reason": "为什么是问题",
      "confidence": 0.92
    }
  ],
  "stats": { "blocker": 0, "major": 0, "minor": 0, "info": 0 }
}

# 上下文
番名：{anime}
发布集数：{release}（本地第 {local} 集）
（术语表与剧情仅供参考，不要据此报告术语一致性问题）
术语表：
{glossary}
前情摘要：
{recap}

# 字幕表格
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
