import fs from 'node:fs'
import path from 'node:path'
import { canTransition } from '@shared/state-machine'
import type {
  AuditEntry,
  EpisodeRecord,
  EpisodeState,
  ProjectMeta,
  ReviewIssue,
  ReviewRun
} from '@shared/types'
import { nowIso } from '@shared/time'
import { readJsonSafe, writeJsonAtomic } from './atomic'
import { ensureDir, toLongPath } from '../util/paths'
import { scoped } from '../util/logger'

const log = scoped('store')

export const STORE_VERSION = 1

export interface ProjectStateFile {
  schemaVersion: number
  project: ProjectMeta
  episodes: EpisodeRecord[]
  runs: ReviewRun[]
  issues: ReviewIssue[]
}

export const STATE_DIR = '.epflow'
export const STATE_FILE = 'state.json'
export const AUDIT_FILE = 'audit.jsonl'

/**
 * 项目状态库：一个项目一个 state.json，原子写 + 单代 .bak。
 * 所有写操作都在内存中完成再整体落盘，等价于「事务」。
 */
export class ProjectStore {
  readonly rootPath: string
  private state: ProjectStateFile
  private dirty = false

  private constructor(rootPath: string, state: ProjectStateFile) {
    this.rootPath = rootPath
    this.state = state
  }

  static stateDir(rootPath: string): string {
    return path.join(rootPath, STATE_DIR)
  }

  static statePath(rootPath: string): string {
    return path.join(rootPath, STATE_DIR, STATE_FILE)
  }

  static auditPath(rootPath: string): string {
    return path.join(rootPath, STATE_DIR, AUDIT_FILE)
  }

  static exists(rootPath: string): boolean {
    return fs.existsSync(toLongPath(ProjectStore.statePath(rootPath)))
  }

  static open(rootPath: string): ProjectStore {
    const file = ProjectStore.statePath(rootPath)
    const fallback: ProjectStateFile = {
      schemaVersion: STORE_VERSION,
      project: {} as ProjectMeta,
      episodes: [],
      runs: [],
      issues: []
    }
    const raw = readJsonSafe<ProjectStateFile>(file, fallback)
    if (!raw || !raw.project || !Array.isArray(raw.episodes)) {
      throw new Error(`项目状态文件损坏：${file}`)
    }
    return new ProjectStore(rootPath, migrate(raw))
  }

  static create(project: ProjectMeta, episodes: EpisodeRecord[]): ProjectStore {
    ensureDir(ProjectStore.stateDir(project.rootPath))
    const state: ProjectStateFile = {
      schemaVersion: STORE_VERSION,
      project,
      episodes,
      runs: [],
      issues: []
    }
    const store = new ProjectStore(project.rootPath, state)
    store.save()
    return store
  }

  get project(): ProjectMeta {
    return this.state.project
  }

  get episodes(): EpisodeRecord[] {
    return this.state.episodes
  }

  get runs(): ReviewRun[] {
    return this.state.runs
  }

  get issues(): ReviewIssue[] {
    return this.state.issues
  }

  getEpisode(localNo: string): EpisodeRecord {
    const ep = this.state.episodes.find((e) => e.localNo === localNo)
    if (!ep) throw new Error(`找不到第 ${localNo} 集`)
    return ep
  }

  findEpisode(localNo: string): EpisodeRecord | null {
    return this.state.episodes.find((e) => e.localNo === localNo) ?? null
  }

  getEpisodeById(id: string): EpisodeRecord | null {
    return this.state.episodes.find((e) => e.id === id) ?? null
  }

  save(): void {
    writeJsonAtomic(ProjectStore.statePath(this.rootPath), this.state)
    this.dirty = false
  }

  markDirty(): void {
    this.dirty = true
  }

  /** 直接更新字段（不改状态） */
  updateEpisode(localNo: string, patch: Partial<EpisodeRecord>): EpisodeRecord {
    const ep = this.getEpisode(localNo)
    Object.assign(ep, patch, { updatedAt: nowIso() })
    this.save()
    return ep
  }

  /** 复用已有项目时补齐缺失集 */
  addEpisode(episode: EpisodeRecord): void {
    if (this.state.episodes.some((e) => e.localNo === episode.localNo)) return
    this.state.episodes.push(episode)
    this.state.episodes.sort((a, b) => a.localNo.localeCompare(b.localNo))
    this.save()
  }

  updateProject(patch: Partial<ProjectMeta>): ProjectMeta {
    Object.assign(this.state.project, patch, { updatedAt: nowIso() })
    this.save()
    this.writeSnapshots()
    return this.state.project
  }

  /**
   * 状态迁移：校验合法性 → 写状态 + 审计（同一次落盘）。
   */
  transition(
    localNo: string,
    next: EpisodeState,
    action: string,
    detail: Record<string, unknown> | null = null,
    actor = ''
  ): EpisodeRecord {
    const ep = this.getEpisode(localNo)
    if (!canTransition(ep.state, next)) {
      throw new Error(`非法状态迁移：${ep.state} → ${next}（第 ${localNo} 集）`)
    }
    const from = ep.state
    ep.state = next
    ep.updatedAt = nowIso()
    this.save()
    this.appendAudit(action, { from, to: next, ...(detail ?? {}) }, ep.id, actor)
    log.info('transition', { episode: localNo, from, to: next, action })
    return ep
  }

  /** 级联失效：字幕或章节变化时一次性回退 */
  invalidateDownstream(localNo: string, reasons: string[], action: string, actor = ''): EpisodeRecord {
    const ep = this.getEpisode(localNo)
    const from = ep.state
    ep.staleReasons = [...new Set([...ep.staleReasons, ...reasons])]
    ep.aiVerdict = ep.aiVerdict === 'pass' ? 'unknown' : ep.aiVerdict
    ep.human = null
    if (ep.chapterDraft) ep.chapterDraft = { ...ep.chapterDraft, stale: true }
    ep.chapters = null
    if (from !== 'SUB_IMPORTED') {
      ep.state = 'SUB_IMPORTED'
    }
    ep.updatedAt = nowIso()
    this.save()
    this.appendAudit(action, { from, to: ep.state, reasons }, ep.id, actor)
    return ep
  }

  appendAudit(
    action: string,
    detail: Record<string, unknown> | null,
    episodeId: string | null = null,
    actor = ''
  ): AuditEntry {
    const entry: AuditEntry = {
      at: nowIso(),
      actor,
      action,
      episodeId,
      detail
    }
    ensureDir(ProjectStore.stateDir(this.rootPath))
    try {
      fs.appendFileSync(toLongPath(ProjectStore.auditPath(this.rootPath)), `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (err) {
      log.warn('audit append failed', { message: String(err) })
    }
    return entry
  }

  readAudit(): AuditEntry[] {
    try {
      const text = fs.readFileSync(toLongPath(ProjectStore.auditPath(this.rootPath)), 'utf8')
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as AuditEntry
          } catch {
            return null
          }
        })
        .filter((x): x is AuditEntry => Boolean(x))
    } catch {
      return []
    }
  }

  addRun(run: ReviewRun): void {
    this.state.runs.push(run)
    this.save()
  }

  addIssues(issues: ReviewIssue[]): void {
    this.state.issues.push(...issues)
    this.save()
  }

  updateIssue(issueId: string, patch: Partial<ReviewIssue>): ReviewIssue {
    const issue = this.state.issues.find((i) => i.id === issueId)
    if (!issue) throw new Error(`找不到问题 ${issueId}`)
    Object.assign(issue, patch)
    this.save()
    return issue
  }

  issuesOf(episodeId: string, runId?: string): ReviewIssue[] {
    return this.state.issues.filter(
      (i) => i.episodeId === episodeId && (runId ? i.runId === runId : true)
    )
  }

  runsOf(episodeId: string): ReviewRun[] {
    return this.state.runs.filter((r) => r.episodeId === episodeId)
  }

  latestRun(episodeId: string): ReviewRun | null {
    const runs = this.runsOf(episodeId)
    return runs.length > 0 ? (runs[runs.length - 1] ?? null) : null
  }

  /** 写可读快照（§14 A/B），失败不影响主流程 */
  writeSnapshots(): void {
    try {
      writeJsonAtomic(path.join(this.rootPath, 'project.json'), {
        schema_version: 1,
        anime_name: this.state.project.animeName,
        root_path: this.state.project.rootPath,
        release_name_template: this.state.project.releaseNameTemplate,
        release_episode_base: this.state.project.releaseEpisodeBase,
        episode_count: this.state.project.episodeCount,
        local_start: this.state.project.localStart,
        work_name_template: this.state.project.workNameTemplate,
        created_at: this.state.project.createdAt
      })
      writeJsonAtomic(path.join(this.rootPath, 'episodes.json'), {
        project: this.state.project.animeName,
        episodes: this.state.episodes.map((e) => ({
          local_no: e.localNo,
          release_no: e.releaseNo,
          state: e.state,
          work_name: e.workName,
          subtitle: e.subtitle ? { path: e.subtitle.path, sha256: e.subtitle.sha256 } : null,
          chapters: e.chapters
            ? { path: e.chapters.path, sha256: e.chapters.sha256, reviewed: true, chapter_count: e.chapters.chapterCount }
            : null,
          final_path: e.final?.path ?? null
        }))
      })
    } catch (err) {
      log.warn('snapshot write failed', { message: String(err) })
    }
  }
}

function migrate(state: ProjectStateFile): ProjectStateFile {
  if (!state.schemaVersion || state.schemaVersion < STORE_VERSION) {
    state.schemaVersion = STORE_VERSION
  }
  state.runs = state.runs ?? []
  state.issues = state.issues ?? []
  for (const ep of state.episodes) {
    ep.staleReasons = ep.staleReasons ?? []
    ep.note = ep.note ?? ''
  }
  return state
}

/** 打开项目目录下的状态库；不存在则报错 */
export function openStore(rootPath: string): ProjectStore {
  return ProjectStore.open(rootPath)
}
