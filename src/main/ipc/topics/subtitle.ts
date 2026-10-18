import { z } from 'zod'
import fs from 'node:fs'
import { handle } from '../registry'
import { getSettings } from '../../store/settings'
import {
  importSubtitle,
  readSubtitle,
  readSubtitleText,
  writeSubtitleText,
  checkSubtitleIntegrity
} from '../../services/subtitle-service'
import { replaceInAss } from '@shared/ass-parser'
import { openStore } from '../../store/repository'
import { resolveTool } from '../../integrations/tools'
import { spawn } from 'node:child_process'
import { shell } from 'electron'
import { broadcast } from '../events'

export function registerSubtitleTopics(): void {
  handle(
    'subtitle:import',
    z.object({ rootPath: z.string().min(1), localNo: z.string().min(1), filePath: z.string().min(1) }),
    async ({ rootPath, localNo, filePath }) => {
      const settings = getSettings()
      const ep = await importSubtitle(rootPath, localNo, filePath, settings)
      broadcast('episode:state', { localNo, state: ep.state })
      return ep
    }
  )

  handle(
    'subtitle:read',
    z.object({ rootPath: z.string().min(1), localNo: z.string().min(1) }),
    async ({ rootPath, localNo }) => {
      const result = await readSubtitle(rootPath, localNo)
      const doc = result.document
      return {
        info: result.info,
        events: (doc?.events ?? []).map((e) => ({
          index: e.index,
          lineNo: e.lineNo,
          startMs: e.startMs,
          endMs: e.endMs,
          style: e.style,
          name: e.name,
          text: e.text,
          plain: e.plain,
          isComment: e.isComment,
          type: e.type
        })),
        styles: doc?.styles.map((s) => s.name) ?? [],
        playResX: doc?.playResX ?? 1920,
        playResY: doc?.playResY ?? 1080,
        exists: result.exists,
        currentHash: result.currentHash,
        documentText: readSubtitleText(rootPath, localNo) ?? ''
      }
    }
  )

  handle(
    'subtitle:replace',
    z.object({
      rootPath: z.string().min(1),
      localNo: z.string().min(1),
      find: z.string().min(1),
      replace: z.string(),
      regex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      onlyDialogue: z.boolean().optional(),
      count: z.number().int().nonnegative()
    }),
    async ({ rootPath, localNo, find, replace, regex, caseSensitive, onlyDialogue, count }) => {
      const settings = getSettings()
      const text = readSubtitleText(rootPath, localNo)
      if (text === null) throw new Error('该集尚未导入字幕')
      const result = replaceInAss(text, find, replace, {
        regex,
        caseSensitive,
        onlyDialogue,
        limit: count > 0 ? count : undefined
      })
      if (result.count > 0) {
        writeSubtitleText(rootPath, localNo, result.text, settings.operator)
        const changed = await checkSubtitleIntegrity(rootPath, localNo, settings.operator, '字幕内容被查找替换修改')
        const ep = openStore(rootPath).getEpisode(localNo)
        broadcast('episode:state', { localNo, state: ep.state })
        if (changed) broadcast('watch:subtitle-changed', { localNo, kind: 'subtitle', message: '字幕已变更，审阅结论失效', state: ep.state })
      }
      return { count: result.count }
    }
  )

  handle(
    'subtitle:open-external',
    z.object({ rootPath: z.string().min(1), localNo: z.string().min(1) }),
    async ({ rootPath, localNo }) => {
      const store = openStore(rootPath)
      const ep = store.getEpisode(localNo)
      if (!ep.subtitle?.path || !fs.existsSync(ep.subtitle.path)) throw new Error('该集尚未导入字幕')
      const aegisub = resolveTool('aegisub')
      if (aegisub.exists) {
        spawn(aegisub.path, [ep.subtitle.path], { detached: true, stdio: 'ignore' }).unref()
      } else {
        const err = await shell.openPath(ep.subtitle.path)
        if (err) throw new Error(err)
      }
    }
  )
}
