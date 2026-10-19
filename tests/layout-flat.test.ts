import { describe, expect, it, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultSettings } from '@shared/constants'
import type { AppSettings } from '@shared/types'
import {
  createProject,
  migrateToFlatLayout,
  previewProject,
  updateProjectMeta
} from '@main/services/project-service'
import { importSubtitle } from '@main/services/subtitle-service'
import { openStore } from '@main/store/repository'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'epflow-layout-'))
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
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,第一句
`

function baseInput(animeName: string, subDirName: string) {
  return {
    animeName,
    materialRoot: MATERIAL,
    releaseNameTemplate: '[{release}]',
    releaseEpisodeBase: 1,
    releaseEpisodeWidth: 2,
    episodeCount: 2,
    localStart: 1,
    workNameTemplate: '{anime} - {ep}',
    subDirName,
    outputMode: 'episode-output' as const
  }
}

afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('集目录扁平布局', () => {
  it('子目录名为空时，字幕直接落在集目录，不创建翻译用目录', async () => {
    const input = baseInput('Flat Show', '')
    const preview = previewProject(input)
    expect(preview.ok).toBe(true)

    const snapshot = createProject(input, { conflict: 'abort', operator: 'tester', settings })
    const root = snapshot.project.rootPath
    expect(snapshot.project.subDirName).toBe('')
    expect(snapshot.episodes[0]?.subDir).toBe(snapshot.episodes[0]?.dir)
    expect(fs.existsSync(path.join(root, '[翻译用]'))).toBe(false)

    const src = path.join(TMP, 'flat.ass')
    fs.writeFileSync(src, ASS, 'utf8')
    const ep = await importSubtitle(root, '01', src, settings)
    expect(ep.subDir).toBe(path.join(root, '01'))
    expect(ep.subtitle?.path).toBe(path.join(root, '01', 'Flat Show - 01.ass'))
    expect(fs.existsSync(ep.subtitle!.path)).toBe(true)
  })

  it('迁移：把字幕从 [翻译用]/01 移到 01，并清理空目录', async () => {
    const input = baseInput('Migrate Show', '[翻译用]')
    const snapshot = createProject(input, { conflict: 'abort', operator: 'tester', settings })
    const root = snapshot.project.rootPath
    const src = path.join(TMP, 'migrate.ass')
    fs.writeFileSync(src, ASS, 'utf8')
    const before = await importSubtitle(root, '01', src, settings)
    const oldPath = before.subtitle!.path
    expect(oldPath).toBe(path.join(root, '[翻译用]', '01', 'Migrate Show - 01.ass'))
    expect(fs.existsSync(oldPath)).toBe(true)

    const result = migrateToFlatLayout(root, 'tester')
    expect(result.moved.length).toBe(1)

    const store = openStore(root)
    const after = store.getEpisode('01')
    expect(store.project.subDirName).toBe('')
    expect(after.subDir).toBe(path.join(root, '01'))
    expect(after.subtitle?.path).toBe(path.join(root, '01', 'Migrate Show - 01.ass'))
    expect(fs.existsSync(after.subtitle!.path)).toBe(true)
    expect(fs.existsSync(oldPath)).toBe(false)
    expect(fs.existsSync(path.join(root, '[翻译用]'))).toBe(false)
    // 字幕哈希不变，审阅记录仍然有效
    expect(after.subtitle?.sha256).toBe(before.subtitle?.sha256)
  })

  it('改项目子目录名会同步移动已有字幕文件', async () => {
    const input = baseInput('Move Show', '')
    const snapshot = createProject(input, { conflict: 'abort', operator: 'tester', settings })
    const root = snapshot.project.rootPath
    const src = path.join(TMP, 'move.ass')
    fs.writeFileSync(src, ASS, 'utf8')
    const before = await importSubtitle(root, '01', src, settings)
    expect(before.subDir).toBe(path.join(root, '01'))

    updateProjectMeta(root, { subDirName: '[翻译用]' }, 'tester')
    const store = openStore(root)
    const after = store.getEpisode('01')
    expect(store.project.subDirName).toBe('[翻译用]')
    expect(after.subDir).toBe(path.join(root, '[翻译用]', '01'))
    expect(after.subtitle?.path).toBe(path.join(root, '[翻译用]', '01', 'Move Show - 01.ass'))
    expect(fs.existsSync(after.subtitle!.path)).toBe(true)

    // 再切回扁平布局
    updateProjectMeta(root, { subDirName: '' }, 'tester')
    const back = openStore(root).getEpisode('01')
    expect(back.subDir).toBe(path.join(root, '01'))
    expect(fs.existsSync(path.join(root, '01', 'Move Show - 01.ass'))).toBe(true)
  })
})
