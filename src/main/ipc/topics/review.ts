import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { handle } from '../registry'
import { getSettings } from '../../store/settings'
import {
  buildPromptForEpisode,
  forcePassReview,
  listIssues,
  runAiReview,
  setIssueStatus,
  submitReviewJson
} from '../../services/review-service'
import {
  HUMAN_CHECKLIST,
  cancelHumanReview,
  openHumanReview,
  passHumanReview,
  rejectHumanReview
} from '../../services/human-service'
import { openStore } from '../../store/repository'
import { writeFileAtomic } from '../../store/atomic'
import { broadcast } from '../events'

const rootPath = z.object({ rootPath: z.string().min(1) })

export function registerReviewTopics(): void {
  handle(
    'review:prepare',
    z.object({ rootPath: z.string().min(1), localNo: z.string().min(1) }),
    ({ rootPath: root, localNo }) => {
      const settings = getSettings()
      const result = buildPromptForEpisode(root, localNo, settings)
      return result
    }
  )

  handle(
    'review:start',
    z.object({ rootPath: z.string().min(1), localNo: z.string().min(1) }),
    async ({ rootPath: root, localNo }) => {
      const settings = getSettings()
      const store = openStore(root)
      const ep = store.getEpisode(localNo)
      store.appendAudit('review.invoke', { mode: settings.dsh.mode }, ep.id, settings.operator)
      const outcome = await runAiReview(root, localNo, settings, settings.operator)
      broadcast('episode:state', { localNo, state: outcome.episode.state })
      return outcome
    }
  )

  handle(
    'review:submit-json',
    z.object({ rootPath: z.string().min(1), localNo: z.string().min(1), json: z.string().min(2) }),
    async ({ rootPath: root, localNo, json }) => {
      const settings = getSettings()
      const store = openStore(root)
      const ep = store.getEpisode(localNo)
      // 保留原始返回，便于追溯
      const rawDir = path.join(root, '.epflow', 'raw')
      fs.mkdirSync(rawDir, { recursive: true })
      writeFileAtomic(path.join(rawDir, `${localNo}-${Date.now()}.json`), json)
      store.appendAudit('review.submit-json', { length: json.length }, ep.id, settings.operator)
      const outcome = await submitReviewJson(root, localNo, json, settings, settings.operator)
      broadcast('episode:state', { localNo, state: outcome.episode.state })
      return outcome
    }
  )

  handle(
    'review:issues',
    z.object({ rootPath: z.string().min(1), localNo: z.string().min(1) }),
    ({ rootPath: root, localNo }) => {
      const store = openStore(root)
      const ep = store.getEpisode(localNo)
      return {
        issues: listIssues(root, localNo),
        run: store.latestRun(ep.id),
        runs: store.runsOf(ep.id)
      }
    }
  )

  handle(
    'review:set-issue',
    z.object({
      rootPath: z.string().min(1),
      issueId: z.string().min(1),
      status: z.enum(['open', 'fixed', 'ignored', 'false_positive']),
      note: z.string()
    }),
    ({ rootPath: root, issueId, status, note }) => {
      const settings = getSettings()
      return setIssueStatus(root, issueId, status, note, settings.operator)
    }
  )

  handle(
    'review:force-pass',
    z.object({ rootPath: z.string().min(1), localNo: z.string().min(1), note: z.string() }),
    ({ rootPath: root, localNo, note }) => {
      const settings = getSettings()
      const ep = forcePassReview(root, localNo, note, settings, settings.operator)
      broadcast('episode:state', { localNo, state: ep.state })
      return ep
    }
  )

  handle(
    'human:open',
    z.object({ rootPath: z.string().min(1), localNo: z.string().min(1) }),
    async ({ rootPath: root, localNo }) => {
      const settings = getSettings()
      const ep = await openHumanReview(root, localNo, settings)
      broadcast('episode:state', { localNo, state: ep.state })
      return ep
    }
  )

  handle(
    'human:pass',
    z.object({
      rootPath: z.string().min(1),
      localNo: z.string().min(1),
      checklist: z.array(z.string()),
      note: z.string()
    }),
    async ({ rootPath: root, localNo, checklist, note }) => {
      const settings = getSettings()
      const ep = await passHumanReview(root, localNo, checklist, note, settings)
      broadcast('episode:state', { localNo, state: ep.state })
      return ep
    }
  )

  handle(
    'human:reject',
    z.object({
      rootPath: z.string().min(1),
      localNo: z.string().min(1),
      reason: z.string(),
      needReReview: z.boolean()
    }),
    ({ rootPath: root, localNo, reason, needReReview }) => {
      const settings = getSettings()
      const ep = rejectHumanReview(root, localNo, reason, needReReview, settings)
      broadcast('episode:state', { localNo, state: ep.state })
      return ep
    }
  )

  handle(
    'human:cancel',
    z.object({ rootPath: z.string().min(1), localNo: z.string().min(1) }),
    ({ rootPath: root, localNo }) => {
      const settings = getSettings()
      const ep = cancelHumanReview(root, localNo, settings.operator)
      broadcast('episode:state', { localNo, state: ep.state })
      return ep
    }
  )

  void rootPath
  void HUMAN_CHECKLIST
}
