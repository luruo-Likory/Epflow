import fs from 'node:fs'
import path from 'node:path'
import { toLongPath, ensureDir } from '../util/paths'

/**
 * 原子写：tmp → fsync → rename，替换前把旧文件保留为 .bak。
 * 这是 JSON 状态库的「事务」语义基础。
 */
export function writeFileAtomic(file: string, content: string | Buffer): void {
  const dir = path.dirname(file)
  ensureDir(dir)
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  const fd = fs.openSync(toLongPath(tmp), 'w')
  try {
    fs.writeFileSync(fd, content)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  const backup = `${file}.bak`
  if (fs.existsSync(toLongPath(file))) {
    try {
      fs.copyFileSync(toLongPath(file), toLongPath(backup))
    } catch {
      /* 备份失败不阻断写入 */
    }
  }
  fs.renameSync(toLongPath(tmp), toLongPath(file))
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function readJsonSafe<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(toLongPath(file), 'utf8')
    return JSON.parse(stripBom(raw)) as T
  } catch {
    try {
      const raw = fs.readFileSync(toLongPath(`${file}.bak`), 'utf8')
      return JSON.parse(stripBom(raw)) as T
    } catch {
      return fallback
    }
  }
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export function fileShaOrNull(file: string): string | null {
  return null
}
