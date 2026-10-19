/** vitest 用的 electron 最小桩件：让主进程服务能在普通 Node 下被测试 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

// 每个测试 worker 用独立目录，避免并行运行时 app-state.json 的原子写竞争
const base = path.join(os.tmpdir(), `epflow-vitest-userdata-${process.pid}`)
fs.mkdirSync(base, { recursive: true })

export const app = {
  isPackaged: false,
  getVersion: () => '1.0.0-test',
  getName: () => 'EpFlow',
  setName: () => undefined,
  getLocale: () => 'zh-CN',
  getPath: (name: string) => {
    if (name === 'userData') return base
    if (name === 'temp') return os.tmpdir()
    if (name === 'logs') return path.join(base, 'logs')
    return base
  },
  setPath: () => undefined,
  setAppUserModelId: () => undefined,
  disableHardwareAcceleration: () => undefined,
  requestSingleInstanceLock: () => true,
  whenReady: () => Promise.resolve(),
  quit: () => undefined,
  on: () => undefined,
  once: () => undefined
}

export const ipcMain = {
  handle: () => undefined,
  removeHandler: () => undefined
}

export const BrowserWindow = class {
  static getAllWindows(): unknown[] {
    return []
  }
  static getFocusedWindow(): null {
    return null
  }
}

export const shell = {
  openPath: async () => '',
  showItemInFolder: () => undefined,
  openExternal: async () => undefined
}

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: '' })
}

export const clipboard = { writeText: () => undefined }

export const contextBridge = { exposeInMainWorld: () => undefined }

export const ipcRenderer = {
  on: () => undefined,
  invoke: async () => undefined
}

export default { app, ipcMain, BrowserWindow, shell, dialog, clipboard, contextBridge, ipcRenderer }
