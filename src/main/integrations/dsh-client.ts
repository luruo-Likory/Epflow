import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { DshSettings } from '@shared/types'
import { runProcess } from './process-runner'
import { resolveTool } from './tools'
import { scoped } from '../util/logger'

const log = scoped('dsh')

export interface DshCallResult {
  text: string
  durationMs: number
  /** 传输层信息，写入审阅记录的 environment 字段 */
  channel: 'cli' | 'http' | 'paste'
  model: string
}

export class DshUnavailableError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message)
    this.name = 'DshUnavailableError'
  }
}

function buildArgs(template: string, vars: Record<string, string>): string[] {
  const expanded = template.replace(/\{(\w+)\}/g, (all, key: string) => vars[key] ?? all)
  // 简易但可靠的参数切分：支持双引号包裹的含空格参数
  const out: string[] = []
  const regex = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(expanded)) !== null) {
    out.push(m[1] ?? m[2] ?? '')
  }
  return out
}

export function dshAvailable(settings: DshSettings): { ok: boolean; reason?: string } {
  if (settings.mode === 'paste') return { ok: true }
  if (settings.mode === 'http') {
    if (!settings.httpUrl) return { ok: false, reason: '未配置 HTTP 接口地址' }
    if (!process.env[settings.apiKeyEnv]) {
      return { ok: false, reason: `环境变量 ${settings.apiKeyEnv} 未设置（用于 API Key）` }
    }
    return { ok: true }
  }
  // cli
  const tool = resolveTool('dsh')
  if (tool.exists) return { ok: true }
  if (settings.command) {
    const found = resolveTool('dsh')
    if (found.exists) return { ok: true }
  }
  return { ok: false, reason: '未找到 dsh 命令行（可在设置中手动指定，或改用「粘贴 JSON」模式）' }
}

/**
 * 调用 AI 审阅。
 * 三种模式共享同一份 prompt 与同一份结果解析逻辑，只有传输层不同。
 */
export async function callDsh(prompt: string, settings: DshSettings): Promise<DshCallResult> {
  const started = Date.now()
  if (settings.mode === 'http') {
    const text = await callHttp(prompt, settings)
    return { text, durationMs: Date.now() - started, channel: 'http', model: settings.model }
  }
  if (settings.mode === 'cli') {
    const text = await callCli(prompt, settings)
    return { text, durationMs: Date.now() - started, channel: 'cli', model: settings.model }
  }
  throw new DshUnavailableError('「粘贴 JSON」模式不需要自动调用', '请复制 prompt 到 DSH，再把返回的 JSON 粘回软件')
}

async function callHttp(prompt: string, settings: DshSettings): Promise<string> {
  const apiKey = process.env[settings.apiKeyEnv]
  if (!apiKey) throw new DshUnavailableError(`环境变量 ${settings.apiKeyEnv} 未设置`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs)
  try {
    const res = await fetch(settings.httpUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.2,
        stream: false,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '你是严谨的字幕审阅助手，只输出 JSON。' },
          { role: 'user', content: prompt }
        ]
      })
    })
    const body = await res.text()
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}：${body.slice(0, 500)}`)
    }
    const parsed = JSON.parse(body) as Record<string, unknown>
    const content = extractContent(parsed)
    if (!content) throw new Error(`接口返回中没有可用的文本内容：${body.slice(0, 300)}`)
    return content
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error(`AI 请求超时（${settings.timeoutMs}ms）`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function extractContent(payload: Record<string, unknown>): string | null {
  const choices = payload.choices
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>
    const message = first.message as Record<string, unknown> | undefined
    if (message && typeof message.content === 'string') return message.content
    if (typeof first.text === 'string') return first.text
  }
  if (typeof payload.content === 'string') return payload.content
  if (typeof payload.text === 'string') return payload.text
  if (typeof payload.output === 'string') return payload.output
  return null
}

async function callCli(prompt: string, settings: DshSettings): Promise<string> {
  const tool = resolveTool('dsh')
  const command = tool.exists ? tool.path : settings.command
  if (!command) throw new DshUnavailableError('未配置 dsh 命令行')

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epflow-dsh-'))
  const promptFile = path.join(tmpDir, 'prompt.md')
  fs.writeFileSync(promptFile, prompt, 'utf8')
  const args = buildArgs(settings.argsTemplate, { promptFile, model: settings.model })

  try {
    const result = await runProcess(command, args, { timeoutMs: settings.timeoutMs })
    if (result.timedOut) throw new Error(`dsh 调用超时（${settings.timeoutMs}ms）`)
    if (result.code !== 0) {
      throw new Error(`dsh 退出码 ${result.code}：${(result.stderr || result.stdout).slice(0, 800)}`)
    }
    const text = result.stdout.trim() || result.stderr.trim()
    if (!text) throw new Error('dsh 没有输出内容')
    return text
  } finally {
    setTimeout(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }, 5_000)
    log.debug('cli call done')
  }
}

/** 直接读取已有 prompt 文件内容（粘贴模式用） */
export function writePromptFile(dir: string, name: string, prompt: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, prompt, 'utf8')
  return file
}
