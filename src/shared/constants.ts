import type { AppSettings } from './types'

export const APP_NAME = 'EpFlow'
export const SETTINGS_SCHEMA_VERSION = 1
export const STATE_SCHEMA_VERSION = 1

export const DEFAULT_MATERIAL_ROOT = 'D:\\media\\origin material'
/**
 * 「翻译用」子目录名的默认值。
 * 空字符串表示不使用子目录：字幕、章节草稿等文件直接放在集目录（01/、02/…）下，
 * 与 json/vpy/output 同级，减少一层目录嵌套。
 */
export const DEFAULT_SUB_DIR = ''
export const DEFAULT_WORK_NAME_TEMPLATE = '{anime} - {ep}'
export const DEFAULT_PROMPT_VERSION = 'review-v2'
export const OUTPUT_DIR_NAME = 'output'
export const STATE_DIR_NAME = '.epflow'

export const SEVERITY_ORDER = { blocker: 0, major: 1, minor: 2, info: 3 } as const

export const GATE_ACTION_LABEL: Record<string, string> = {
  'open-human-review': '打开人工审阅',
  'human-pass': '人工审阅通过',
  'generate-chapters': '生成章节',
  'lock-chapters': '章节审阅通过',
  encode: '压制本集',
  merge: '合并章节',
  transcode: '转 MP4',
  rename: '重命名'
}

export function defaultSettings(): AppSettings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    operator: '',
    materialRoot: DEFAULT_MATERIAL_ROOT,
    subDirName: DEFAULT_SUB_DIR,
    tools: {
      okegui: '',
      ffmpeg: '',
      ffprobe: '',
      mkvpropedit: '',
      mkvmerge: '',
      aegisub: '',
      mpv: '',
      python: '',
      dsh: ''
    },
    dsh: {
      mode: 'paste',
      command: 'dsh',
      argsTemplate: 'exec --prompt-file "{promptFile}" --model {model} --output-format json',
      model: 'deepseek-chat',
      timeoutMs: 600_000,
      retries: 2,
      httpUrl: 'https://api.deepseek.com/chat/completions',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      allowSubtitleUpload: true
    },
    review: {
      effectStyleKeywords: ['特效', 'Effect', 'Title', 'Staff', 'Logo', 'OP', 'ED', 'Kara', 'Comment'],
      screenStyleKeywords: ['ScreenText', 'Screen', 'Sign', 'Caption', '屏字', '屏幕字', '字幕', 'Note'],
      excludeComments: true
    },
    chapter: {
      gapThresholdMs: 2000,
      minChapterLenMs: 90_000,
      maxChapterLenMs: 480_000,
      maxChapters: 10,
      minChapters: 3,
      detectOpEd: true,
      firstChapterAtZero: true,
      language: 'und'
    },
    naming: {
      workNameEpSource: 'release',
      conflict: 'suffix',
      outputMode: 'episode-output',
      outputDirName: OUTPUT_DIR_NAME
    },
    mp4: { subtitleMode: 'mov_text' },
    encode: {
      minSizeMb: 50,
      timeoutMs: 1_800_000,
      pollIntervalMs: 2000,
      keepBackup: true,
      requireSourceVideo: false
    },
    publish: {
      enabled: false,
      uploadEnabled: false,
      provider: 'site-a',
      torrentMaker: 'utorrent',
      seedClient: 'qbittorrent',
      policy: 'required',
      trackers: [],
      pieceSizeKb: 2048,
      autoStart: true,
      monitorIntervalMs: 30_000
    },
    allowForcePass: false,
    theme: 'light'
  }
}
