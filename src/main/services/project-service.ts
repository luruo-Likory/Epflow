import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { AppSettings, EpisodeRecord, ProjectMeta, ProjectSnapshot } from '@shared/types'
import { nowIso } from '@shared/time'
import { validateAnimeName, sanitizeFileName, validateReleaseTemplate, validateSubDirName } from '@shared/filename'
import { formatRelease, toReleaseTemplate, findReleaseCandidates, chooseDefaultCandidate } from '@shared/release-name'
import { createVariableMap } from '@shared/template-vars'
import { ProjectStore, openStore } from '../store/repository'
import { ensureDir, existsLong, listDir, listDirs, toLongPath } from '../util/paths'
import { randomId } from '../util/hash'
import { scoped } from '../util/logger'
import { loadAppState, upsertProjectIndex, type ProjectIndexEntry } from '../store/settings'

const log = scoped('project')

export const createProjectInputSchema = z.object({
  animeName: z.string().min(1).max(80),
  materialRoot: z.string().min(1),
  releaseNameTemplate: z.string().min(1),
  releaseEpisodeBase: z.number().int().min(0).max(9999),
  releaseEpisodeWidth: z.number().int().min(1).max(4).default(2),
  episodeCount: z.number().int().min(1).max(999),
  localStart: z.number().int().min(1).max(999).default(1),
  workNameTemplate: z.string().min(1).default('{anime} - {ep}'),
  /** 空字符串 = 不使用「翻译用」子目录，文件直接放集目录 */
  subDirName: z.string().max(80).default(''),
  outputMode: z.enum(['episode-output', 'project-release']).default('episode-output')
})

export type CreateProjectInputRaw = z.infer<typeof createProjectInputSchema>

export interface CreateProjectInput {
  animeName: string
  materialRoot: string
  releaseNameTemplate: string
  releaseEpisodeBase: number
  releaseEpisodeWidth?: number
  episodeCount: number
  localStart?: number
  workNameTemplate?: string
  subDirName?: string
  outputMode?: 'episode-output' | 'project-release'
}

export interface NormalizedCreateProjectInput {
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

export function normalizeInput(input: CreateProjectInput): NormalizedCreateProjectInput {
  return {
    animeName: input.animeName,
    materialRoot: input.materialRoot,
    releaseNameTemplate: input.releaseNameTemplate,
    releaseEpisodeBase: input.releaseEpisodeBase,
    releaseEpisodeWidth: input.releaseEpisodeWidth ?? 2,
    episodeCount: input.episodeCount,
    localStart: input.localStart ?? 1,
    workNameTemplate: input.workNameTemplate || '{anime} - {ep}',
    subDirName: (input.subDirName ?? '').trim(),
    outputMode: input.outputMode ?? 'episode-output'
  }
}

export interface EpisodePreview {
  localNo: string
  releaseNo: string
  workName: string
  dir: string
  subDir: string
  outputDir: string
  state: EpisodeRecord['state']
}

export interface TreeLine {
  depth: number
  name: string
  kind: 'dir' | 'file'
  note?: string
}

export interface ProjectPreview {
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
  episodes: EpisodePreview[]
  tree: TreeLine[]
}

function localWidth(count: number, start: number): number {
  const last = start + count - 1
  return Math.max(2, String(last).length)
}

export function localNoOf(
  index: number,
  input: Pick<NormalizedCreateProjectInput, 'localStart' | 'episodeCount'>
): string {
  const width = localWidth(input.episodeCount, input.localStart)
  return String(input.localStart + index).padStart(width, '0')
}

export function buildProjectMeta(input: CreateProjectInput, operator: string): ProjectMeta {
  const full = normalizeInput(input)
  const animeName = full.animeName.trim()
  const rootPath = path.join(full.materialRoot, animeName)
  return {
    id: randomId('prj'),
    animeName,
    materialRoot: full.materialRoot,
    rootPath,
    releaseNameTemplate: full.releaseNameTemplate,
    releaseEpisodeBase: full.releaseEpisodeBase,
    releaseEpisodeWidth: full.releaseEpisodeWidth,
    episodeCount: full.episodeCount,
    localStart: full.localStart,
    workNameTemplate: full.workNameTemplate,
    subDirName: full.subDirName,
    outputMode: full.outputMode,
    createdAt: nowIso(),
    updatedAt: nowIso()
  }
}

export function buildEpisodes(meta: ProjectMeta, settings?: Partial<AppSettings>): EpisodeRecord[] {
  const episodes: EpisodeRecord[] = []
  const width = localWidth(meta.episodeCount, meta.localStart)
  for (let i = 0; i < meta.episodeCount; i += 1) {
    const localNo = String(meta.localStart + i).padStart(width, '0')
    const releaseNoNum = meta.releaseEpisodeBase + i
    const releaseNo = formatRelease(releaseNoNum, meta.releaseEpisodeWidth)
    const dir = path.join(meta.rootPath, localNo)
    // 子目录名为空时，字幕/章节草稿等直接放在集目录下（与 json/vpy/output 同级）
    const subDir = meta.subDirName ? path.join(meta.rootPath, meta.subDirName, localNo) : dir
    const output = meta.outputMode === 'project-release'
      ? path.join(meta.rootPath, 'release')
      : path.join(dir, 'output')
    const vars = createVariableMap({
      anime: meta.animeName,
      localNo,
      localInt: Number(localNo),
      releaseNo,
      releaseInt: releaseNoNum,
      releaseRaw: String(releaseNoNum),
      root: meta.materialRoot,
      project: meta.rootPath,
      epDir: dir,
      subDir,
      output,
      ext: 'mkv',
      workNameTemplate: meta.workNameTemplate,
      epSource: settings?.naming?.workNameEpSource ?? 'release'
    })
    episodes.push({
      id: `${meta.id}-${localNo}`,
      projectId: meta.id,
      localNo,
      releaseNo,
      state: 'INIT',
      workName: vars.work ?? `${meta.animeName} - ${releaseNo}`,
      dir,
      subDir,
      templateJson: null,
      templateVpy: null,
      subtitle: null,
      reviewVideo: null,
      aiRunId: null,
      aiVerdict: null,
      human: null,
      chapterDraft: null,
      chapters: null,
      encode: null,
      merge: null,
      transcode: null,
      final: null,
      staleReasons: [],
      note: '',
      updatedAt: nowIso()
    })
  }
  return episodes
}

export function previewProject(input: CreateProjectInput): ProjectPreview {
  const errors: string[] = []
  const warnings: string[] = []
  const full = normalizeInput(input)

  const nameError = validateAnimeName(full.animeName)
  if (nameError) errors.push(nameError)
  const tplError = validateReleaseTemplate(full.releaseNameTemplate)
  if (tplError) errors.push(tplError)
  if (!existsLong(full.materialRoot)) errors.push(`素材根目录不存在：${full.materialRoot}`)
  else {
    try {
      fs.accessSync(toLongPath(full.materialRoot), fs.constants.W_OK)
    } catch {
      errors.push(`素材根目录不可写：${full.materialRoot}`)
    }
  }
  if (full.episodeCount < 1 || full.episodeCount > 999) errors.push('总集数需在 1–999 之间')
  if (!full.releaseNameTemplate.includes('{release}')) errors.push('发布名模板缺少 {release}')
  const subDirError = validateSubDirName(full.subDirName)
  if (subDirError) errors.push(subDirError)

  const meta = buildProjectMeta(input, '')
  const episodes = buildEpisodes(meta)
  const rootExists = existsLong(meta.rootPath)
  const existingLocalDirs: string[] = []
  const missingLocalDirs: string[] = []
  for (const ep of episodes) {
    if (existsLong(ep.dir)) existingLocalDirs.push(ep.localNo)
    else missingLocalDirs.push(ep.localNo)
  }
  const existingSubDir = meta.subDirName ? existsLong(path.join(meta.rootPath, meta.subDirName)) : false
  const hasState = ProjectStore.exists(meta.rootPath)

  if (rootExists && !hasState) {
    warnings.push('目录已存在但没有 EpFlow 状态库，将以「复用」模式补建缺失目录')
  }
  if (existingLocalDirs.length > 0 && existingLocalDirs.length < episodes.length) {
    warnings.push(`已有 ${existingLocalDirs.length} 个集目录，将复用并补齐其余目录（不会删除任何文件）`)
  }
  const candidates = findReleaseCandidates(input.releaseNameTemplate.replace('{release}', '01'))
  void candidates

  const tree: TreeLine[] = [
    { depth: 0, name: path.basename(meta.rootPath) || meta.rootPath, kind: 'dir', note: '项目根' },
    { depth: 1, name: ProjectStore.stateDir(''), kind: 'dir', note: '软件状态库' },
    { depth: 1, name: 'project.json / episodes.json', kind: 'file', note: '可读快照' }
  ]
  if (meta.subDirName) {
    tree.push({ depth: 1, name: meta.subDirName, kind: 'dir', note: '翻译用' })
  }
  const epDepth = meta.subDirName ? 2 : 1
  for (const ep of episodes.slice(0, 4)) {
    tree.push({ depth: epDepth, name: ep.localNo, kind: 'dir' })
    tree.push({
      depth: epDepth + 1,
      name: `${ep.workName}.ass`,
      kind: 'file',
      note: meta.subDirName ? '字幕（导入后生成）' : '字幕（与 json/vpy 同目录）'
    })
  }
  if (episodes.length > 4) tree.push({ depth: epDepth, name: `… 共 ${episodes.length} 集`, kind: 'dir' })
  tree.push({ depth: 1, name: '01 … nn', kind: 'dir', note: '集目录（json/vpy/mkv/output）' })

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    animeName: meta.animeName,
    rootPath: meta.rootPath,
    conflicts: {
      rootExists,
      existingLocalDirs,
      missingLocalDirs,
      existingSubDir,
      hasState
    },
    episodes: episodes.map((e) => ({
      localNo: e.localNo,
      releaseNo: e.releaseNo,
      workName: e.workName,
      dir: e.dir,
      subDir: e.subDir,
      outputDir: e.dir + path.sep + 'output',
      state: e.state
    })),
    tree
  }
}

export interface CreateProjectOptions {
  conflict: 'reuse' | 'abort' | 'rename'
  renamedAnime?: string
  operator: string
  settings: AppSettings
}

export function createProject(input: CreateProjectInput, options: CreateProjectOptions): ProjectSnapshot {
  const preview = previewProject(input)
  if (!preview.ok) throw new Error(preview.errors.join('；'))

  let effective: CreateProjectInput = normalizeInput(input)
  const existingRoot = existsLong(preview.rootPath)
  if (existingRoot) {
    if (options.conflict === 'abort') throw new Error('已取消：目标目录已存在')
    if (options.conflict === 'rename') {
      const base = (options.renamedAnime ?? input.animeName).trim()
      if (!base) throw new Error('改名不能为空')
      effective = { ...effective, animeName: base }
      let attempt = 1
      while (existsLong(path.join(effective.materialRoot, effective.animeName))) {
        attempt += 1
        effective.animeName = `${base} (${attempt})`
      }
      preview.rootPath = path.join(effective.materialRoot, effective.animeName)
    }
  }

  const meta = buildProjectMeta(effective, options.operator)
  const episodes = buildEpisodes(meta, options.settings)

  // 创建目录树（只增不删）
  ensureDir(meta.rootPath)
  ensureDir(ProjectStore.stateDir(meta.rootPath))
  if (meta.subDirName) ensureDir(path.join(meta.rootPath, meta.subDirName))
  if (meta.outputMode === 'project-release') ensureDir(path.join(meta.rootPath, 'release'))
  for (const ep of episodes) {
    ensureDir(ep.dir)
    if (ep.subDir !== ep.dir) ensureDir(ep.subDir)
    if (meta.outputMode === 'episode-output') ensureDir(path.join(ep.dir, 'output'))
  }

  let store: ProjectStore
  if (ProjectStore.exists(meta.rootPath)) {
    // 复用已有状态库：保留已有集状态，只补建缺失集
    store = openStore(meta.rootPath)
    for (const ep of episodes) store.addEpisode(ep)
  } else {
    store = ProjectStore.create(meta, episodes)
  }
  store.writeSnapshots()
  store.appendAudit(
    'project.create',
    {
      animeName: meta.animeName,
      releaseBase: meta.releaseEpisodeBase,
      episodeCount: meta.episodeCount,
      localStart: meta.localStart,
      conflict: options.conflict
    },
    null,
    options.operator
  )

  upsertProjectIndex({
    id: store.project.id,
    animeName: store.project.animeName,
    rootPath: store.project.rootPath,
    episodeCount: store.project.episodeCount,
    lastOpenedAt: nowIso()
  })

  log.info('project created', { root: meta.rootPath, episodes: episodes.length })
  return { project: store.project, episodes: store.episodes }
}

export interface ProjectSummary {
  id: string
  animeName: string
  rootPath: string
  episodeCount: number
  exists: boolean
  lastOpenedAt: string
  stateCounts: Record<string, number>
  doneCount: number
}

export function listProjects(): ProjectSummary[] {
  const state = loadAppState()
  const out: ProjectSummary[] = []
  for (const entry of state.projects) {
    const exists = ProjectStore.exists(entry.rootPath)
    let counts: Record<string, number> = {}
    let episodeCount = entry.episodeCount
    if (exists) {
      try {
        const store = openStore(entry.rootPath)
        counts = {}
        for (const ep of store.episodes) counts[ep.state] = (counts[ep.state] ?? 0) + 1
        episodeCount = store.episodes.length
      } catch {
        /* 损坏项目按缺失处理 */
      }
    }
    out.push({
      id: entry.id,
      animeName: entry.animeName,
      rootPath: entry.rootPath,
      episodeCount,
      exists,
      lastOpenedAt: entry.lastOpenedAt,
      stateCounts: counts,
      doneCount: (counts.DONE ?? 0) + (counts.NAMED ?? 0)
    })
  }
  return out
}

export function openProject(rootPath: string): ProjectSnapshot {
  const store = openStore(rootPath)
  upsertProjectIndex({
    id: store.project.id,
    animeName: store.project.animeName,
    rootPath: store.project.rootPath,
    episodeCount: store.project.episodeCount,
    lastOpenedAt: nowIso()
  })
  return { project: store.project, episodes: store.episodes }
}

export interface DetectedProject {
  rootPath: string
  animeName: string
  hasState: boolean
  episodeDirs: string[]
  sampleFiles: string[]
  guessedReleaseBase: number | null
  guessedReleaseWidth: number
}

/** 扫描素材根目录，识别现有工程（只读） */
export function scanMaterialRoot(materialRoot: string): DetectedProject[] {
  const out: DetectedProject[] = []
  for (const dir of listDirs(materialRoot)) {
    const name = path.basename(dir)
    if (name.startsWith('_') || name.startsWith('.')) continue
    const entries = listDir(dir)
    const episodeDirs = entries.filter((e) => /^\d{2,3}$/.test(e)).sort()
    const sampleFiles: string[] = []
    const pushSample = (d: string) => {
      for (const f of listDir(d)) {
        if (/\.(json|vpy|ass|ssa|xml)$/i.test(f) && sampleFiles.length < 8) sampleFiles.push(f)
      }
    }
    pushSample(dir)
    for (const ep of episodeDirs.slice(0, 2)) pushSample(path.join(dir, ep))
    if (episodeDirs.length === 0 && sampleFiles.length === 0) continue

    let guessedBase: number | null = null
    let guessedWidth = 2
    const firstEp = episodeDirs[0]
    if (firstEp) {
      const jsonName = listDir(path.join(dir, firstEp)).find((f) => /\.json$/i.test(f))
      if (jsonName) {
        const m = /(\d{1,4})(?=[^\d]*\.json$)/.exec(jsonName)
        if (m && m[1]) {
          guessedBase = Number(m[1])
          guessedWidth = m[1].length
        }
      }
    }
    out.push({
      rootPath: dir,
      animeName: name,
      hasState: ProjectStore.exists(dir),
      episodeDirs,
      sampleFiles,
      guessedReleaseBase: guessedBase,
      guessedReleaseWidth: guessedWidth
    })
  }
  return out
}

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.webm', '.ts', '.m2ts', '.flv', '.wmv', '.mpg', '.mpeg'])

/** 为某一集设置审阅用视频（传 null 表示恢复为模板源视频） */
export function setReviewVideo(
  rootPath: string,
  localNo: string,
  videoPath: string | null,
  operator: string
): EpisodeRecord {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  if (videoPath) {
    if (!existsLong(videoPath)) throw new Error(`视频文件不存在：${videoPath}`)
    const ext = path.extname(videoPath).toLowerCase()
    if (!VIDEO_EXTENSIONS.has(ext)) throw new Error(`不支持的视频格式：${ext}`)
  }
  store.updateEpisode(localNo, {
    reviewVideo: videoPath ? { path: videoPath, setAt: nowIso(), source: 'manual' } : null
  })
  store.appendAudit('episode.video', { path: videoPath }, ep.id, operator)
  return store.getEpisode(localNo)
}

export function setReleaseNo(rootPath: string, localNo: string, releaseNo: string, operator: string): ProjectSnapshot {  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  const prev = ep.releaseNo
  store.updateEpisode(localNo, { releaseNo })
  store.appendAudit('episode.release-no', { localNo, from: prev, to: releaseNo }, ep.id, operator)
  return { project: store.project, episodes: store.episodes }
}

export function updateProjectMeta(
  rootPath: string,
  patch: Partial<Pick<ProjectMeta, 'releaseNameTemplate' | 'releaseEpisodeBase' | 'workNameTemplate' | 'subDirName' | 'outputMode'>>,
  operator: string
): ProjectSnapshot {
  const store = openStore(rootPath)
  const next = store.updateProject(patch)
  // 发布名/工作名模板变化：重算工作名（保留用户已手工修正的 releaseNo）
  const episodes = buildEpisodes(next)
  for (const ep of store.episodes) {
    const computed = episodes.find((e) => e.localNo === ep.localNo)
    if (!computed) continue
    if (computed.workName !== ep.workName) {
      store.updateEpisode(ep.localNo, { workName: computed.workName })
    }
  }
  // 翻译用子目录变化：把字幕/章节草稿迁到新位置，保证路径与目录布局一致
  if (patch.subDirName !== undefined) {
    const result = emptyLayoutResult()
    for (const ep of [...store.episodes]) relocateEpisodeFiles(store, ep, targetSubDirOf(next, ep), result)
    store.appendAudit('project.layout-move', { moved: result.moved.length, skipped: result.skipped.length }, null, operator)
  }
  store.appendAudit('project.update', patch as Record<string, unknown>, null, operator)
  return { project: store.project, episodes: store.episodes }
}

export interface LayoutFileMove {
  from: string
  to: string
}

export interface LayoutMigrationResult {
  moved: LayoutFileMove[]
  skipped: string[]
  removedDirs: string[]
  removedBackups: string[]
}

function emptyLayoutResult(): LayoutMigrationResult {
  return { moved: [], skipped: [], removedDirs: [], removedBackups: [] }
}

function targetSubDirOf(meta: ProjectMeta, ep: EpisodeRecord): string {
  return meta.subDirName ? path.join(meta.rootPath, meta.subDirName, ep.localNo) : ep.dir
}

/** 把单个文件移动到目标目录；文件已在目标目录或不存在时原样返回 */
function moveFileInto(filePath: string | null | undefined, dir: string, result: LayoutMigrationResult): string | null {
  if (!filePath || !existsLong(filePath)) return filePath ?? null
  const fromDir = path.resolve(path.dirname(filePath)).toLowerCase()
  if (fromDir === path.resolve(dir).toLowerCase()) return filePath
  const target = path.join(dir, path.basename(filePath))
  if (existsLong(target)) {
    result.skipped.push(`${filePath}（目标已存在：${target}）`)
    return filePath
  }
  ensureDir(dir)
  fs.renameSync(toLongPath(filePath), toLongPath(target))
  result.moved.push({ from: filePath, to: target })
  // 迁移时顺手清掉 EpFlow 自己生成的备份，避免它们继续留在旧目录里
  for (const suffix of ['.orig', '.bak']) {
    const sidecar = `${filePath}${suffix}`
    if (!existsLong(sidecar)) continue
    try {
      fs.rmSync(toLongPath(sidecar), { force: true })
      result.removedBackups.push(sidecar)
    } catch {
      /* 删除失败不影响迁移 */
    }
  }
  return target
}

/** 把某一集的字幕/章节草稿迁到 targetDir，并同步状态里的路径 */
function relocateEpisodeFiles(
  store: ProjectStore,
  ep: EpisodeRecord,
  targetDir: string,
  result: LayoutMigrationResult
): void {
  const patch: Partial<EpisodeRecord> = {}
  if (ep.subtitle) {
    const moved = moveFileInto(ep.subtitle.path, targetDir, result)
    if (moved && moved !== ep.subtitle.path) patch.subtitle = { ...ep.subtitle, path: moved }
  }
  if (ep.chapterDraft) {
    const moved = moveFileInto(ep.chapterDraft.path, targetDir, result)
    if (moved && moved !== ep.chapterDraft.path) patch.chapterDraft = { ...ep.chapterDraft, path: moved }
  }
  if (ep.subDir !== targetDir) patch.subDir = targetDir
  if (Object.keys(patch).length > 0) store.updateEpisode(ep.localNo, patch)
}

function cleanupEmptyDir(dir: string, result: LayoutMigrationResult): void {
  try {
    fs.rmdirSync(toLongPath(dir))
    result.removedDirs.push(dir)
  } catch {
    /* 目录不存在或非空：保留 */
  }
}

/**
 * 把项目从「根目录/翻译用/集号/」布局迁移成「根目录/集号/」扁平布局：
 * 字幕、章节草稿等直接放到集目录，与 json/vpy/output 同级。
 * 只移动文件、不改文件内容；迁移后项目 subDirName 置空。
 */
export function migrateToFlatLayout(rootPath: string, operator: string): LayoutMigrationResult {
  const store = openStore(rootPath)
  const meta = store.project
  const oldSubName = meta.subDirName
  const result = emptyLayoutResult()

  for (const ep of [...store.episodes]) relocateEpisodeFiles(store, ep, ep.dir, result)

  if (oldSubName) {
    store.updateProject({ subDirName: '' })
    for (const ep of store.episodes) cleanupEmptyDir(path.join(rootPath, oldSubName, ep.localNo), result)
    cleanupEmptyDir(path.join(rootPath, oldSubName), result)
  }
  store.appendAudit(
    'project.layout-flat',
    { from: oldSubName, moved: result.moved.length, removedDirs: result.removedDirs.length },
    null,
    operator
  )
  return result
}

export function resolveReleaseTemplateFromName(name: string): string {
  const candidate = chooseDefaultCandidate(findReleaseCandidates(name))
  return toReleaseTemplate(name, candidate)
}

export function suggestionForRoot(materialRoot: string, animeName: string): string {
  return path.join(sanitizeFileName(materialRoot, { replacement: '_' }), animeName)
}

export interface RecoverResult {
  /** 状态被回退的集 */
  recovered: string[]
  /** 启动哈希校验发现字幕变化的集 */
  verified: string[]
}

/**
 * 启动恢复：处理过渡态 + 字幕哈希复核（§7.3 崩溃恢复 / §FR-06 锁定校验）
 */
export async function recoverProject(rootPath: string, actor: string): Promise<RecoverResult> {
  const store = openStore(rootPath)
  const recovered: string[] = []
  for (const ep of store.episodes) {
    if (ep.state === 'AI_REVIEWING') {
      store.transition(ep.localNo, 'SUB_IMPORTED', 'recover', { from: ep.state }, actor)
      recovered.push(ep.localNo)
    } else if (ep.state === 'CHAPTER_REVIEWING') {
      store.transition(ep.localNo, 'CHAPTER_DRAFT', 'recover', { from: ep.state }, actor)
      recovered.push(ep.localNo)
    } else if (ep.state === 'ENCODING') {
      store.transition(ep.localNo, 'CHAPTER_LOCKED', 'recover', { from: ep.state }, actor)
      recovered.push(ep.localNo)
    }
  }
  const verified: string[] = []
  const { verifyAllSubtitles } = await import('./subtitle-service')
  const changed = await verifyAllSubtitles(rootPath, actor)
  verified.push(...changed)
  return { recovered, verified }
}

export function indexEntryOf(snapshot: ProjectSnapshot): ProjectIndexEntry {
  return {
    id: snapshot.project.id,
    animeName: snapshot.project.animeName,
    rootPath: snapshot.project.rootPath,
    episodeCount: snapshot.project.episodeCount,
    lastOpenedAt: nowIso()
  }
}
