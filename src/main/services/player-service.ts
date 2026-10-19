import type { BrowserWindow } from 'electron'
import { BrowserWindow as BW } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { resolveTool } from '../integrations/tools'
import { scoped } from '../util/logger'
import { broadcast } from '../ipc/events'

const log = scoped('player')

export interface PlayerRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PlayerStatus {
  running: boolean
  engine: 'mpv' | 'builtin'
  timePos: number
  duration: number
  paused: boolean
  reason?: string
}

interface PlayerSession {
  mainWin: BrowserWindow
  overlay: BrowserWindow
  child: ChildProcess
  socket: net.Socket
  rect: PlayerRect
  status: PlayerStatus
  mainListeners: Array<() => void>
}

let session: PlayerSession | null = null
let generation = 0
let broadcastTimer: NodeJS.Timeout | null = null

export function playerStatus(): PlayerStatus {
  return session?.status ?? { running: false, engine: 'builtin', timePos: 0, duration: 0, paused: true }
}

function pushStatus(patch: Partial<PlayerStatus>): void {
  if (!session) return
  session.status = { ...session.status, ...patch }
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    if (session) broadcast('mpv:status', session.status)
  }, 120)
}

function hwndOf(win: BrowserWindow): string {
  const buf = win.getNativeWindowHandle()
  if (buf.length >= 8) return buf.readBigUInt64LE(0).toString()
  return String(buf.readUInt32LE(0))
}

function screenBounds(mainWin: BrowserWindow, rect: PlayerRect): PlayerRect {
  const content = mainWin.getContentBounds()
  return {
    x: Math.round(content.x + rect.x),
    y: Math.round(content.y + rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height))
  }
}

function applyBounds(): void {
  if (!session) return
  const bounds = screenBounds(session.mainWin, session.rect)
  try {
    session.overlay.setBounds(bounds)
  } catch {
    /* ignore */
  }
}

function send(command: unknown[]): void {
  if (!session?.socket) return
  try {
    session.socket.write(`${JSON.stringify({ command })}\n`)
  } catch (err) {
    log.warn('mpv command failed', { message: String(err) })
  }
}

export function updatePlayerBounds(rect: PlayerRect): void {
  if (!session) return
  session.rect = rect
  applyBounds()
}

export function sendPlayerCommand(command: unknown[]): { ok: boolean; error?: string } {
  if (!session?.socket) return { ok: false, error: '播放器未运行' }
  send(command)
  return { ok: true }
}

function destroyLocal(overlay: BrowserWindow | null, child: ChildProcess | null): void {
  if (child) {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }
  if (overlay && !overlay.isDestroyed()) {
    try {
      overlay.destroy()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 用 mpv 内嵌播放：无边框子窗口的 HWND 交给 mpv（--wid），由 mpv 渲染画面与 ASS 字幕。
 * 通过 generation 令牌避免并发 start/stop 互相覆盖。
 */
export async function startPlayer(
  mainWin: BrowserWindow,
  input: { videoPath: string; subtitlePath: string | null; rect: PlayerRect }
): Promise<{ ok: boolean; reason?: string; engine: 'mpv' | 'builtin' }> {
  generation += 1
  const myGen = generation
  stopPlayerInternal(false)
  const isCurrent = () => generation === myGen

  const mpv = resolveTool('mpv')
  if (!mpv.exists) {
    return { ok: false, reason: '未找到 mpv（可在设置 → 外部工具指定）', engine: 'builtin' }
  }

  log.info('player start', { video: path.basename(input.videoPath), sub: input.subtitlePath ? path.basename(input.subtitlePath) : null })

  const overlay = new BW({
    parent: mainWin,
    frame: false,
    show: false,
    movable: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 透明窗口 + 不加载页面：避免 Chromium 在 mpv 画面上再铺一层背景
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  overlay.setMenu(null)
  overlay.setBounds(screenBounds(mainWin, input.rect))
  overlay.showInactive()

  const pipePath = `\\\\.\\pipe\\epflow-mpv-${process.pid}-${Date.now()}-${myGen}`
  const args = [
    `--wid=${hwndOf(overlay)}`,
    `--input-ipc-server=${pipePath}`,
    '--idle=yes',
    '--force-window=yes',
    '--keep-open=yes',
    '--no-terminal',
    '--no-input-cursor',
    '--osc=yes',
    '--osd-level=0',
    '--volume=80',
    '--pause=yes',
    '--hwdec=auto-safe',
    '--sub-auto=no',
    '--really-quiet'
  ]

  let child: ChildProcess
  try {
    child = spawn(mpv.path, args, { stdio: 'ignore', windowsHide: true })
  } catch (err) {
    destroyLocal(overlay, null)
    return { ok: false, reason: `启动 mpv 失败：${String(err)}`, engine: 'builtin' }
  }
  log.info('mpv spawned', { pid: child.pid })

  const connectDeadline = Date.now() + 6_000
  const socket = await new Promise<net.Socket | null>((resolve) => {
    const attempt = () => {
      if (!isCurrent()) {
        resolve(null)
        return
      }
      const s = net.connect(pipePath)
      const fail = () => {
        s.destroy()
        if (Date.now() > connectDeadline) resolve(null)
        else setTimeout(attempt, 150)
      }
      s.once('connect', () => resolve(s))
      s.once('error', fail)
    }
    attempt()
  })

  if (!socket || !isCurrent()) {
    if (socket) socket.destroy()
    destroyLocal(overlay, child)
    if (!isCurrent()) {
      log.info('player start superseded')
      return { ok: false, reason: '已被新的播放请求取代', engine: 'builtin' }
    }
    log.warn('mpv ipc connect timeout')
    return { ok: false, reason: 'mpv 启动超时（无法连接控制管道）', engine: 'builtin' }
  }

  const newSession: PlayerSession = {
    mainWin,
    overlay,
    child,
    socket,
    rect: input.rect,
    status: { running: true, engine: 'mpv', timePos: 0, duration: 0, paused: true },
    mainListeners: []
  }
  session = newSession
  log.info('mpv connected', { pid: child.pid })

  const onMove = () => applyBounds()
  mainWin.on('move', onMove)
  mainWin.on('resize', onMove)
  newSession.mainListeners.push(() => {
    mainWin.removeListener('move', onMove)
    mainWin.removeListener('resize', onMove)
  })

  let buffer = ''
  socket.on('data', (chunk) => {
    if (session !== newSession) return
    buffer += chunk.toString('utf8')
    let idx = buffer.indexOf('\n')
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      idx = buffer.indexOf('\n')
      if (!line) continue
      try {
        const msg = JSON.parse(line) as { event?: string; name?: string; data?: unknown }
        if (msg.event === 'property-change') {
          if (msg.name === 'time-pos' && typeof msg.data === 'number') pushStatus({ timePos: msg.data })
          if (msg.name === 'duration' && typeof msg.data === 'number') pushStatus({ duration: msg.data })
          if (msg.name === 'pause' && typeof msg.data === 'boolean') pushStatus({ paused: msg.data })
        } else if (msg.event === 'file-loaded') {
          if (input.subtitlePath) send(['sub-add', input.subtitlePath, 'select'])
          send(['set_property', 'pause', true])
        } else if (msg.event === 'end-file') {
          pushStatus({ paused: true })
        }
      } catch {
        /* ignore non-json */
      }
    }
  })
  socket.on('error', () => undefined)

  send(['observe_property', 1, 'time-pos'])
  send(['observe_property', 2, 'duration'])
  send(['observe_property', 3, 'pause'])
  send(['loadfile', input.videoPath, 'replace'])
  send(['set_property', 'pause', true])

  child.on('exit', (code) => {
    log.info('mpv exited', { code })
    if (session === newSession) {
      session.status = { ...session.status, running: false }
      broadcast('mpv:status', session.status)
      stopPlayerInternal(false)
    }
  })

  overlay.on('closed', () => {
    if (session === newSession) stopPlayerInternal(false)
  })

  log.info('mpv started', { video: path.basename(input.videoPath) })
  return { ok: true, engine: 'mpv' }
}

function stopPlayerInternal(notify: boolean): void {
  const current = session
  session = null
  if (current) {
    for (const off of current.mainListeners) {
      try {
        off()
      } catch {
        /* ignore */
      }
    }
    try {
      current.socket.write(`${JSON.stringify({ command: ['quit'] })}\n`)
    } catch {
      /* ignore */
    }
    current.socket.destroy()
    destroyLocal(current.overlay, current.child)
    log.info('mpv stopped')
  }
  if (notify) {
    broadcast('mpv:status', { running: false, engine: 'mpv', timePos: 0, duration: 0, paused: true })
  }
}

export function stopPlayer(): void {
  generation += 1
  stopPlayerInternal(true)
}
