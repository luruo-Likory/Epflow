import { spawn } from 'node:child_process'
import { toLongPath } from '../util/paths'

export interface RunOptions {
  cwd?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  /** 传给子进程的额外输入 */
  stdin?: string
  /** 最大保留的输出长度（字符） */
  maxOutput?: number
}

export interface RunResult {
  file: string
  args: string[]
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  cancelled: boolean
  durationMs: number
}

const running = new Set<number>()

export function cancelAllProcesses(): void {
  for (const pid of running) killTree(pid)
  running.clear()
}

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    /* ignore */
  }
}

/**
 * 统一进程调用：一律参数数组，绝不拼接 shell 字符串（§7.7）。
 * 支持超时、取消、流式输出。
 */
export function runProcess(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const started = Date.now()
  const maxOutput = opts.maxOutput ?? 2_000_000
  return new Promise<RunResult>((resolve) => {
    let child
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
        stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      resolve({
        file,
        args,
        code: null,
        signal: null,
        stdout: '',
        stderr: String(err),
        timedOut: false,
        cancelled: false,
        durationMs: Date.now() - started
      })
      return
    }

    if (child.pid) running.add(child.pid)

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let cancelled = false

    const append = (current: string, chunk: Buffer): string => {
      const text = chunk.toString('utf8')
      const next = current + text
      return next.length > maxOutput ? next.slice(next.length - maxOutput) : next
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
      opts.onStdout?.(chunk.toString('utf8'))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
      opts.onStderr?.(chunk.toString('utf8'))
    })

    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin, 'utf8')
    }

    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            if (child.pid) killTree(child.pid)
          }, opts.timeoutMs)
        : null

    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      if (child.pid) running.delete(child.pid)
      resolve({
        file,
        args,
        code: null,
        signal: null,
        stdout,
        stderr: `${stderr}\n${String(err)}`,
        timedOut,
        cancelled,
        durationMs: Date.now() - started
      })
    })

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      if (child.pid) running.delete(child.pid)
      resolve({
        file,
        args,
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        cancelled,
        durationMs: Date.now() - started
      })
    })
  })
}

/** 用于版本探测：只取第一行输出，失败返回 null */
export async function probeVersion(file: string, args: string[]): Promise<string | null> {
  try {
    const res = await runProcess(file, args, { timeoutMs: 8000, maxOutput: 20_000 })
    const text = `${res.stdout}\n${res.stderr}`.trim().split(/\r?\n/).find((l) => l.trim())
    return text ? text.trim().slice(0, 200) : null
  } catch {
    return null
  }
}

export { toLongPath }
