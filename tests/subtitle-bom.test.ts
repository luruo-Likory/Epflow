import { describe, expect, it, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultSettings } from '@shared/constants'
import type { AppSettings } from '@shared/types'
import { createProject } from '@main/services/project-service'
import { ensureUtf8BomForEncode, importSubtitle, readSubtitleText } from '@main/services/subtitle-service'
import { openStore } from '@main/store/repository'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'epflow-bom-'))
const MATERIAL = path.join(TMP, 'media')
fs.mkdirSync(MATERIAL, { recursive: true })

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
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,中文对白
`

function hasBom(file: string): boolean {
  const buf = fs.readFileSync(file)
  return buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
}

afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('字幕 UTF-8 BOM（VSFilter 兼容）', () => {
  it('导入后字幕带 BOM，读取文本不带 BOM', async () => {
    const snapshot = createProject(
      {
        animeName: 'Bom Show',
        materialRoot: MATERIAL,
        releaseNameTemplate: '[{release}]',
        releaseEpisodeBase: 1,
        releaseEpisodeWidth: 2,
        episodeCount: 1,
        localStart: 1,
        workNameTemplate: '{anime} - {ep}',
        subDirName: '',
        outputMode: 'episode-output'
      },
      { conflict: 'abort', operator: 'tester', settings }
    )
    const root = snapshot.project.rootPath
    const src = path.join(TMP, 'no-bom.ass')
    fs.writeFileSync(src, ASS, 'utf8')

    const ep = await importSubtitle(root, '01', src, settings)
    expect(ep.subtitle?.encoding).toBe('utf-8-bom')
    expect(hasBom(ep.subtitle!.path)).toBe(true)
    expect(readSubtitleText(root, '01')?.startsWith('[Script Info]')).toBe(true)
  })

  it('压制前给无 BOM 字幕补 BOM，并同步哈希与人工审阅哈希', async () => {
    const snapshot = createProject(
      {
        animeName: 'Bom Fix Show',
        materialRoot: MATERIAL,
        releaseNameTemplate: '[{release}]',
        releaseEpisodeBase: 1,
        releaseEpisodeWidth: 2,
        episodeCount: 1,
        localStart: 1,
        workNameTemplate: '{anime} - {ep}',
        subDirName: '',
        outputMode: 'episode-output'
      },
      { conflict: 'abort', operator: 'tester', settings }
    )
    const root = snapshot.project.rootPath
    const src = path.join(TMP, 'fix.ass')
    fs.writeFileSync(src, ASS, 'utf8')
    const ep = await importSubtitle(root, '01', src, settings)
    const file = ep.subtitle!.path

    // 模拟旧版本导入/外部编辑造成的「无 BOM」文件
    fs.writeFileSync(file, ASS, 'utf8')
    expect(hasBom(file)).toBe(false)

    const store = openStore(root)
    const before = store.getEpisode('01')
    store.updateEpisode('01', {
      subtitle: { ...before.subtitle!, sha256: 'stale' },
      human: {
        at: new Date().toISOString(),
        by: 'tester',
        subtitleHash: 'stale',
        aiRunId: before.aiRunId ?? '',
        note: '',
        checklist: []
      }
    })

    const result = await ensureUtf8BomForEncode(root, '01', 'tester')
    expect(result.fixed).toBe(true)
    expect(hasBom(file)).toBe(true)

    const after = openStore(root).getEpisode('01')
    expect(after.subtitle?.encoding).toBe('utf-8-bom')
    expect(after.subtitle?.sha256).toBe(result.hash)
    expect(after.human?.subtitleHash).toBe(result.hash)

    // 已是 BOM 时重复调用不再改动
    const again = await ensureUtf8BomForEncode(root, '01', 'tester')
    expect(again.fixed).toBe(false)
  })
})
