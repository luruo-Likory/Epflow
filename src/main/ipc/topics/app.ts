import { app, dialog, shell, BrowserWindow } from 'electron'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { handle } from '../registry'
import { getSettings, resetSettings, saveSettings } from '../../store/settings'
import { detectTools, applyDetectedTools } from '../../integrations/tools'
import { logsDir } from '../../util/logger'

const empty = z.undefined().or(z.null()).transform(() => undefined)

const fileFilter = z.object({
  name: z.string(),
  extensions: z.array(z.string())
})

export function registerAppTopics(): void {
  handle('app:info', empty, () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath('userData'),
    isPackaged: app.isPackaged,
    locale: app.getLocale()
  }))

  handle(
    'app:open-path',
    z.object({ path: z.string().min(1), reveal: z.boolean().optional() }),
    async ({ path: target, reveal }) => {
      if (reveal) {
        shell.showItemInFolder(target)
      } else {
        const err = await shell.openPath(target)
        if (err) throw new Error(err)
      }
    }
  )

  handle('app:quit', empty, () => {
    app.quit()
  })

  handle('settings:get', empty, () => getSettings())

  handle('settings:save', z.object({}).passthrough(), (patch) => {
    const clean = { ...patch } as Record<string, unknown>
    // publish 分组在 v1 强制关闭
    if (clean.publish && typeof clean.publish === 'object') {
      const publish = clean.publish as Record<string, unknown>
      publish.enabled = false
      publish.uploadEnabled = false
    }
    return saveSettings(clean as Parameters<typeof saveSettings>[0])
  })

  handle('settings:detect-tools', z.object({ withVersion: z.boolean().optional() }).optional(), async (payload) =>
    detectTools({ withVersion: payload?.withVersion })
  )

  handle('settings:apply-tools', empty, async () => {
    await applyDetectedTools()
    return getSettings()
  })

  handle(
    'dialog:pick-files',
    z.object({
      title: z.string().optional(),
      filters: z.array(fileFilter).optional(),
      multi: z.boolean().optional()
    }),
    async ({ title, filters, multi }) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const res = win
        ? await dialog.showOpenDialog(win, {
            title,
            filters,
            properties: multi ? ['openFile', 'multiSelections'] : ['openFile']
          })
        : await dialog.showOpenDialog({ title, filters, properties: ['openFile'] })
      return res.canceled ? [] : res.filePaths
    }
  )

  handle(
    'dialog:pick-dir',
    z.object({ title: z.string().optional(), defaultPath: z.string().optional() }),
    async ({ title, defaultPath }) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const res = win
        ? await dialog.showOpenDialog(win, { title, defaultPath, properties: ['openDirectory', 'createDirectory'] })
        : await dialog.showOpenDialog({ title, defaultPath, properties: ['openDirectory'] })
      return res.canceled ? null : (res.filePaths[0] ?? null)
    }
  )

  handle(
    'dialog:save-file',
    z.object({ title: z.string().optional(), defaultPath: z.string().optional(), filters: z.array(fileFilter).optional() }),
    async ({ title, defaultPath, filters }) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const res = win
        ? await dialog.showSaveDialog(win, { title, defaultPath, filters })
        : await dialog.showSaveDialog({ title, defaultPath, filters })
      return res.canceled ? null : (res.filePath ?? null)
    }
  )

  handle('app:export-diagnostics', z.object({ dir: z.string().min(1) }), async ({ dir }) => {
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const target = path.join(dir, `epflow-diagnostics-${stamp}`)
    fs.mkdirSync(target, { recursive: true })
    const files: string[] = []

    // 日志
    const srcLogs = logsDir()
    for (const f of fs.readdirSync(srcLogs)) {
      if (!f.endsWith('.log')) continue
      fs.copyFileSync(path.join(srcLogs, f), path.join(target, f))
      files.push(f)
    }

    // 脱敏设置（去掉路径以外没有敏感信息，仍只保留工具路径与分组）
    const settings = getSettings()
    const sanitized = {
      ...settings,
      operator: settings.operator ? '(已填写)' : '',
      tools: Object.fromEntries(
        Object.entries(settings.tools).map(([k, v]) => [k, v ? path.basename(v) : ''])
      )
    }
    const settingsPath = path.join(target, 'settings.sanitized.json')
    fs.writeFileSync(settingsPath, JSON.stringify(sanitized, null, 2), 'utf8')
    files.push('settings.sanitized.json')

    const summary = {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      platform: process.platform,
      arch: process.arch,
      osRelease: process.getSystemVersion?.() ?? '',
      generatedAt: new Date().toISOString()
    }
    const summaryPath = path.join(target, 'system.json')
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8')
    files.push('system.json')

    return { path: target, files }
  })

  // 预留：重置设置（供设置页使用）
  handle('settings:reset', empty, () => resetSettings())
}
