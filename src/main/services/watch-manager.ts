import fs from 'node:fs'
import path from 'node:path'
import { openStore } from '../store/repository'
import { checkSubtitleIntegrity } from './subtitle-service'
import { broadcast } from '../ipc/events'
import { scoped } from '../util/logger'
import { getSettings } from '../store/settings'

const log = scoped('watch')

interface ActiveWatch {
  rootPath: string
  close: () => void
}

let active: ActiveWatch | null = null
let pending = new Set<string>()
let timer: NodeJS.Timeout | null = null

export function activateProject(rootPath: string): void {
  deactivateProject()
  try {
    const watcher = fs.watch(rootPath, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const file = String(filename)
      if (!/\.(ass|ssa|xml)$/i.test(file)) return
      pending.add(path.join(rootPath, file))
      schedule(rootPath)
    })
    active = {
      rootPath,
      close: () => watcher.close()
    }
    log.info('watch activated', { rootPath })
  } catch (err) {
    log.warn('watch failed', { message: String(err) })
  }
}

export function deactivateProject(): void {
  active?.close()
  active = null
  pending = new Set()
  if (timer) clearTimeout(timer)
  timer = null
}

function schedule(rootPath: string): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    const files = [...pending]
    pending = new Set()
    void handleChanges(rootPath, files)
  }, 600)
}

async function handleChanges(rootPath: string, files: string[]): Promise<void> {
  if (!ProjectExists(rootPath)) return
  const settings = getSettings()
  let store
  try {
    store = openStore(rootPath)
  } catch {
    return
  }
  const affected = new Set<string>()
  for (const file of files) {
    const match = store.episodes.find(
      (ep) =>
        (ep.subtitle && sameFile(ep.subtitle.path, file)) ||
        (ep.chapters && sameFile(ep.chapters.path, file)) ||
        (ep.chapterDraft && sameFile(ep.chapterDraft.path, file))
    )
    if (match) affected.add(match.localNo)
  }
  for (const localNo of affected) {
    try {
      const changed = await checkSubtitleIntegrity(rootPath, localNo, settings.operator, '检测到字幕文件变化')
      const ep = openStore(rootPath).getEpisode(localNo)
      if (changed) {
        broadcast('watch:subtitle-changed', {
          localNo,
          kind: 'subtitle',
          message: '字幕已变更，AI 与人工审阅结论已失效',
          state: ep.state
        })
        broadcast('episode:state', { localNo, state: ep.state })
      } else {
        broadcast('watch:chapters-changed', {
          localNo,
          kind: 'chapters',
          message: '检测到章节文件变化',
          state: ep.state
        })
      }
    } catch (err) {
      log.warn('change handling failed', { localNo, message: String(err) })
    }
  }
}

function sameFile(a: string | null | undefined, b: string): boolean {
  if (!a) return false
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

function ProjectExists(rootPath: string): boolean {
  return fs.existsSync(rootPath)
}

export function currentWatchRoot(): string | null {
  return active?.rootPath ?? null
}
