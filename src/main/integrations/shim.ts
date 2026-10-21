import fs from 'node:fs'
import path from 'node:path'

/**
 * 从 npm 在 Windows 生成的 .cmd / .bat shim 里解析出真正的 Node 入口。
 * Node 的 spawn 不能直接执行 .cmd（会报 spawn EINVAL），所以调用方应改用
 * `process.execPath` + 这个入口。
 */
export function shimNodeEntry(command: string): string | null {
  if (!/\.(cmd|bat)$/i.test(command)) return null
  try {
    const text = fs.readFileSync(command, 'utf8')
    // npm shim 形如： "%_prog%"  "%dp0%\node_modules\@scope\pkg\bin.js" %*
    const match = /%dp0%\\"?([^"%\r\n]+?\.(?:js|cjs|mjs))"?/i.exec(text)
    if (!match?.[1]) return null
    const target = path.join(path.dirname(command), match[1].replace(/^\\+/, ''))
    return fs.existsSync(target) ? target : null
  } catch {
    return null
  }
}

/** .js/.cjs/.mjs 直接可用；.cmd/.bat 解析 shim；其它返回 null（按原样执行） */
export function nodeEntryFor(command: string): string | null {
  if (/\.(js|cjs|mjs)$/i.test(command)) return command
  return shimNodeEntry(command)
}
