import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { registerAllTopics } from './ipc'
import { registerIpc } from './ipc/registry'
import { loadSettings, userDataDir } from './store/settings'
import { closeLog, log, scoped } from './util/logger'
import { readJsonSafe, writeJsonAtomic } from './store/atomic'

const logMain = scoped('main')

// 管道断开时避免 EPIPE 把进程带崩
process.stdout?.on?.('error', () => undefined)
process.stderr?.on?.('error', () => undefined)
const isDev = !app.isPackaged && process.env.NODE_ENV === 'development'
const smokeArg = process.argv.find((a) => a.startsWith('--smoke'))

// 测试/便携场景：允许覆盖数据目录，避免污染真实用户数据
if (process.env.EPFLOW_USER_DATA) {
  app.setPath('userData', process.env.EPFLOW_USER_DATA)
}
if (smokeArg) {
  app.disableHardwareAcceleration()
}

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

const WINDOW_STATE_FILE = () => path.join(userDataDir(), 'window-state.json')

let mainWindow: BrowserWindow | null = null

function loadWindowState(): WindowState {
  const fallback: WindowState = { width: 1440, height: 900 }
  const state = readJsonSafe<WindowState>(WINDOW_STATE_FILE(), fallback)
  if (!Number.isFinite(state.width) || state.width < 1024) state.width = fallback.width
  if (!Number.isFinite(state.height) || state.height < 720) state.height = fallback.height
  return state
}

function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const bounds = win.getNormalBounds()
  writeJsonAtomic(WINDOW_STATE_FILE(), {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    maximized: win.isMaximized()
  } satisfies WindowState)
}

function buildMenu(win: BrowserWindow): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '打开数据目录', click: () => shell.openPath(userDataDir()) },
        { type: 'separator' },
        { label: '退出', role: 'quit', accelerator: 'Alt+F4' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开日志目录',
          click: () => shell.openPath(path.join(userDataDir(), 'logs'))
        },
        {
          label: '关于 EpFlow',
          click: () => {
            void win.webContents.executeJavaScript(
              `window.dispatchEvent(new CustomEvent('epflow:about'))`
            )
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  const state = loadWindowState()
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: '#F8FAFC',
    show: false,
    autoHideMenuBar: false,
    title: 'EpFlow',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true
    }
  })

  mainWindow = win

  if (state.maximized) win.maximize()

  win.once('ready-to-show', () => {
    win.show()
  })

  win.on('close', () => saveWindowState(win))
  win.on('closed', () => {
    mainWindow = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    void win.loadURL(devUrl)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  if (smokeArg) setupSmoke(win)

  buildMenu(win)
}

/**
 * 冒烟自检：加载完成后导出渲染层状态并退出。
 * 用于无人工介入的构建验证（T7-06 E2E 基础）。
 */
async function captureScreens(win: BrowserWindow, dir: string): Promise<string[]> {
  fs.mkdirSync(dir, { recursive: true })
  const trail: string[] = []
  const shot = async (name: string) => {
    const breadcrumb = (await win.webContents.executeJavaScript(
      `(document.querySelector('.breadcrumb') || document.body).innerText.replace(/\\s+/g, ' ').slice(0, 80)`
    )) as string
    trail.push(`${name}: ${breadcrumb}`)
    const image = await win.webContents.capturePage()
    fs.writeFileSync(path.join(dir, `${name}.png`), image.toPNG())
  }
  const clickText = async (text: string): Promise<boolean> =>
    (await win.webContents.executeJavaScript(
      `(() => {
        const target = ${JSON.stringify(text)}.replace(/\\s/g, '')
        const nodes = Array.from(document.querySelectorAll('button, .nav-item, .tab'))
        const el = nodes.find(
          (n) =>
            ((n.textContent || '').replace(/\\s/g, '')).includes(target) ||
            ((n.getAttribute('aria-label') || '').replace(/\\s/g, '')).includes(target)
        )
        if (el) { el.click(); return true }
        return false
      })()`
    )) as boolean
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  await wait(600)
  // 冒烟时强制使用 mpv 内嵌，避免历史 localStorage 把截图固定成内置播放器
  await win.webContents
    .executeJavaScript(`try { localStorage.setItem('epflow.player', 'builtin') } catch (e) {}`)
    .catch(() => undefined)
  await shot('01-projects')
  // 若已有项目，进入项目页与审阅工作台各截一张，便于验证新界面
  const openedProject = (await win.webContents.executeJavaScript(
    `(() => {
      const cards = Array.from(document.querySelectorAll('.card'))
      const card =
        cards.find((c) => (c.textContent || '').includes('演示番')) ||
        cards.find((c) => /共 \\d+ 集|已完成|状态库/.test(c.textContent || ''))
      if (!card) return false
      card.click()
      return true
    })()`
  )) as boolean
  if (openedProject) {
    await wait(1400)
    await shot('01b-project')
    const openedEpisode = (await win.webContents.executeJavaScript(
      `(() => {
        const cards = Array.from(document.querySelectorAll('.card'))
        const card = cards.find((c) => /第 \\d+ 集/.test(c.textContent || ''))
        if (!card) return false
        card.click()
        return true
      })()`
    )) as boolean
    if (openedEpisode) {
      await wait(Number(process.env.EPFLOW_SMOKE_HOLD ?? 1600))
      await shot('01c-workbench')
      // 试着播放，验证 mpv 是否真的在推进（截图看不到子窗口内容，用状态判断）
      await clickText('播放或暂停')
      await wait(2000)
      const status = (await win.webContents.executeJavaScript(
        `window.epflow.invoke('player:status')`
      )) as { data?: { running?: boolean; timePos?: number; paused?: boolean } }
      trail.push(`player: ${JSON.stringify(status?.data ?? status)}`)
      await shot('01d-workbench-playing')
      await clickText('← 项目')
      await wait(600)
    }
  }
  if (await clickText('设置')) {
    await wait(900)
    await shot('02-settings')
  }
  if (await clickText('审计日志')) {
    await wait(700)
    await shot('03-audit')
  }
  if (await clickText('项目')) {
    await wait(600)
    if (await clickText('＋ 新建项目')) {
      await wait(900)
      await shot('04-wizard')
    }
  }
  if (await clickText('发布（v2）')) {
    await wait(600)
    await shot('05-publish')
  }
  return trail
}

function setupSmoke(win: BrowserWindow): void {
  const errors: string[] = []
  const outArg = process.argv.find((a) => a.startsWith('--smoke-out='))
  const outFile = outArg ? outArg.slice('--smoke-out='.length) : path.join(userDataDir(), 'smoke.json')
  let done = false

  win.webContents.on('console-message', (...args: unknown[]) => {
    const first = args[0] as { level?: string | number; message?: string } | number | undefined
    const second = args[1]
    if (typeof first === 'object' && first !== null) {
      if (first.level === 'error' || first.level === 3) errors.push(String(first.message ?? ''))
      return
    }
    if (typeof first === 'number' && first >= 2) errors.push(String(second ?? ''))
  })
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    errors.push(`did-fail-load ${code} ${desc}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    errors.push(`render-process-gone ${details.reason}`)
  })

  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void (async () => {
        if (done) return
        done = true
        const shotsArg = process.argv.find((a) => a.startsWith('--shots='))
        let trail: string[] = []
        if (shotsArg) {
          try {
            win.show()
            trail = await captureScreens(win, shotsArg.slice('--shots='.length))
          } catch (err) {
            errors.push(`screenshot failed: ${String(err)}`)
          }
        }
        let dom: { title: string; text: string; hasRoot: boolean; childCount: number } = {
          title: '',
          text: '',
          hasRoot: false,
          childCount: 0
        }
        try {
          dom = (await win.webContents.executeJavaScript(
            `(() => {
              const root = document.querySelector('#root')
              return {
                title: document.title,
                text: (document.body.innerText || '').slice(0, 4000),
                hasRoot: Boolean(root),
                childCount: root ? root.children.length : 0
              }
            })()`
          )) as typeof dom
        } catch (err) {
          errors.push(`executeJavaScript failed: ${String(err)}`)
        }
        const report = {
          at: new Date().toISOString(),
          ok: errors.length === 0 && dom.hasRoot && dom.childCount > 0,
          errors,
          trail,
          dom
        }
        try {
          fs.mkdirSync(path.dirname(outFile), { recursive: true })
          fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8')
        } catch {
          /* ignore */
        }
        log('info', 'main', 'smoke finished', { ok: report.ok, errors: errors.length })
        app.exit(report.ok ? 0 : 1)
      })()
    }, 1800)
  })
}

function bootstrap(): void {
  loadSettings()
  log('info', 'main', 'EpFlow starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    isDev
  })

  registerAllTopics()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  process.on('uncaughtException', (err) => {
    log('error', 'main', 'uncaughtException', { message: err.message, stack: err.stack })
  })
  process.on('unhandledRejection', (reason) => {
    log('error', 'main', 'unhandledRejection', { reason: String(reason) })
  })

  app.setAppUserModelId('com.epflow.app')

  void app.whenReady().then(() => {
    bootstrap()
    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit()
    })
  })

  app.on('before-quit', () => {
    logMain.info('shutting down')
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { deactivateProject } = require('./services/watch-manager') as typeof import('./services/watch-manager')
      deactivateProject()
    } catch {
      /* ignore */
    }
    closeLog()
  })
}
