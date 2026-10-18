import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, EpisodeRecord, GateAction, GateBlocker, GateReport, ProjectMeta } from '@shared/types'
import { existsLong, toLongPath } from '../util/paths'
import { sha256File } from '../util/hash'
import { openStore } from '../store/repository'
import type { ProjectStore } from '../store/repository'

function blocker(code: string, label: string, hint?: string): GateBlocker {
  return { code, label, hint }
}

export interface GateContext {
  settings: AppSettings
  /** 其他集是否正在压制 */
  encodingOther: string | null
}

/** 同步部分：不读文件哈希的判断 */
function baseBlockers(
  store: ProjectStore,
  ep: EpisodeRecord,
  action: GateAction,
  ctx: GateContext
): GateBlocker[] {
  const blockers: GateBlocker[] = []
  const aiOk = ep.aiVerdict === 'pass' && ep.state !== 'SUB_IMPORTED'
  const humanOk = Boolean(ep.human)
  const chaptersOk = Boolean(ep.chapters)

  const requireAi = () => {
    if (!aiOk) blockers.push(blocker('AI_NOT_PASSED', 'AI 审阅尚未通过', '请先完成 AI 审阅并处理阻断问题'))
  }
  const requireHuman = () => {
    requireAi()
    if (!humanOk) blockers.push(blocker('HUMAN_NOT_PASSED', '人工审阅尚未通过', 'AI 通过后打开人工审阅并提交确认清单'))
  }
  const requireChapters = () => {
    if (!chaptersOk) {
      blockers.push(blocker('CHAPTER_NOT_LOCKED', '章节尚未锁定', '请完成章节审阅并点击「章节审阅通过」'))
    }
  }

  switch (action) {
    case 'open-human-review': {
      if (ep.state !== 'AI_PASSED') {
        blockers.push(
          blocker('STATE', '当前状态不可打开人工审阅', `当前状态：${ep.state}，需为 AI_PASSED`)
        )
      }
      requireAi()
      if (!ep.subtitle) blockers.push(blocker('NO_SUBTITLE', '尚未导入字幕'))
      break
    }
    case 'human-pass': {
      if (ep.state !== 'HUMAN_REVIEWING') blockers.push(blocker('STATE', '当前不在人工审阅中'))
      requireAi()
      break
    }
    case 'generate-chapters': {
      requireHuman()
      if (!ep.subtitle) blockers.push(blocker('NO_SUBTITLE', '尚未导入字幕'))
      break
    }
    case 'lock-chapters': {
      requireHuman()
      if (!ep.chapterDraft) blockers.push(blocker('NO_DRAFT', '尚未生成章节草稿'))
      else if (ep.chapterDraft.stale) {
        blockers.push(blocker('CHAPTER_STALE', '章节草稿已过期', '字幕已变更，请重新生成章节'))
      }
      break
    }
    case 'encode': {
      requireHuman()
      requireChapters()
      if (!ep.templateJson || !existsLong(ep.templateJson)) {
        blockers.push(blocker('NO_TEMPLATE_JSON', '模板 JSON 不存在', '请先完成模板实例化'))
      }
      if (!ep.templateVpy || !existsLong(ep.templateVpy)) {
        blockers.push(blocker('NO_TEMPLATE_VPY', '模板 VPY 不存在', '请先完成模板实例化'))
      }
      if (ep.state === 'ENCODING') blockers.push(blocker('ENCODING', '该集正在压制中'))
      if (ctx.encodingOther) {
        blockers.push(blocker('ENCODING_OTHER', `第 ${ctx.encodingOther} 集正在压制中`, 'v1 一次只允许一集压制'))
      }
      if (ctx.settings.encode.requireSourceVideo && ep.templateJson) {
        try {
          const json = JSON.parse(fs.readFileSync(toLongPath(ep.templateJson), 'utf8')) as { InputFiles?: unknown }
          const files = Array.isArray(json.InputFiles)
            ? json.InputFiles.filter((x): x is string => typeof x === 'string')
            : []
          const missing = files.filter((f) => !existsLong(f))
          if (missing.length > 0) {
            blockers.push(blocker('NO_SOURCE', `源视频缺失：${path.basename(missing[0] ?? '')}`, '请放置源视频后重试'))
          }
        } catch {
          blockers.push(blocker('BAD_TEMPLATE', '模板 JSON 无法解析', '请重新实例化模板'))
        }
      }
      break
    }
    case 'merge': {
      if (!ep.encode?.outputPath || !existsLong(ep.encode.outputPath)) {
        blockers.push(blocker('NO_OUTPUT', '成品不存在', '请先完成压制并识别成品'))
      }
      requireChapters()
      break
    }
    case 'transcode': {
      if (!ep.merge) blockers.push(blocker('NOT_MERGED', '章节尚未合并'))
      if (!ep.encode?.outputPath) blockers.push(blocker('NO_OUTPUT', '成品不存在'))
      break
    }
    case 'rename': {
      if (!ep.encode?.outputPath) blockers.push(blocker('NO_OUTPUT', '成品不存在'))
      break
    }
    default:
      break
  }
  void store
  return blockers
}

/** 异步部分：读取真实哈希做一致性校验（§6.3 哈希一致） */
async function hashBlockers(ep: EpisodeRecord, action: GateAction): Promise<GateBlocker[]> {
  const blockers: GateBlocker[] = []
  const needSubtitleHash = action === 'encode' || action === 'open-human-review'
  if (needSubtitleHash && ep.subtitle?.path && existsLong(ep.subtitle.path)) {
    const current = await sha256File(ep.subtitle.path)
    if (current !== ep.subtitle.sha256) {
      blockers.push(
        blocker('SUB_HASH_CHANGED', '字幕已变更，审阅记录失效', '请重新进行 AI 审阅与人工审阅')
      )
    }
    if (ep.human && ep.human.subtitleHash !== current) {
      blockers.push(blocker('HUMAN_HASH_MISMATCH', '人工审阅记录与当前字幕不一致', '需重新人工审阅'))
    }
  }
  const needChapterHash = action === 'encode' || action === 'merge'
  if (needChapterHash && ep.chapters?.path && existsLong(ep.chapters.path)) {
    const current = await sha256File(ep.chapters.path)
    if (current !== ep.chapters.sha256) {
      blockers.push(blocker('CHAPTER_HASH_CHANGED', '章节 XML 已被外部修改', '请重新审阅并锁定章节'))
    }
  }
  return blockers
}

export function findEncodingEpisode(store: ProjectStore, exceptLocalNo?: string): string | null {
  const found = store.episodes.find((e) => e.state === 'ENCODING' && e.localNo !== exceptLocalNo)
  return found?.localNo ?? null
}

export async function checkGate(
  rootPath: string,
  localNo: string,
  action: GateAction,
  settings: AppSettings
): Promise<GateReport> {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  const ctx: GateContext = { settings, encodingOther: findEncodingEpisode(store, localNo) }
  const blockers = baseBlockers(store, ep, action, ctx)
  const hashBlocked = await hashBlockers(ep, action)
  blockers.push(...hashBlocked)
  return { action, ok: blockers.length === 0, blockers }
}

export async function requireGate(
  rootPath: string,
  localNo: string,
  action: GateAction,
  settings: AppSettings
): Promise<void> {
  const report = await checkGate(rootPath, localNo, action, settings)
  if (!report.ok) {
    const err = new Error(report.blockers.map((b) => b.label).join('；'))
    ;(err as Error & { gate?: GateReport }).gate = report
    throw err
  }
}

/** 所有动作的门禁汇总（集卡片/工作台一次拿全） */
export async function checkAllGates(
  rootPath: string,
  localNo: string,
  settings: AppSettings
): Promise<Record<GateAction, GateReport>> {
  const actions: GateAction[] = [
    'open-human-review',
    'human-pass',
    'generate-chapters',
    'lock-chapters',
    'encode',
    'merge',
    'transcode',
    'rename'
  ]
  const out = {} as Record<GateAction, GateReport>
  for (const action of actions) out[action] = await checkGate(rootPath, localNo, action, settings)
  return out
}

export function projectMetaOf(rootPath: string): ProjectMeta {
  return openStore(rootPath).project
}
