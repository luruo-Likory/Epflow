import type { AssEvent } from './ass-parser'
import type { ReviewScopeSettings } from './types'

export type AssEventKind = 'dialogue' | 'screen' | 'effect'

export const DEFAULT_REVIEW_SCOPE: ReviewScopeSettings = {
  effectStyleKeywords: ['特效', 'Effect', 'Title', 'Staff', 'Logo', 'OP', 'ED', 'Kara', 'Comment'],
  screenStyleKeywords: ['ScreenText', 'Screen', 'Sign', 'Caption', '屏字', '屏幕字', '字幕', 'Note'],
  excludeComments: true
}

const MERGE = (base: ReviewScopeSettings, patch?: Partial<ReviewScopeSettings> | null): ReviewScopeSettings => ({
  effectStyleKeywords: patch?.effectStyleKeywords ?? base.effectStyleKeywords,
  screenStyleKeywords: patch?.screenStyleKeywords ?? base.screenStyleKeywords,
  excludeComments: patch?.excludeComments ?? base.excludeComments
})

export function resolveScope(patch?: Partial<ReviewScopeSettings> | null): ReviewScopeSettings {
  return MERGE(DEFAULT_REVIEW_SCOPE, patch)
}

function matchesStyle(style: string, keywords: string[]): boolean {
  if (!style) return false
  const lower = style.toLowerCase()
  return keywords.some((k) => k.trim() && lower.includes(k.trim().toLowerCase()))
}

/** 带这些覆盖标签的行视为特效行：绘图、裁剪、淡入淡出、动画、卡拉OK、旋转/模糊 */
const EFFECT_TAG = /\\(p[1-9]|clip|iclip|fad|fade|t\(|k[fo]?\d|K\d|frz|frx|fry|blur|be\d)/i

export function hasEffectTags(text: string): boolean {
  return EFFECT_TAG.test(text)
}

/** 有定位/对齐覆盖时，两句重叠可以被解释为有意排版（不再提示上下排列） */
const POSITION_TAG = /\\(an\d|a\d|pos|move|org|q\d)/i

export function hasPositionOverride(text: string): boolean {
  return POSITION_TAG.test(text)
}

/**
 * 判断一行属于：对白 / 屏幕字 / 特效。
 * - Comment 与命中特效样式关键字、或带绘图/运动/淡入淡出/卡拉OK 标签 → 特效（不审）
 * - 命中屏幕字样式关键字 → 屏幕字（审）
 * - 其余 → 对白（审）
 */
export function classifyEvent(event: AssEvent, scope?: Partial<ReviewScopeSettings> | null): AssEventKind {
  const cfg = resolveScope(scope)
  if (event.isComment && cfg.excludeComments) return 'effect'
  if (matchesStyle(event.style, cfg.effectStyleKeywords)) return 'effect'
  if (hasEffectTags(event.text)) return 'effect'
  if (matchesStyle(event.style, cfg.screenStyleKeywords)) return 'screen'
  return 'dialogue'
}

export function filterReviewableEvents(
  events: AssEvent[],
  scope?: Partial<ReviewScopeSettings> | null
): AssEvent[] {
  return events.filter((e) => classifyEvent(e, scope) !== 'effect')
}

export interface LayoutFinding {
  first: AssEvent
  second: AssEvent
  overlapMs: number
  reason: string
}

/**
 * 同一时间出现两句：检查是否上下排列。
 * 判定规则：时间轴重叠 + 同一样式 + 都没有定位类覆盖标签 → 两句会叠在同一位置，提示合并或分行。
 */
export function findOverlapLayoutIssues(
  events: AssEvent[],
  scope?: Partial<ReviewScopeSettings> | null
): LayoutFinding[] {
  const cfg = resolveScope(scope)
  const candidates = filterReviewableEvents(events, cfg)
    .filter((e) => e.plain.trim().length > 0)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)

  const findings: LayoutFinding[] = []
  for (let i = 0; i < candidates.length; i += 1) {
    const a = candidates[i]!
    for (let j = i + 1; j < candidates.length; j += 1) {
      const b = candidates[j]!
      if (b.startMs >= a.endMs) break
      const overlapMs = Math.min(a.endMs, b.endMs) - b.startMs
      if (overlapMs < 200) continue
      if (a.style !== b.style) continue
      if (hasPositionOverride(a.text) || hasPositionOverride(b.text)) continue
      findings.push({
        first: a,
        second: b,
        overlapMs,
        reason: `第 ${a.index} 行与第 ${b.index} 行在 ${overlapMs}ms 内同时显示，且样式相同、无定位标签，会叠在同一位置`
      })
      break
    }
  }
  return findings
}
