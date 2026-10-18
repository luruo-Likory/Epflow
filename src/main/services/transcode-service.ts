import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, EpisodeRecord, MediaProbe, TranscodeInfo } from '@shared/types'
import { nowIso } from '@shared/time'
import { openStore } from '../store/repository'
import { existsLong, toLongPath } from '../util/paths'
import { scoped } from '../util/logger'
import { requireGate } from './gate-service'
import { resolveTool } from '../integrations/tools'
import { runProcess } from '../integrations/process-runner'
import { probeMedia } from '../integrations/ffprobe'
import { broadcast } from '../ipc/events'

const log = scoped('transcode')

export type TranscodeChoice = 'mp4' | 'keep'

export function outputDirOf(rootPath: string, localNo: string): string {
  const store = openStore(rootPath)
  const project = store.project
  const ep = store.getEpisode(localNo)
  return project.outputMode === 'project-release'
    ? path.join(project.rootPath, 'release')
    : path.join(ep.dir, 'output')
}

function ffmpegArgs(input: string, output: string, subtitleMode: 'mov_text' | 'drop'): string[] {
  const args = ['-hide_banner', '-nostdin', '-y', '-i', input, '-map', '0', '-c', 'copy']
  if (subtitleMode === 'mov_text') {
    args.push('-c:s', 'mov_text')
  } else {
    args.push('-sn')
  }
  args.push('-map_metadata', '0', '-map_chapters', '0', '-f', 'mp4', output)
  return args
}

export async function decideTranscode(
  rootPath: string,
  localNo: string,
  choice: TranscodeChoice,
  settings: AppSettings
): Promise<EpisodeRecord> {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  await requireGate(rootPath, localNo, 'transcode', settings)

  if (choice === 'keep') {
    store.updateEpisode(localNo, { transcode: null })
    store.appendAudit('transcode.keep-mkv', null, ep.id, settings.operator)
    return store.getEpisode(localNo)
  }

  const input = ep.encode?.outputPath
  if (!input || !existsLong(input)) throw new Error('成品不存在')
  const ffmpeg = resolveTool('ffmpeg')
  if (!ffmpeg.exists) throw new Error('未找到 ffmpeg，请在设置中指定路径')

  const ffprobe = resolveTool('ffprobe')
  const before: MediaProbe | null = ffprobe.exists ? await probeMedia(input, ffprobe.path) : null

  const dir = outputDirOf(rootPath, localNo)
  fs.mkdirSync(toLongPath(dir), { recursive: true })
  const finalTarget = path.join(dir, `${ep.workName}.mp4`)
  const temp = `${finalTarget}.tmp`

  broadcast('encode:progress', { localNo, phase: 'transcoding', message: '正在无损转封装为 MP4…' })

  const run = async (mode: 'mov_text' | 'drop') => {
    const res = await runProcess(ffmpeg.path, ffmpegArgs(input, temp, mode), {
      timeoutMs: 30 * 60_000,
      onStderr: (chunk) => {
        const line = chunk.split(/\r?\n/).filter(Boolean).slice(-1)[0]
        if (line) broadcast('encode:progress', { localNo, phase: 'transcoding', message: line.slice(0, 200) })
      }
    })
    return res
  }

  let lastLog = ''
  let ok = false
  let usedMode = settings.mp4.subtitleMode
  try {
    let res = await run(settings.mp4.subtitleMode)
    lastLog = `${res.stdout}\n${res.stderr}`
    if (res.code !== 0 && settings.mp4.subtitleMode === 'mov_text') {
      // 字幕轨不兼容时退化为丢弃字幕
      broadcast('encode:progress', {
        localNo,
        phase: 'transcoding',
        message: '字幕转 mov_text 失败，正在尝试丢弃字幕…'
      })
      res = await run('drop')
      lastLog += `\n[retry drop]\n${res.stdout}\n${res.stderr}`
      usedMode = 'drop'
    }
    ok = res.code === 0 && existsLong(temp) && (fs.statSync(toLongPath(temp)).size > 0)
  } catch (err) {
    lastLog += `\n${(err as Error).message}`
  }

  if (!ok) {
    try {
      if (existsLong(temp)) fs.unlinkSync(toLongPath(temp))
    } catch {
      /* ignore */
    }
    store.appendAudit('transcode.failed', { log: lastLog.slice(0, 4000) }, ep.id, settings.operator)
    throw new Error(`MP4 转换失败，已保留 MKV。${lastLog.split(/\r?\n/).slice(-6).join(' ').slice(0, 600)}`)
  }

  // 校验
  const after: MediaProbe | null = ffprobe.exists ? await probeMedia(temp, ffprobe.path) : null
  const durationDelta =
    before?.durationMs && after?.durationMs ? Math.abs(before.durationMs - after.durationMs) : null
  if (durationDelta !== null && durationDelta > 1000) {
    try {
      fs.unlinkSync(toLongPath(temp))
    } catch {
      /* ignore */
    }
    throw new Error(`MP4 时长与源文件相差 ${durationDelta}ms（> 1s），已取消`)
  }
  if (ep.merge && after && after.chapterCount !== null && after.chapterCount !== ep.merge.chapterCount) {
    log.warn('chapter count mismatch after mp4', { expected: ep.merge.chapterCount, got: after.chapterCount })
  }

  if (existsLong(finalTarget)) {
    fs.unlinkSync(toLongPath(finalTarget))
  }
  fs.renameSync(toLongPath(temp), toLongPath(finalTarget))

  const info: TranscodeInfo = {
    at: nowIso(),
    from: input,
    to: finalTarget,
    subtitleMode: usedMode,
    durationDeltaMs: durationDelta,
    ok: true,
    log: lastLog.slice(0, 20_000)
  }
  store.updateEpisode(localNo, { transcode: info })
  store.transition(localNo, 'MP4_DONE', 'transcode.done', { to: finalTarget, subtitleMode: usedMode }, settings.operator)
  store.writeSnapshots()
  broadcast('encode:progress', { localNo, phase: 'mp4-done', message: 'MP4 已生成' })
  log.info('transcode done', { localNo, to: finalTarget })
  return store.getEpisode(localNo)
}

/** 当前该集的「最终候选文件」 */
export function candidateFinalFile(ep: EpisodeRecord): string | null {
  if (ep.transcode?.ok && ep.transcode.to && existsLong(ep.transcode.to)) return ep.transcode.to
  if (ep.encode?.outputPath && existsLong(ep.encode.outputPath)) return ep.encode.outputPath
  return null
}
