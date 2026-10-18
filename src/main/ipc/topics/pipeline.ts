import { z } from 'zod'
import { handle } from '../registry'
import { getSettings } from '../../store/settings'
import { checkAllGates, checkGate } from '../../services/gate-service'
import {
  cancelEncode,
  rescanOutput,
  setOutputManually,
  startEncode
} from '../../services/encode-service'
import { mergeChapters } from '../../services/mux-service'
import { decideTranscode } from '../../services/transcode-service'
import { markDone, previewFinalName, renameToRelease } from '../../services/naming-service'
import { broadcast } from '../events'

const ep = z.object({ rootPath: z.string().min(1), localNo: z.string().min(1) })

export function registerPipelineTopics(): void {
  handle(
    'gate:check',
    ep,
    async ({ rootPath, localNo }) => checkAllGates(rootPath, localNo, getSettings())
  )

  handle(
    'gate:check-one',
    z.object({
      rootPath: z.string().min(1),
      localNo: z.string().min(1),
      action: z.enum([
        'open-human-review',
        'human-pass',
        'generate-chapters',
        'lock-chapters',
        'encode',
        'merge',
        'transcode',
        'rename'
      ])
    }),
    async ({ rootPath, localNo, action }) => checkGate(rootPath, localNo, action, getSettings())
  )

  handle('encode:start', ep, async ({ rootPath, localNo }) => {
    const settings = getSettings()
    const result = await startEncode(rootPath, localNo, settings)
    broadcast('episode:state', { localNo, state: result.episode.state })
    return result.episode
  })

  handle('encode:cancel', ep, ({ rootPath, localNo }) => {
    const settings = getSettings()
    const episode = cancelEncode(rootPath, localNo, settings.operator)
    broadcast('episode:state', { localNo, state: episode.state })
    return episode
  })

  handle('encode:rescan', ep, ({ rootPath, localNo }) => rescanOutput(rootPath, localNo, getSettings()))

  handle('encode:accept', ep.extend({ path: z.string().min(1) }), async ({ rootPath, localNo, path }) => {
    const settings = getSettings()
    const episode = await setOutputManually(rootPath, localNo, path, settings)
    broadcast('episode:state', { localNo, state: episode.state })
    return episode
  })

  handle('merge:run', ep, async ({ rootPath, localNo }) => {
    const settings = getSettings()
    const episode = await mergeChapters(rootPath, localNo, settings)
    broadcast('episode:state', { localNo, state: episode.state })
    return episode
  })

  handle(
    'transcode:run',
    ep.extend({ mode: z.enum(['mp4', 'keep']) }),
    async ({ rootPath, localNo, mode }) => {
      const settings = getSettings()
      const episode = await decideTranscode(rootPath, localNo, mode, settings)
      broadcast('episode:state', { localNo, state: episode.state })
      return episode
    }
  )

  handle('naming:preview', ep, ({ rootPath, localNo }) =>
    previewFinalName(rootPath, localNo, getSettings())
  )

  handle('naming:run', ep, async ({ rootPath, localNo }) => {
    const settings = getSettings()
    const episode = await renameToRelease(rootPath, localNo, settings)
    broadcast('episode:state', { localNo, state: episode.state })
    return episode
  })

  handle('episode:done', ep, ({ rootPath, localNo }) => {
    const settings = getSettings()
    const episode = markDone(rootPath, localNo, settings.operator)
    broadcast('episode:state', { localNo, state: episode.state })
    return episode
  })
}
