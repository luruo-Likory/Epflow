import { describe, expect, it } from 'vitest'
import {
  buildChapters,
  chaptersToXml,
  validateChapters,
  type ChapterConfig,
  type ChapterInputEvent
} from '../src/shared/chapter-builder'
import type { Chapter } from '../src/shared/types'

const MAX_UINT64 = 18446744073709551615n

function cfg(overrides: Partial<ChapterConfig> = {}): ChapterConfig {
  return {
    gapThresholdMs: 2000,
    minChapterLenMs: 90000,
    maxChapterLenMs: 480000,
    maxChapters: 10,
    minChapters: 3,
    detectOpEd: true,
    firstChapterAtZero: true,
    ...overrides
  }
}

function event(startSec: number, endSec: number, text = '台词'): ChapterInputEvent {
  return { startMs: startSec * 1000, endMs: endSec * 1000, text, isComment: false }
}

function comment(startSec: number, endSec: number): ChapterInputEvent {
  return { startMs: startSec * 1000, endMs: endSec * 1000, text: '注释', isComment: true }
}

/** 生成 count 段对白，每段 lenSec 秒，段间空 gapSec 秒 */
function chunks(count: number, lenSec = 100, gapSec = 2, offsetSec = 0): ChapterInputEvent[] {
  return Array.from({ length: count }, (_, index) => {
    const start = offsetSec + index * (lenSec + gapSec)
    return event(start, start + lenSec, `第 ${index + 1} 句`)
  })
}

describe('buildChapters', () => {
  it('空事件生成唯一的 0 起点章节', () => {
    const result = buildChapters([], 600000, cfg())

    expect(result).toHaveLength(1)
    expect(result[0]?.startMs).toBe(0)
    expect(result[0]?.title).toBe('Chapter 01')
    expect(result[0]?.source).toBe('auto')
    expect(result[0]?.uid).toMatch(/^\d+$/)
  })

  it('过滤 Comment 与纯空白文本，不产生额外章节', () => {
    const events: ChapterInputEvent[] = [
      comment(0, 100),
      { startMs: 102000, endMs: 200000, text: '   ', isComment: false },
      { startMs: 202000, endMs: 300000, text: '\n\t', isComment: false }
    ]

    const result = buildChapters(events, 400000, cfg())

    expect(result).toHaveLength(1)
    expect(result[0]?.startMs).toBe(0)
  })

  it('正常 3 段以上对白生成 3–10 个升序章节', () => {
    const result = buildChapters(chunks(4, 100, 2), 500000, cfg())

    expect(result.length).toBeGreaterThanOrEqual(3)
    expect(result.length).toBeLessThanOrEqual(10)
    expect(result[0]?.startMs).toBe(0)
    for (let i = 1; i < result.length; i += 1) {
      expect(result[i]!.startMs).toBeGreaterThan(result[i - 1]!.startMs)
    }
  })

  it('大 gap 处生成切点，章节从空档开始', () => {
    const events = [event(0, 100), event(102, 200), event(500, 600)]

    const result = buildChapters(events, 700000, cfg())
    const starts = result.map((chapter) => chapter.startMs)

    expect(starts).toContain(200000)
    expect(starts.some((start) => start >= 200000 && start <= 500000)).toBe(true)
  })

  it('切点不会落在任何对白的中间', () => {
    // A 与 B 重叠；A 的结束点 100s 落在 B 内部，不能作为切点
    const events = [event(0, 100), event(50, 200), event(300, 400)]

    const result = buildChapters(events, 500000, cfg())

    expect(result.some((chapter) => chapter.startMs === 100000)).toBe(false)
    for (const chapter of result) {
      for (const dialogue of events) {
        const strictlyInside =
          chapter.startMs > dialogue.startMs && chapter.startMs < dialogue.endMs
        expect(strictlyInside).toBe(false)
      }
    }
  })

  it('候选切点过多时截断到 maxChapters', () => {
    const events = chunks(12, 100, 3)
    const result = buildChapters(
      events,
      1500000,
      cfg({ maxChapters: 4, maxChapterLenMs: 2000000, detectOpEd: false })
    )

    expect(result).toHaveLength(4)
    expect(result[0]?.startMs).toBe(0)
    expect(result.map((chapter) => chapter.startMs)).toEqual([0, 100000, 203000, 306000])
  })

  it('候选过少时降低 gap 阈值重试并达标', () => {
    // 段间 gap 均为 1000ms：2000/1500 都不够，1000 才能产生切点
    const events = [
      { startMs: 0, endMs: 100000, text: '一', isComment: false },
      { startMs: 101000, endMs: 201000, text: '二', isComment: false },
      { startMs: 202000, endMs: 302000, text: '三', isComment: false }
    ]

    const result = buildChapters(events, 400000, cfg({ gapThresholdMs: 2000, minChapters: 3 }))

    expect(result).toHaveLength(3)
    expect(result.map((chapter) => chapter.startMs)).toEqual([0, 100000, 201000])
  })

  it('超长段在最大 gap 处补切，章节长度不超过 maxChapterLenMs', () => {
    // 400 句短对白，句间 gap 仅 1s（低于阈值），只能靠超长段补切
    const events = Array.from({ length: 400 }, (_, index) => event(index * 3, index * 3 + 2))

    const result = buildChapters(events, 1200000, cfg({ detectOpEd: false }))

    expect(result.length).toBeGreaterThan(1)
    for (let i = 1; i < result.length; i += 1) {
      expect(result[i]!.startMs - result[i - 1]!.startMs).toBeLessThanOrEqual(480000)
    }
  })

  it('识别 OP 与 ED 并设置对应来源', () => {
    const result = buildChapters(chunks(8, 100, 2), 900000, cfg({ detectOpEd: true }))

    const op = result.find((chapter) => chapter.startMs === 100000)
    const ed = result.find((chapter) => chapter.startMs === 712000)

    expect(op?.title).toBe('OP')
    expect(op?.source).toBe('op')
    expect(ed?.title).toBe('ED')
    expect(ed?.source).toBe('ed')
    expect(result.filter((chapter) => chapter.source === 'op')).toHaveLength(1)
    expect(result.filter((chapter) => chapter.source === 'ed')).toHaveLength(1)
  })

  it('firstChapterAtZero 开关控制首章起点', () => {
    const events: ChapterInputEvent[] = [
      { startMs: 12345.6, endMs: 150000, text: '开场', isComment: false },
      { startMs: 152000, endMs: 252000, text: '后续', isComment: false }
    ]

    const atZero = buildChapters(events, 300000, cfg({ firstChapterAtZero: true }))
    const fromFirstDialogue = buildChapters(events, 300000, cfg({ firstChapterAtZero: false }))

    expect(atZero[0]?.startMs).toBe(0)
    expect(fromFirstDialogue[0]?.startMs).toBe(12346)
  })

  it('每章 UID 唯一且是 64 位无符号十进制字符串', () => {
    const result = buildChapters(chunks(15, 100, 2), 1600000, cfg({ maxChapters: 10 }))
    const uids = result.map((chapter) => chapter.uid)

    expect(new Set(uids).size).toBe(uids.length)
    for (const uid of uids) {
      expect(uid).toMatch(/^\d+$/)
      expect(BigInt(uid)).toBeGreaterThan(0n)
      expect(BigInt(uid)).toBeLessThanOrEqual(MAX_UINT64)
    }
  })
})

describe('chaptersToXml', () => {
  it('输出合法的 Matroska 章节 XML 与 9 位纳秒时间', () => {
    const chapters = buildChapters(chunks(4, 100, 2), 500000, cfg({ detectOpEd: false }))
    const xml = chaptersToXml(chapters, { editionUid: '1234567890123456789', language: 'zh-Hans' })

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true)
    expect(xml).toContain('<Chapters>\n  <EditionEntry>\n')
    expect(xml).toContain('<EditionUID>1234567890123456789</EditionUID>')
    expect(xml).toContain('    <ChapterAtom>\n      <ChapterTimeStart>')
    expect(xml).toMatch(/<ChapterTimeStart>\d{2}:\d{2}:\d{2}\.\d{9}<\/ChapterTimeStart>/)
    expect(xml).toContain('<ChapterLanguage>zh-Hans</ChapterLanguage>')
    expect(xml).toContain('<ChapLanguageIETF>zh-Hans</ChapLanguageIETF>')
    expect((xml.match(/<ChapterAtom>/g) ?? []).length).toBe(chapters.length)
    for (const chapter of chapters) {
      expect(xml).toContain(`<ChapterUID>${chapter.uid}</ChapterUID>`)
      expect(xml).toContain(`<ChapterString>${chapter.title}</ChapterString>`)
    }
    expect(xml.endsWith('  </EditionEntry>\n</Chapters>\n')).toBe(true)
  })

  it('未提供 EditionUID 时生成 64 位十进制随机值', () => {
    const chapters: Chapter[] = [
      { startMs: 0, title: 'Chapter 01', source: 'auto', uid: '1' }
    ]

    const xml = chaptersToXml(chapters)
    const edition = /<EditionUID>(\d+)<\/EditionUID>/.exec(xml)

    expect(edition).not.toBeNull()
    const value = edition?.[1] ?? ''
    expect(value).toMatch(/^\d+$/)
    expect(BigInt(value)).toBeGreaterThan(0n)
    expect(BigInt(value)).toBeLessThanOrEqual(MAX_UINT64)
    expect(xml).toContain('<ChapterLanguage>und</ChapterLanguage>')
  })

  it('标题与语言中的 XML 特殊字符被正确转义', () => {
    const chapters: Chapter[] = [
      { startMs: 0, title: 'A & B <C>', source: 'auto', uid: '1' },
      { startMs: 600000, title: 'Tom & "Jerry" <\'x\'>', source: 'auto', uid: '2' }
    ]

    const xml = chaptersToXml(chapters, { editionUid: '99', language: 'en & <x>' })

    expect(xml).toContain('<ChapterString>A &amp; B &lt;C&gt;</ChapterString>')
    expect(xml).toContain(
      '<ChapterString>Tom &amp; &quot;Jerry&quot; &lt;&apos;x&apos;&gt;</ChapterString>'
    )
    expect(xml).toContain('<ChapterLanguage>en &amp; &lt;x&gt;</ChapterLanguage>')
    expect(xml).toContain('<ChapLanguageIETF>en &amp; &lt;x&gt;</ChapLanguageIETF>')
    expect(xml).not.toContain('<ChapterString>A & B <C></ChapterString>')
  })
})

describe('validateChapters', () => {
  it('合法章节返回空错误数组', () => {
    const chapters: Chapter[] = [
      { startMs: 0, title: 'Chapter 01', source: 'auto', uid: '1' },
      { startMs: 600000, title: 'Chapter 02', source: 'auto', uid: '2' }
    ]

    expect(validateChapters(chapters, 1200000)).toEqual([])
  })

  it('拦截空列表、负数起点、非递增时间与过小间隔', () => {
    expect(validateChapters([]).some((error) => error.includes('至少需要 1 个章节'))).toBe(true)

    const negative: Chapter[] = [
      { startMs: -1000, title: 'Chapter 01', source: 'auto', uid: '1' }
    ]
    expect(validateChapters(negative).some((error) => error.includes('不得早于 0'))).toBe(true)

    const notIncreasing: Chapter[] = [
      { startMs: 0, title: 'Chapter 01', source: 'auto', uid: '1' },
      { startMs: 0, title: 'Chapter 02', source: 'auto', uid: '2' }
    ]
    expect(validateChapters(notIncreasing).some((error) => error.includes('严格递增'))).toBe(true)

    const tooClose: Chapter[] = [
      { startMs: 0, title: 'Chapter 01', source: 'auto', uid: '1' },
      { startMs: 1000, title: 'Chapter 02', source: 'auto', uid: '2' }
    ]
    expect(validateChapters(tooClose).some((error) => error.includes('间隔不足'))).toBe(true)
  })

  it('拦截超出时长、重复 UID 与空 UID', () => {
    const overDuration: Chapter[] = [
      { startMs: 0, title: 'Chapter 01', source: 'auto', uid: '1' },
      { startMs: 200000, title: 'Chapter 02', source: 'auto', uid: '2' }
    ]
    expect(
      validateChapters(overDuration, 100000).some((error) => error.includes('超出时长上限'))
    ).toBe(true)

    const duplicateUid: Chapter[] = [
      { startMs: 0, title: 'Chapter 01', source: 'auto', uid: 'same' },
      { startMs: 600000, title: 'Chapter 02', source: 'auto', uid: 'same' }
    ]
    expect(validateChapters(duplicateUid).some((error) => error.includes('UID 重复'))).toBe(true)

    const emptyUid: Chapter[] = [
      { startMs: 0, title: 'Chapter 01', source: 'auto', uid: '  ' },
      { startMs: 600000, title: 'Chapter 02', source: 'auto', uid: '2' }
    ]
    expect(validateChapters(emptyUid).some((error) => error.includes('UID 不能为空'))).toBe(true)
  })
})
