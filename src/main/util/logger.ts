import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const KEEP_DAYS = 14
const MAX_FIELD_LEN = 600

let currentDay = ''
let stream: fs.WriteStream | null = null
let currentLevel: LogLevel = 'info'
const listeners = new Set<(line: LogLine) => void>()

export interface LogLine {
  at: string
  level: LogLevel
  scope: string
  message: string
  extra?: unknown
}

export function logsDir(): string {
  const dir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level
}

export function onLogLine(cb: (line: LogLine) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function dayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function openStream(day: string): fs.WriteStream {
  const file = path.join(logsDir(), `epflow-${day}.log`)
  const s = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' })
  s.on('error', () => {
    /* 日志失败不能影响主流程 */
  })
  return s
}

function rotateIfNeeded(day: string): void {
  if (day === currentDay && stream) return
  stream?.end()
  currentDay = day
  stream = openStream(day)
  pruneOldLogs()
}

function pruneOldLogs(): void {
  try {
    const dir = logsDir()
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^epflow-\d{8}\.log$/.test(f))
      .sort()
    const excess = files.length - KEEP_DAYS
    if (excess <= 0) return
    for (const f of files.slice(0, excess)) {
      try {
        fs.unlinkSync(path.join(dir, f))
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function shortValue(value: unknown): unknown {
  if (value === undefined || value === null) return value
  if (typeof value === 'string') {
    return value.length > MAX_FIELD_LEN ? `${value.slice(0, MAX_FIELD_LEN)}…(${value.length})` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  try {
    const text = JSON.stringify(value)
    if (text && text.length > MAX_FIELD_LEN) return `${text.slice(0, MAX_FIELD_LEN)}…`
    return value
  } catch {
    return String(value)
  }
}

export function log(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return
  const at = new Date().toISOString()
  const line: LogLine = { at, level, scope, message, extra: shortValue(extra) }

  const text =
    `${at} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}` +
    (extra === undefined ? '' : ` ${safeStringify(line.extra)}`)

  if (!app.isPackaged) {
    // eslint-disable-next-line no-console
    console.log(text)
  }
  try {
    rotateIfNeeded(dayKey(new Date()))
    stream?.write(`${text}\n`)
  } catch {
    /* ignore */
  }
  for (const cb of listeners) {
    try {
      cb(line)
    } catch {
      /* ignore */
    }
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

export interface Logger {
  debug(message: string, extra?: unknown): void
  info(message: string, extra?: unknown): void
  warn(message: string, extra?: unknown): void
  error(message: string, extra?: unknown): void
}

export function scoped(scope: string): Logger {
  return {
    debug: (m, e) => log('debug', scope, m, e),
    info: (m, e) => log('info', scope, m, e),
    warn: (m, e) => log('warn', scope, m, e),
    error: (m, e) => log('error', scope, m, e)
  }
}

export function closeLog(): void {
  stream?.end()
  stream = null
}
