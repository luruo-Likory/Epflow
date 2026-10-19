import { z } from 'zod'
import { handle } from '../registry'
import { getSettings } from '../../store/settings'
import {
  createProject,
  createProjectInputSchema,
  listProjects,
  migrateToFlatLayout,
  openProject,
  previewProject,
  recoverProject,
  scanMaterialRoot,
  setReleaseNo,
  setReviewVideo,
  updateProjectMeta
} from '../../services/project-service'
import { openStore } from '../../store/repository'
import { checkAllGates } from '../../services/gate-service'
import { listIssues } from '../../services/review-service'
import { broadcast } from '../events'

const rootPath = z.object({ rootPath: z.string().min(1) })

export function registerProjectTopics(): void {
  handle('project:list', z.undefined().or(z.null()).transform(() => undefined), () => listProjects())

  handle('project:preview', createProjectInputSchema, (input) => previewProject(input))

  handle(
    'project:create',
    z.object({
      input: createProjectInputSchema,
      conflict: z.enum(['reuse', 'abort', 'rename']).default('abort'),
      renamedAnime: z.string().optional()
    }),
    ({ input, conflict, renamedAnime }) => {
      const settings = getSettings()
      return createProject(input, {
        conflict: conflict ?? 'abort',
        renamedAnime,
        operator: settings.operator,
        settings
      })
    }
  )

  handle('project:open', rootPath, async ({ rootPath: root }) => {
    const snapshot = openProject(root)
    const { activateProject } = await import('../../services/watch-manager')
    activateProject(root)
    return snapshot
  })

  handle('project:scan', z.object({ materialRoot: z.string().min(1) }), ({ materialRoot }) =>
    scanMaterialRoot(materialRoot)
  )

  handle(
    'project:update-meta',
    z.object({
      rootPath: z.string().min(1),
      patch: z.object({
        releaseNameTemplate: z.string().optional(),
        releaseEpisodeBase: z.number().int().optional(),
        workNameTemplate: z.string().optional(),
        subDirName: z.string().optional(),
        outputMode: z.enum(['episode-output', 'project-release']).optional()
      })
    }),
    ({ rootPath: root, patch }) => updateProjectMeta(root, patch, getSettings().operator)
  )

  handle(
    'project:set-release-no',
    z.object({ rootPath: z.string().min(1), localNo: z.string().min(1), releaseNo: z.string().min(1) }),
    ({ rootPath: root, localNo, releaseNo }) =>
      setReleaseNo(root, localNo, releaseNo, getSettings().operator)
  )

  handle('project:recover', rootPath, async ({ rootPath: root }) => recoverProject(root, getSettings().operator))

  handle('project:migrate-layout', rootPath, ({ rootPath: root }) =>
    migrateToFlatLayout(root, getSettings().operator)
  )

  handle(
    'episode:detail',
    z.object({ rootPath: z.string().min(1), localNo: z.string().min(1) }),
    async ({ rootPath: root, localNo }) => {
      const settings = getSettings()
      const store = openStore(root)
      const ep = store.getEpisode(localNo)
      return {
        episode: ep,
        project: store.project,
        issues: listIssues(root, localNo),
        run: store.latestRun(ep.id),
        runs: store.runsOf(ep.id),
        gates: await checkAllGates(root, localNo, settings)
      }
    }
  )

  handle(
    'episode:set-video',
    z.object({
      rootPath: z.string().min(1),
      localNo: z.string().min(1),
      path: z.string().nullable()
    }),
    ({ rootPath: root, localNo, path: videoPath }) => {
      const ep = setReviewVideo(root, localNo, videoPath, getSettings().operator)
      broadcast('episode:state', { localNo, state: ep.state })
      return ep
    }
  )

  handle(
    'episode:note',
    z.object({ rootPath: z.string().min(1), localNo: z.string().min(1), note: z.string() }),
    ({ rootPath: root, localNo, note }) => {
      const store = openStore(root)
      const ep = store.getEpisode(localNo)
      store.updateEpisode(localNo, { note })
      store.appendAudit('episode.note', { note }, ep.id, getSettings().operator)
      return store.getEpisode(localNo)
    }
  )

}
