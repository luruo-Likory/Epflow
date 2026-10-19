import { describe, expect, it, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultSettings } from '@shared/constants'
import type { AppSettings } from '@shared/types'
import { createProject } from '@main/services/project-service'
import { findOutputCandidates } from '@main/services/encode-service'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'epflow-cand-'))
const MATERIAL = path.join(TMP, 'media')
fs.mkdirSync(MATERIAL, { recursive: true })

const settings: AppSettings = { ...defaultSettings(), operator: 'tester' }

afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('成品识别排除 OKEGui 临时目录', () => {
  it('不把 D_\\ 下的半成品与 .mkv_ 中间文件当成品', async () => {
    const snapshot = createProject(
      {
        animeName: 'Candidate Show',
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
    const ep = snapshot.episodes[0]!
    const started = Date.now() - 60_000

    const tempDir = path.join(ep.dir, 'D_', '367E88CC-01')
    fs.mkdirSync(tempDir, { recursive: true })
    fs.writeFileSync(path.join(tempDir, 'Candidate Show - 01.mkv_.mkv'), Buffer.alloc(2048))

    const outDir = path.join(ep.dir, 'output', '367E88CC-01')
    fs.mkdirSync(outDir, { recursive: true })
    const good = path.join(outDir, 'Candidate Show - 01.mkv')
    fs.writeFileSync(good, Buffer.alloc(4096))

    const candidates = await findOutputCandidates(ep, started, { minSizeMb: 0 })
    expect(candidates.map((c) => c.path)).toEqual([good])

    // 即使把 D_ 当成扫描根（旧逻辑），也应被过滤
    const viaRecursive = await findOutputCandidates(ep, started, { minSizeMb: 0, checkStability: false })
    expect(viaRecursive.some((c) => c.path.includes(`${path.sep}D_${path.sep}`))).toBe(false)
    expect(viaRecursive.some((c) => c.path.endsWith('.mkv_.mkv'))).toBe(false)
  })
})
