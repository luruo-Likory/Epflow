import { z } from 'zod'
import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { handle } from '../registry'
import { openStore } from '../../store/repository'
import { existsLong } from '../../util/paths'
import {
  playerStatus,
  sendPlayerCommand,
  startPlayer,
  stopPlayer,
  updatePlayerBounds
} from '../../services/player-service'
import fs from 'node:fs'

const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive()
})

function videoOf(rootPath: string, localNo: string): string | null {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  if (ep.reviewVideo?.path && existsLong(ep.reviewVideo.path)) return ep.reviewVideo.path
  if (ep.templateJson && existsLong(ep.templateJson)) {
    try {
      const json = JSON.parse(fs.readFileSync(ep.templateJson, 'utf8')) as { InputFiles?: unknown }
      const files = Array.isArray(json.InputFiles)
        ? json.InputFiles.filter((x): x is string => typeof x === 'string')
        : []
      const found = files.find((f) => existsLong(f))
      if (found) return found
    } catch {
      /* ignore */
    }
  }
  return null
}

function subtitleOf(rootPath: string, localNo: string): string | null {
  const store = openStore(rootPath)
  const ep = store.getEpisode(localNo)
  return ep.subtitle?.path && existsLong(ep.subtitle.path) ? ep.subtitle.path : null
}

export function registerPlayerTopics(): void {
  handle(
    'player:start',
    z.object({
      rootPath: z.string().min(1),
      localNo: z.string().min(1),
      rect: rectSchema
    }),
    async ({ rootPath, localNo, rect }, event: IpcMainInvokeEvent) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { ok: false, reason: '找不到主窗口', engine: 'builtin' as const }
      const videoPath = videoOf(rootPath, localNo)
      if (!videoPath) return { ok: false, reason: '未找到可播放的视频', engine: 'builtin' as const }
      return startPlayer(win, { videoPath, subtitlePath: subtitleOf(rootPath, localNo), rect })
    }
  )

  handle('player:bounds', z.object({ rect: rectSchema }), ({ rect }) => {
    updatePlayerBounds(rect)
  })

  handle(
    'player:command',
    z.object({ command: z.array(z.union([z.string(), z.number(), z.boolean()])) }),
    ({ command }) => sendPlayerCommand(command)
  )

  handle('player:stop', z.undefined().or(z.null()).transform(() => undefined), () => {
    stopPlayer()
  })

  handle('player:status', z.undefined().or(z.null()).transform(() => undefined), () => playerStatus())
}
