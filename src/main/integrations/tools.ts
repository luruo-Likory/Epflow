import fs from 'node:fs'
import path from 'node:path'
import type { ToolPaths } from '@shared/types'
import { getSettings, saveSettings } from '../store/settings'
import { existsLong } from '../util/paths'
import { probeVersion } from './process-runner'
import { nodeEntryFor } from './shim'

export type ToolKey = keyof ToolPaths

export interface ToolProbe {
  key: ToolKey
  label: string
  path: string
  exists: boolean
  version: string | null
  /** 来源：用户设置 / 内置候选 / PATH */
  source: 'setting' | 'candidate' | 'path' | 'none'
  versionArgs: string[]
  required: boolean
}

/** npm 全局 bin 目录（Windows 默认 %APPDATA%\npm） */
function npmBin(...parts: string[]): string {
  const dir = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : ''
  return dir ? path.join(dir, ...parts) : ''
}

const CANDIDATES: Record<ToolKey, string[]> = {
  okegui: [
    'D:\\media\\OKEGui\\OKEGui.exe',
    'D:\\media\\local64\\OKEGui\\OKEGui.exe',
    'C:\\Program Files\\OKEGui\\OKEGui.exe'
  ],  ffmpeg: [
    'D:\\media\\local64\\bin-video\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'
  ],
  ffprobe: [
    'D:\\media\\local64\\bin-video\\ffprobe.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe'
  ],
  mkvpropedit: [
    'C:\\Program Files\\MKVToolNix\\mkvpropedit.exe',
    'C:\\Program Files (x86)\\MKVToolNix\\mkvpropedit.exe',
    'D:\\Program Files\\MKVToolNix\\mkvpropedit.exe',
    'D:\\Program Files (x86)\\MKVToolNix\\mkvpropedit.exe',
    'D:\\media\\local64\\bin-video\\mkvpropedit.exe'
  ],
  mkvmerge: [
    'C:\\Program Files\\MKVToolNix\\mkvmerge.exe',
    'C:\\Program Files (x86)\\MKVToolNix\\mkvmerge.exe',
    'D:\\Program Files\\MKVToolNix\\mkvmerge.exe',
    'D:\\Program Files (x86)\\MKVToolNix\\mkvmerge.exe',
    'D:\\media\\local64\\bin-video\\mkvmerge.exe'
  ],
  aegisub: [
    'D:\\media\\Aegisub\\aegisub.exe',
    'C:\\Program Files\\Aegisub\\aegisub64.exe',
    'C:\\Program Files (x86)\\Aegisub\\aegisub32.exe'
  ],
  mpv: ['D:\\media\\local64\\bin-video\\mpv.exe'],
  python: ['D:\\media\\OKEGui\\tools\\vapoursynth\\python.exe'],
  // AI 审阅命令行：优先 dsh（headless 一次性任务），其次 dcli（DSH-CLI 启动器）
  dsh: [
    npmBin('dsh.cmd'),
    npmBin('dcli.cmd'),
    npmBin('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    npmBin('node_modules', '@harmattan666', 'dcli', 'bin', 'dcli.js')
  ].filter(Boolean)
}

const LABELS: Record<ToolKey, string> = {
  okegui: 'OKEGui（压制）',
  ffmpeg: 'ffmpeg（转码）',
  ffprobe: 'ffprobe（媒体信息/校验）',
  mkvpropedit: 'mkvpropedit（写章节）',
  mkvmerge: 'mkvmerge（章节合并回退）',
  aegisub: 'Aegisub（人工审阅）',
  mpv: 'mpv（预览播放）',
  python: 'Python（vpy 语法校验）',
  dsh: 'DSH / dcli（AI 审阅）'
}

const VERSION_ARGS: Record<ToolKey, string[]> = {
  // GUI 程序不支持 --version，探测版本会挂起窗口，直接留空
  okegui: [],
  ffmpeg: ['-version'],
  ffprobe: ['-version'],
  mkvpropedit: ['--version'],
  mkvmerge: ['--version'],
  aegisub: [],
  mpv: ['--version'],
  python: ['--version'],
  dsh: ['--version']
}

const REQUIRED: Record<ToolKey, boolean> = {
  okegui: true,
  ffmpeg: true,
  ffprobe: true,
  mkvpropedit: true,
  mkvmerge: false,
  aegisub: false,
  mpv: false,
  python: false,
  // AI 审阅可用「粘贴 JSON」模式，不依赖 dsh 命令
  dsh: false
}

const PATH_EXE: Record<ToolKey, string[]> = {
  okegui: ['OKEGui.exe'],
  ffmpeg: ['ffmpeg.exe'],
  ffprobe: ['ffprobe.exe'],
  mkvpropedit: ['mkvpropedit.exe'],
  mkvmerge: ['mkvmerge.exe'],
  aegisub: ['aegisub64.exe', 'aegisub32.exe', 'aegisub.exe'],
  mpv: ['mpv.exe'],
  python: ['python.exe'],
  dsh: ['dsh.cmd', 'dsh.exe', 'dcli.cmd', 'dcli.exe', 'dsh.ps1', 'dcli.ps1']
}

function searchPath(names: string[]): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (existsLong(candidate)) return candidate
    }
  }
  return null
}

export function resolveTool(key: ToolKey): ToolProbe {
  const settings = getSettings()
  const configured = settings.tools[key]?.trim()
  if (configured && fs.existsSync(configured)) {
    // 允许用户只填「安装目录里的某个 exe」（例如 mkvtoolnix-gui.exe），自动推导同目录下的目标程序
    let resolvedPath = configured
    const baseName = path.basename(configured).toLowerCase()
    if (!PATH_EXE[key].some((name) => name.toLowerCase() === baseName)) {
      const dir = path.dirname(configured)
      for (const name of PATH_EXE[key]) {
        const candidate = path.join(dir, name)
        if (fs.existsSync(candidate)) {
          resolvedPath = candidate
          break
        }
      }
    }
    return {
      key,
      label: LABELS[key],
      path: resolvedPath,
      exists: true,
      version: null,
      source: 'setting',
      versionArgs: VERSION_ARGS[key],
      required: REQUIRED[key]
    }
  }
  for (const candidate of CANDIDATES[key]) {
    if (fs.existsSync(candidate)) {
      return {
        key,
        label: LABELS[key],
        path: candidate,
        exists: true,
        version: null,
        source: 'candidate',
        versionArgs: VERSION_ARGS[key],
        required: REQUIRED[key]
      }
    }
  }
  const found = searchPath(PATH_EXE[key])
  return {
    key,
    label: LABELS[key],
    path: found ?? '',
    exists: Boolean(found),
    version: null,
    source: found ? 'path' : 'none',
    versionArgs: VERSION_ARGS[key],
    required: REQUIRED[key]
  }
}

export function toolPath(key: ToolKey): string {
  const probe = resolveTool(key)
  return probe.exists ? probe.path : ''
}

export async function detectTools(options: { withVersion?: boolean } = {}): Promise<ToolProbe[]> {
  const keys = Object.keys(CANDIDATES) as ToolKey[]
  const probes = keys.map((k) => resolveTool(k))
  if (options.withVersion !== false) {
    await Promise.all(
      probes.map(async (probe) => {
        if (!probe.exists) return
        if (probe.versionArgs.length === 0) {
          probe.version = null
          return
        }
        // .cmd / .bat 不能被 Node 直接 spawn（EINVAL），解析 shim 后用 Node 跑真正的入口
        const entry = nodeEntryFor(probe.path)
        probe.version = entry
          ? await probeVersion(process.execPath, [entry, ...probe.versionArgs])
          : await probeVersion(probe.path, probe.versionArgs)
      })
    )
  }
  return probes
}

/** 探测结果回写设置（只填空白项，不覆盖用户已选路径） */
export async function applyDetectedTools(): Promise<ToolPaths> {
  const probes = await detectTools({ withVersion: false })
  const settings = getSettings()
  const tools: ToolPaths = { ...settings.tools }
  for (const probe of probes) {
    if (probe.exists && !tools[probe.key]) tools[probe.key] = probe.path
  }
  saveSettings({ tools })
  return tools
}
