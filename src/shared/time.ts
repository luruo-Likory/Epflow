/** 时间与时间码工具（纯函数，主进程与渲染层共用） */

export function nowIso(): string {
  const d = new Date()
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const local = new Date(d.getTime() + off * 60_000)
  const base = local.toISOString().replace('Z', '')
  return `${base.slice(0, 19)}${sign}${pad(off / 60)}:${pad(off % 60)}`
}

/** 00:06:35.220 */
export function formatTimecode(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const total = Math.round(ms)
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor((total % 3_600_000) / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  const milli = total % 1000
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${String(milli).padStart(3, '0')}`
}

/** 00:00:00.000000000（Matroska 章节时间） */
export function formatChapterTime(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor((total % 3_600_000) / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  const nano = (total % 1000) * 1_000_000
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${String(nano).padStart(9, '0')}`
}

/** 24:36 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`
}

/** ASS 时间码 0:00:06.35（厘秒） */
export function parseAssTime(value: string): number {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})$/.exec(value.trim())
  if (!m) return Number.NaN
  const h = Number(m[1])
  const mi = Number(m[2])
  const s = Number(m[3])
  const frac = m[4] ?? '0'
  const cs = frac.length === 3 ? Number(frac) : Number(frac.padEnd(2, '0'))
  return ((h * 60 + mi) * 60 + s) * 1000 + (frac.length === 3 ? cs : cs * 10)
}

export function formatAssTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 10) * 10)
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor((total % 3_600_000) / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  const cs = Math.floor((total % 1000) / 10)
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(cs)}`
}

export function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0')
}

export function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}
