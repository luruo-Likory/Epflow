import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultSettings } from '@shared/constants'
import type { AppSettings } from '@shared/types'
import { createProject } from '@main/services/project-service'
import { analyzeTemplate, instantiateTemplates, previewTemplate, saveTemplateFiles } from '@main/services/template-service'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'epflow-tpl-reg-'))

const JSON_TEMPLATE = `{
  "Version": 3,
  "VSVersion": "2025H1.1p",
  "ProjectName": "Even.the.Student.Council.Has.Its.Holes.S01E01",
  "EncoderType": "x264",
  "EncoderParam": "--crf 20 --qcomp 0.7 --aq-strength 0.9 --psy-rd 1.0 --pbratio 1.3",
  "ContainerFormat": "mkv",
  "AudioTracks": [{ "OutputCodec": "aac" }],
  "InputScript": "Even.the.Student.Council.Has.Its.Holes.S01E01.vpy",
  "InputFiles": [
    "D:\\\\media\\\\origin material\\\\Seitokai ni mo Ana wa Aru\\\\01\\\\Even.the.Student.Council.Has.Its.Holes.S01E01.mkv"
  ],
  "Fps": 23.976,
  "Rpc": false
}
`

const VPY_TEMPLATE = `import vapoursynth as vs
from vapoursynth import core
import mvsfunc as mvf

# OKE:INPUTFILE
a = "Even.the.Student.Council.Has.Its.Holes.S01E01.mkv"
src8 = core.lsmas.LWLibavSource(a)
src16 = core.fmtc.bitdepth(src8, bits=16)
nr8 = mvf.Depth(src16, depth=8)
nrmask = core.tcanny.TCanny(nr8, sigma=0.8, op=2, planes=[0,1,2])
debd = core.f3kdb.Deband(src16, range=12)
debd = mvf.LimitFilter(debd, src16, thr=0.5, thrc=0.8, elast=1.5)
res = core.vsfm.TextSubMod(debd, "D:/media/origin material/Seitokai ni mo Ana wa Aru/01/Even.the.Student.Council.Has.Its.Holes.S01E01.ass")
res = mvf.Depth(res, 8).set_output()
`

describe('模板替换安全（回归：相对 vpy 输入导致 "." 被替换成路径）', () => {
  it('相对输入不应产生 "." / 纯数字替换，且不破坏函数调用与参数小数', async () => {
    const material = path.join(TMP, 'media')
    fs.mkdirSync(material, { recursive: true })
    const settings: AppSettings = { ...defaultSettings(), operator: 'tester' }
    const snapshot = createProject(
      {
        animeName: 'Seitokai Test',
        materialRoot: material,
        releaseNameTemplate: '[测试组] 学生会 [{release}][简体双语]',
        releaseEpisodeBase: 1,
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

    const jsonPath = path.join(TMP, 'Template.S01E01.json')
    const vpyPath = path.join(TMP, 'Template.S01E01.vpy')
    fs.writeFileSync(jsonPath, JSON_TEMPLATE, 'utf8')
    fs.writeFileSync(vpyPath, VPY_TEMPLATE, 'utf8')
    saveTemplateFiles(root, [jsonPath, vpyPath])

    const analysis = analyzeTemplate(root)
    expect(analysis.substitutions.length).toBeGreaterThan(0)
    for (const sub of analysis.substitutions) {
      expect(sub.from.trim()).not.toBe('.')
      expect(sub.from.trim()).not.toBe('..')
      expect(sub.from).not.toMatch(/^\d+$/)
      expect(sub.from.length).toBeGreaterThanOrEqual(3)
    }

    const preview = previewTemplate(root, '01', analysis.substitutions, settings)
    expect(preview.errors).toHaveLength(0)
    expect(preview.json?.after).not.toContain('coreD:')
    expect(preview.vpy?.after).toContain('core.lsmas.LWLibavSource')
    expect(preview.vpy?.after).toContain('sigma=0.8')

    const result = await instantiateTemplates(root, settings, { onExists: 'backup', validateVpy: false })
    expect(result.rows[0]?.jsonOk).toBe(true)
    expect(result.rows[0]?.vpyOk).toBe(true)

    const ep = result.snapshot.episodes[0]!
    const vpy = fs.readFileSync(ep.templateVpy!, 'utf8')
    expect(vpy).toContain('core.lsmas.LWLibavSource')
    expect(vpy).toContain('core.fmtc.bitdepth')
    expect(vpy).toContain('sigma=0.8')
    expect(vpy).toContain('thr=0.5')
    expect(vpy).not.toMatch(/coreD:|mvfD:|vsD:/)
    expect(vpy).toContain('Seitokai Test - 01.mkv')
    expect(vpy).toContain('[翻译用]')
    // 绝对路径必须写成 raw string，避免 \0 / \t / \n 被 Python 当成转义
    expect(vpy).toMatch(/a = R"[A-Za-z]:\\/)
    expect(vpy).toMatch(/TextSubMod\([^\n]*R"[A-Za-z]:\\/)
    expect(vpy).not.toMatch(/= "[A-Za-z]:\\/)

    const json = JSON.parse(fs.readFileSync(ep.templateJson!, 'utf8')) as {
      VSVersion: string
      ProjectName: string
      InputScript: string
      InputFiles: string[]
      EncoderParam: string
    }
    expect(json.VSVersion).toBe('2025H1.1p')
    expect(json.EncoderParam).toContain('--qcomp 0.7')
    expect(json.EncoderParam).toContain('--psy-rd 1.0')
    expect(json.ProjectName).toBe('Seitokai Test - 01')
    expect(json.InputScript).toBe('Seitokai Test - 01.vpy')
    expect(json.InputFiles[0]).toBe(path.join(ep.dir, 'Seitokai Test - 01.mkv'))
  })
})
