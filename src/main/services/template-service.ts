import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, EpisodeRecord, ProjectMeta, ProjectSnapshot } from '@shared/types'
import { createVariableMap, expandVariables, type VariableMap } from '@shared/template-vars'
import { diffLines, type DiffLine } from '@shared/diff'
import { nowIso } from '@shared/time'
import { ProjectStore, openStore } from '../store/repository'
import { ensureDir, existsLong, toLongPath, timestamp } from '../util/paths'
import { writeFileAtomic } from '../store/atomic'
import { scoped } from '../util/logger'
import { runProcess } from '../integrations/process-runner'
import { resolveTool } from '../integrations/tools'

const log = scoped('template')

export const TEMPLATE_DIR = '.templates'

export interface TemplateInfo {
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
  /** JSON 里出现的全部绝对路径 */
  absolutePaths: string[]
}

export interface TemplateBundle {
  rootPath: string
  jsonPath: string | null
  vpyPath: string | null
  jsonText: string | null
  vpyText: string | null
  info: TemplateInfo | null
}

export interface Substitution {
  id: string
  kind: 'work' | 'anime' | 'path' | 'episode' | 'subtitle' | 'custom'
  from: string
  to: string
  count: number
  enabled: boolean
  /** 替换只发生在哪些文件 */
  scope: 'json' | 'vpy' | 'both'
}

export interface TemplateAnalysis {
  bundle: TemplateBundle
  substitutions: Substitution[]
  warnings: string[]
  hasPlaceholders: boolean
}

function templateDir(root: string): string {
  return path.join(root, TEMPLATE_DIR)
}

export function loadBundle(rootPath: string): TemplateBundle {
  const dir = templateDir(rootPath)
  const jsonPath = path.join(dir, 'source.json')
  const vpyPath = path.join(dir, 'source.vpy')
  const bundle: TemplateBundle = {
    rootPath,
    jsonPath: existsLong(jsonPath) ? jsonPath : null,
    vpyPath: existsLong(vpyPath) ? vpyPath : null,
    jsonText: null,
    vpyText: null,
    info: null
  }
  if (bundle.jsonPath) bundle.jsonText = fs.readFileSync(toLongPath(bundle.jsonPath), 'utf8').replace(/^\uFEFF/, '')
  if (bundle.vpyPath) bundle.vpyText = fs.readFileSync(toLongPath(bundle.vpyPath), 'utf8').replace(/^\uFEFF/, '')
  bundle.info = analyzeBundle(bundle)
  return bundle
}

/** 保存上传的模板文件到 .templates\source.* */
export function saveTemplateFiles(rootPath: string, files: string[]): TemplateBundle {
  const dir = templateDir(rootPath)
  ensureDir(dir)
  for (const file of files) {
    const ext = path.extname(file).toLowerCase()
    const name = ext === '.json' ? 'source.json' : ext === '.vpy' ? 'source.vpy' : null
    if (!name) continue
    const target = path.join(dir, name)
    if (existsLong(target)) {
      fs.copyFileSync(toLongPath(target), toLongPath(`${target}.bak.${timestamp()}`))
    }
    fs.copyFileSync(toLongPath(file), toLongPath(target))
  }
  return loadBundle(rootPath)
}

export function analyzeBundle(bundle: TemplateBundle): TemplateInfo {
  const info: TemplateInfo = {
    projectName: null,
    inputScript: null,
    inputFiles: [],
    vpyInput: null,
    vpySubtitle: null,
    oldEpDir: null,
    oldAnime: null,
    oldLocal: null,
    oldRelease: null,
    oldWork: null,
    absolutePaths: []
  }

  if (bundle.jsonText) {
    try {
      const parsed = JSON.parse(bundle.jsonText) as Record<string, unknown>
      if (typeof parsed.ProjectName === 'string') info.projectName = parsed.ProjectName
      if (typeof parsed.InputScript === 'string') info.inputScript = parsed.InputScript
      if (Array.isArray(parsed.InputFiles)) {
        info.inputFiles = parsed.InputFiles.filter((x): x is string => typeof x === 'string')
      }
      collectPaths(parsed, info.absolutePaths)
    } catch {
      /* JSON 语法错误在 preview 阶段报出 */
    }
  }

  if (bundle.vpyText) {
    const inputMatch = /#\s*OKE:INPUTFILE[^\n]*\n[^\n]*?R?"([^"]+)"/.exec(bundle.vpyText)
    if (inputMatch?.[1]) info.vpyInput = inputMatch[1]
    const subMatch = /TextSub(?:Mod)?\s*\([^,]*,\s*R?"([^"]+)"/.exec(bundle.vpyText)
    if (subMatch?.[1]) info.vpySubtitle = subMatch[1]
    for (const m of bundle.vpyText.matchAll(/R?"([A-Za-z]:[\\/][^"]+)"/g)) {
      if (m[1] && !info.absolutePaths.includes(m[1])) info.absolutePaths.push(m[1])
    }
  }

  const samplePath = info.vpyInput ?? info.inputFiles[0] ?? info.absolutePaths[0] ?? null
  if (samplePath) {
    const normalized = samplePath.replace(/\//g, '\\')
    const isAbsolute = /^[A-Za-z]:[\\/]/.test(normalized)
    // 相对路径（例如 vpy 里只写了文件名）不能拿来推导「旧集目录 / 旧番名」，
    // 否则 path.dirname 会得到 "."，替换时会把整份脚本里的所有点变成路径。
    if (isAbsolute) {
      const epDir = path.dirname(normalized)
      info.oldEpDir = epDir
      info.oldLocal = path.basename(epDir)
      info.oldAnime = path.basename(path.dirname(epDir))
    }
    const stem = path.basename(normalized, path.extname(normalized))
    info.oldWork = stem
    const rel = /(?:^|[.\s_-])(?:S\d{1,2})?E(?:P)?(\d{1,3})$/i.exec(stem)
    const cn = /第\s*(\d{1,3})\s*[集话話]/.exec(stem)
    info.oldRelease = rel?.[1] ?? cn?.[1] ?? null
  }
  if (!info.oldRelease && info.projectName) {
    const m = /(?:E|EP|第)\s*(\d{1,3})\s*$/.exec(info.projectName.trim())
    if (m?.[1]) info.oldRelease = m[1]
  }
  return info
}

function collectPaths(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return
  if (typeof value === 'string') {
    if (/^[A-Za-z]:[\\/]/.test(value) && !out.includes(value)) out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collectPaths(v, out, depth + 1)
    return
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) collectPaths(v, out, depth + 1)
  }
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = 0
  for (;;) {
    const found = text.indexOf(needle, index)
    if (found < 0) break
    count += 1
    index = found + needle.length
  }
  return count
}

const ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/

/**
 * 替换源必须足够具体：至少 3 个字符、且包含字母或中文。
 * 否则 "."、"01"、"-" 这类短串会把整份模板里的标点/数字全部替换掉。
 */
export function isSafeSubstitutionSource(value: string | null | undefined): value is string {
  if (!value) return false
  const text = value.trim()
  if (text.length < 3) return false
  if (text === '.' || text === '..') return false
  return /[A-Za-z\u4e00-\u9fa5]/.test(text)
}

/** 生成候选替换表（L2），并按出现次数排序 */
export function buildSubstitutions(bundle: TemplateBundle, info: TemplateInfo): Substitution[] {
  const all = `${bundle.jsonText ?? ''}\n${bundle.vpyText ?? ''}`
  const out: Substitution[] = []
  const add = (
    id: string,
    kind: Substitution['kind'],
    from: string | null,
    to: string,
    scope: Substitution['scope'] = 'both'
  ) => {
    if (!isSafeSubstitutionSource(from)) return
    // 原始文本里 JSON 的路径是双反斜杠（D:\\media\\...），vpy 里可能是正斜杠，
    // 因此计数要同时考虑转义形式，否则「绝对路径」替换会被误判为不存在。
    const variants = [from, from.replace(/\\/g, '\\\\'), from.replace(/\\/g, '/')]
    const count = Math.max(...variants.map((v) => countOccurrences(all, v)))
    if (count === 0) return
    if (out.some((s) => s.from === from)) return
    out.push({ id, kind, from, to, count, enabled: true, scope })
  }

  for (const file of info.inputFiles) {
    const stem = path.basename(file, path.extname(file))
    if (ABSOLUTE_PATH.test(file)) add(`input-${out.length}`, 'path', file, '{ep_dir}\\{work}.mkv', 'both')
    add(`input-stem-${out.length}`, 'work', stem, '{work}')
  }
  if (isSafeSubstitutionSource(info.vpyInput)) {
    // 相对路径（只写文件名）也映射到规范路径；绝对路径同样映射到当前集目录
    add('vpy-input', 'path', info.vpyInput, '{ep_dir}\\{work}.mkv')
  }
  if (isSafeSubstitutionSource(info.vpySubtitle)) {
    add('vpy-subtitle', 'subtitle', info.vpySubtitle, '{sub_dir}\\{work}.ass')
  }
  if (isSafeSubstitutionSource(info.oldEpDir)) add('old-ep-dir', 'path', info.oldEpDir, '{ep_dir}')
  add('old-work', 'work', info.oldWork, '{work}')
  if (isSafeSubstitutionSource(info.oldAnime)) add('old-anime', 'anime', info.oldAnime, '{anime}')
  // 不再按「裸集数」替换：集数通常已包含在工作名/文件名里，
  // 单独替换 "01" 会误伤版本号、参数小数等无关内容。

  return out.sort((a, b) => b.from.length - a.from.length)
}

export function analyzeTemplate(rootPath: string): TemplateAnalysis {
  const bundle = loadBundle(rootPath)
  const warnings: string[] = []
  if (!bundle.jsonText) warnings.push('尚未上传 JSON 模板')
  if (!bundle.vpyText) warnings.push('尚未上传 VPY 模板')
  const info = bundle.info ?? analyzeBundle(bundle)
  const substitutions = buildSubstitutions(bundle, info)
  const hasPlaceholders = /\{(anime|local|release|ep|work|root|project|ep_dir|sub_dir|output|ext)\}/.test(
    `${bundle.jsonText ?? ''}${bundle.vpyText ?? ''}`
  )
  if (!hasPlaceholders && substitutions.length === 0) {
    warnings.push('模板既没有变量占位符，也没有识别到旧番名/旧路径，可能需要手工映射（L3）')
  }
  if (bundle.jsonText) {
    try {
      JSON.parse(bundle.jsonText)
    } catch (err) {
      warnings.push(`JSON 语法错误：${(err as Error).message}`)
    }
  }
  return { bundle, substitutions, warnings, hasPlaceholders }
}

export interface RenderVarsInput {
  meta: ProjectMeta
  episode: EpisodeRecord
  settings: Pick<AppSettings, 'naming'>
}

function variableMapOf(input: RenderVarsInput, ext: string): VariableMap {
  const { meta, episode } = input
  const output =
    meta.outputMode === 'project-release' ? path.join(meta.rootPath, 'release') : path.join(episode.dir, 'output')
  const releaseInt = Number(episode.releaseNo)
  return createVariableMap({
    anime: meta.animeName,
    localNo: episode.localNo,
    localInt: Number(episode.localNo),
    releaseNo: episode.releaseNo,
    releaseInt: Number.isFinite(releaseInt) ? releaseInt : 0,
    releaseRaw: String(releaseInt),
    root: meta.materialRoot,
    project: meta.rootPath,
    epDir: episode.dir,
    subDir: episode.subDir,
    output,
    ext,
    workNameTemplate: meta.workNameTemplate,
    epSource: input.settings.naming.workNameEpSource
  })
}

function applySubstitutions(text: string, substitutions: Substitution[], scope: 'json' | 'vpy'): string {
  let out = text
  const active = substitutions
    .filter((s) => s.enabled && (s.scope === 'both' || s.scope === scope))
    .filter((s) => isSafeSubstitutionSource(s.from))
    .sort((a, b) => b.from.length - a.from.length)
  for (const sub of active) {
    if (!sub.from) continue
    out = out.split(sub.from).join(sub.to)
  }
  return out
}

function normalizeSlashesInQuotes(text: string, style: 'posix' | 'win'): string {
  return text.replace(/R?"([^"]*)"/g, (all, inner: string) => {
    const normalized = style === 'posix' ? inner.replace(/\\/g, '/') : inner.replace(/\//g, '\\')
    const quote = all.startsWith('R') ? 'R"' : '"'
    return `${quote}${normalized}"`
  })
}

/**
 * 普通字符串里的 Windows 绝对路径必须改成 raw string：
 * "D:\...\01\x.ass" 中的 \0 会被 Python 当成八进制转义，\t、\n 同理，
 * 导致 TextSubMod / LWLibavSource 打不开文件。R"..." 里反斜杠保持字面量。
 */
export function quoteWindowsPathsAsRaw(text: string): string {
  return text.replace(/(?<!R)"([A-Za-z]:[\\/][^"\n]*)"/g, (_all, inner: string) => {
    // 模板里若已经写成 \\ 转义形式，先还原成单反斜杠，再交给 raw string
    const normalized = inner.replace(/\\\\/g, '\\')
    return `R"${normalized}"`
  })
}

export interface RenderedFile {
  path: string
  text: string
  warnings: string[]
}

export function renderJsonFor(
  bundle: TemplateBundle,
  vars: VariableMap,
  substitutions: Substitution[],
  input: RenderVarsInput
): RenderedFile {
  const warnings: string[] = []
  if (!bundle.jsonText) throw new Error('缺少 JSON 模板')
  const parsed = JSON.parse(bundle.jsonText) as unknown
  const walk = (value: unknown, key: string | null): unknown => {
    if (typeof value === 'string') {
      const subbed = applySubstitutions(value, substitutions, 'json')
      return expandVariables(subbed, vars).text
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, key))
    if (value && typeof value === 'object') {
      const outObj: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) outObj[k] = walk(v, k)
      return outObj
    }
    return value
  }
  const rendered = walk(parsed, null) as Record<string, unknown>
  if (typeof rendered.ProjectName === 'string') rendered.ProjectName = rendered.ProjectName.trim()
  if (typeof rendered.InputScript === 'string') {
    rendered.InputScript = path.basename(rendered.InputScript.replace(/\//g, '\\'))
  }
  const finalText = `${JSON.stringify(rendered, null, 2)}\n`
  const leftover = findLeftovers(finalText, bundle.info)
  if (leftover.length > 0) {
    warnings.push(`疑似残留旧值：${leftover.slice(0, 3).join('、')}`)
  }
  return { path: '', text: finalText, warnings }
}

export function renderVpyFor(
  bundle: TemplateBundle,
  vars: VariableMap,
  substitutions: Substitution[]
): RenderedFile {
  const warnings: string[] = []
  if (!bundle.vpyText) throw new Error('缺少 VPY 模板')
  const usesPosix = /R"[^"]*\/[^"]*"/.test(bundle.vpyText)
  const substituted = applySubstitutions(bundle.vpyText, substitutions, 'vpy')
  const expanded = expandVariables(substituted, vars).text
  const slashed = usesPosix ? normalizeSlashesInQuotes(expanded, 'posix') : expanded
  const finalText = quoteWindowsPathsAsRaw(slashed)
  const leftover = findLeftovers(finalText, bundle.info)
  if (leftover.length > 0) warnings.push(`疑似残留旧值：${leftover.slice(0, 3).join('、')}`)
  return { path: '', text: finalText, warnings }
}

function findLeftovers(text: string, info: TemplateInfo | null): string[] {
  if (!info) return []
  const out: string[] = []
  // 只比对「旧工作名 / 旧集目录绝对路径」——新路径里出现番名是正常的
  const needles = [info.oldWork, info.oldEpDir].filter((x): x is string => Boolean(x))
  for (const needle of needles) {
    if (needle.length < 6) continue
    const idx = text.indexOf(needle)
    if (idx >= 0) out.push(text.slice(idx, Math.min(text.length, idx + 60)).replace(/\s+/g, ' '))
  }
  return out
}

export interface TemplatePreview {
  localNo: string
  json: { before: string; after: string; diff: DiffLine[] } | null
  vpy: { before: string; after: string; diff: DiffLine[] } | null
  warnings: string[]
  errors: string[]
  substitutions: Substitution[]
}

export function previewTemplate(
  rootPath: string,
  localNo: string,
  substitutions: Substitution[],
  settings: AppSettings
): TemplatePreview {
  const store = openStore(rootPath)
  const episode = store.getEpisode(localNo)
  const analysis = analyzeTemplate(rootPath)
  const warnings: string[] = []
  const errors: string[] = []
  let json: TemplatePreview['json'] = null
  let vpy: TemplatePreview['vpy'] = null
  const vars = variableMapOf({ meta: store.project, episode, settings }, 'mkv')

  if (analysis.bundle.jsonText) {
    try {
      const rendered = renderJsonFor(analysis.bundle, vars, substitutions, {
        meta: store.project,
        episode,
        settings
      })
      json = {
        before: analysis.bundle.jsonText,
        after: rendered.text,
        diff: diffLines(analysis.bundle.jsonText, rendered.text)
      }
      warnings.push(...rendered.warnings)
    } catch (err) {
      errors.push(`JSON 生成失败：${(err as Error).message}`)
    }
  }
  if (analysis.bundle.vpyText) {
    try {
      const rendered = renderVpyFor(analysis.bundle, vars, substitutions)
      vpy = {
        before: analysis.bundle.vpyText,
        after: rendered.text,
        diff: diffLines(analysis.bundle.vpyText, rendered.text)
      }
      warnings.push(...rendered.warnings)
    } catch (err) {
      errors.push(`VPY 生成失败：${(err as Error).message}`)
    }
  }
  return { localNo, json, vpy, warnings: [...new Set(warnings)], errors, substitutions }
}

export interface InstantiateOptions {
  localNos?: string[]
  /** 已存在同名文件时：备份或跳过 */
  onExists: 'backup' | 'skip'
  substitutions?: Substitution[]
  /** 是否运行 python -m py_compile 校验 */
  validateVpy?: boolean
}

export interface InstantiateRow {
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

export async function instantiateTemplates(
  rootPath: string,
  settings: AppSettings,
  options: InstantiateOptions
): Promise<{ rows: InstantiateRow[]; snapshot: ProjectSnapshot }> {
  const store = openStore(rootPath)
  const analysis = analyzeTemplate(rootPath)
  if (!analysis.bundle.jsonText && !analysis.bundle.vpyText) {
    throw new Error('请先上传 JSON / VPY 模板')
  }
  const substitutions = options.substitutions ?? analysis.substitutions
  const targets = options.localNos && options.localNos.length > 0
    ? store.episodes.filter((e) => options.localNos?.includes(e.localNo))
    : store.episodes

  const rows: InstantiateRow[] = []
  for (const episode of targets) {
    const vars = variableMapOf({ meta: store.project, episode, settings }, 'mkv')
    const row: InstantiateRow = {
      localNo: episode.localNo,
      releaseNo: episode.releaseNo,
      jsonPath: null,
      vpyPath: null,
      jsonOk: false,
      vpyOk: false,
      sourceExists: false,
      warnings: [],
      error: null
    }
    try {
      if (analysis.bundle.jsonText) {
        const rendered = renderJsonFor(analysis.bundle, vars, substitutions, {
          meta: store.project,
          episode,
          settings
        })
        const target = path.join(episode.dir, `${episode.workName}.json`)
        if (existsLong(target) && options.onExists === 'skip') {
          row.warnings.push('JSON 已存在，已跳过')
          row.jsonPath = target
          row.jsonOk = true
        } else {
          if (existsLong(target)) {
            fs.copyFileSync(toLongPath(target), toLongPath(`${target}.bak.${timestamp()}`))
          }
          writeFileAtomic(target, rendered.text)
          row.jsonPath = target
          row.jsonOk = true
        }
        row.warnings.push(...rendered.warnings)
        // 校验 InputFiles 指向的源视频
        const parsed = JSON.parse(rendered.text) as { InputFiles?: unknown }
        const files = Array.isArray(parsed.InputFiles)
          ? parsed.InputFiles.filter((x): x is string => typeof x === 'string')
          : []
        row.sourceExists = files.length === 0 || files.every((f) => existsLong(f))
        if (!row.sourceExists) row.warnings.push('源视频缺失（可稍后放置，不阻断）')
      }

      if (analysis.bundle.vpyText) {
        const rendered = renderVpyFor(analysis.bundle, vars, substitutions)
        const target = path.join(episode.dir, `${episode.workName}.vpy`)
        if (existsLong(target) && options.onExists === 'skip') {
          row.warnings.push('VPY 已存在，已跳过')
          row.vpyPath = target
          row.vpyOk = true
        } else {
          if (existsLong(target)) {
            fs.copyFileSync(toLongPath(target), toLongPath(`${target}.bak.${timestamp()}`))
          }
          writeFileAtomic(target, rendered.text)
          row.vpyPath = target
          row.vpyOk = true
        }
        row.warnings.push(...rendered.warnings)
        if (options.validateVpy !== false) {
          const python = resolveTool('python')
          if (python.exists) {
            const check = await runProcess(python.path, ['-m', 'py_compile', target], { timeoutMs: 20_000 })
            if (check.code !== 0) {
              row.vpyOk = false
              row.error = `VPY 语法校验失败：${(check.stderr || check.stdout).split(/\r?\n/).slice(0, 4).join(' ')}`
            }
          }
        }
      }

      if (row.jsonOk || row.vpyOk) {
        const nextState =
          episode.state === 'INIT' || episode.state === 'SUB_IMPORTED' ? 'TEMPLATE_READY' : episode.state
        store.updateEpisode(episode.localNo, {
          templateJson: row.jsonPath,
          templateVpy: row.vpyPath,
          state: nextState
        })
      }
    } catch (err) {
      row.error = (err as Error).message
    }
    rows.push(row)
  }

  store.appendAudit(
    'template.instantiate',
    { count: rows.length, failed: rows.filter((r) => r.error).length },
    null,
    settings.operator
  )
  store.writeSnapshots()
  log.info('templates instantiated', { count: rows.length })
  return { rows, snapshot: { project: store.project, episodes: store.episodes } }
}

export function setEpisodeTemplatePaths(
  rootPath: string,
  localNo: string,
  jsonPath: string | null,
  vpyPath: string | null,
  operator: string
): void {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  store.updateEpisode(localNo, { templateJson: jsonPath, templateVpy: vpyPath })
  store.appendAudit('template.assign', { jsonPath, vpyPath }, ep.id, operator)
}

export function storeTemplateIntoEpisode(rootPath: string, localNo: string, files: string[], operator: string): void {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  let jsonPath = ep.templateJson
  let vpyPath = ep.templateVpy
  for (const file of files) {
    const ext = path.extname(file).toLowerCase()
    if (ext === '.json') jsonPath = file
    if (ext === '.vpy') vpyPath = file
  }
  store.updateEpisode(localNo, { templateJson: jsonPath, templateVpy: vpyPath })
  store.appendAudit('template.assign', { jsonPath, vpyPath }, ep.id, operator)
}

export function templateStatus(rootPath: string): { hasJson: boolean; hasVpy: boolean; dir: string } {
  const dir = templateDir(rootPath)
  return {
    hasJson: existsLong(path.join(dir, 'source.json')),
    hasVpy: existsLong(path.join(dir, 'source.vpy')),
    dir
  }
}

export function ensureTemplateDir(rootPath: string): void {
  ensureDir(templateDir(rootPath))
}

export function templateUpdatedAt(rootPath: string): string {
  const file = path.join(templateDir(rootPath), 'source.json')
  if (!existsLong(file)) return ''
  try {
    return fs.statSync(toLongPath(file)).mtime.toISOString()
  } catch {
    return ''
  }
}

export { nowIso }
