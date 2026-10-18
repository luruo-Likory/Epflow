import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { AuditFilterDto } from '@shared/api'
import type { AuditEntry, ProjectSnapshot } from '@shared/types'
import { errorText, invoke } from '../lib/api'
import { Badge, Button, Card, EmptyState, Field, Select, TextInput, useToast } from '../components/ui'

/* ------------------------------------------------------------------ */
/* 工具函数                                                             */
/* ------------------------------------------------------------------ */

const ACTION_COLOR: Record<string, string> = {
  project: '#0e7490', // 青
  subtitle: '#1d4ed8', // 蓝
  review: '#7c3aed', // 紫
  human: '#059669', // 绿
  chapter: '#d97706', // 橙
  encode: '#065f46', // 深绿
  mux: '#065f46',
  transcode: '#065f46',
  naming: '#065f46',
  publish: '#64748b' // 灰
}

function actionColor(action: string): string {
  const prefix = action.split('.')[0] ?? action
  return ACTION_COLOR[prefix] ?? 'var(--color-text)'
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

function summarize(detail: Record<string, unknown> | null): string {
  if (!detail) return '—'
  let text: string
  try {
    text = JSON.stringify(detail) ?? ''
  } catch {
    text = String(detail)
  }
  if (!text) return '—'
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

function detailJson(detail: Record<string, unknown> | null): string {
  if (!detail) return '（无详情）'
  try {
    return JSON.stringify(detail, null, 2) ?? '（无详情）'
  } catch {
    return String(detail)
  }
}

const LIMIT_OPTIONS = [
  { value: '100', label: '最近 100 条' },
  { value: '500', label: '最近 500 条' },
  { value: '2000', label: '最近 2000 条' }
]

/* ------------------------------------------------------------------ */
/* 页面                                                                 */
/* ------------------------------------------------------------------ */

export default function AuditPage(props: { rootPath?: string }): React.ReactElement {
  const { rootPath } = props
  const toast = useToast()

  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null)
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [actionDraft, setActionDraft] = useState('')
  const [action, setAction] = useState('')
  const [localNo, setLocalNo] = useState('')
  const [limit, setLimit] = useState(500)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), [])

  const applyAction = useCallback(() => {
    setAction(actionDraft.trim())
  }, [actionDraft])

  /* 读取集号对照（失败不阻塞审计列表） */
  useEffect(() => {
    if (!rootPath) return
    let alive = true
    void invoke('project:open', { rootPath })
      .then((snap) => {
        if (alive) setSnapshot(snap)
      })
      .catch((err) => {
        if (alive) toast.error(errorText(err))
      })
    return () => {
      alive = false
    }
  }, [rootPath, refreshToken, toast])

  /* 拉取审计列表 */
  useEffect(() => {
    if (!rootPath) return
    let alive = true
    setLoading(true)
    setError(null)

    const filter: AuditFilterDto = { limit }
    if (action) filter.action = action
    if (localNo) filter.localNo = localNo

    void invoke('audit:list', { rootPath, filter })
      .then((list) => {
        if (alive) setEntries(list)
      })
      .catch((err) => {
        if (!alive) return
        setError(errorText(err))
        toast.error(errorText(err))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })

    return () => {
      alive = false
    }
  }, [rootPath, action, localNo, limit, refreshToken, toast])

  const episodeLabels = useMemo(() => {
    const map = new Map<string, string>()
    for (const episode of snapshot?.episodes ?? []) {
      map.set(episode.id, episode.localNo)
    }
    return map
  }, [snapshot])

  const episodeOptions = useMemo(() => {
    const list = (snapshot?.episodes ?? []).map((episode) => ({
      value: episode.localNo,
      label: `第 ${episode.localNo} 集（发布 ${episode.releaseNo}）`
    }))
    return [{ value: '', label: '全部集' }, ...list]
  }, [snapshot])

  const exportCsv = useCallback(async () => {
    if (!rootPath) return
    setExporting(true)
    try {
      const target = await invoke('dialog:save-file', {
        title: '导出审计日志',
        defaultPath: 'audit.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      })
      if (!target) return
      const result = await invoke('audit:export', { rootPath, target })
      toast.success(`已导出 ${result.count} 条审计记录`)
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setExporting(false)
    }
  }, [rootPath, toast])

  /* 没有打开项目 */
  if (!rootPath) {
    return (
      <Card title="审计日志">
        <EmptyState
          title="请先从项目页打开一个项目，再看审计日志"
          description="审计日志按项目独立存储（.epflow/audit.jsonl），需先打开项目才能查询与导出。"
        />
      </Card>
    )
  }

  const filtered = Boolean(action || localNo)
  const filterChips = [action ? `动作前缀：${action}` : '', localNo ? `第 ${localNo} 集` : ''].filter(Boolean)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 1200, margin: '0 auto', fontSize: 13 }}>
      <Card
        title={
          <div className="row" style={{ gap: 10 }}>
            <span style={{ fontSize: 16 }}>审计日志</span>
            <Badge tone="gray" dot={false}>
              {loading ? '载入中' : `${entries.length} 条`}
            </Badge>
            {filtered && (
              <Badge tone="teal" dot={false}>
                已筛选
              </Badge>
            )}
          </div>
        }
        extra={
          <div className="row wrap">
            <Button size="sm" onClick={refresh} disabled={loading}>
              刷新
            </Button>
            <Button size="sm" kind="primary" onClick={() => void exportCsv()} disabled={exporting || entries.length === 0}>
              导出 CSV
            </Button>
          </div>
        }
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 12,
            alignItems: 'end'
          }}
        >
          <Field label="动作前缀" hint="支持前缀匹配，如 project / review / encode">
            <div className="row" style={{ gap: 6 }}>
              <TextInput
                value={actionDraft}
                placeholder="全部动作"
                style={{ flex: 1, minWidth: 0 }}
                onChange={(event) => setActionDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') applyAction()
                }}
              />
              <Button size="sm" onClick={applyAction}>
                查询
              </Button>
            </div>
          </Field>

          <Field label="集号" hint="从当前项目读取；按集过滤">
            <Select value={localNo} options={episodeOptions} onChange={(event) => setLocalNo(event.target.value)} />
          </Field>

          <Field label="条数上限">
            <Select
              value={String(limit)}
              options={LIMIT_OPTIONS}
              onChange={(event) => setLimit(Number(event.target.value))}
            />
          </Field>
        </div>

        <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
          {filterChips.length > 0 ? (
            filterChips.map((chip) => (
              <span key={chip} className="badge tone-teal">
                {chip}
              </span>
            ))
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              未设置筛选条件
            </span>
          )}
          <span className="spacer" />
          <span
            className="mono muted"
            style={{ fontSize: 11, maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={rootPath}
          >
            {rootPath}
          </span>
        </div>
      </Card>

      {error && (
        <div
          style={{
            background: 'var(--color-danger-soft)',
            border: '1px solid #fecaca',
            color: '#991b1b',
            borderRadius: 'var(--radius-control)',
            padding: '8px 10px',
            fontSize: 12
          }}
        >
          读取审计日志失败：{error}
        </div>
      )}

      <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 330px)' }}>
        <table className="grid" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <th style={{ width: 154 }}>时间</th>
              <th style={{ width: 110 }}>操作者</th>
              <th style={{ width: 200 }}>动作</th>
              <th style={{ width: 92 }}>集</th>
              <th>详情摘要</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => {
              const episode = entry.episodeId ? episodeLabels.get(entry.episodeId) : undefined
              return (
                <tr key={`${entry.at}-${entry.action}-${index}`}>
                  <td className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    {formatTime(entry.at)}
                  </td>
                  <td style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.actor || '—'}
                  </td>
                  <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span className="mono" style={{ fontSize: 12, fontWeight: 500, color: actionColor(entry.action) }}>
                      {entry.action}
                    </span>
                  </td>
                  <td style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{episode ? `第 ${episode} 集` : '—'}</td>
                  <td
                    title={detailJson(entry.detail)}
                    style={{
                      fontSize: 12,
                      color: 'var(--color-text-muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {summarize(entry.detail)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!loading && entries.length === 0 && (
          <EmptyState
            title="还没有审计记录"
            description={filtered ? '当前筛选条件下没有匹配的记录，试试放宽筛选。' : '执行项目创建、字幕导入、审阅或压制等操作后，这里会出现记录。'}
            action={
              filtered ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setActionDraft('')
                    setAction('')
                    setLocalNo('')
                  }}
                >
                  清除筛选
                </Button>
              ) : undefined
            }
          />
        )}
        {loading && entries.length === 0 && (
          <div className="empty">
            <div className="muted" style={{ fontSize: 12 }}>
              正在读取审计日志…
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
