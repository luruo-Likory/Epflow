import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { DshSettings } from '@shared/types'
import { runProcess } from './process-runner'
import { resolveTool } from './tools'
import { nodeEntryFor } from './shim'
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
  return {
    ok: false,
    reason: '未找到 dsh / dcli 命令行（可在设置中手动指定，或改用「粘贴 JSON」模式）'
  }
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

type CliKind = 'dsh' | 'dcli' | 'custom'

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase()
}

/**
 * 判断命令行属于哪种实现。
 * - dsh：官方 CLI，支持 `dsh headless -`，任务从 stdin 读，适合长 prompt
 * - dcli：SKzrui/DSH-CLI 的启动器，只支持把任务作为命令行参数
 */
export function cliKindOf(command: string): CliKind {
  const lower = normalizeSlashes(command)
  const base = path.basename(command).toLowerCase()
  if (lower.includes('@deepseek-ai/dsh') || ['dsh', 'dsh.cmd', 'dsh.exe', 'dsh.ps1'].includes(base)) {
    return 'dsh'
  }
  if (
    lower.includes('harmattan666') ||
    lower.includes('/dcli/') ||
    ['dcli', 'dcli.cmd', 'dcli.exe', 'dcli.ps1'].includes(base)
  ) {
    return 'dcli'
  }
  return 'custom'
}

/** 从 npm 生成的 .cmd shim 里解析出真正的 Node 入口（实现在 shim.ts，工具探测也复用） */
export { shimNodeEntry } from './shim'

/** dcli 只能把任务放在 argv 里，超过 Windows 命令行上限会失败，留出安全余量 */
const DCLI_MAX_PROMPT_CHARS = 20_000

/** 从 DSH 凭据库读取 API Key（桌面版登录后密钥存在这里，headless 需要环境变量） */
function apiKeyFromCredentialStore(name: string): string | null {
  try {
    const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
    const text = fs.readFileSync(file, 'utf8')
    const match = new RegExp(`${name}\\s*:\\s*(sk-[A-Za-z0-9_-]+)`).exec(text)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

function buildCliEnv(settings: DshSettings): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: '1',
    DCLI_FORMAT: '0',
    DCLI_SPLIT: '0'
  }
  const keyName = settings.apiKeyEnv || 'DEEPSEEK_API_KEY'
  if (!env[keyName]) {
    const stored = apiKeyFromCredentialStore(keyName)
    if (stored) env[keyName] = stored
  }
  return env
}

async function callCli(prompt: string, settings: DshSettings): Promise<string> {
  const tool = resolveTool('dsh')
  const command = tool.exists ? tool.path : settings.command
  if (!command) throw new DshUnavailableError('未配置 dsh / dcli 命令行')
  if (/deepseek[ _-]?harness\.exe$/i.test(command)) {
    throw new DshUnavailableError(
      '当前「dsh 路径」指向的是 DSH 桌面程序，它不接受命令行参数',
      '请指向 dsh.cmd / dcli.cmd（或 dsh 的 lib/bin.js），或改用「粘贴 JSON」模式'
    )
  }

  const kind = cliKindOf(command)
  const nodeEntry = nodeEntryFor(command)
  if (!nodeEntry && /\.(cmd|bat)$/i.test(command)) {
    throw new DshUnavailableError(
      `无法从 ${path.basename(command)} 解析出 Node 入口`,
      '请在设置里把路径指向 node_modules\\@deepseek-ai\\dsh\\lib\\bin.js 或 dcli 的 bin\\dcli.js'
    )
  }

  const env = buildCliEnv(settings)
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epflow-ai-'))
  let file = command
  let args: string[] = []
  let stdin: string | undefined

  if (kind === 'dsh') {
    // 官方 CLI 的一次性模式：任务从 stdin 读（`-`），长 prompt 不受命令行长度限制
    file = nodeEntry ? process.execPath : command
    args = nodeEntry ? [nodeEntry, 'headless', '-'] : ['headless', '-']
    stdin = prompt
  } else if (kind === 'dcli') {
    if (prompt.length > DCLI_MAX_PROMPT_CHARS) {
      throw new DshUnavailableError(
        `提示词 ${prompt.length} 字符，超过 dcli 命令行参数的安全上限`,
        '请安装 dsh 并在设置里指向 dsh.cmd（支持 stdin 长 prompt），或改用「粘贴 JSON」模式'
      )
    }
    file = nodeEntry ? process.execPath : command
    args = nodeEntry ? [nodeEntry, prompt] : [prompt]
  } else {
    const promptFile = path.join(workDir, 'prompt.md')
    fs.writeFileSync(promptFile, prompt, 'utf8')
    args = buildArgs(settings.argsTemplate, { promptFile, model: settings.model })
  }

  try {
    const result = await runProcess(file, args, {
      timeoutMs: settings.timeoutMs,
      env,
      stdin,
      // 隔离 dsh/dcli 的会话目录，避免污染项目目录；自定义命令沿用调用方环境
      cwd: kind === 'custom' ? undefined : workDir,
      maxOutput: 4_000_000
    })
    if (result.timedOut) throw new Error(`AI 调用超时（${settings.timeoutMs}ms）`)
    if (result.code !== 0) {
      throw new Error(`AI 命令退出码 ${result.code}：${(result.stderr || result.stdout).slice(0, 800)}`)
    }
    const text = result.stdout.trim() || result.stderr.trim()
    if (!text) throw new Error('AI 命令没有输出内容')
    return text
  } finally {
    setTimeout(() => {
      try {
        fs.rmSync(workDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }, 5_000)
    log.debug('cli call done', { kind })
  }
}

/** 直接读取已有 prompt 文件内容（粘贴模式用） */
export function writePromptFile(dir: string, name: string, prompt: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, prompt, 'utf8')
  return file
}
