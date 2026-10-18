import type { MediaProbe } from '@shared/types'
import { runProcess } from './process-runner'

export interface ChapterProbeEntry {
  index: number
  startMs: number
  title: string | null
}

export interface ChapterProbeResult {
  count: number
  firstStartMs: number | null
  entries: ChapterProbeEntry[]
}

interface FfprobeJson {
  format?: { duration?: string; format_name?: string }
  streams?: Array<{
    codec_type?: string
    codec_name?: string
    width?: number
    height?: number
    duration?: string
  }>
  chapters?: Array<{
    start_time?: string
    tags?: { title?: string }
  }>
}

async function ffprobeJson(file: string, ffprobePath: string, extra: string[] = []): Promise<FfprobeJson | null> {
  if (!ffprobePath) return null
  const args = [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-show_chapters',
    ...extra,
    file
  ]
  const res = await runProcess(ffprobePath, args, { timeoutMs: 120_000 })
  if (res.code !== 0) return null
  try {
    return JSON.parse(res.stdout) as FfprobeJson
  } catch {
    return null
  }
}

export async function probeMedia(file: string, ffprobePath: string): Promise<MediaProbe | null> {
  const data = await ffprobeJson(file, ffprobePath)
  if (!data) return null
  const streams = data.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.filter((s) => s.codec_type === 'audio')
  const subs = streams.filter((s) => s.codec_type === 'subtitle')
  const durationSec = Number(data.format?.duration ?? video?.duration ?? 0)
  return {
    durationMs: Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec * 1000) : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    audioTracks: audio.length,
    subtitleTracks: subs.length,
    chapterCount: data.chapters?.length ?? null,
    formatName: data.format?.format_name ?? null
  }
}

export async function probeChapters(file: string, ffprobePath: string): Promise<ChapterProbeResult> {
  const data = await ffprobeJson(file, ffprobePath)
  const chapters = data?.chapters ?? []
  const entries: ChapterProbeEntry[] = chapters.map((c, i) => ({
    index: i + 1,
    startMs: Math.round(Number(c.start_time ?? 0) * 1000),
    title: c.tags?.title ?? null
  }))
  return {
    count: entries.length,
    firstStartMs: entries.length > 0 ? (entries[0]?.startMs ?? null) : null,
    entries
  }
}
