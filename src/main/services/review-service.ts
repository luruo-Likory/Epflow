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
import { parseAss, validateAssStructure, type AssDocument } from '@shared/ass-parser'
import { ProjectStore, openStore } from '../store/repository'
import { randomId } from '../util/hash'
import { existsLong, toLongPath } from '../util/paths'
import { scoped } from '../util/logger'
import { callDsh, DshUnavailableError, dshAvailable } from '../integrations/dsh-client'
import { buildPrompt, chunkEvents, formatEventRows, PROMPT_VERSION } from './review-prompt'
import { checkSubtitleIntegrity } from './subtitle-service'
import { sha256Text } from '../util/hash'

const log = scoped('review')

const aiIssueSchema = z.object({
  id: z.string().optional(),
  severity: z.string(),
  category: z.string().optional(),
  line: z.number().nullable().optional(),
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
/* 本地预检                                                            */
/* ------------------------------------------------------------------ */

export interface PrecheckConfig {
  /** 单行允许的最大显示宽度占画面宽度的比例 */
  maxWidthRatio: number
  minDurationMs: number
  maxDurationMs: number
}

export const DEFAULT_PRECHECK: PrecheckConfig = {
  maxWidthRatio: 0.92,
  minDurationMs: 500,
  maxDurationMs: 8000
}

interface DraftIssue {
  severity: Severity
  category: IssueCategory
  line: number | null
  startMs: number | null
  endMs: number | null
  original: string
  suggestion: string
  reason: string
  confidence: number | null
}

export function localPrecheck(doc: AssDocument, cfg: PrecheckConfig = DEFAULT_PRECHECK): DraftIssue[] {
  const out: DraftIssue[] = []
  const styleMap = new Map(doc.styles.map((s) => [s.name, s]))
  const dialogues = doc.events.filter((e) => !e.isComment)
  const maxWidthPx = doc.playResX * cfg.maxWidthRatio

  for (let i = 0; i < dialogues.length; i += 1) {
    const e = dialogues[i]!
    const push = (draft: Omit<DraftIssue, 'line' | 'startMs' | 'endMs' | 'original'> & { original?: string }) => {
      out.push({
        line: e.index,
        startMs: e.startMs,
        endMs: e.endMs,
        original: draft.original ?? e.plain.slice(0, 120),
        ...draft
      })
    }

    const duration = e.endMs - e.startMs
    if (duration <= 0) {
      push({
        severity: 'major',
        category: 'timing',
        suggestion: '修正结束时间，确保晚于开始时间',
        reason: `时长异常（${duration} ms）`,
        confidence: 1
      })
    } else if (duration < cfg.minDurationMs) {
      push({
        severity: 'minor',
        category: 'timing',
        suggestion: '确认是否需要延长停留时间',
        reason: `时长过短（${duration} ms < ${cfg.minDurationMs} ms）`,
        confidence: 0.9
      })
    } else if (duration > cfg.maxDurationMs) {
      push({
        severity: 'minor',
        category: 'timing',
        suggestion: '考虑拆分或缩短该行',
        reason: `时长过长（${duration} ms > ${cfg.maxDurationMs} ms）`,
        confidence: 0.8
      })
    }

    if (!e.plain.trim()) {
      push({
        severity: 'major',
        category: 'omission',
        suggestion: '删除空行或补全对白',
        reason: '对白文本为空或仅含 ASS 标签',
        confidence: 1
      })
    }

    const opens = (e.text.match(/\{/g) ?? []).length
    const closes = (e.text.match(/\}/g) ?? []).length
    if (opens !== closes) {
      push({
        severity: 'major',
        category: 'ass_tag',
        suggestion: '补全或删除多余的 { }',
        reason: `花括号不配对（{ ×${opens}，} ×${closes}）`,
        confidence: 1
      })
    }
    const newlines = (e.text.match(/\\N/gi) ?? []).length
    if (newlines > 2) {
      push({
        severity: 'minor',
        category: 'ass_tag',
        suggestion: '减少硬换行，避免超出画面',
        reason: `单行含 ${newlines} 个硬换行`,
        confidence: 0.85
      })
    }

    if (e.style && styleMap.size > 0 && !styleMap.has(e.style)) {
      push({
        severity: 'major',
        category: 'ass_tag',
        suggestion: '改为已定义样式或补充样式定义',
        reason: `样式 "${e.style}" 不存在`,
        confidence: 1
      })
    }

    const style = styleMap.get(e.style)
    if (style && style.fontsize > 0) {
      const estimated = estimateWidth(e.plain, style.fontsize)
      if (estimated > maxWidthPx) {
        push({
          severity: 'minor',
          category: 'style',
          suggestion: '考虑换行或缩小字号',
          reason: `按样式估算宽度约 ${Math.round(estimated)}px，超过画面可用宽度 ${Math.round(maxWidthPx)}px`,
          confidence: 0.6
        })
      }
    }

    // 时间重叠：与后一条比较
    const next = dialogues[i + 1]
    if (next && e.endMs > next.startMs) {
      push({
        severity: 'major',
        category: 'timing',
        suggestion: '缩短本行结束时间或后移下一行',
        reason: `与第 ${next.index} 行时间重叠 ${e.endMs - next.startMs} ms`,
        confidence: 0.95
      })
    }
  }

  for (const tagIssue of validateAssStructure(doc)) {
    const severity: Severity = tagIssue.kind === 'empty-text' ? 'major' : 'minor'
    if (out.some((o) => o.line === tagIssue.line && o.category === 'ass_tag')) continue
    out.push({
      severity,
      category: 'ass_tag',
      line: tagIssue.line,
      startMs: null,
      endMs: null,
      original: '',
      suggestion: '修复该行的 ASS 标签',
      reason: tagIssue.detail,
      confidence: 1
    })
  }

  return out
}

function estimateWidth(plain: string, fontSize: number): number {
  let units = 0
  for (const ch of plain) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x2e80) units += 1
    else if (/\s/.test(ch)) units += 0.3
    else units += 0.55
  }
  return units * fontSize
}

/* ------------------------------------------------------------------ */
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
): { prompt: string; chunks: number; promptFile: string } {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  const doc = readDocument(rootPath, localNo)
  const dialogues = doc.events.filter((e) => !e.isComment)
  const chunks = chunkEvents(dialogues, 24_000)
  const rows = chunks.map((chunk) => formatEventRows(chunk)).join('\n')
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
  store.appendAudit('review.prompt', { chunkCount: chunks.length, promptHash: sha256Text(prompt).slice(0, 12) }, ep.id, settings.operator)
  return { prompt, chunks: chunks.length, promptFile }
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
  const local = localPrecheck(doc)
  const dialogues = doc.events.filter((e) => !e.isComment)
  const chunks = chunkEvents(dialogues, 24_000)
  const started = Date.now()

  let lastRaw = ''
  let parsed: AiResponse | null = null
  let parseError: string | null = null
  const warnings: string[] = []

  for (let i = 0; i < chunks.length; i += 1) {
    const prompt = buildPrompt(
      {
        anime: store.project.animeName,
        release: ep.releaseNo,
        localNo: ep.localNo,
        glossary: readGlossary(rootPath),
        recap: ''
      },
      formatEventRows(chunks[i]!)
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
  const local = localPrecheck(doc)
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
  return updated
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
