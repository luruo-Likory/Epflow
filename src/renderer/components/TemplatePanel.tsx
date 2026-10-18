import { useCallback, useEffect, useMemo, useState } from 'react'
import type { InstantiateRowDto, SubstitutionDto, TemplateAnalysisDto, TemplatePreviewDto } from '@shared/api'
import type { EpisodeRecord } from '@shared/types'
import { invoke, errorText } from '../lib/api'
import { Badge, Button, Card, Checkbox, EmptyState, Field, Select, useToast } from './ui'

export function TemplatePanel({
  rootPath,
  episodes,
  onChanged
}: {
  rootPath: string
  episodes: EpisodeRecord[]
  onChanged?: () => void
}): React.ReactElement {
  const toast = useToast()
  const [analysis, setAnalysis] = useState<TemplateAnalysisDto | null>(null)
  const [subs, setSubs] = useState<SubstitutionDto[]>([])
  const [busy, setBusy] = useState(false)
  const [localNo, setLocalNo] = useState(episodes[0]?.localNo ?? '01')
  const [preview, setPreview] = useState<TemplatePreviewDto | null>(null)
  const [rows, setRows] = useState<InstantiateRowDto[] | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await invoke('template:analyze', { rootPath })
      setAnalysis(result)
      setSubs(result.substitutions)
    } catch (err) {
      toast.error(errorText(err))
    }
  }, [rootPath, toast])

  useEffect(() => {
    void load()
  }, [load])

  const upload = async () => {
    try {
      const files = await invoke('dialog:pick-files', {
        title: '选择 OKEGui 模板（json / vpy）',
        filters: [{ name: 'OKEGui 模板', extensions: ['json', 'vpy'] }],
        multi: true
      })
      if (files.length === 0) return
      setBusy(true)
      const result = await invoke('template:upload', { rootPath, files })
      setAnalysis(result)
      setSubs(result.substitutions)
      toast.success('模板已上传')
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const doPreview = async () => {
    try {
      setBusy(true)
      const result = await invoke('template:preview', { rootPath, localNo, substitutions: subs })
      setPreview(result)
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const instantiate = async (onlyCurrent: boolean) => {
    try {
      setBusy(true)
      const result = await invoke('template:instantiate', {
        rootPath,
        localNos: onlyCurrent ? [localNo] : undefined,
        onExists: 'backup',
        substitutions: subs,
        validateVpy: true
      })
      setRows(result.rows)
      const failed = result.rows.filter((r) => r.error).length
      if (failed > 0) toast.warn(`实例化完成，${failed} 集失败`)
      else toast.success(`已实例化 ${result.rows.length} 集`)
      onChanged?.()
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const info = analysis?.info
  const diffLines = useMemo(() => {
    if (!preview) return []
    const source = preview.json ?? preview.vpy
    return source?.diff.slice(0, 400) ?? []
  }, [preview])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card
        title="模板与实例化"
        extra={
          <div className="row">
            <Button size="sm" onClick={() => void load()}>
              刷新
            </Button>
            <Button size="sm" kind="primary" onClick={() => void upload()} disabled={busy}>
              上传模板
            </Button>
          </div>
        }
      >
        {!analysis ? (
          <div className="muted">加载中…</div>
        ) : (
          <>
            <div className="row wrap" style={{ marginBottom: 10 }}>
              <Badge tone={analysis.hasJson ? 'green' : 'gray'}>JSON {analysis.hasJson ? '已就绪' : '未上传'}</Badge>
              <Badge tone={analysis.hasVpy ? 'green' : 'gray'}>VPY {analysis.hasVpy ? '已就绪' : '未上传'}</Badge>
              {analysis.hasPlaceholders && <Badge tone="teal">含变量占位符</Badge>}
              {info?.oldAnime && <span className="muted">旧番名：{info.oldAnime}</span>}
              {info?.oldRelease && <span className="muted">旧集数：{info.oldRelease}</span>}
            </div>

            {analysis.warnings.length > 0 && (
              <ul style={{ margin: '0 0 10px 18px', padding: 0, color: 'var(--color-warning)', fontSize: 12.5 }}>
                {analysis.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}

            <div className="panel-title" style={{ fontSize: 12.5, marginBottom: 6 }}>
              替换项（L2 智能识别，可逐项关闭）
            </div>
            {subs.length === 0 ? (
              <div className="muted" style={{ fontSize: 12.5 }}>
                未识别到旧值；若模板使用 {'{anime}'} / {'{work}'} 等占位符可直接实例化。
              </div>
            ) : (
              <div className="table-wrap" style={{ maxHeight: 200 }}>
                <table className="grid">
                  <thead>
                    <tr>
                      <th style={{ width: 40 }}>启用</th>
                      <th style={{ width: 70 }}>类型</th>
                      <th>原文</th>
                      <th>替换为</th>
                      <th style={{ width: 60 }} className="num">
                        次数
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {subs.map((sub) => (
                      <tr key={sub.id}>
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={sub.enabled}
                            onChange={(e) =>
                              setSubs((prev) =>
                                prev.map((s) => (s.id === sub.id ? { ...s, enabled: e.target.checked } : s))
                              )
                            }
                          />
                        </td>
                        <td className="muted">{sub.kind}</td>
                        <td className="mono" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }} title={sub.from}>
                          {sub.from}
                        </td>
                        <td className="mono" title={sub.to}>
                          {sub.to}
                        </td>
                        <td className="num">{sub.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="row" style={{ marginTop: 10 }}>
              <div style={{ width: 140 }}>
                <Select
                  value={localNo}
                  onChange={(e) => setLocalNo(e.target.value)}
                  options={episodes.slice(0, 60).map((ep) => ({
                    value: ep.localNo,
                    label: `第 ${ep.localNo} 集 → ${ep.releaseNo}`
                  }))}
                />
              </div>
              <Button size="sm" onClick={() => void doPreview()} disabled={busy || !analysis.hasJson && !analysis.hasVpy}>
                预览差异
              </Button>
              <Button size="sm" onClick={() => void instantiate(true)} disabled={busy}>
                只实例化当前集
              </Button>
              <Button size="sm" kind="primary" onClick={() => void instantiate(false)} disabled={busy}>
                实例化全部 {episodes.length} 集
              </Button>
            </div>
          </>
        )}
      </Card>

      {preview && (
        <Card title={`差异预览 · 第 ${preview.localNo} 集`} extra={<Button size="sm" onClick={() => setPreview(null)}>关闭</Button>}>
          {preview.errors.length > 0 && (
            <div style={{ color: 'var(--color-danger)', fontSize: 12.5, marginBottom: 8 }}>{preview.errors.join('；')}</div>
          )}
          {preview.warnings.length > 0 && (
            <div style={{ color: 'var(--color-warning)', fontSize: 12.5, marginBottom: 8 }}>{preview.warnings.join('；')}</div>
          )}
          <div className="table-wrap" style={{ maxHeight: 320 }}>
            <table className="grid">
              <thead>
                <tr>
                  <th style={{ width: 44 }} className="num">
                    旧
                  </th>
                  <th>原内容</th>
                  <th style={{ width: 44 }} className="num">
                    新
                  </th>
                  <th>新内容</th>
                </tr>
              </thead>
              <tbody>
                {diffLines.map((line, i) => (
                  <tr
                    key={i}
                    style={{
                      background: line.kind === 'del' ? '#fef2f2' : line.kind === 'add' ? '#ecfdf5' : undefined
                    }}
                  >
                    <td className="num muted">{line.leftNo ?? ''}</td>
                    <td className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      {line.left ?? ''}
                    </td>
                    <td className="num muted">{line.rightNo ?? ''}</td>
                    <td className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      {line.right ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {rows && (
        <Card title="实例化结果">
          <div className="table-wrap" style={{ maxHeight: 260 }}>
            <table className="grid">
              <thead>
                <tr>
                  <th style={{ width: 70 }}>本地集</th>
                  <th style={{ width: 70 }}>发布集</th>
                  <th style={{ width: 70 }}>JSON</th>
                  <th style={{ width: 70 }}>VPY</th>
                  <th style={{ width: 90 }}>源视频</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.localNo}>
                    <td>{r.localNo}</td>
                    <td>{r.releaseNo}</td>
                    <td>{r.jsonOk ? '✓' : '✕'}</td>
                    <td>{r.vpyOk ? '✓' : '✕'}</td>
                    <td>{r.sourceExists ? '✓' : '缺'}</td>
                    <td style={{ color: r.error ? 'var(--color-danger)' : 'var(--color-text-muted)', fontSize: 12 }}>
                      {r.error ?? r.warnings.join('；') ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
