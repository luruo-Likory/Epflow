import { describe, expect, it } from 'vitest'

import {
  applyReleaseTemplate,
  chooseDefaultCandidate,
  computeReleaseNo,
  findReleaseCandidates,
  formatRelease,
  renderReleaseName,
  toReleaseTemplate
} from '@shared/release-name'
import {
  buildWorkName,
  createVariableMap,
  expandVariables,
  type TemplateInput
} from '@shared/template-vars'
import { dialogueEvents, parseAss, replaceInAss, validateAssStructure } from '@shared/ass-parser'
import {
  isReservedName,
  sanitizeFileName,
  validateAnimeName
} from '@shared/filename'
import { formatChapterTime, formatTimecode, parseAssTime } from '@shared/time'
import { diffLines } from '@shared/diff'

const RELEASE_SAMPLE =
  '[云光字幕组] 动物狂想曲 最终季 Part.2 BEASTARS Final Season [13][简体双语][1080p]招募翻译'

describe('release-name', () => {
  it('默认候选为方括号中的 13，并能生成发布名模板', () => {
    const candidate = chooseDefaultCandidate(findReleaseCandidates(RELEASE_SAMPLE))
    expect(candidate).not.toBeNull()
    expect(candidate!.digits).toBe('13')
    expect(candidate!.value).toBe(13)
    expect(candidate!.pattern).toBe('bracket')
    expect(applyReleaseTemplate(RELEASE_SAMPLE, candidate!)).toBe(
      '[云光字幕组] 动物狂想曲 最终季 Part.2 BEASTARS Final Season [{release}][简体双语][1080p]招募翻译'
    )
  })

  it('不误选 1080p、5.1、Part.2、x264 与年份 2026', () => {
    expect(findReleaseCandidates(RELEASE_SAMPLE).map((c) => c.digits)).toEqual(['13'])
    // 纯噪声文本不应产生任何候选
    expect(findReleaseCandidates('1080p 5.1 Part.2 x264 2026')).toEqual([])
  })

  it('dash 模式识别 Title - 01 中的 01', () => {
    const candidate = chooseDefaultCandidate(findReleaseCandidates('Title - 01'))
    expect(candidate).not.toBeNull()
    expect(candidate!.digits).toBe('01')
    expect(candidate!.pattern).toBe('dash')
  })

  it('cn 模式识别 第13集 中的 13', () => {
    const candidate = chooseDefaultCandidate(findReleaseCandidates('某某番 第13集'))
    expect(candidate).not.toBeNull()
    expect(candidate!.digits).toBe('13')
    expect(candidate!.pattern).toBe('cn')
  })

  it('en 模式识别 Show.S03E13.1080p 中的 13 而不是季号', () => {
    const candidate = chooseDefaultCandidate(findReleaseCandidates('Show.S03E13.1080p'))
    expect(candidate).not.toBeNull()
    expect(candidate!.digits).toBe('13')
    expect(candidate!.pattern).toBe('en')
  })

  it('已有 {release} 的模板再次转换保持不变', () => {
    const template = '[组] 番 [{release}].mp4'
    expect(toReleaseTemplate(template)).toBe(template)
  })

  it('formatRelease 按宽度补零', () => {
    expect(formatRelease(1, 2)).toBe('01')
    expect(formatRelease(13, 3)).toBe('013')
  })

  it('renderReleaseName 正确替换发布集数位', () => {
    expect(renderReleaseName('[组] 番 [{release}].mp4', '07')).toBe('[组] 番 [07].mp4')
  })

  it('computeReleaseNo 按本地集号偏移计算发布集数', () => {
    expect(computeReleaseNo(13, 1, 1)).toBe(13)
    expect(computeReleaseNo(13, 3, 1)).toBe(15)
  })
})

const baseInput: TemplateInput = {
  anime: '动物狂想曲',
  localNo: '01',
  localInt: 1,
  releaseNo: '13',
  releaseInt: 13,
  releaseRaw: '13',
  root: 'D:\\Anime',
  project: 'D:\\Anime\\BEASTARS',
  epDir: 'D:\\Anime\\BEASTARS\\01',
  subDir: 'D:\\Anime\\BEASTARS\\01\\sub',
  output: 'D:\\Anime\\BEASTARS\\13.mkv',
  ext: 'mkv',
  workNameTemplate: '{anime} - {ep}'
}

describe('template-vars', () => {
  it('createVariableMap 正确生成主机路径变量', () => {
    const vars = createVariableMap(baseInput)
    expect(vars.ep_dir).toBe('D:\\Anime\\BEASTARS\\01')
    expect(vars.sub_dir).toBe('D:\\Anime\\BEASTARS\\01\\sub')
    expect(vars.output).toBe('D:\\Anime\\BEASTARS\\13.mkv')
    expect(vars.root).toBe('D:\\Anime')
    expect(vars.project).toBe('D:\\Anime\\BEASTARS')
    expect(vars.ext).toBe('mkv')
  })

  it('{work} 按 workNameTemplate 与 epSource 生成', () => {
    expect(createVariableMap({ ...baseInput, epSource: 'release' }).work).toBe('动物狂想曲 - 13')
    expect(createVariableMap({ ...baseInput, epSource: 'local' }).work).toBe('动物狂想曲 - 01')
  })

  it('expandVariables 单次扫描，值中的 {anime} 不会被二次展开', () => {
    const result = expandVariables('{release}/{anime}', {
      release: '{anime}',
      anime: '动物狂想曲'
    })
    expect(result.text).toBe('{anime}/动物狂想曲')
    expect(result.unknown).toEqual([])
  })

  it('未知变量原样保留并出现在 unknown 中', () => {
    const result = expandVariables('{anime}/{unknown_var}', { anime: '动物狂想曲' })
    expect(result.text).toBe('动物狂想曲/{unknown_var}')
    expect(result.unknown).toEqual(['unknown_var'])
  })

  it('buildWorkName 在 epSource 为 local 时使用本地集号', () => {
    expect(
      buildWorkName({ ...baseInput, workNameTemplate: '{anime} - {ep}', epSource: 'local' })
    ).toBe('动物狂想曲 - 01')
  })
})

const ASS_TEXT = [
  '[Script Info]',
  'Title: 解析测试',
  'ScriptType: v4.00+',
  'PlayResX: 1920',
  'PlayResY: 1080',
  'WrapStyle: 2',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,思源黑体,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1',
  'Style: Title,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,1,8,20,20,20,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:01.00,0:00:03.50,Default,小明,0,0,0,,你好, 世界, 再见',
  'Dialogue: 1,0:00:04.00,0:00:06.35,Title,,0,0,0,,{\\i1}第二行\\N换行{\\i0}',
  'Comment: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,这是注释'
].join('\n')

describe('ass-parser', () => {
  it('解析 Script Info、Styles 与 Events', () => {
    const doc = parseAss(ASS_TEXT)
    expect(doc.events).toHaveLength(3)
    expect(doc.events.map((e) => e.index)).toEqual([1, 2, 3])
    expect(dialogueEvents(doc)).toHaveLength(2)
    expect(doc.events[2]?.type).toBe('comment')
    expect(doc.events[2]?.isComment).toBe(true)

    expect(doc.events[0]?.startMs).toBe(1000)
    expect(doc.events[0]?.endMs).toBe(3500)
    expect(doc.events[1]?.startMs).toBe(4000)
    expect(doc.events[1]?.endMs).toBe(6350)

    expect(doc.events[1]?.plain).toBe('第二行\n换行')
    expect(doc.events[0]?.plain).toBe('你好, 世界, 再见')

    expect(doc.styleNames).toEqual(['Default', 'Title'])
    expect(doc.events[1]?.style).toBe('Title')
    expect(doc.styles[0]?.fontname).toBe('思源黑体')
    expect(doc.styles[0]?.fontsize).toBe(48)

    expect(doc.playResX).toBe(1920)
    expect(doc.playResY).toBe(1080)
    expect(doc.wrapStyle).toBe(2)
  })

  it('文本中含逗号时不被截断', () => {
    const doc = parseAss(ASS_TEXT)
    expect(doc.events[0]?.text).toBe('你好, 世界, 再见')
  })

  it('replaceInAss 只替换对白文本并返回替换次数', () => {
    const source = [
      '[Script Info]',
      'Title: 替换测试',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: Default,替换体,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,这是替换测试'
    ].join('\n')

    const result = replaceInAss(source, '替换', '已更换')
    expect(result.count).toBe(1)
    expect(result.text).toContain('这是已更换测试')
    // 样式行中的命中不应被替换
    const styleLine = result.text.split('\n').find((line) => line.startsWith('Style:'))
    expect(styleLine).toContain('替换体')
    expect(styleLine).not.toContain('已更换体')
  })

  it('validateAssStructure 报出未配对花括号、未知样式与空文本', () => {
    const source = [
      '[Script Info]',
      'PlayResX: 1920',
      'PlayResY: 1080',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1花括号未闭合',
      'Dialogue: 0,0:00:03.00,0:00:04.00,Missing,,0,0,0,,样式不存在',
      'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\i1}'
    ].join('\n')

    const issues = validateAssStructure(parseAss(source))
    const kinds = issues.map((issue) => issue.kind)
    expect(kinds).toContain('unbalanced-brace')
    expect(kinds).toContain('unknown-style')
    expect(kinds).toContain('empty-text')
  })
})

describe('filename', () => {
  it('sanitizeFileName 处理 Windows 非法字符', () => {
    expect(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j')
  })

  it('sanitizeFileName 处理尾随空格与点、保留名', () => {
    expect(sanitizeFileName('  番名.  ')).toBe('番名')
    expect(sanitizeFileName('CON')).toBe('CON_')
    expect(sanitizeFileName('con.txt')).toBe('con.txt_')
    expect(isReservedName('con.txt')).toBe(true)
  })

  it('validateAnimeName 校验空、非法字符、超长与尾随点', () => {
    expect(validateAnimeName('')).toBe('番名不能为空')
    expect(validateAnimeName('   ')).toBe('番名不能为空')
    const illegalMessage = '番名不能包含 < > : " / \\ | ? * 等字符'
    expect(validateAnimeName('a:b')).toBe(illegalMessage)
    // 连续调用仍应识别非法字符（全局正则不应残留 lastIndex）
    expect(validateAnimeName('c:d')).toBe(illegalMessage)
    expect(validateAnimeName('番'.repeat(81))).toBe('番名长度不能超过 80 个字符')
    expect(validateAnimeName('番名.')).toBe('番名不能以空格或点结尾')
    expect(validateAnimeName('正常番名')).toBeNull()
  })
})

describe('time', () => {
  it('formatTimecode 与 formatChapterTime 输出正确的时码', () => {
    expect(formatTimecode(395220)).toBe('00:06:35.220')
    expect(formatChapterTime(242000)).toBe('00:04:02.000000000')
  })

  it('parseAssTime 把 ASS 时间码换算为毫秒', () => {
    expect(parseAssTime('0:00:06.35')).toBe(6350)
  })
})

describe('diff', () => {
  it('相同文本返回全 same', () => {
    const result = diffLines('a\nb\nc', 'a\nb\nc')
    expect(result).toHaveLength(3)
    expect(result.every((line) => line.kind === 'same')).toBe(true)
    expect(result.map((line) => line.leftNo)).toEqual([1, 2, 3])
    expect(result.map((line) => line.rightNo)).toEqual([1, 2, 3])
  })

  it('新增一行时返回 add', () => {
    const result = diffLines('a\nb', 'a\nb\nc')
    expect(result.map((line) => line.kind)).toEqual(['same', 'same', 'add'])
    expect(result[2]?.right).toBe('c')
    expect(result[2]?.rightNo).toBe(3)
  })

  it('删除一行时返回 del', () => {
    const result = diffLines('a\nb\nc', 'a\nb')
    expect(result.map((line) => line.kind)).toEqual(['same', 'same', 'del'])
    expect(result[2]?.left).toBe('c')
    expect(result[2]?.leftNo).toBe(3)
  })
})
