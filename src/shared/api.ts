import type {
  AppSettings,
  AuditEntry,
  Chapter,
  EpisodeRecord,
  GateAction,
  GateReport,
  ProjectMeta,
  ProjectSnapshot,
  ReviewIssue,
  ReviewRun
} from './types'
import type { SubtitleInfo } from './types'
import type { AssDocument } from './ass-parser'

/* ------------------------------------------------------------------ */
/* 通用 DTO                                                             */
/* ------------------------------------------------------------------ */

export interface ToolProbeDto {
  key: string
  label: string
  path: string
  exists: boolean
  version: string | null
  source: 'setting' | 'candidate' | 'path' | 'none'
  required: boolean
}

export interface AppInfoDto {
  version: string
  platform: string
  userData: string
  isPackaged: boolean
  locale: string
}

export interface FileFilterDto {
  name: string
  extensions: string[]
}

export interface ProjectSummaryDto {
  id: string
  animeName: string
  rootPath: string
  episodeCount: number
  exists: boolean
  lastOpenedAt: string
  stateCounts: Record<string, number>
  doneCount: number
}

export interface TreeLineDto {
  depth: number
  name: string
  kind: 'dir' | 'file'
  note?: string
}

export interface EpisodePreviewDto {
  localNo: string
  releaseNo: string
  workName: string
  dir: string
  subDir: string
  outputDir: string
  state: string
}

export interface ProjectPreviewDto {
  ok: boolean
  errors: string[]
  warnings: string[]
  animeName: string
  rootPath: string
  conflicts: {
    rootExists: boolean
    existingLocalDirs: string[]
    missingLocalDirs: string[]
    existingSubDir: boolean
    hasState: boolean
  }
  episodes: EpisodePreviewDto[]
  tree: TreeLineDto[]
}

export interface CreateProjectInputDto {
  animeName: string
  materialRoot: string
  releaseNameTemplate: string
  releaseEpisodeBase: number
  releaseEpisodeWidth: number
  episodeCount: number
  localStart: number
  workNameTemplate: string
  subDirName: string
  outputMode: 'episode-output' | 'project-release'
}

export interface DetectedProjectDto {
  rootPath: string
  animeName: string
  hasState: boolean
  episodeDirs: string[]
  sampleFiles: string[]
  guessedReleaseBase: number | null
  guessedReleaseWidth: number
}

export interface TemplateInfoDto {
  projectName: string | null
  inputScript: string | null
  inputFiles: string[]
  vpyInput: string | null
  vpySubtitle: string | null
  oldEpDir: string | null
  oldAnime: string | null
  oldLocal: string | null
  oldRelease: string | null
  oldWork: string | null
  absolutePaths: string[]
}

export interface SubstitutionDto {
  id: string
  kind: 'work' | 'anime' | 'path' | 'episode' | 'subtitle' | 'custom'
  from: string
  to: string
  count: number
  enabled: boolean
  scope: 'json' | 'vpy' | 'both'
}

export interface TemplateAnalysisDto {
  info: TemplateInfoDto
  substitutions: SubstitutionDto[]
  warnings: string[]
  hasPlaceholders: boolean
  hasJson: boolean
  hasVpy: boolean
  jsonText: string | null
  vpyText: string | null
}

export interface DiffLineDto {
  kind: 'same' | 'add' | 'del'
  left: string | null
  right: string | null
  leftNo: number | null
  rightNo: number | null
}

export interface TemplatePreviewDto {
  localNo: string
  json: { before: string; after: string; diff: DiffLineDto[] } | null
  vpy: { before: string; after: string; diff: DiffLineDto[] } | null
  warnings: string[]
  errors: string[]
  substitutions: SubstitutionDto[]
}

export interface InstantiateRowDto {
  localNo: string
  releaseNo: string
  jsonPath: string | null
  vpyPath: string | null
  jsonOk: boolean
  vpyOk: boolean
  sourceExists: boolean
  warnings: string[]
  error: string | null
}

export interface SubtitleEventDto {
  index: number
  lineNo: number
  startMs: number
  endMs: number
  style: string
  name: string
  text: string
  plain: string
  isComment: boolean
  type: 'dialogue' | 'comment'
}

export interface SubtitleViewDto {
  info: SubtitleInfo | null
  events: SubtitleEventDto[]
  styles: string[]
  playResX: number
  playResY: number
  exists: boolean
  currentHash: string | null
  documentText: string
}

export interface ReviewIssuesDto {
  issues: ReviewIssue[]
  run: ReviewRun | null
  runs: ReviewRun[]
}

export interface ReviewPrepareDto {
  prompt: string
  promptFile: string
  chunks: number
}

export interface ReviewOutcomeDto {
  run: ReviewRun
  issues: ReviewIssue[]
  warnings: string[]
  episode: EpisodeRecord
}

export interface ChapterViewDto {
  chapters: Chapter[]
  xml: string
  locked: boolean
  draft: {
    path: string
    updatedAt: string
    chapterCount: number
    stale: boolean
    chapters: Chapter[]
  } | null
  lockedInfo: EpisodeRecord['chapters']
  stale: boolean
  durationMs: number | null
}

export interface OutputCandidateDto {
  path: string
  size: number
  mtimeMs: number
}

export interface EpisodeDetailDto {
  episode: EpisodeRecord
  project: ProjectMeta
  issues: ReviewIssue[]
  run: ReviewRun | null
  runs: ReviewRun[]
  gates: Record<string, GateReport>
}

export interface WatchEventDto {
  localNo: string
  kind: 'subtitle' | 'chapters' | 'output'
  message: string
  state?: string
}

export interface ProgressEventDto {
  localNo: string
  phase: string
  message: string
  path?: string
  candidates?: Array<{ path: string; size: number }>
}

export interface AuditFilterDto {
  action?: string
  localNo?: string
  from?: string
  to?: string
  limit?: number
}

/* ------------------------------------------------------------------ */
/* IPC 主题表                                                           */
/* ------------------------------------------------------------------ */

export interface ApiTopicMap {
  'app:info': { payload: undefined; result: AppInfoDto }
  'app:open-path': { payload: { path: string; reveal?: boolean }; result: void }
  'app:export-diagnostics': { payload: { dir: string }; result: { path: string; files: string[] } }
  'app:quit': { payload: undefined; result: void }

  'settings:get': { payload: undefined; result: AppSettings }
  'settings:save': { payload: Partial<AppSettings>; result: AppSettings }
  'settings:reset': { payload: undefined; result: AppSettings }
  'settings:detect-tools': { payload: { withVersion?: boolean } | undefined; result: ToolProbeDto[] }
  'settings:apply-tools': { payload: undefined; result: AppSettings }

  'dialog:pick-files': {
    payload: { title?: string; filters?: FileFilterDto[]; multi?: boolean }
    result: string[]
  }
  'dialog:pick-dir': { payload: { title?: string; defaultPath?: string }; result: string | null }
  'dialog:save-file': {
    payload: { title?: string; defaultPath?: string; filters?: FileFilterDto[] }
    result: string | null
  }

  'project:list': { payload: undefined; result: ProjectSummaryDto[] }
  'project:preview': { payload: CreateProjectInputDto; result: ProjectPreviewDto }
  'project:create': {
    payload: {
      input: CreateProjectInputDto
      conflict: 'reuse' | 'abort' | 'rename'
      renamedAnime?: string
    }
    result: ProjectSnapshot
  }
  'project:open': { payload: { rootPath: string }; result: ProjectSnapshot }
  'project:scan': { payload: { materialRoot: string }; result: DetectedProjectDto[] }
  'project:update-meta': {
    payload: {
      rootPath: string
      patch: Partial<
        Pick<ProjectMeta, 'releaseNameTemplate' | 'releaseEpisodeBase' | 'workNameTemplate' | 'subDirName' | 'outputMode'>
      >
    }
    result: ProjectSnapshot
  }
  'project:set-release-no': {
    payload: { rootPath: string; localNo: string; releaseNo: string }
    result: ProjectSnapshot
  }
  'project:recover': { payload: { rootPath: string }; result: { recovered: string[]; verified: string[] } }

  'episode:detail': { payload: { rootPath: string; localNo: string }; result: EpisodeDetailDto }
  'episode:note': { payload: { rootPath: string; localNo: string; note: string }; result: EpisodeRecord }
  'episode:done': { payload: { rootPath: string; localNo: string }; result: EpisodeRecord }

  'template:analyze': { payload: { rootPath: string }; result: TemplateAnalysisDto }
  'template:upload': { payload: { rootPath: string; files: string[] }; result: TemplateAnalysisDto }
  'template:preview': {
    payload: { rootPath: string; localNo: string; substitutions?: SubstitutionDto[] }
    result: TemplatePreviewDto
  }
  'template:instantiate': {
    payload: {
      rootPath: string
      localNos?: string[]
      onExists: 'backup' | 'skip'
      substitutions?: SubstitutionDto[]
      validateVpy?: boolean
    }
    result: { rows: InstantiateRowDto[]; snapshot: ProjectSnapshot }
  }

  'subtitle:import': {
    payload: { rootPath: string; localNo: string; filePath: string }
    result: EpisodeRecord
  }
  'subtitle:read': { payload: { rootPath: string; localNo: string }; result: SubtitleViewDto }
  'subtitle:replace': {
    payload: {
      rootPath: string
      localNo: string
      find: string
      replace: string
      regex?: boolean
      caseSensitive?: boolean
      onlyDialogue?: boolean
      count: number
    }
    result: { count: number }
  }
  'subtitle:open-external': { payload: { rootPath: string; localNo: string }; result: void }

  'review:prepare': { payload: { rootPath: string; localNo: string }; result: ReviewPrepareDto }
  'review:start': { payload: { rootPath: string; localNo: string }; result: ReviewOutcomeDto }
  'review:submit-json': {
    payload: { rootPath: string; localNo: string; json: string }
    result: ReviewOutcomeDto
  }
  'review:issues': { payload: { rootPath: string; localNo: string }; result: ReviewIssuesDto }
  'review:set-issue': {
    payload: { rootPath: string; issueId: string; status: 'open' | 'fixed' | 'ignored' | 'false_positive'; note: string }
    result: ReviewIssue
  }
  'review:force-pass': { payload: { rootPath: string; localNo: string; note: string }; result: EpisodeRecord }

  'human:open': { payload: { rootPath: string; localNo: string }; result: EpisodeRecord }
  'human:pass': {
    payload: { rootPath: string; localNo: string; checklist: string[]; note: string }
    result: EpisodeRecord
  }
  'human:reject': {
    payload: { rootPath: string; localNo: string; reason: string; needReReview: boolean }
    result: EpisodeRecord
  }
  'human:cancel': { payload: { rootPath: string; localNo: string }; result: EpisodeRecord }

  'chapter:generate': {
    payload: { rootPath: string; localNo: string; overrides?: Partial<AppSettings['chapter']> }
    result: ChapterViewDto
  }
  'chapter:read': { payload: { rootPath: string; localNo: string }; result: ChapterViewDto }
  'chapter:save': {
    payload: { rootPath: string; localNo: string; chapters: Chapter[] }
    result: ChapterViewDto
  }
  'chapter:lock': {
    payload: { rootPath: string; localNo: string; checklist: string[] }
    result: EpisodeRecord
  }

  'gate:check': {
    payload: { rootPath: string; localNo: string }
    result: Record<string, GateReport>
  }
  'gate:check-one': {
    payload: { rootPath: string; localNo: string; action: GateAction }
    result: GateReport
  }

  'encode:start': { payload: { rootPath: string; localNo: string }; result: EpisodeRecord }
  'encode:cancel': { payload: { rootPath: string; localNo: string }; result: EpisodeRecord }
  'encode:rescan': { payload: { rootPath: string; localNo: string }; result: OutputCandidateDto[] }
  'encode:accept': { payload: { rootPath: string; localNo: string; path: string }; result: EpisodeRecord }

  'merge:run': { payload: { rootPath: string; localNo: string }; result: EpisodeRecord }
  'transcode:run': {
    payload: { rootPath: string; localNo: string; mode: 'mp4' | 'keep' }
    result: EpisodeRecord
  }
  'naming:preview': {
    payload: { rootPath: string; localNo: string }
    result: { name: string; dir: string; conflict: boolean }
  }
  'naming:run': { payload: { rootPath: string; localNo: string }; result: EpisodeRecord }

  'audit:list': { payload: { rootPath: string; filter?: AuditFilterDto }; result: AuditEntry[] }
  'audit:export': { payload: { rootPath: string; target: string }; result: { path: string; count: number } }
}

export type TopicName = keyof ApiTopicMap

export type { AssDocument }
