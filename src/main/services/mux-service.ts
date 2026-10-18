import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, EpisodeRecord, MergeInfo } from '@shared/types'
import { nowIso } from '@shared/time'
import { openStore } from '../store/repository'
import { existsLong, toLongPath } from '../util/paths'
import { sha256File } from '../util/hash'
import { scoped } from '../util/logger'
import { requireGate } from './gate-service'
import { resolveTool } from '../integrations/tools'
import { runProcess } from '../integrations/process-runner'
import { probeChapters } from '../integrations/ffprobe'
import { broadcast } from '../ipc/events'

const log = scoped('mux')

function parseChapterCountFromXml(xml: string): number {
  return (xml.match(/<ChapterAtom>/g) ?? []).length
}

export async function mergeChapters(
  rootPath: string,
  localNo: string,
  settings: AppSettings
): Promise<EpisodeRecord> {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  await requireGate(rootPath, localNo, 'merge', settings)

  const output = ep.encode?.outputPath
  const xml = ep.chapters?.path
  if (!output || !existsLong(output)) throw new Error('成品不存在')
  if (!xml || !existsLong(xml)) throw new Error('章节 XML 不存在')

  const xmlText = fs.readFileSync(toLongPath(xml), 'utf8')
  const expected = parseChapterCountFromXml(xmlText)
  const xmlHash = await sha256File(xml)
  if (ep.chapters && ep.chapters.sha256 !== xmlHash) {
    throw new Error('章节 XML 与锁定记录不一致（可能被外部修改），请重新审阅章节')
  }

  const backup = `${output}.before-chapters.mkv`
  let backupCreated = false
  if (settings.encode.keepBackup) {
    fs.copyFileSync(toLongPath(output), toLongPath(backup))
    backupCreated = true
  }

  const mkvpropedit = resolveTool('mkvpropedit')
  const mkvmerge = resolveTool('mkvmerge')
  let tool: MergeInfo['tool'] = 'mkvpropedit'
  let logText = ''

  const verify = async (): Promise<{ ok: boolean; detail: string; count: number; firstStart: number | null }> => {
    const ffprobe = resolveTool('ffprobe')
    if (!ffprobe.exists) return { ok: true, detail: 'ffprobe 不可用，跳过校验', count: expected, firstStart: null }
    const probe = await probeChapters(output, ffprobe.path)
    const firstStart = probe.firstStartMs
    const titlesOk = probe.entries.every((e) => Boolean(e.title))
    const ok = probe.count === expected && firstStart === 0 && titlesOk
    return {
      ok,
      detail: `章节数 ${probe.count}/${expected}，首章 ${firstStart ?? 'null'}ms，标题完整：${titlesOk}`,
      count: probe.count,
      firstStart
    }
  }

  const runMerge = async (): Promise<void> => {
    if (mkvpropedit.exists) {
      tool = 'mkvpropedit'
      const res = await runProcess(mkvpropedit.path, [output, '--chapters', xml], { timeoutMs: 300_000 })
      logText = `mkvpropedit exit=${res.code}\n${res.stdout}\n${res.stderr}`.trim()
      if (res.code === 0) return
    }
    if (!mkvmerge.exists) {
      throw new Error(`章节合并失败，且未找到 mkvmerge 作为回退。日志：${logText.slice(0, 400)}`)
    }
    tool = 'mkvmerge'
    const temp = `${output}.merging.mkv`
    const res = await runProcess(
      mkvmerge.path,
      ['-o', temp, '--chapters', xml, output],
      { timeoutMs: 600_000 }
    )
    logText += `\nmkvmerge exit=${res.code}\n${res.stdout}\n${res.stderr}`
    if (res.code !== 0) throw new Error(`mkvmerge 合并失败（exit ${res.code}）`)
    fs.copyFileSync(toLongPath(temp), toLongPath(output))
    try {
      fs.unlinkSync(toLongPath(temp))
    } catch {
      /* ignore */
    }
  }

  try {
    await runMerge()
    const result = await verify()
    if (!result.ok) {
      throw new Error(`合并后校验未通过：${result.detail}`)
    }
    const merge: MergeInfo = {
      at: nowIso(),
      tool,
      xmlHash,
      chapterCount: result.count,
      firstChapterStartMs: result.firstStart ?? 0,
      backupPath: backupCreated ? backup : null,
      log: logText.slice(0, 20_000)
    }
    store.updateEpisode(localNo, { merge })
    store.transition(localNo, 'CHAPTER_MERGED', 'mux.done', { tool, count: result.count }, settings.operator)
    store.writeSnapshots()
    broadcast('encode:progress', { localNo, phase: 'merged', message: '章节已合并' })
    log.info('chapters merged', { localNo, tool, count: result.count })
    return store.getEpisode(localNo)
  } catch (err) {
    // 恢复备份
    if (backupCreated && existsLong(backup)) {
      try {
        fs.copyFileSync(toLongPath(backup), toLongPath(output))
      } catch {
        /* ignore */
      }
    }
    store.appendAudit(
      'mux.failed',
      { message: (err as Error).message, tool, log: logText.slice(0, 4000) },
      ep.id,
      settings.operator
    )
    throw err
  }
}

export async function restoreBackup(rootPath: string, localNo: string): Promise<void> {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  const output = ep.encode?.outputPath
  if (!output) throw new Error('成品不存在')
  const backup = `${output}.before-chapters.mkv`
  if (!existsLong(backup)) throw new Error('没有合并前备份')
  fs.copyFileSync(toLongPath(backup), toLongPath(output))
}
