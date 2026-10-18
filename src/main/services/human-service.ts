import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, EpisodeRecord, HumanLock } from '@shared/types'
import { nowIso } from '@shared/time'
import { openStore } from '../store/repository'
import { existsLong, toLongPath } from '../util/paths'
import { sha256File } from '../util/hash'
import { scoped } from '../util/logger'
import { requireGate } from './gate-service'
import { spawn } from 'node:child_process'
import { resolveTool } from '../integrations/tools'
import { checkSubtitleIntegrity } from './subtitle-service'

const log = scoped('human')

export const HUMAN_CHECKLIST = [
  '已通读全片字幕',
  '已核对时间轴与对白同步',
  '已检查样式、字体、特效标签',
  '已确认 AI 问题均已处理或豁免'
]

export async function openHumanReview(
  rootPath: string,
  localNo: string,
  settings: AppSettings
): Promise<EpisodeRecord> {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  await requireGate(rootPath, localNo, 'open-human-review', settings)
  if (!ep.subtitle?.path || !existsLong(ep.subtitle.path)) throw new Error('该集尚未导入字幕')

  const changed = await checkSubtitleIntegrity(rootPath, localNo, settings.operator)
  if (changed) throw new Error('字幕已变更，AI 审阅结论失效，请重新审阅')

  const aegisub = resolveTool('aegisub')
  try {
    if (aegisub.exists) {
      spawn(aegisub.path, [ep.subtitle.path], { detached: true, stdio: 'ignore' }).unref()
    } else {
      const { shell } = require('electron') as typeof import('electron')
      await shell.openPath(ep.subtitle.path)
    }
  } catch (err) {
    log.warn('open editor failed', { message: String(err) })
  }

  if (store.getEpisode(localNo).state === 'AI_PASSED') {
    store.transition(localNo, 'HUMAN_REVIEWING', 'human.start', null, settings.operator)
  }
  return store.getEpisode(localNo)
}

export async function passHumanReview(
  rootPath: string,
  localNo: string,
  checklist: string[],
  note: string,
  settings: AppSettings
): Promise<EpisodeRecord> {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  await requireGate(rootPath, localNo, 'human-pass', settings)
  if (!ep.subtitle?.path) throw new Error('该集尚未导入字幕')

  const missing = HUMAN_CHECKLIST.filter((item) => !checklist.includes(item))
  if (missing.length > 0) throw new Error(`请逐项确认：${missing.join('、')}`)

  const changed = await checkSubtitleIntegrity(rootPath, localNo, settings.operator)
  if (changed) throw new Error('字幕在人工审阅期间被修改，AI 审阅结论已失效，请重新进行 AI 审阅')

  const hash = await sha256File(ep.subtitle.path)
  if (hash !== ep.subtitle.sha256) throw new Error('字幕哈希与导入记录不一致，请重新导入或重新审阅')

  const human: HumanLock = {
    at: nowIso(),
    by: settings.operator,
    subtitleHash: hash,
    aiRunId: ep.aiRunId ?? '',
    note: note.trim(),
    checklist
  }
  store.updateEpisode(localNo, { human })
  store.transition(localNo, 'HUMAN_PASSED', 'human.pass', { hash, note }, settings.operator)
  store.writeSnapshots()
  log.info('human passed', { localNo })
  return store.getEpisode(localNo)
}

export function rejectHumanReview(
  rootPath: string,
  localNo: string,
  reason: string,
  needReReview: boolean,
  settings: AppSettings
): EpisodeRecord {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  if (ep.state !== 'HUMAN_REVIEWING') throw new Error('当前不在人工审阅中')
  if (reason.trim().length < 10) throw new Error('打回原因至少填写 10 个字')
  store.updateEpisode(localNo, { human: null, note: reason.trim() })
  const target = needReReview ? 'SUB_IMPORTED' : 'AI_PASSED'
  store.transition(localNo, target, 'human.reject', { reason: reason.trim(), needReReview }, settings.operator)
  if (needReReview) {
    store.updateEpisode(localNo, { aiVerdict: 'unknown' })
  }
  return store.getEpisode(localNo)
}

export function cancelHumanReview(rootPath: string, localNo: string, actor: string): EpisodeRecord {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  if (ep.state !== 'HUMAN_REVIEWING') throw new Error('当前不在人工审阅中')
  store.transition(localNo, 'AI_PASSED', 'human.cancel', null, actor)
  return store.getEpisode(localNo)
}
