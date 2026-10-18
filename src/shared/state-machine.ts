import type { EpisodeState, Severity } from './types'

/**
 * 合法状态转移（§6.2）。任何未列出的转移都会被仓储层拒绝并记录审计。
 * 注意：`SUB_IMPORTED` 是「回到起点」的汇聚态，字幕变更时所有下游状态都会回退到这里。
 */
export const TRANSITIONS: Record<EpisodeState, EpisodeState[]> = {
  INIT: ['TEMPLATE_READY', 'SUB_IMPORTED'],
  TEMPLATE_READY: ['SUB_IMPORTED'],
  SUB_IMPORTED: ['AI_REVIEWING', 'TEMPLATE_READY'],
  AI_REVIEWING: ['AI_PASSED', 'AI_REJECTED', 'SUB_IMPORTED'],
  AI_REJECTED: ['AI_REVIEWING', 'SUB_IMPORTED'],
  AI_PASSED: ['HUMAN_REVIEWING', 'SUB_IMPORTED'],
  HUMAN_REVIEWING: ['HUMAN_PASSED', 'HUMAN_REJECTED', 'AI_PASSED', 'SUB_IMPORTED'],
  HUMAN_REJECTED: ['SUB_IMPORTED', 'AI_PASSED', 'AI_REVIEWING'],
  HUMAN_PASSED: ['CHAPTER_DRAFT', 'SUB_IMPORTED'],
  CHAPTER_DRAFT: ['CHAPTER_REVIEWING', 'CHAPTER_LOCKED', 'SUB_IMPORTED'],
  CHAPTER_REVIEWING: ['CHAPTER_LOCKED', 'CHAPTER_DRAFT', 'SUB_IMPORTED'],
  CHAPTER_LOCKED: ['ENCODING', 'CHAPTER_DRAFT', 'SUB_IMPORTED'],
  ENCODING: ['ENCODED', 'ENCODE_FAILED', 'CHAPTER_LOCKED', 'SUB_IMPORTED'],
  ENCODE_FAILED: ['ENCODING', 'CHAPTER_LOCKED', 'SUB_IMPORTED'],
  ENCODED: ['CHAPTER_MERGED', 'CHAPTER_LOCKED', 'SUB_IMPORTED'],
  CHAPTER_MERGED: ['MP4_DONE', 'NAMED', 'ENCODED', 'SUB_IMPORTED'],
  MP4_DONE: ['NAMED', 'CHAPTER_MERGED', 'SUB_IMPORTED'],
  NAMED: ['DONE', 'CHAPTER_MERGED', 'SUB_IMPORTED'],
  DONE: ['CHAPTER_MERGED', 'SUB_IMPORTED'],
  BLOCKED: ['SUB_IMPORTED', 'AI_PASSED', 'CHAPTER_LOCKED', 'ENCODED', 'CHAPTER_MERGED']
}

export function canTransition(from: EpisodeState, to: EpisodeState): boolean {
  if (from === to) return true
  return TRANSITIONS[from]?.includes(to) ?? false
}

export type Tone = 'gray' | 'blue' | 'teal' | 'orange' | 'green' | 'deep-green' | 'red'

export interface StateMeta {
  label: string
  tone: Tone
  animate?: boolean
  /** 主流程阶段序号，用于进度展示；BLOCKED 为 -1 */
  step: number
}

export const STATE_META: Record<EpisodeState, StateMeta> = {
  INIT: { label: '未开始', tone: 'gray', step: 0 },
  TEMPLATE_READY: { label: '模板就绪', tone: 'blue', step: 1 },
  SUB_IMPORTED: { label: '待 AI 审阅', tone: 'teal', step: 2 },
  AI_REVIEWING: { label: 'AI 审阅中', tone: 'blue', animate: true, step: 3 },
  AI_REJECTED: { label: 'AI 有问题', tone: 'orange', step: 3 },
  AI_PASSED: { label: '待人工审阅', tone: 'teal', step: 4 },
  HUMAN_REVIEWING: { label: '人工审阅中', tone: 'teal', animate: true, step: 5 },
  HUMAN_REJECTED: { label: '已打回', tone: 'orange', step: 5 },
  HUMAN_PASSED: { label: '双审通过', tone: 'green', step: 6 },
  CHAPTER_DRAFT: { label: '章节待审', tone: 'teal', step: 7 },
  CHAPTER_REVIEWING: { label: '章节审阅中', tone: 'teal', animate: true, step: 7 },
  CHAPTER_LOCKED: { label: '章节已锁定', tone: 'green', step: 8 },
  ENCODING: { label: '压制中', tone: 'blue', animate: true, step: 9 },
  ENCODE_FAILED: { label: '压制失败', tone: 'red', step: 9 },
  ENCODED: { label: '成品已就绪', tone: 'green', step: 10 },
  CHAPTER_MERGED: { label: '章节已合并', tone: 'green', step: 11 },
  MP4_DONE: { label: '已转 MP4', tone: 'green', step: 12 },
  NAMED: { label: '已命名', tone: 'deep-green', step: 13 },
  DONE: { label: '已完成', tone: 'deep-green', step: 14 },
  BLOCKED: { label: '被上游变更阻断', tone: 'red', step: -1 }
}

export const SEVERITY_META: Record<
  Severity,
  { label: string; tone: Tone; color: string; order: number }
> = {
  blocker: { label: '阻断', tone: 'red', color: '#DC2626', order: 0 },
  major: { label: '重要', tone: 'orange', color: '#D97706', order: 1 },
  minor: { label: '建议', tone: 'orange', color: '#CA8A04', order: 2 },
  info: { label: '提示', tone: 'gray', color: '#64748B', order: 3 }
}

/** 主流程步骤（用于集卡片进度条） */
export const MAIN_FLOW: EpisodeState[] = [
  'INIT',
  'TEMPLATE_READY',
  'SUB_IMPORTED',
  'AI_PASSED',
  'HUMAN_PASSED',
  'CHAPTER_DRAFT',
  'CHAPTER_LOCKED',
  'ENCODING',
  'ENCODED',
  'CHAPTER_MERGED',
  'NAMED',
  'DONE'
]
