import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type {
  AiVerdict,
  AppSettings,
  EpisodeRecord,
  IssueCategory,
  IssueStatus,
  ReviewIssue,
  ReviewRun,
  ReviewStats,
  Severity
} from '@shared/types'
import { ISSUE_CATEGORIES, SEVERITIES } from '@shared/types'
import { nowIso } from '@shared/time'
import { parseAss, type AssDocument } from '@shared/ass-parser'
import type { ReviewScopeSettings } from '@shared/types'
import { classifyEvent, filterReviewableEvents, findOverlapLayoutIssues, type AssEventKind } from '@shared/ass-classify'
import { ProjectStore, openStore } from '../store/repository'
import { randomId } from '../util/hash'
import { existsLong, toLongPath } from '../util/paths'
import { scoped } from '../util/logger'
import { callDsh, DshUnavailableError, dshAvailable } from '../integrations/dsh-client'
import { buildPrompt, chunkEvents, formatEventRows, PROMPT_VERSION } from './review-prompt'
import { checkSubtitleIntegrity } from './subtitle-service'
import { sha256Text } from '../util/hash'

const log = scoped('review')

export const aiIssueSchema = z.object({
  id: z.string().optional(),
  severity: z.string(),
  category: z.string().optional(),
  line: z.number().nullable().optional(),
  lines: z.array(z.number()).optional(),
  start_ms: z.number().nullable().optional(),
  end_ms: z.number().nullable().optional(),
  original: z.string().optional(),
  suggestion: z.string().optional(),
  reason: z.string().optional(),
  confidence: z.number().nullable().optional()
})

const aiResponseSchema = z.object({
  schema_version: z.string().optional(),
  verdict: z.string().optional(),
  summary: z.string().optional(),
  issues: z.array(aiIssueSchema).default([]),
  stats: z
    .object({
      blocker: z.number().optional(),
      major: z.number().optional(),
      minor: z.number().optional(),
      info: z.number().optional()
    })
    .optional()
})

export type AiResponse = z.infer<typeof aiResponseSchema>

export interface ReviewOutcome {
  run: ReviewRun
  issues: ReviewIssue[]
  warnings: string[]
  episode: EpisodeRecord
}

/* ------------------------------------------------------------------ */
/* 本地检查：只做「同一时间两句是否上下排列」                            */
/* ------------------------------------------------------------------ */

interface DraftIssue {
  severity: Severity
  category: IssueCategory
  line: number | null
  relatedLines: number[] | null
  startMs: number | null
  endMs: number | null
  original: string
  suggestion: string
  reason: string
  confidence: number | null
}

/**
 * 审阅范围收敛为三类：错别字 / 通顺 / 上下排列。
 * 其中只有「上下排列」能本地判断：时间重叠 + 同一样式 + 无定位标签 → 两句会叠在同一位置。
 */
export function localPrecheck(
  doc: AssDocument,
  scope?: Partial<ReviewScopeSettings> | null
): DraftIssue[] {
  const findings = findOverlapLayoutIssues(doc.events, scope)
  return findings.map((finding) => ({
    severity: 'major',
    category: 'layout',
    line: finding.first.index,
    relatedLines: [finding.first.index, finding.second.index],
    startMs: finding.first.startMs,
    endMs: Math.max(finding.first.endMs, finding.second.endMs),
    original: `${finding.first.plain} / ${finding.second.plain}`.slice(0, 200),
    suggestion: '合并成一条对白并用 \\N 上下排列，或给其中一条加对齐/定位（\\an7 / \\an9 / \\pos）',
    reason: finding.reason,
    confidence: 1
  }))
}
/* 结果解析                                                            */
/* ------------------------------------------------------------------ */

export function extractJson(text: string): string | null {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const candidate = fenced?.[1]?.trim() ?? trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return candidate.slice(start, end + 1)
}

export function parseAiResponse(text: string): { ok: true; data: AiResponse } | { ok: false; error: string } {
  const json = extractJson(text)
  if (!json) return { ok: false, error: '响应中找不到 JSON 对象' }
  try {
    const raw = JSON.parse(json) as unknown
    const parsed = aiResponseSchema.safeParse(raw)
    if (!parsed.success) {
      return { ok: false, error: `Schema 校验失败：${parsed.error.issues.map((i) => i.message).join('; ')}` }
    }
    return { ok: true, data: parsed.data }
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${(err as Error).message}` }
  }
}

function normalizeSeverity(value: string): Severity {
  return (SEVERITIES as readonly string[]).includes(value) ? (value as Severity) : 'minor'
}

function normalizeCategory(value: string | undefined): IssueCategory {
  if (value && (ISSUE_CATEGORIES as readonly string[]).includes(value)) return value as IssueCategory
  return 'context'
}

export function computeStats(issues: Pick<ReviewIssue, 'severity'>[]): ReviewStats {
  const stats: ReviewStats = { blocker: 0, major: 0, minor: 0, info: 0 }
  for (const issue of issues) stats[issue.severity] += 1
  return stats
}

export function decideVerdict(issues: Pick<ReviewIssue, 'severity' | 'status'>[]): AiVerdict {
  const blocking = issues.filter(
    (i) => (i.severity === 'blocker' || i.severity === 'major') && i.status !== 'ignored' && i.status !== 'fixed'
  )
  return blocking.length === 0 ? 'pass' : 'fail'
}

/* ------------------------------------------------------------------ */
/* 审阅流程                                                            */
/* ------------------------------------------------------------------ */

function toReviewing(store: ProjectStore, localNo: string, actor: string): void {
  const ep = store.getEpisode(localNo)
  if (ep.state === 'AI_PASSED' || ep.state === 'HUMAN_REVIEWING' || ep.state === 'HUMAN_PASSED'
    || ep.state === 'CHAPTER_DRAFT' || ep.state === 'CHAPTER_LOCKED' || ep.state === 'ENCODE_FAILED'
    || ep.state === 'ENCODED' || ep.state === 'CHAPTER_MERGED' || ep.state === 'NAMED' || ep.state === 'DONE'
    || ep.state === 'MP4_DONE') {
    store.transition(localNo, 'SUB_IMPORTED', 'review.restart', null, actor)
  }
  const current = store.getEpisode(localNo)
  if (current.state !== 'AI_REVIEWING') {
    store.transition(localNo, 'AI_REVIEWING', 'review.start', null, actor)
  }
}

function failReview(
  store: ProjectStore,
  localNo: string,
  message: string,
  actor: string,
  raw: string | null
): ReviewOutcome {
  const ep = store.getEpisode(localNo)
  const started = Date.now()
  const run: ReviewRun = {
    id: randomId('run'),
    episodeId: ep.id,
    runAt: nowIso(),
    model: '',
    promptVersion: PROMPT_VERSION,
    subtitleHash: ep.subtitle?.sha256 ?? '',
    verdict: 'unknown',
    stats: { blocker: 0, major: 0, minor: 0, info: 0 },
    rawResponse: raw ? raw.slice(0, 200_000) : null,
    parseError: message,
    durationMs: Date.now() - started,
    tokenUsage: null,
    issueCount: 0
  }
  store.addRun(run)
  if (ep.state === 'AI_REVIEWING') {
    store.transition(localNo, 'SUB_IMPORTED', 'review.failed', { message }, actor)
  }
  store.appendAudit('review.failed', { message }, ep.id, actor)
  return { run, issues: [], warnings: [message], episode: store.getEpisode(localNo) }
}

function buildIssues(
  raw: AiResponse | null,
  local: DraftIssue[],
  runId: string,
  episodeId: string,
  store: ProjectStore,
  actor: string
): ReviewIssue[] {
  const out: ReviewIssue[] = []
  let counter = 0
  for (const draft of local) {
    counter += 1
    out.push({
      id: `${runId}-L${String(counter).padStart(4, '0')}`,
      runId,
      episodeId,
      severity: draft.severity,
      category: draft.category,
      line: draft.line,
      relatedLines: draft.relatedLines,
      startMs: draft.startMs,
      endMs: draft.endMs,
      original: draft.original,
      suggestion: draft.suggestion,
      reason: draft.reason,
      confidence: draft.confidence,
      status: 'open',
      source: 'local',
      resolutionNote: null,
      resolvedAt: null,
      resolvedBy: null
    })
  }
  void store
  void actor
  if (raw) {
    let aiCounter = 0
    for (const item of raw.issues) {
      aiCounter += 1
      out.push({
        id: `${runId}-A${String(aiCounter).padStart(4, '0')}`,
        runId,
        episodeId,
        severity: normalizeSeverity(item.severity),
        category: normalizeCategory(item.category),
        line: item.line ?? null,
        relatedLines: item.lines && item.lines.length > 0 ? item.lines : null,
        startMs: item.start_ms ?? null,
        endMs: item.end_ms ?? null,
        original: item.original ?? '',
        suggestion: item.suggestion ?? '',
        reason: item.reason ?? '',
        confidence: item.confidence ?? null,
        status: 'open',
        source: 'ai',
        resolutionNote: null,
        resolvedAt: null,
        resolvedBy: null
      })
    }
  }
  return out
}

function readDocument(rootPath: string, localNo: string): AssDocument {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  if (!ep.subtitle?.path || !existsLong(ep.subtitle.path)) {
    throw new Error('该集尚未导入字幕，无法审阅')
  }
  const text = fs.readFileSync(toLongPath(ep.subtitle.path), 'utf8')
  return parseAss(text)
}

export function buildPromptForEpisode(
  rootPath: string,
  localNo: string,
  settings: AppSettings
): { prompt: string; chunks: number; promptFile: string; reviewedLines: number; skippedLines: number } {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  const doc = readDocument(rootPath, localNo)
  const reviewable = filterReviewableEvents(doc.events, settings.review)
  const kinds = new Map<number, AssEventKind>(
    reviewable.map((e) => [e.index, classifyEvent(e, settings.review)])
  )
  const chunks = chunkEvents(reviewable, 24_000)
  const rows = chunks.map((chunk) => formatEventRows(chunk, kinds)).join('\n')
  const glossary = readGlossary(rootPath)
  const prompt = buildPrompt(
    {
      anime: store.project.animeName,
      release: ep.releaseNo,
      localNo: ep.localNo,
      glossary,
      recap: ''
    },
    rows
  )
  const dir = path.join(rootPath, '.epflow', 'prompts')
  fs.mkdirSync(dir, { recursive: true })
  const promptFile = path.join(dir, `${ep.localNo}-${PROMPT_VERSION}.md`)
  fs.writeFileSync(promptFile, prompt, 'utf8')
  const skippedLines = doc.events.length - reviewable.length
  store.appendAudit(
    'review.prompt',
    { chunkCount: chunks.length, promptHash: sha256Text(prompt).slice(0, 12), reviewedLines: reviewable.length, skippedLines },
    ep.id,
    settings.operator
  )
  return { prompt, chunks: chunks.length, promptFile, reviewedLines: reviewable.length, skippedLines }
}

export function readGlossary(rootPath: string): string {
  const file = path.join(rootPath, 'glossary.json')
  if (!fs.existsSync(toLongPath(file))) return ''
  try {
    const data = JSON.parse(fs.readFileSync(toLongPath(file), 'utf8')) as Array<{ term?: string; translation?: string }>
    if (!Array.isArray(data)) return ''
    return data
      .filter((x) => x.term)
      .map((x) => `${x.term} => ${x.translation ?? ''}`)
      .join('\n')
  } catch {
    return ''
  }
}

export function writeGlossary(rootPath: string, glossary: Array<{ term: string; translation: string }>): void {
  fs.writeFileSync(path.join(rootPath, 'glossary.json'), JSON.stringify(glossary, null, 2), 'utf8')
}

export async function runAiReview(
  rootPath: string,
  localNo: string,
  settings: AppSettings,
  actor: string
): Promise<ReviewOutcome> {
  const store = openStore(rootPath)
  const availability = dshAvailable(settings.dsh)
  if (settings.dsh.mode !== 'paste' && !availability.ok) {
    throw new DshUnavailableError(availability.reason ?? 'AI 审阅不可用', '可在设置中切换到「粘贴 JSON」模式')
  }
  if (settings.dsh.mode !== 'paste' && !settings.dsh.allowSubtitleUpload) {
    throw new DshUnavailableError(
      '设置中未允许把字幕文本发送到外部 AI',
      '请到「设置 → AI 审阅」打开「允许发送字幕文本」，或改用「粘贴 JSON」模式自行控制'
    )
  }
  if (settings.dsh.mode === 'paste') {
    throw new DshUnavailableError('当前为「粘贴 JSON」模式', '请先复制 prompt，在 DSH 中审阅后把 JSON 粘贴回来')
  }

  const changed = await checkSubtitleIntegrity(rootPath, localNo, actor)
  if (changed) throw new Error('字幕在审阅前发生变化，请重新发起审阅')

  toReviewing(store, localNo, actor)
  const ep = store.getEpisode(localNo)
  const doc = readDocument(rootPath, localNo)
  const local = localPrecheck(doc, settings.review)
  const reviewable = filterReviewableEvents(doc.events, settings.review)
  const kinds = new Map<number, AssEventKind>(
    reviewable.map((e) => [e.index, classifyEvent(e, settings.review)])
  )
  const chunks = chunkEvents(reviewable, 24_000)
  const started = Date.now()

  let lastRaw = ''
  let parsed: AiResponse | null = null
  let parseError: string | null = null
  const warnings: string[] = []
  const skipped = doc.events.length - reviewable.length
  if (skipped > 0) warnings.push(`已跳过 ${skipped} 行特效/注释，只审阅对白与屏幕字`)

  for (let i = 0; i < chunks.length; i += 1) {
    const prompt = buildPrompt(
      {
        anime: store.project.animeName,
        release: ep.releaseNo,
        localNo: ep.localNo,
        glossary: readGlossary(rootPath),
        recap: ''
      },
      formatEventRows(chunks[i]!, kinds)
    )
    let attempts = 0
    const maxAttempts = Math.max(1, settings.dsh.retries + 1)
    for (;;) {
      attempts += 1
      try {
        const result = await callDsh(prompt, settings.dsh)
        lastRaw = result.text
        const outcome = parseAiResponse(result.text)
        if (!outcome.ok) {
          parseError = outcome.error
          if (attempts >= maxAttempts) break
          continue
        }
        if (!parsed) parsed = outcome.data
        else parsed.issues.push(...outcome.data.issues)
        parseError = null
        break
      } catch (err) {
        parseError = (err as Error).message
        if (attempts >= maxAttempts) break
      }
    }
    if (parseError) break
    if (chunks.length > 1) warnings.push(`已分 ${chunks.length} 段审阅（第 ${i + 1} 段完成）`)
  }

  const durationMs = Date.now() - started
  const runId = randomId('run')

  if (parseError || !parsed) {
    return failReview(store, localNo, parseError ?? 'AI 返回为空', actor, lastRaw)
  }

  const issues = buildIssues(parsed, local, runId, ep.id, store, actor)
  const stats = computeStats(issues)
  const verdict = decideVerdict(issues)

  const run: ReviewRun = {
    id: runId,
    episodeId: ep.id,
    runAt: nowIso(),
    model: settings.dsh.model,
    promptVersion: PROMPT_VERSION,
    subtitleHash: ep.subtitle?.sha256 ?? '',
    verdict,
    stats,
    rawResponse: lastRaw.slice(0, 200_000),
    parseError: null,
    durationMs,
    tokenUsage: null,
    issueCount: issues.length
  }
  store.addRun(run)
  store.addIssues(issues)
  store.updateEpisode(localNo, { aiRunId: runId, aiVerdict: verdict, staleReasons: [] })
  store.transition(localNo, verdict === 'pass' ? 'AI_PASSED' : 'AI_REJECTED', 'review.finish', {
    runId,
    verdict,
    stats
  }, actor)
  log.info('review finished', { localNo, verdict, issues: issues.length })

  return { run, issues, warnings, episode: store.getEpisode(localNo) }
}

/** 粘贴模式：把用户粘贴的 JSON 作为一次审阅结果入库 */
export async function submitReviewJson(
  rootPath: string,
  localNo: string,
  jsonText: string,
  settings: AppSettings,
  actor: string
): Promise<ReviewOutcome> {
  const store = openStore(rootPath)
  const outcome = parseAiResponse(jsonText)
  if (!outcome.ok) throw new Error(outcome.error)
  const ep = store.getEpisode(localNo)
  const doc = readDocument(rootPath, localNo)
  const local = localPrecheck(doc, settings.review)
  toReviewing(store, localNo, actor)
  const runId = randomId('run')
  const issues = buildIssues(outcome.data, local, runId, ep.id, store, actor)
  const stats = computeStats(issues)
  const verdict = decideVerdict(issues)
  const run: ReviewRun = {
    id: runId,
    episodeId: ep.id,
    runAt: nowIso(),
    model: settings.dsh.model,
    promptVersion: PROMPT_VERSION,
    subtitleHash: ep.subtitle?.sha256 ?? '',
    verdict,
    stats,
    rawResponse: jsonText.slice(0, 200_000),
    parseError: null,
    durationMs: 0,
    tokenUsage: null,
    issueCount: issues.length
  }
  store.addRun(run)
  store.addIssues(issues)
  store.updateEpisode(localNo, { aiRunId: runId, aiVerdict: verdict, staleReasons: [] })
  store.transition(localNo, verdict === 'pass' ? 'AI_PASSED' : 'AI_REJECTED', 'review.finish', {
    runId,
    verdict,
    stats,
    source: 'paste'
  }, actor)
  return { run, issues, warnings: [], episode: store.getEpisode(localNo) }
}

export function setIssueStatus(
  rootPath: string,
  issueId: string,
  status: IssueStatus,
  note: string,
  actor: string
): ReviewIssue {
  const store = openStore(rootPath)
  const issue = store.issues.find((i) => i.id === issueId)
  if (!issue) throw new Error('问题不存在')
  if ((status === 'ignored' || status === 'false_positive') && !note.trim()) {
    throw new Error('忽略或误报必须填写理由')
  }
  const updated = store.updateIssue(issueId, {
    status,
    resolutionNote: note.trim() || null,
    resolvedAt: nowIso(),
    resolvedBy: actor
  })
  store.appendAudit('issue.status', { issueId, status, note }, issue.episodeId, actor)
  reconcileAiState(store, issue.episodeId, actor)
  return updated
}

/**
 * 问题处理完后同步 AI 结论与状态：
 * - 没有未处理的 blocker/major → 自动从 AI_REJECTED 进入 AI_PASSED（解锁人工审阅）
 * - 已通过后又把阻断问题改回未处理 → 回退 AI_REJECTED
 */
function reconcileAiState(store: ProjectStore, episodeId: string, actor: string): void {
  const ep = store.getEpisodeById(episodeId)
  if (!ep) return
  if (ep.state !== 'AI_REJECTED' && ep.state !== 'AI_PASSED') return
  const run = store.latestRun(ep.id)
  if (!run) return
  const issues = store.issuesOf(ep.id, run.id)
  const verdict = decideVerdict(issues)
  if (verdict === 'pass' && ep.state === 'AI_REJECTED') {
    store.updateEpisode(ep.localNo, { aiVerdict: 'pass' })
    store.transition(ep.localNo, 'AI_PASSED', 'review.auto-pass', { issueCount: issues.length }, actor)
  } else if (verdict === 'fail' && ep.state === 'AI_PASSED') {
    store.updateEpisode(ep.localNo, { aiVerdict: 'fail' })
    store.transition(ep.localNo, 'AI_REJECTED', 'review.reopen', null, actor)
  }
}

/** 强制通过：仅当设置允许；所有未处理的 blocker/major 记为 ignored 并留痕 */
export function forcePassReview(
  rootPath: string,
  localNo: string,
  note: string,
  settings: AppSettings,
  actor: string
): EpisodeRecord {
  if (!settings.allowForcePass) throw new Error('当前设置不允许强制通过 AI 审阅')
  if (!note.trim()) throw new Error('强制通过必须填写豁免理由')
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  const run = store.latestRun(ep.id)
  if (!run) throw new Error('该集还没有 AI 审阅记录')
  const issues = store.issuesOf(ep.id, run.id)
  const blocking = issues.filter((i) => i.severity === 'blocker' || i.severity === 'major')
  for (const issue of blocking) {
    if (issue.status === 'open') {
      store.updateIssue(issue.id, {
        status: 'ignored',
        resolutionNote: `强制通过豁免：${note}`,
        resolvedAt: nowIso(),
        resolvedBy: actor
      })
    }
  }
  store.updateEpisode(localNo, { aiVerdict: 'pass', aiRunId: run.id })
  if (ep.state === 'AI_REJECTED' || ep.state === 'AI_REVIEWING') {
    store.transition(localNo, 'AI_PASSED', 'review.force-pass', { note, issues: blocking.map((i) => i.id) }, actor)
  }
  store.appendAudit('review.force-pass', { note, issues: blocking.map((i) => i.id) }, ep.id, actor)
  return store.getEpisode(localNo)
}

export function listIssues(rootPath: string, localNo: string): ReviewIssue[] {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  const run = store.latestRun(ep.id)
  if (!run) return []
  return store.issuesOf(ep.id, run.id)
}
