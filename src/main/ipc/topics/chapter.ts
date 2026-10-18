import { z } from 'zod'
import { handle } from '../registry'
import { getSettings } from '../../store/settings'
import {
  generateChapterDraft,
  lockChapters,
  readChapters,
  saveChapterDraft
} from '../../services/chapter-service'
import { broadcast } from '../events'

const chapterSchema = z.object({
  startMs: z.number().nonnegative(),
  title: z.string(),
  source: z.enum(['auto', 'manual', 'op', 'ed']),
  uid: z.string()
})

export function registerChapterTopics(): void {
  handle(
    'chapter:generate',
    z.object({
      rootPath: z.string().min(1),
      localNo: z.string().min(1),
      overrides: z
        .object({
          gapThresholdMs: z.number().optional(),
          minChapterLenMs: z.number().optional(),
          maxChapterLenMs: z.number().optional(),
          maxChapters: z.number().optional(),
          minChapters: z.number().optional(),
          detectOpEd: z.boolean().optional(),
          firstChapterAtZero: z.boolean().optional(),
          language: z.string().optional()
        })
        .optional()
    }),
    async ({ rootPath, localNo, overrides }) => {
      const settings = getSettings()
      const view = await generateChapterDraft(rootPath, localNo, settings, overrides)
      broadcast('episode:state', { localNo, state: 'CHAPTER_DRAFT' })
      return view
    }
  )

  handle(
    'chapter:read',
    z.object({ rootPath: z.string().min(1), localNo: z.string().min(1) }),
    ({ rootPath, localNo }) => readChapters(rootPath, localNo, getSettings())
  )

  handle(
    'chapter:save',
    z.object({
      rootPath: z.string().min(1),
      localNo: z.string().min(1),
      chapters: z.array(chapterSchema).min(1)
    }),
    ({ rootPath, localNo, chapters }) => saveChapterDraft(rootPath, localNo, chapters, getSettings())
  )

  handle(
    'chapter:lock',
    z.object({
      rootPath: z.string().min(1),
      localNo: z.string().min(1),
      checklist: z.array(z.string())
    }),
    async ({ rootPath, localNo, checklist }) => {
      const settings = getSettings()
      const ep = await lockChapters(rootPath, localNo, checklist, settings)
      broadcast('episode:state', { localNo, state: ep.state })
      return ep
    }
  )
}
