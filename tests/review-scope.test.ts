import { describe, expect, it } from 'vitest'
import { parseAss } from '@shared/ass-parser'
import {
  classifyEvent,
  DEFAULT_REVIEW_SCOPE,
  filterReviewableEvents,
  findOverlapLayoutIssues,
  hasEffectTags,
  hasPositionOverride
} from '@shared/ass-classify'
import { formatEventRows, PROMPT_VERSION, buildPrompt } from '@main/services/review-prompt'

const HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1
Style: ScreenText,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,8,10,10,10,1
Style: 特效-01,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,8,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`

function docWith(eventLines: string[]): ReturnType<typeof parseAss> {
  return parseAss(`${HEADER}${eventLines.join('\n')}\n`)
}

describe('字幕行分类（对白 / 屏幕字 / 特效）', () => {
  it('普通样式是对白，ScreenText 是屏幕字，特效样式与绘图行是特效', () => {
    const doc = docWith([
      'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,普通对白',
      'Dialogue: 0,0:00:03.00,0:00:05.00,ScreenText,,0,0,0,,店铺招牌',
      'Dialogue: 0,0:00:05.00,0:00:07.00,特效-01,,0,0,0,,花字特效',
      'Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}',
      'Dialogue: 0,0:00:09.00,0:00:11.00,Default,,0,0,0,,{\\fad(200,200)}淡入淡出',
      'Comment: 0,0:00:11.00,0:00:13.00,Default,,0,0,0,,注释行'
    ])
    const kinds = doc.events.map((e) => classifyEvent(e, DEFAULT_REVIEW_SCOPE))
    expect(kinds).toEqual(['dialogue', 'screen', 'effect', 'effect', 'effect', 'effect'])
  })

  it('可自定义关键字：把某样式加入特效后会被过滤', () => {
    const doc = docWith([
      'Dialogue: 0,0:00:01.00,0:00:03.00,ScreenText,,0,0,0,,招牌',
      'Dialogue: 0,0:00:03.00,0:00:05.00,Default,,0,0,0,,对白'
    ])
    const scope = { ...DEFAULT_REVIEW_SCOPE, effectStyleKeywords: [...DEFAULT_REVIEW_SCOPE.effectStyleKeywords, 'ScreenText'] }
    const kept = filterReviewableEvents(doc.events, scope)
    expect(kept.map((e) => e.plain)).toEqual(['对白'])
  })

  it('识别绘图/动画/卡拉OK 等特效标签', () => {
    expect(hasEffectTags('{\\p1}m 0 0 l 1 1')).toBe(true)
    expect(hasEffectTags('{\\t(0,500,\\frz30)}文字')).toBe(true)
    expect(hasEffectTags('{\\k20}歌词')).toBe(true)
    expect(hasEffectTags('{\\an7\\pos(10,10)}文字')).toBe(false)
    expect(hasPositionOverride('{\\an7}文字')).toBe(true)
    expect(hasPositionOverride('{\\N}文字')).toBe(false)
  })
})

describe('同一时间两句的上下排列检查', () => {
  it('重叠 + 同样式 + 无定位 → 报 layout', () => {
    const doc = docWith([
      'Dialogue: 0,0:00:10.00,0:00:13.00,Default,,0,0,0,,第一句',
      'Dialogue: 0,0:00:12.00,0:00:15.00,Default,,0,0,0,,第二句'
    ])
    const findings = findOverlapLayoutIssues(doc.events, DEFAULT_REVIEW_SCOPE)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.first.index).toBe(1)
    expect(findings[0]?.second.index).toBe(2)
    expect(findings[0]?.reason).toContain('同时显示')
  })

  it('带 \\an / \\pos 定位时不报（视为有意排版）', () => {
    const doc = docWith([
      'Dialogue: 0,0:00:10.00,0:00:13.00,Default,,0,0,0,,上方字幕',
      'Dialogue: 0,0:00:12.00,0:00:15.00,Default,,0,0,0,,{\\an7}下方字幕'
    ])
    expect(findOverlapLayoutIssues(doc.events, DEFAULT_REVIEW_SCOPE)).toHaveLength(0)
  })

  it('不同样式重叠（如对白 + 屏幕字）不报', () => {
    const doc = docWith([
      'Dialogue: 0,0:00:10.00,0:00:13.00,Default,,0,0,0,,对白',
      'Dialogue: 0,0:00:12.00,0:00:15.00,ScreenText,,0,0,0,,招牌'
    ])
    expect(findOverlapLayoutIssues(doc.events, DEFAULT_REVIEW_SCOPE)).toHaveLength(0)
  })

  it('特效行不参与重叠检查', () => {
    const doc = docWith([
      'Dialogue: 0,0:00:10.00,0:00:13.00,Default,,0,0,0,,对白',
      'Dialogue: 0,0:00:12.00,0:00:15.00,特效-01,,0,0,0,,特效力'
    ])
    expect(findOverlapLayoutIssues(doc.events, DEFAULT_REVIEW_SCOPE)).toHaveLength(0)
  })
})

describe('审阅 prompt（v2）', () => {
  it('版本已升级，且只包含三类检查', () => {
    expect(PROMPT_VERSION).toBe('review-v2')
    const prompt = buildPrompt(
      { anime: '测试番', release: '01', localNo: '01', glossary: '', recap: '' },
      '1\t00:00:01.000 --> 00:00:03.000\t[对白]\t你好'
    )
    expect(prompt).toContain('错别字')
    expect(prompt).toContain('不通顺')
    expect(prompt).toContain('上下排列')
    expect(prompt).toContain('typo|grammar|layout')
    expect(prompt).toContain('不要报告')
    // 类别只允许三类；accuracy / term / punctuation 不应出现在 category 取值里
    expect(prompt).not.toContain('accuracy')
    expect(prompt).not.toContain('category: term')
    expect(prompt).not.toContain('punctuation')
  })

  it('表格带类型标注，且特效行不会出现在 prompt 中', () => {
    const doc = docWith([
      'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,普通对白',
      'Dialogue: 0,0:00:03.00,0:00:05.00,ScreenText,,0,0,0,,招牌文字',
      'Dialogue: 0,0:00:05.00,0:00:07.00,特效-01,,0,0,0,,特效专用文本'
    ])
    const reviewable = filterReviewableEvents(doc.events, DEFAULT_REVIEW_SCOPE)
    const kinds = new Map(reviewable.map((e) => [e.index, classifyEvent(e, DEFAULT_REVIEW_SCOPE)]))
    const rows = formatEventRows(reviewable, kinds)
    expect(rows).toContain('[对白]')
    expect(rows).toContain('[屏字]')
    expect(rows).toContain('普通对白')
    expect(rows).toContain('招牌文字')
    expect(rows).not.toContain('特效专用文本')
  })
})
