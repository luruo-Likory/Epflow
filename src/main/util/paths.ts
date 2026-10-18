import path from 'node:path'
import fs from 'node:fs'

/**
 * Windows 路径工具集中处。
 * 所有需要「超长路径」安全的位置都应调用 toLongPath()。
 */

const WINDOWS_ILLEGAL = /[<>:"/\\|?*\u0000-\u001F]/g
const RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9'
])

const MAX_PATH = 240

/** 给需要访问的路径加上 \\?\ 前缀（仅绝对路径、且已存在或即将创建） */
export function toLongPath(p: string): string {
  if (process.platform !== 'win32') return p
  if (p.startsWith('\\\\?\\')) return p
  const abs = path.resolve(p)
  if (abs.startsWith('\\\\')) return `\\\\?\\UNC${abs.slice(1)}`
  if (abs.length < MAX_PATH) return abs
  return `\\\\?\\${abs}`
}

export function existsLong(p: string): boolean {
  try {
    return fs.existsSync(toLongPath(p))
  } catch {
    return false
  }
}

export function statLong(p: string): fs.Stats | null {
  try {
    return fs.statSync(toLongPath(p))
  } catch {
    return null
  }
}

/** 判断 child 是否位于 parent 之内（大小写不敏感） */
export function isSubPath(parent: string, child: string): boolean {
  const p = path.resolve(parent).toLowerCase()
  const c = path.resolve(child).toLowerCase()
  if (p === c) return true
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

export function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

/** 清理 Windows 文件名中的非法字符，去掉尾随空格与点 */
export function sanitizeFileName(name: string, replacement = '_'): string {
  let out = name.replace(WINDOWS_ILLEGAL, replacement)
  out = out.replace(/\s+/g, ' ').trim()
  out = out.replace(/[. ]+$/g, '')
  if (out.length === 0) out = 'untitled'
  const stem = out.split('.')[0] ?? out
  if (RESERVED_NAMES.has(stem.toUpperCase())) {
    out = `${out}_`
  }
  return out
}

/** 校验番名：不允许 Windows 非法字符、结尾空格/点、长度 > 80 */
export function validateAnimeName(name: string): string | null {
  if (!name || !name.trim()) return '番名不能为空'
  if (name.length > 80) return '番名长度不能超过 80 个字符'
  if (WINDOWS_ILLEGAL.test(name)) return '番名不能包含 < > : " / \\ | ? * 等字符'
  if (/[. ]$/.test(name)) return '番名不能以空格或点结尾'
  if (name.trim() !== name) return '番名首尾不能有空格'
  return null
}

export function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)
}

/** 保证目录存在（支持长路径） */
export function ensureDir(dir: string): void {
  fs.mkdirSync(toLongPath(dir), { recursive: true })
}

export function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(toLongPath(dir))
  } catch {
    return []
  }
}

export function listDirs(dir: string): string[] {
  const base = toLongPath(dir)
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name))
  } catch {
    return []
  }
}

export function listFiles(dir: string, ext?: string): string[] {
  const base = toLongPath(dir)
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => path.join(dir, d.name))
      .filter((f) => (ext ? path.extname(f).toLowerCase() === ext.toLowerCase() : true))
  } catch {
    return []
  }
}

/** 递归查找一层（用于 output\D_\... 兼容） */
export function listFilesRecursive(dir: string, ext: string, depth = 2): string[] {
  const out: string[] = []
  const walk = (d: string, level: number) => {
    if (level > depth) return
    for (const f of listFiles(d, ext)) out.push(f)
    for (const sub of listDirs(d)) walk(sub, level + 1)
  }
  walk(dir, 0)
  return out
}

/** 生成不冲突的文件路径：name.ext → name (2).ext */
export function uniquePath(target: string): string {
  if (!existsLong(target)) return target
  const dir = path.dirname(target)
  const ext = path.extname(target)
  const stem = path.basename(target, ext)
  for (let i = 2; i < 1000; i += 1) {
    const candidate = path.join(dir, `${stem} (${i})${ext}`)
    if (!existsLong(candidate)) return candidate
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`)
}

export function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function relativeTo(base: string, target: string): string {
  return path.relative(base, target)
}
