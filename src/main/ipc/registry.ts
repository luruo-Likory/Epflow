import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ZodType } from 'zod'
import { EpFlowError, toAppError } from '@shared/errors'
import type { Result } from '@shared/types'
import { log } from '../util/logger'

type Handler<P, R> = (payload: P, event: IpcMainInvokeEvent) => Promise<R> | R

interface Registration<P, R> {
  name: string
  payload: ZodType<P>
  result?: ZodType<R>
  handler: Handler<P, R>
}

const registrations = new Map<string, Registration<unknown, unknown>>()

/** 注册一个 IPC 主题；payload 一律经过 zod 校验，返回统一 Result 信封。 */
export function handle<P, R>(
  name: string,
  payload: ZodType<P>,
  handler: Handler<P, R>,
  result?: ZodType<R>
): void {
  if (registrations.has(name)) throw new Error(`duplicate ipc topic: ${name}`)
  registrations.set(name, { name, payload, handler, result } as Registration<unknown, unknown>)
}

export function registerIpc(): void {
  for (const reg of registrations.values()) {
    ipcMain.handle(reg.name, async (event, raw): Promise<Result<unknown>> => {
      const started = Date.now()
      try {
        const parsed = reg.payload.safeParse(raw)
        if (!parsed.success) {
          const message = parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ')
          throw new EpFlowError('E_VALIDATION', `参数校验失败：${message}`)
        }
        const value = await reg.handler(parsed.data, event)
        if (reg.result) {
          const checked = reg.result.safeParse(value)
          if (!checked.success) {
            throw new EpFlowError('E_SCHEMA', `返回值不符合约定：${reg.name}`, {
              detail: checked.error.issues
            })
          }
        }
        log('debug', 'ipc', `${reg.name} ok`, { ms: Date.now() - started })
        return { ok: true, data: value }
      } catch (err) {
        const error = toAppError(err)
        log('warn', 'ipc', `${reg.name} failed`, {
          code: error.code,
          message: error.message,
          ms: Date.now() - started
        })
        return { ok: false, error }
      }
    })
  }
  log('info', 'ipc', `registered ${registrations.size} topics`)
}
