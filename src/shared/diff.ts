/** 极简逐行 diff（供模板替换预览使用，不追求最小编辑距离） */

export type DiffKind = 'same' | 'add' | 'del'

export interface DiffLine {
  kind: DiffKind
  left: string | null
  right: string | null
  /** 行号（1-based，对应各自侧） */
  leftNo: number | null
  rightNo: number | null
}

/** LCS 行级 diff；两侧行数 > 4000 时退化为「整段替换」以保证响应速度 */
export function diffLines(left: string, right: string): DiffLine[] {
  const a = left.split(/\r?\n/)
  const b = right.split(/\r?\n/)
  if (a.length * b.length > 4_000_000) {
    return [
      ...a.map((line, i) => ({ kind: 'del' as const, left: line, right: null, leftNo: i + 1, rightNo: null })),
      ...b.map((line, i) => ({ kind: 'add' as const, left: null, right: line, leftNo: null, rightNo: i + 1 }))
    ]
  }

  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0)
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', left: a[i] ?? '', right: b[j] ?? '', leftNo: i + 1, rightNo: j + 1 })
      i += 1
      j += 1
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      out.push({ kind: 'del', left: a[i] ?? '', right: null, leftNo: i + 1, rightNo: null })
      i += 1
    } else {
      out.push({ kind: 'add', left: null, right: b[j] ?? '', leftNo: null, rightNo: j + 1 })
      j += 1
    }
  }
  while (i < n) {
    out.push({ kind: 'del', left: a[i] ?? '', right: null, leftNo: i + 1, rightNo: null })
    i += 1
  }
  while (j < m) {
    out.push({ kind: 'add', left: null, right: b[j] ?? '', leftNo: null, rightNo: j + 1 })
    j += 1
  }
  return out
}
