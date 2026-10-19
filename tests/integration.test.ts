import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultSettings } from '@shared/constants'
import type { AppSettings } from '@shared/types'
import { createProject, previewProject } from '@main/services/project-service'
import { importSubtitle } from '@main/services/subtitle-service'
import { submitReviewJson, setIssueStatus, buildPromptForEpisode, forcePassReview } from '@main/services/review-service'
import { passHumanReview } from '@main/services/human-service'
import { generateChapterDraft, lockChapters, readChapters } from '@main/services/chapter-service'
import { checkGate } from '@main/services/gate-service'
import { previewFinalName } from '@main/services/naming-service'
import { openStore } from '@main/store/repository'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'epflow-it-'))
const MATERIAL = path.join(TMP, 'media')

const settings: AppSettings = { ...defaultSettings(), operator: 'tester' }

const ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,第一句对白
Dialogue: 0,0:01:40.00,0:01:42.00,Default,,0,0,0,,第二句对白
Dialogue: 0,0:03:20.00,0:03:22.00,Default,,0,0,0,,第三句对白
Dialogue: 0,0:03:22.00,0:03:23.00,Default,,0,0,0,,第四句
`

function makeEpisodeDir(): void {
  fs.mkdirSync(MATERIAL, { recursive: true })
}

beforeEach(() => {
  makeEpisodeDir()
})

afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('端到端主流程（不依赖外部工具）', () => {
  it('初始化 → 导入字幕 → AI 审阅 → 人工通过 → 章节锁定 → 命名预览', async () => {
    const input = {
      animeName: 'BEASTARS S03',
      materialRoot: MATERIAL,
      releaseNameTemplate: '[字幕组] 示例动画 [{release}][简体双语][1080p]招募翻译',
      releaseEpisodeBase: 13,
      releaseEpisodeWidth: 2,
      episodeCount: 3,
      localStart: 1,
      workNameTemplate: '{anime} - {ep}',
      subDirName: '[翻译用]',
      outputMode: 'episode-output' as const
    }

    const preview = previewProject(input)
    expect(preview.ok).toBe(true)
    expect(preview.episodes.map((e) => e.releaseNo)).toEqual(['13', '14', '15'])
    expect(preview.episodes[0]?.workName).toBe('BEASTARS S03 - 13')

    const snapshot = createProject(input, { conflict: 'abort', operator: 'tester', settings })
    const root = snapshot.project.rootPath
    expect(fs.existsSync(path.join(root, '01'))).toBe(true)
    expect(fs.existsSync(path.join(root, '[翻译用]', '01'))).toBe(true)
    expect(fs.existsSync(path.join(root, '01', 'output'))).toBe(true)
    expect(snapshot.episodes[0]?.state).toBe('INIT')

    // 导入字幕
    const assPath = path.join(TMP, 'source.ass')
    fs.writeFileSync(assPath, ASS, 'utf8')
    const imported = await importSubtitle(root, '01', assPath, settings)
    expect(imported.state).toBe('SUB_IMPORTED')
    expect(imported.subtitle?.lineCount).toBe(4)
    expect(imported.subtitle?.path).toBe(path.join(root, '[翻译用]', '01', 'BEASTARS S03 - 13.ass'))
    expect(fs.existsSync(imported.subtitle!.path)).toBe(true)

    // prompt 生成
    const prompt = buildPromptForEpisode(root, '01', settings)
    expect(prompt.prompt).toContain('BEASTARS S03')
    expect(prompt.prompt).toContain('第一句对白')
    expect(prompt.chunks).toBeGreaterThanOrEqual(1)

    // AI 结果（只有 minor，判定通过）
    const aiJson = JSON.stringify({
      schema_version: '1.0',
      verdict: 'pass',
      summary: '仅建议级问题',
      issues: [
        {
          severity: 'minor',
          category: 'punctuation',
          line: 1,
          start_ms: 0,
          end_ms: 2000,
          original: '第一句对白',
          suggestion: '第一句对白。',
          reason: '缺句号',
          confidence: 0.7
        }
      ]
    })
    const outcome = await submitReviewJson(root, '01', aiJson, settings, 'tester')
    expect(outcome.run.verdict).toBe('pass')
    expect(outcome.episode.state).toBe('AI_PASSED')
    expect(outcome.issues.some((i) => i.source === 'ai')).toBe(true)

    // minor 忽略必须填理由
    const minor = outcome.issues.find((i) => i.severity === 'minor')
    expect(minor).toBeTruthy()
    expect(() => setIssueStatus(root, minor!.id, 'ignored', '', 'tester')).toThrow()
    const updated = setIssueStatus(root, minor!.id, 'ignored', '风格问题，可接受', 'tester')
    expect(updated.status).toBe('ignored')

    // 人工审阅
    const store = openStore(root)
    store.transition('01', 'HUMAN_REVIEWING', 'test.start', null, 'tester')
    const human = await passHumanReview(
      root,
      '01',
      ['已通读全片字幕', '已核对时间轴与对白同步', '已检查样式、字体、特效标签', '已确认 AI 问题均已处理或豁免'],
      '通读无问题',
      settings
    )
    expect(human.state).toBe('HUMAN_PASSED')
    expect(human.human?.subtitleHash).toBe(human.subtitle?.sha256)

    // 章节
    const draft = await generateChapterDraft(root, '01', settings)
    expect(draft.chapters.length).toBeGreaterThanOrEqual(1)
    expect(draft.chapters[0]?.startMs).toBe(0)
    expect(draft.xml).toContain('<ChapterAtom>')
    expect(draft.xml).toContain('00:00:00.000000000')

    const locked = await lockChapters(
      root,
      '01',
      ['章节切点与剧情段落一致', '标题/编号无误', '已确认首章从 0 开始'],
      settings
    )
    expect(locked.state).toBe('CHAPTER_LOCKED')
    expect(locked.chapters?.chapterCount).toBe(draft.chapters.length)
    expect(fs.existsSync(locked.chapters!.path)).toBe(true)

    const view = readChapters(root, '01', settings)
    expect(view.locked).toBe(true)

    // 门禁：缺模板与成品，压制必须被阻断
    const gate = await checkGate(root, '01', 'encode', settings)
    expect(gate.ok).toBe(false)
    expect(gate.blockers.map((b) => b.code)).toContain('NO_TEMPLATE_JSON')

    // 命名预览
    const naming = previewFinalName(root, '01', settings)
    expect(naming.name).toBe('[字幕组] 示例动画 [13][简体双语][1080p]招募翻译.mkv')

    // 审计记录完整
    const audit = openStore(root).readAudit()
    const actions = audit.map((a) => a.action)
    expect(actions).toContain('project.create')
    expect(actions).toContain('subtitle.import')
    expect(actions).toContain('review.finish')
    expect(actions).toContain('human.pass')
    expect(actions).toContain('chapter.lock')
  })

  it('字幕变更会级联失效人工通过记录', async () => {
    const root = path.join(MATERIAL, 'BEASTARS S03')
    const target = path.join(root, '[翻译用]', '01', 'BEASTARS S03 - 13.ass')
    const original = fs.readFileSync(target, 'utf8')
    fs.writeFileSync(target, original.replace('第四句', '第四句（改动）'), 'utf8')

    const { checkSubtitleIntegrity } = await import('@main/services/subtitle-service')
    const changed = await checkSubtitleIntegrity(root, '01', 'tester')
    expect(changed).toBe(true)
    const ep = openStore(root).getEpisode('01')
    expect(ep.state).toBe('SUB_IMPORTED')
    expect(ep.human).toBeNull()
    expect(ep.chapters).toBeNull()
    expect(ep.staleReasons.length).toBeGreaterThan(0)
  })
})

describe('模板替换（用真实 OKEGui 模板验证）', () => {
  // 用环境变量指向本机真实模板目录；未设置时整组测试自动跳过
  const REAL_ROOT = process.env.EPFLOW_TEST_MATERIAL ?? ''
  const REAL_JSON = REAL_ROOT ? path.join(REAL_ROOT, 'BEASTARS S03', '01', 'BEASTARS.S03E13.json') : ''
  const REAL_VPY = REAL_ROOT ? path.join(REAL_ROOT, 'BEASTARS S03', '01', 'BEASTARS.S03E13.vpy') : ''
  const available = Boolean(REAL_ROOT) && fs.existsSync(REAL_JSON) && fs.existsSync(REAL_VPY)

  it.skipIf(!available)('实例化后 JSON/VPY 全部指向新工作名与集目录', async () => {
    const { saveTemplateFiles, analyzeTemplate, previewTemplate, instantiateTemplates } = await import(
      '@main/services/template-service'
    )
    const material = path.join(TMP, 'tmpl-media')
    fs.mkdirSync(material, { recursive: true })
    const root = path.join(material, 'BEASTARS S03')
    const snapshot = createProject(
      {
        animeName: 'BEASTARS S03',
        materialRoot: material,
        releaseNameTemplate: '[字幕组] 示例动画 [{release}][简体双语][1080p]招募翻译',
        releaseEpisodeBase: 13,
        releaseEpisodeWidth: 2,
        episodeCount: 2,
        localStart: 1,
        workNameTemplate: '{anime} - {ep}',
        subDirName: '[翻译用]',
        outputMode: 'episode-output'
      },
      { conflict: 'abort', operator: 'tester', settings }
    )
    expect(snapshot.episodes.length).toBe(2)

    // 放到临时目录再上传，避免修改用户原始文件
    const jsonCopy = path.join(TMP, 'BEASTARS.S03E13.json')
    const vpyCopy = path.join(TMP, 'BEASTARS.S03E13.vpy')
    fs.copyFileSync(REAL_JSON, jsonCopy)
    fs.copyFileSync(REAL_VPY, vpyCopy)

    saveTemplateFiles(root, [jsonCopy, vpyCopy])
    const analysis = analyzeTemplate(root)
    expect(analysis.bundle.jsonText).toBeTruthy()
    expect(analysis.bundle.vpyText).toBeTruthy()
    expect(analysis.substitutions.length).toBeGreaterThan(0)
    expect(analysis.bundle.info?.oldAnime).toBe('BEASTARS S03')

    const preview = previewTemplate(root, '01', analysis.substitutions, settings)
    expect(preview.errors).toHaveLength(0)
    expect(preview.json?.after).toContain('BEASTARS S03 - 13')
    expect(preview.json?.after).not.toContain('BEASTARS.S03E13')

    const result = await instantiateTemplates(root, settings, { onExists: 'backup', validateVpy: false })
    expect(result.rows).toHaveLength(2)
    expect(result.rows.every((r) => r.jsonOk && r.vpyOk)).toBe(true)

    const ep = result.snapshot.episodes.find((e) => e.localNo === '01')!
    expect(ep.state).toBe('TEMPLATE_READY')
    const json = JSON.parse(fs.readFileSync(ep.templateJson!, 'utf8')) as {
      ProjectName: string
      InputScript: string
      InputFiles: string[]
    }
    expect(json.ProjectName).toBe('BEASTARS S03 - 13')
    expect(json.InputScript).toBe('BEASTARS S03 - 13.vpy')
    expect(json.InputFiles[0]?.toLowerCase()).toContain(path.join('01', 'BEASTARS S03 - 13.mkv').toLowerCase())

    const vpy = fs.readFileSync(ep.templateVpy!, 'utf8')
    expect(vpy).toContain('# OKE:INPUTFILE')
    expect(vpy).toContain('BEASTARS S03 - 13.mkv')
    expect(vpy).toContain('BEASTARS S03 - 13.ass')
    expect(vpy).toContain('[翻译用]')

    const ep2 = result.snapshot.episodes.find((e) => e.localNo === '02')!
    const json2 = JSON.parse(fs.readFileSync(ep2.templateJson!, 'utf8')) as { ProjectName: string; InputFiles: string[] }
    expect(json2.ProjectName).toBe('BEASTARS S03 - 14')
    expect(json2.InputFiles[0]?.toLowerCase()).toContain(path.join('02', 'BEASTARS S03 - 14.mkv').toLowerCase())
  })
})

describe('存量工程扫描', () => {
  it('能识别集目录与猜测发布基准集数', async () => {
    const { scanMaterialRoot } = await import('@main/services/project-service')
    const material = path.join(TMP, 'scan-media')
    const project = path.join(material, 'Sparks of Tomorrow')
    fs.mkdirSync(path.join(project, '01'), { recursive: true })
    fs.mkdirSync(path.join(project, '02'), { recursive: true })
    fs.writeFileSync(path.join(project, '01', 'Sparks.of.Tomorrow.S01E13.json'), '{}', 'utf8')
    fs.writeFileSync(path.join(project, '01', 'Sparks.of.Tomorrow.S01E13.vpy'), '# vpy', 'utf8')

    const rows = scanMaterialRoot(material)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.animeName).toBe('Sparks of Tomorrow')
    expect(rows[0]?.episodeDirs).toEqual(['01', '02'])
    expect(rows[0]?.guessedReleaseBase).toBe(13)
    expect(rows[0]?.hasState).toBe(false)
  })
})

describe('审阅视频选择', () => {
  it('可为本集设置/清除审阅视频，并拒绝非视频文件', async () => {
    const { setReviewVideo } = await import('@main/services/project-service')
    const root = path.join(MATERIAL, 'BEASTARS S03')
    const video = path.join(TMP, 'sample-video.mkv')
    fs.writeFileSync(video, 'not a real video', 'utf8')

    const set = setReviewVideo(root, '01', video, 'tester')
    expect(set.reviewVideo?.path).toBe(video)
    expect(set.reviewVideo?.source).toBe('manual')

    const cleared = setReviewVideo(root, '01', null, 'tester')
    expect(cleared.reviewVideo).toBeNull()

    const bad = path.join(TMP, 'notes.txt')
    fs.writeFileSync(bad, 'x', 'utf8')
    expect(() => setReviewVideo(root, '01', bad, 'tester')).toThrow(/不支持的视频格式/)
    expect(() => setReviewVideo(root, '01', path.join(TMP, 'missing.mkv'), 'tester')).toThrow(/不存在/)

    const audit = openStore(root).readAudit().map((a) => a.action)
    expect(audit).toContain('episode.video')
  })
})

describe('问题处理后的 AI 状态流转', () => {
  const FLOW_ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,第一句
Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,第二句
Dialogue: 0,0:00:09.00,0:00:11.00,Default,,0,0,0,,第三句
`

  it('全部修复后自动进入待人工审阅；重新打开问题会回退；强制通过不再报非法迁移', async () => {
    const material = path.join(TMP, 'flow-media')
    fs.mkdirSync(material, { recursive: true })
    const flowSettings: AppSettings = { ...defaultSettings(), operator: 'tester', allowForcePass: true }
    const snap = createProject(
      {
        animeName: 'Flow Repro',
        materialRoot: material,
        releaseNameTemplate: '[测试组] 流程验证 [{release}]',
        releaseEpisodeBase: 1,
        releaseEpisodeWidth: 2,
        episodeCount: 1,
        localStart: 1,
        workNameTemplate: '{anime} - {ep}',
        subDirName: '[翻译用]',
        outputMode: 'episode-output'
      },
      { conflict: 'abort', operator: 'tester', settings: flowSettings }
    )
    const root = snap.project.rootPath
    const assPath = path.join(TMP, 'flow.ass')
    fs.writeFileSync(assPath, FLOW_ASS, 'utf8')
    await importSubtitle(root, '01', assPath, flowSettings)

    const aiJson = JSON.stringify({
      schema_version: '1.0',
      verdict: 'fail',
      summary: '存在重要问题',
      issues: [
        {
          severity: 'major',
          category: 'typo',
          line: 1,
          original: '第一句',
          suggestion: '修改错别字',
          reason: '错别字',
          confidence: 0.9
        }
      ]
    })
    const outcome = await submitReviewJson(root, '01', aiJson, flowSettings, 'tester')
    expect(outcome.episode.state).toBe('AI_REJECTED')

    const major = outcome.issues.find((i) => i.severity === 'major')!
    setIssueStatus(root, major.id, 'fixed', '', 'tester')
    let ep = openStore(root).getEpisode('01')
    expect(ep.state).toBe('AI_PASSED')
    expect(ep.aiVerdict).toBe('pass')

    const gate = await checkGate(root, '01', 'open-human-review', flowSettings)
    expect(gate.ok).toBe(true)

    // 重新打开问题 → 回退
    setIssueStatus(root, major.id, 'open', '', 'tester')
    ep = openStore(root).getEpisode('01')
    expect(ep.state).toBe('AI_REJECTED')

    // 强制通过（允许豁免）→ 合法迁移
    const forced = forcePassReview(root, '01', '测试豁免：已知问题可接受', flowSettings, 'tester')
    expect(forced.state).toBe('AI_PASSED')
    expect(forced.aiVerdict).toBe('pass')
  })
})
