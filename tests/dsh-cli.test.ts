import { describe, expect, it, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppSettings } from '@shared/types'
import { defaultSettings } from '@shared/constants'
import { callDsh, cliKindOf, shimNodeEntry, DshUnavailableError } from '@main/integrations/dsh-client'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'epflow-dshcli-'))

/** 模拟 resolveTool 的结果，测试里随时切换命令 */
const state = vi.hoisted(() => ({ command: '' as string }))
vi.mock('@main/integrations/tools', () => ({
  resolveTool: () => ({
    key: 'dsh',
    label: 'dsh',
    path: state.command,
    exists: Boolean(state.command),
    version: null,
    source: 'setting',
    versionArgs: [],
    required: false
  })
}))

function writeFakeNode(name: string, body: string): string {
  const file = path.join(TMP, `${name}.js`)
  fs.writeFileSync(file, body, 'utf8')
  return file
}

function writeShim(name: string, nodeEntry: string): string {
  const cmd = path.join(TMP, `${name}.cmd`)
  // 与 npm 生成的 Windows shim 结构一致：用 %dp0%\...\entry.js 指向真正的 Node 入口
  fs.writeFileSync(
    cmd,
    `@ECHO off\r\nSET dp0=%~dp0\r\nnode  "%dp0%\\${path.basename(nodeEntry)}" %*\r\n`,
    'utf8'
  )
  return cmd
}

const dshEntry = writeFakeNode(
  'fake-dsh',
  `let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>data+=d);process.stdin.on('end',()=>{
     console.log(JSON.stringify({ ok:true, mode:'stdin', len:data.length, argv:process.argv.slice(2) }));
   });`
)
const dcliEntry = writeFakeNode(
  'fake-dcli',
  `let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>data+=d);process.stdin.on('end',()=>{
     console.log(JSON.stringify({ ok:true, mode:'argv', len:(process.argv[2]||'').length, stdinLen:data.length }));
   });`
)
const dshCmd = writeShim('dsh', dshEntry)
const dcliCmd = writeShim('dcli', dcliEntry)

const settings = (command = ''): AppSettings => ({
  ...defaultSettings(),
  dsh: { ...defaultSettings().dsh, mode: 'cli', command }
})

beforeEach(() => {
  state.command = dshCmd
})

afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('命令行识别', () => {
  it('区分 dsh / dcli / 自定义', () => {
    expect(cliKindOf('C:\\Users\\x\\AppData\\Roaming\\npm\\dsh.cmd')).toBe('dsh')
    expect(cliKindOf('C:\\Users\\x\\AppData\\Roaming\\npm\\dcli.cmd')).toBe('dcli')
    expect(cliKindOf('C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js')).toBe('dsh')
    expect(cliKindOf('C:\\npm\\node_modules\\@harmattan666\\dcli\\bin\\dcli.js')).toBe('dcli')
    expect(cliKindOf('C:\\tools\\my-ai.exe')).toBe('custom')
  })

  it('能从 npm shim 解析 Node 入口', () => {
    expect(shimNodeEntry(dshCmd)).toBe(dshEntry)
    expect(shimNodeEntry('C:\\not-exist.cmd')).toBeNull()
  })
})

describe('cli 调用', () => {
  it('dsh：prompt 走 stdin，长 prompt 不受命令行长度限制', async () => {
    const prompt = `审阅：${'中'.repeat(30_000)}`
    const result = await callDsh(prompt, settings().dsh)
    const parsed = JSON.parse(result.text) as { mode: string; len: number; argv: string[] }
    expect(result.channel).toBe('cli')
    expect(parsed.mode).toBe('stdin')
    expect(parsed.len).toBe(prompt.length)
    expect(parsed.argv).toEqual(['headless', '-'])
  })

  it('dcli：短 prompt 放 argv，不读 stdin', async () => {
    state.command = dcliCmd
    const result = await callDsh('短任务', settings().dsh)
    const parsed = JSON.parse(result.text) as { mode: string; len: number; stdinLen: number }
    expect(parsed.mode).toBe('argv')
    expect(parsed.len).toBe('短任务'.length)
    expect(parsed.stdinLen).toBe(0)
  })

  it('dcli：超长 prompt 直接给出可操作的错误，而不是被命令行截断', async () => {
    state.command = dcliCmd
    await expect(callDsh('中'.repeat(25_000), settings().dsh)).rejects.toBeInstanceOf(DshUnavailableError)
  })
})
