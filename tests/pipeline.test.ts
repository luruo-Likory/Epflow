import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultSettings } from '@shared/constants'
import type { AppSettings } from '@shared/types'
import { createProject } from '@main/services/project-service'
import { importSubtitle } from '@main/services/subtitle-service'
import { submitReviewJson } from '@main/services/review-service'
import { passHumanReview } from '@main/services/human-service'
import { generateChapterDraft, lockChapters } from '@main/services/chapter-service'
import { acceptOutput, findOutputCandidates } from '@main/services/encode-service'
import { mergeChapters } from '@main/services/mux-service'
import { decideTranscode } from '@main/services/transcode-service'
import { markDone, previewFinalName, renameToRelease } from '@main/services/naming-service'
import { openStore } from '@main/store/repository'
import { resolveTool } from '@main/integrations/tools'
import { probeChapters, probeMedia } from '@main/integrations/ffprobe'
import { runProcess } from '@main/integrations/process-runner'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'epflow-pipe-'))
const MATERIAL = path.join(TMP, 'media')

const ffmpeg = resolveTool('ffmpeg')
const ffprobe = resolveTool('ffprobe')
const mkvpropedit = resolveTool('mkvpropedit')
const ready = ffmpeg.exists && ffprobe.exists && mkvpropedit.exists

const settings: AppSettings = {
  ...defaultSettings(),
  operator: 'tester',
  encode: { ...defaultSettings().encode, minSizeMb: 0 }
}

const ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,第一句
Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,第二句
`

describe.skipIf(!ready)('压制后处理流水线（真实 ffmpeg + MKVToolNix）', () => {
  it('成品识别 → 章节合并 → MP4 转封装 → 发布名重命名 → 完成', async () => {
    fs.mkdirSync(MATERIAL, { recursive: true })
    const snapshot = createProject(
      {
        animeName: 'Pipeline Test',
        materialRoot: MATERIAL,
        releaseNameTemplate: '[测试组] 流水线验证 [{release}][简体][1080p]',
        releaseEpisodeBase: 7,
        releaseEpisodeWidth: 2,
        episodeCount: 1,
        localStart: 1,
        workNameTemplate: '{anime} - {ep}',
        subDirName: '[翻译用]',
        outputMode: 'episode-output'
      },
      { conflict: 'abort', operator: 'tester', settings }
    )
    const root = snapshot.project.rootPath
    const ep = snapshot.episodes[0]!

    // 字幕 + 审阅 + 人工
    const assPath = path.join(TMP, 'src.ass')
    fs.writeFileSync(assPath, ASS, 'utf8')
    await importSubtitle(root, '01', assPath, settings)
    await submitReviewJson(
      root,
      '01',
      JSON.stringify({ schema_version: '1.0', verdict: 'pass', summary: 'ok', issues: [] }),
      settings,
      'tester'
    )
    openStore(root).transition('01', 'HUMAN_REVIEWING', 'test', null, 'tester')
    await passHumanReview(
      root,
      '01',
      ['已通读全片字幕', '已核对时间轴与对白同步', '已检查样式、字体、特效标签', '已确认 AI 问题均已处理或豁免'],
      '',
      settings
    )
    await generateChapterDraft(root, '01', settings)
    await lockChapters(root, '01', ['章节切点与剧情段落一致', '标题/编号无误', '已确认首章从 0 开始'], settings)

    // 用 ffmpeg 造一个 20s 的测试成品，放进 OKEGui 风格的输出目录
    const outDir = path.join(root, '01', 'output', 'ABCDEF12-01')
    fs.mkdirSync(outDir, { recursive: true })
    const mkvPath = path.join(outDir, 'Pipeline.Test.S01E07.mkv')
    const made = await runProcess(
      ffmpeg.path,
      [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=320x240:r=10:d=20',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=44100:cl=mono',
        '-shortest',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '32k',
        mkvPath
      ],
      { timeoutMs: 180_000 }
    )
    expect(made.code, made.stderr.slice(-400)).toBe(0)
    expect(fs.existsSync(mkvPath)).toBe(true)

    // 识别
    const candidates = await findOutputCandidates(ep, Date.now() - 60_000, { minSizeMb: 0 })
    expect(candidates.some((c) => c.path === mkvPath)).toBe(true)

    openStore(root).transition('01', 'ENCODING', 'test', null, 'tester')
    const encoded = await acceptOutput(root, '01', mkvPath, settings)
    expect(encoded.state).toBe('ENCODED')
    expect(encoded.encode?.probe?.durationMs).toBeGreaterThan(15_000)

    // 合并章节
    const merged = await mergeChapters(root, '01', settings)
    expect(merged.state).toBe('CHAPTER_MERGED')
    expect(merged.merge?.tool).toBe('mkvpropedit')
    const chapters = await probeChapters(mkvPath, ffprobe.path)
    expect(chapters.count).toBe(merged.merge?.chapterCount)
    expect(chapters.firstStartMs).toBe(0)
    expect(chapters.entries[0]?.title).toBeTruthy()

    // 转 MP4
    const mp4 = await decideTranscode(root, '01', 'mp4', settings)
    expect(mp4.state).toBe('MP4_DONE')
    expect(mp4.transcode?.ok).toBe(true)
    expect(fs.existsSync(mp4.transcode!.to)).toBe(true)
    const mp4Probe = await probeMedia(mp4.transcode!.to, ffprobe.path)
    const mkvProbe = await probeMedia(mkvPath, ffprobe.path)
    expect(Math.abs((mp4Probe?.durationMs ?? 0) - (mkvProbe?.durationMs ?? 0))).toBeLessThanOrEqual(1000)
    expect(mp4Probe?.chapterCount).toBe(chapters.count)

    // 命名：最终文件落在该集 output\（默认策略），而不是 OKEGui 的子目录
    const preview = previewFinalName(root, '01', settings)
    expect(preview.name).toBe('[测试组] 流水线验证 [07][简体][1080p].mp4')
    const named = await renameToRelease(root, '01', settings)
    expect(named.state).toBe('NAMED')
    expect(named.final?.path).toBe(path.join(root, '01', 'output', preview.name))
    expect(fs.existsSync(named.final!.path)).toBe(true)

    // 完成
    const done = markDone(root, '01', 'tester')
    expect(done.state).toBe('DONE')

    const audit = openStore(root).readAudit().map((a) => a.action)
    expect(audit).toContain('encode.detected')
    expect(audit).toContain('mux.done')
    expect(audit).toContain('transcode.done')
    expect(audit).toContain('naming.done')
    expect(audit).toContain('episode.done')
  })
})

it('工具探测能定位本机 MKVToolNix', () => {
  const probe = resolveTool('mkvpropedit')
  if (!ready) {
    expect(probe.exists).toBe(false)
    return
  }
  expect(probe.exists).toBe(true)
  expect(probe.path.toLowerCase()).toContain('mkvpropedit.exe')
})
