/** 字幕编码探测与规范化（§FR-04） */

export interface DecodeResult {
  text: string
  /** 源文件编码名 */
  encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'gbk' | 'unknown'
  /** 是否含有替换字符（解码可能失败） */
  lossy: boolean
}

function hasBom(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false
  return bytes.every((b, i) => buf[i] === b)
}

function tryDecode(buf: Buffer, encoding: string): { text: string; ok: boolean } {
  try {
    const decoder = new TextDecoder(encoding, { fatal: true })
    return { text: decoder.decode(buf), ok: true }
  } catch {
    return { text: '', ok: false }
  }
}

export function decodeSubtitle(buf: Buffer): DecodeResult {
  if (hasBom(buf, [0xef, 0xbb, 0xbf])) {
    const text = buf.slice(3).toString('utf8')
    return { text, encoding: 'utf-8-bom', lossy: text.includes('\uFFFD') }
  }
  if (hasBom(buf, [0xff, 0xfe])) {
    return { text: buf.slice(2).toString('utf16le'), encoding: 'utf-16le', lossy: false }
  }
  if (hasBom(buf, [0xfe, 0xff])) {
    const swapped = Buffer.from(buf.slice(2))
    swapped.swap16()
    return { text: swapped.toString('utf16le'), encoding: 'utf-16be', lossy: false }
  }

  const utf8 = tryDecode(buf, 'utf-8')
  if (utf8.ok) return { text: utf8.text, encoding: 'utf-8', lossy: false }

  const gbk = tryDecode(buf, 'gbk')
  if (gbk.ok) return { text: gbk.text, encoding: 'gbk', lossy: false }

  const fallback = buf.toString('utf8')
  return { text: fallback, encoding: 'unknown', lossy: true }
}

/** 统一转成 UTF-8 无 BOM 文本 */
export function normalizeToUtf8(buf: Buffer): { text: string; encoding: DecodeResult['encoding'] } {
  const decoded = decodeSubtitle(buf)
  return { text: decoded.text.replace(/^\uFEFF/, ''), encoding: decoded.encoding }
}

/** 粗略判断是否为 ASS/SSA 内容 */
export function looksLikeAss(text: string): boolean {
  return /\[Script Info\]/i.test(text) && /\[Events\]/i.test(text)
}
