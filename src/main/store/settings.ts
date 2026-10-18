import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { defaultSettings } from '@shared/constants'
import type { AppSettings } from '@shared/types'
import { readJsonSafe, writeJsonAtomic } from './atomic'
import { scoped } from '../util/logger'

const log = scoped('settings')

let cache: AppSettings | null = null

export function userDataDir(): string {
  return app.getPath('userData')
}

export function settingsFile(): string {
  return path.join(userDataDir(), 'settings.json')
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base
  if (Array.isArray(base) || typeof base !== 'object') return patch as T
  if (typeof patch !== 'object' || Array.isArray(patch)) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const current = (base as Record<string, unknown>)[k]
    out[k] = current !== undefined && typeof current === 'object' && current !== null && !Array.isArray(current)
      ? deepMerge(current, v)
      : v
  }
  return out as T
}

function normalize(s: AppSettings): AppSettings {
  const out = { ...s }
  out.publish = { ...out.publish, enabled: false, uploadEnabled: false }
  out.operator = out.operator || os.userInfo().username
  if (typeof out.allowForcePass !== 'boolean') out.allowForcePass = false
  return out
}

export function loadSettings(): AppSettings {
  if (cache) return cache
  const defaults = defaultSettings()
  const onDisk = readJsonSafe<Partial<AppSettings>>(settingsFile(), {})
  cache = normalize(deepMerge(defaults, onDisk))
  if (!fs.existsSync(settingsFile())) saveSettings(cache)
  return cache
}

export function getSettings(): AppSettings {
  return cache ?? loadSettings()
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const next = normalize(deepMerge(current, patch))
  writeJsonAtomic(settingsFile(), next)
  cache = next
  log.info('settings saved')
  return next
}

export function resetSettings(): AppSettings {
  const next = normalize(defaultSettings())
  writeJsonAtomic(settingsFile(), next)
  cache = next
  return next
}

/* ---------------- 全局应用状态（项目索引） ---------------- */

export interface ProjectIndexEntry {
  id: string
  animeName: string
  rootPath: string
  episodeCount: number
  lastOpenedAt: string
}

export interface AppState {
  schemaVersion: number
  projects: ProjectIndexEntry[]
  lastProjectId: string | null
}

const APP_STATE_VERSION = 1

export function appStateFile(): string {
  return path.join(userDataDir(), 'app-state.json')
}

export function loadAppState(): AppState {
  const fallback: AppState = { schemaVersion: APP_STATE_VERSION, projects: [], lastProjectId: null }
  const state = readJsonSafe<AppState>(appStateFile(), fallback)
  state.projects = Array.isArray(state.projects) ? state.projects : []
  return state
}

export function saveAppState(state: AppState): void {
  state.schemaVersion = APP_STATE_VERSION
  writeJsonAtomic(appStateFile(), state)
}

export function upsertProjectIndex(entry: ProjectIndexEntry): void {
  const state = loadAppState()
  const idx = state.projects.findIndex((p) => p.id === entry.id || p.rootPath.toLowerCase() === entry.rootPath.toLowerCase())
  if (idx >= 0) state.projects[idx] = { ...state.projects[idx], ...entry }
  else state.projects.push(entry)
  state.projects.sort((a, b) => (a.lastOpenedAt < b.lastOpenedAt ? 1 : -1))
  state.lastProjectId = entry.id
  saveAppState(state)
}

export function removeProjectIndex(id: string): void {
  const state = loadAppState()
  state.projects = state.projects.filter((p) => p.id !== id)
  if (state.lastProjectId === id) state.lastProjectId = state.projects[0]?.id ?? null
  saveAppState(state)
}
