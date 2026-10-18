import crypto from 'node:crypto'
import fs from 'node:fs'
import { toLongPath } from './paths'

/** 流式 SHA-256（大文件不读入内存） */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(toLongPath(file))
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

export function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`
}

/** 64 位随机 UID（Matroska 要求无符号整数，用于章节） */
export function randomUid64(): string {
  const buf = crypto.randomBytes(8)
  let value = buf.readBigUInt64BE(0)
  // Matroska UID 通常只取 63 位，避免超过 2^63-1 造成部分工具解析异常
  value &= 0x7fffffffffffffffn
  if (value === 0n) value = 1n
  return value.toString()
}
