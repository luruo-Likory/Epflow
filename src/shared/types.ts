/**
 * 共享类型：主进程、preload、渲染层共用。
 * 本文件必须保持「仅类型 + 纯数据」，不得依赖 Node 或浏览器 API。
 */

/* ------------------------------------------------------------------ */
/* 通用结果与错误                                                       */
/* ------------------------------------------------------------------ */

export type ErrorCode =
  | 'E_VALIDATION'
  | 'E_NOT_FOUND'
  | 'E_CONFLICT'
  | 'E_IO'
  | 'E_GATE_BLOCKED'
  | 'E_TOOL_MISSING'
  | 'E_TIMEOUT'
  | 'E_CANCELLED'
  | 'E_SCHEMA'
  | 'E_EXTERNAL_FAILED'
  | 'E_INTERNAL'

export interface AppError {
  code: ErrorCode
  message: string
  hint?: string
  detail?: unknown
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError }

/* ------------------------------------------------------------------ */
/* 集状态（§6.1）                                                       */
/* ------------------------------------------------------------------ */

export const EPISODE_STATES = [
  'INIT',
  'TEMPLATE_READY',
  'SUB_IMPORTED',
  'AI_REVIEWING',
  'AI_REJECTED',
  'AI_PASSED',
  'HUMAN_REVIEWING',
  'HUMAN_REJECTED',
  'HUMAN_PASSED',
  'CHAPTER_DRAFT',
  'CHAPTER_REVIEWING',
  'CHAPTER_LOCKED',
  'ENCODING',
  'ENCODE_FAILED',
  'ENCODED',
  'CHAPTER_MERGED',
  'MP4_DONE',
  'NAMED',
  'DONE',
  'BLOCKED'
] as const

export type EpisodeState = (typeof EPISODE_STATES)[number]

/** v2 发布状态：v1 只保留定义，不进入主状态机（§6.5 / FR-16） */
export const PUBLISH_STATES = [
  'PUBLISH_READY',
  'TORRENT_CREATED',
  'UPLOADED',
  'SEEDING',
  'SEEDING_INTERRUPTED',
  'SEEDING_DONE',
  'PUBLISH_FAILED'
] as const

export type PublishState = (typeof PUBLISH_STATES)[number]

/* ------------------------------------------------------------------ */
/* AI 审阅                                                             */
/* ------------------------------------------------------------------ */

export const SEVERITIES = ['blocker', 'major', 'minor', 'info'] as const
export type Severity = (typeof SEVERITIES)[number]

export const ISSUE_CATEGORIES = [
  'typo',
  'grammar',
  'layout',
  'accuracy',
  'term',
  'punctuation',
  'timing',
  'ass_tag',
  'omission',
  'style',
  'context'
] as const
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number]

/** 当前审阅范围只覆盖这三类（v1.0.1 起） */
export const REVIEW_SCOPE_CATEGORIES = ['typo', 'grammar', 'layout'] as const

export const ISSUE_STATUSES = ['open', 'fixed', 'ignored', 'false_positive'] as const
export type IssueStatus = (typeof ISSUE_STATUSES)[number]

export type AiVerdict = 'pass' | 'fail' | 'unknown'

export interface ReviewIssue {
  id: string
  runId: string
  episodeId: string
  severity: Severity
  category: IssueCategory
  /** ASS 事件序号（从 1 开始，对应字幕行） */
  line: number | null
  /** layout 问题涉及的第二行（上下排列检查） */
  relatedLines?: number[] | null
  startMs: number | null
  endMs: number | null
  original: string
  suggestion: string
  reason: string
  confidence: number | null
  status: IssueStatus
  /** 来源：本地预检 / AI */
  source: 'local' | 'ai'
  /** 处理理由（ignored / false_positive 必填） */
  resolutionNote: string | null
  resolvedAt: string | null
  resolvedBy: string | null
}

export interface ReviewStats {
  blocker: number
  major: number
  minor: number
  info: number
}

export interface ReviewRun {
  id: string
  episodeId: string
  runAt: string
  model: string
  promptVersion: string
  subtitleHash: string
  verdict: AiVerdict
  stats: ReviewStats
  /** 原始响应（已脱敏、截断）；解析失败时保留全文 */
  rawResponse: string | null
  parseError: string | null
  durationMs: number
  tokenUsage: { input?: number; output?: number; total?: number } | null
  issueCount: number
}

/* ------------------------------------------------------------------ */
/* 章节                                                                */
/* ------------------------------------------------------------------ */

export type ChapterSource = 'auto' | 'manual' | 'op' | 'ed'

export interface Chapter {
  startMs: number
  title: string
  source: ChapterSource
  uid: string
}

export interface ChapterInfo {
  /** 锁定副本：{集目录}\{工作名}.chapters.xml */
  path: string
  sha256: string
  reviewedAt: string
  reviewedBy: string
  chapterCount: number
}

export interface ChapterDraftInfo {
  /** 草稿：{集目录}\{工作名}.chapters.draft.xml（未使用子目录时） */
  path: string
  updatedAt: string
  chapterCount: number
  stale: boolean
  chapters: Chapter[]
}

/* ------------------------------------------------------------------ */
/* 字幕                                                                */
/* ------------------------------------------------------------------ */

export interface SubtitleInfo {
  path: string
  sha256: string
  importedAt: string
  sourceName: string
  /** 导入时规范化到的编码：utf-8-bom（VSFilter 需要 BOM 才能正确识别 UTF-8） */
  encoding: string
  lineCount: number
}

export interface HumanLock {
  at: string
  by: string
  subtitleHash: string
  aiRunId: string
  note: string
  checklist: string[]
}

/** 审阅视频引用（每集可选，便于用不同片源校对） */
export interface ReviewVideoRef {
  path: string
  setAt: string
  /** 来源：用户选择 / 模板 InputFiles */
  source: 'manual' | 'template'
}

/* ------------------------------------------------------------------ */
/* 压制 / 合并 / 转码 / 命名                                             */
/* ------------------------------------------------------------------ */

export interface EncodeInfo {
  startedAt: string
  okeguiPath: string
  /** 识别到的成品 */
  outputPath: string | null
  outputSize: number | null
  outputMtime: string | null
  outputSha256: string | null
  probe: MediaProbe | null
  failedReason: string | null
  cancelledAt: string | null
}

export interface MediaProbe {
  durationMs: number | null
  width: number | null
  height: number | null
  videoCodec: string | null
  audioTracks: number
  subtitleTracks: number
  chapterCount: number | null
  formatName: string | null
}

export interface MergeInfo {
  at: string
  tool: 'mkvpropedit' | 'mkvmerge'
  xmlHash: string
  chapterCount: number
  firstChapterStartMs: number
  backupPath: string | null
  log: string
}

export interface TranscodeInfo {
  at: string
  from: string
  to: string
  subtitleMode: 'mov_text' | 'drop' | 'none'
  durationDeltaMs: number | null
  ok: boolean
  log: string
}

export interface FinalInfo {
  path: string
  size: number
  sha256: string | null
  at: string
  namingTemplateVersion: string
  format: 'mkv' | 'mp4'
}

/* ------------------------------------------------------------------ */
/* 项目与集                                                             */
/* ------------------------------------------------------------------ */

export interface ProjectMeta {
  id: string
  animeName: string
  /** 素材根目录 */
  materialRoot: string
  /** 项目根目录：{materialRoot}\{animeName} */
  rootPath: string
  /** 发布名模板，集数位写作 {release} */
  releaseNameTemplate: string
  /** 基准发布集数 */
  releaseEpisodeBase: number
  /** 发布集数补零宽度 */
  releaseEpisodeWidth: number
  episodeCount: number
  /** 本地起始集号，默认 1 */
  localStart: number
  workNameTemplate: string
  /** 翻译用子目录名；空字符串表示不使用子目录（字幕/章节草稿直接放集目录） */
  subDirName: string
  /** 输出目录策略 */
  outputMode: 'episode-output' | 'project-release'
  createdAt: string
  updatedAt: string
}

export interface EpisodeRecord {
  id: string
  projectId: string
  localNo: string
  releaseNo: string
  state: EpisodeState
  workName: string
  dir: string
  subDir: string
  templateJson: string | null
  templateVpy: string | null
  subtitle: SubtitleInfo | null
  /** 审阅用视频：用户为该集手动选择；为空时回退到模板 InputFiles[0] */
  reviewVideo: ReviewVideoRef | null
  aiRunId: string | null
  aiVerdict: AiVerdict | null
  human: HumanLock | null
  chapterDraft: ChapterDraftInfo | null
  chapters: ChapterInfo | null
  encode: EncodeInfo | null
  merge: MergeInfo | null
  transcode: TranscodeInfo | null
  final: FinalInfo | null
  /** 最近一次变更导致失效的说明 */
  staleReasons: string[]
  /** 最近一次操作者备注 */
  note: string
  updatedAt: string
}

/* ------------------------------------------------------------------ */
/* 审计                                                                */
/* ------------------------------------------------------------------ */

export interface AuditEntry {
  at: string
  actor: string
  action: string
  episodeId: string | null
  detail: Record<string, unknown> | null
}

/* ------------------------------------------------------------------ */
/* 设置（§FR-14 / 附录 C）                                              */
/* ------------------------------------------------------------------ */

export interface ToolPaths {
  okegui: string
  ffmpeg: string
  ffprobe: string
  mkvpropedit: string
  mkvmerge: string
  aegisub: string
  mpv: string
  python: string
  dsh: string
}

export interface DshSettings {
  /** paste：生成 prompt 由用户粘贴到 DSH，再把 JSON 粘回（无外部依赖，默认）
   *  http：OpenAI 兼容 /chat/completions 接口
   *  cli：本机存在 dsh 命令行时直接调用 */
  mode: 'paste' | 'cli' | 'http'
  command: string
  argsTemplate: string
  model: string
  timeoutMs: number
  retries: number
  /** 完整接口地址，如 https://api.deepseek.com/chat/completions */
  httpUrl: string
  /** API Key 所在的环境变量名（不落盘明文密钥） */
  apiKeyEnv: string
  /** 允许把字幕文本发送给 AI（§10 安全要求） */
  allowSubtitleUpload: boolean
}

export interface ChapterSettings {
  gapThresholdMs: number
  minChapterLenMs: number
  maxChapterLenMs: number
  maxChapters: number
  minChapters: number
  detectOpEd: boolean
  firstChapterAtZero: boolean
  /** 章节语言标签 */
  language: string
}

export interface NamingSettings {
  workNameEpSource: 'release' | 'local'
  /** 重命名冲突策略 */
  conflict: 'suffix' | 'ask' | 'trash'
  /** 最终输出目录：episode-output / project-release */
  outputMode: 'episode-output' | 'project-release'
  outputDirName: string
}

export interface Mp4Settings {
  subtitleMode: 'mov_text' | 'drop'
}

export interface EncodeSettings {
  minSizeMb: number
  timeoutMs: number
  pollIntervalMs: number
  keepBackup: boolean
  requireSourceVideo: boolean
}

export interface PublishSettings {
  enabled: boolean
  uploadEnabled: boolean
  provider: string
  torrentMaker: string
  seedClient: string
  policy: string
  trackers: string[]
  pieceSizeKb: number
  autoStart: boolean
  monitorIntervalMs: number
}

/** 审阅范围：只审对白与屏幕字的通顺、错别字、时间重叠时的上下排列 */
export interface ReviewScopeSettings {
  /** 样式名包含这些关键字 → 视为特效行，不送审、不检查 */
  effectStyleKeywords: string[]
  /** 样式名包含这些关键字 → 视为屏幕字（仍然审阅） */
  screenStyleKeywords: string[]
  /** 忽略 Comment 行（默认 true） */
  excludeComments: boolean
}

export interface AppSettings {
  schemaVersion: number
  operator: string
  materialRoot: string
  subDirName: string
  tools: ToolPaths
  dsh: DshSettings
  review: ReviewScopeSettings
  chapter: ChapterSettings
  naming: NamingSettings
  mp4: Mp4Settings
  encode: EncodeSettings
  publish: PublishSettings
  allowForcePass: boolean
  theme: 'light'
}

/* ------------------------------------------------------------------ */
/* 状态快照（IPC DTO）                                                  */
/* ------------------------------------------------------------------ */

export interface ProjectSnapshot {
  project: ProjectMeta
  episodes: EpisodeRecord[]
}

export interface EpisodeDetail {
  episode: EpisodeRecord
  project: ProjectMeta
  issues: ReviewIssue[]
  latestRun: ReviewRun | null
  runs: ReviewRun[]
  gate: GateReport
}

export interface GateBlocker {
  code: string
  label: string
  hint?: string
}

export type GateAction =
  | 'open-human-review'
  | 'human-pass'
  | 'generate-chapters'
  | 'lock-chapters'
  | 'encode'
  | 'merge'
  | 'transcode'
  | 'rename'

export interface GateReport {
  action: GateAction
  ok: boolean
  blockers: GateBlocker[]
}
