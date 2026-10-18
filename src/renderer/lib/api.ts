import type { ApiTopicMap, TopicName } from '@shared/api'
import type { AppError, Result } from '@shared/types'

export class ApiError extends Error {
  readonly code: AppError['code']
  readonly hint?: string
  readonly detail?: unknown

  constructor(error: AppError) {
    super(error.message)
    this.name = 'ApiError'
    this.code = error.code
    this.hint = error.hint
    this.detail = error.detail
  }

  get text(): string {
    return this.hint ? `${this.message}（${this.hint}）` : this.message
  }
}

export async function invoke<T extends TopicName>(
  topic: T,
  payload?: ApiTopicMap[T]['payload']
): Promise<ApiTopicMap[T]['result']> {
  const res = (await window.epflow.invoke(topic, payload)) as Result<unknown>
  if (!res.ok) throw new ApiError(res.error)
  return res.data as ApiTopicMap[T]['result']
}

export function subscribe(channel: string, cb: (payload: unknown) => void): () => void {
  return window.epflow.on(channel, cb)
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.text
  if (err instanceof Error) return err.message
  return String(err)
}
