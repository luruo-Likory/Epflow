export {}

declare global {
  interface Window {
    epflow: {
      invoke(channel: string, payload?: unknown): Promise<unknown>
      on(channel: string, cb: (payload: unknown) => void): () => void
      platform: string
      versions: {
        electron: string
        chrome: string
        node: string
      }
    }
  }
}
