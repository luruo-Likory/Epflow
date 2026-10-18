import type { AppError, ErrorCode, Result } from './types'

export class EpFlowError extends Error {
  readonly code: ErrorCode
  readonly hint?: string
  readonly detail?: unknown

  constructor(code: ErrorCode, message: string, opts?: { hint?: string; detail?: unknown }) {
    super(message)
    this.name = 'EpFlowError'
    this.code = code
    this.hint = opts?.hint
    this.detail = opts?.detail
  }
}

export function epError(
  code: ErrorCode,
  message: string,
  opts?: { hint?: string; detail?: unknown }
): AppError {
  return { code, message, hint: opts?.hint, detail: opts?.detail }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof EpFlowError) {
    return { code: err.code, message: err.message, hint: err.hint, detail: err.detail }
  }
  if (err instanceof Error) {
    return { code: 'E_INTERNAL', message: err.message, detail: { stack: err.stack } }
  }
  return { code: 'E_INTERNAL', message: String(err) }
}

export function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

export function fail(err: unknown): Result<never> {
  return { ok: false, error: toAppError(err) }
}

export function assert(condition: unknown, code: ErrorCode, message: string, hint?: string): asserts condition {
  if (!condition) throw new EpFlowError(code, message, { hint })
}

/** 便于 UI 直接把错误变成一句可读文案 */
export function errorText(err: AppError): string {
  return err.hint ? `${err.message}（${err.hint}）` : err.message
}
