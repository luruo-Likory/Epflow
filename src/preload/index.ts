import { contextBridge, ipcRenderer } from 'electron'

type Listener = (payload: unknown) => void

const listeners = new Map<string, Set<Listener>>()

function on(channel: string, cb: Listener): () => void {
  const set = listeners.get(channel) ?? new Set<Listener>()
  set.add(cb)
  listeners.set(channel, set)
  return () => set.delete(cb)
}

// 统一订阅：所有主进程事件从同一个桥接通道转发
ipcRenderer.on('epflow:event', (_event, channel: string, payload: unknown) => {
  const set = listeners.get(channel)
  if (!set) return
  for (const cb of set) {
    try {
      cb(payload)
    } catch {
      /* ignore */
    }
  }
})

const api = {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    return ipcRenderer.invoke(channel, payload)
  },
  on,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }
}

contextBridge.exposeInMainWorld('epflow', api)

export type EpFlowBridge = typeof api
