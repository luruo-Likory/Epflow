import fs from 'node:fs'
import type { AuditEntry } from '@shared/types'
import { openStore } from '../store/repository'
import { nowIso } from '@shared/time'

/** 追加一批审计（供批量操作使用），失败不抛 */
export function appendAuditEntries(
  rootPath: string,
  action: string,
  detail: Record<string, unknown> | null,
  actor: string,
  episodeIds: string[] = []
): AuditEntry[] {
  try {
    const store = openStore(rootPath)
    const out: AuditEntry[] = []
    if (episodeIds.length === 0) {
      out.push(store.appendAudit(action, detail, null, actor))
    } else {
      for (const id of episodeIds) out.push(store.appendAudit(action, detail, id, actor))
    }
    return out
  } catch {
    return []
  }
}

export function auditStamp(): string {
  return nowIso()
}

export function auditCsv(entries: AuditEntry[]): string {
  return [
    'time,actor,action,episode,detail',
    ...entries.map((e) =>
      [e.at, e.actor, e.action, e.episodeId ?? '', JSON.stringify(e.detail ?? {})]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    )
  ].join('\r\n')
}

export function writeAuditCsv(entries: AuditEntry[], target: string): string {
  fs.mkdirSync(require('node:path').dirname(target), { recursive: true })
  fs.writeFileSync(target, `${auditCsv(entries)}\r\n`, 'utf8')
  return target
}
