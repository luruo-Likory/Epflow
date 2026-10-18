import { useCallback, useEffect, useState } from 'react'
import type { ProjectSummaryDto } from '@shared/api'
import { invoke, errorText } from '../lib/api'
import { Badge, Button, Card, EmptyState, Progress, useToast } from '../components/ui'
import { ImportProjectModal } from '../components/ImportModal'

const GRID_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
  gap: 12
}

function formatOpenedAt(value: string): string {
  if (!value) return '未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

function doneOf(summary: ProjectSummaryDto): number {
  return (summary.stateCounts.DONE ?? 0) + (summary.stateCounts.NAMED ?? 0)
}

export default function ProjectList(props: {
  onOpen: (rootPath: string) => void
  onNew: () => void
}): React.ReactElement {
  const { onOpen, onNew } = props
  const toast = useToast()
  const [projects, setProjects] = useState<ProjectSummaryDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const rows = await invoke('project:list')
      setProjects(rows)
    } catch (err) {
      const message = errorText(err)
      setError(message)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  const handleOpen = (summary: ProjectSummaryDto): void => {
    if (!summary.exists) {
      toast.warn('状态库缺失：项目目录可能已被移动或删除，无法打开。')
      return
    }
    onOpen(summary.rootPath)
  }

  const copyPath = async (rootPath: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(rootPath)
      toast.success('路径已复制')
    } catch {
      toast.error('无法复制路径，请手动选择文本')
    }
  }

  const removeHint = (): void => {
    toast.warn('当前版本不提供移除项目索引的接口；如需清理，请在设置中处理。')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.4 }}>项目</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            选择一个番剧项目继续推进字幕、审阅与压制流程，或新建一个项目。
          </div>
        </div>
        <span className="spacer" />
        <div className="row">
          <Button onClick={() => void load()} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </Button>
          <Button onClick={() => setImportOpen(true)} disabled={loading}>
            导入现有工程
          </Button>
          <Button kind="primary" onClick={onNew}>
            ＋ 新建项目
          </Button>
        </div>
      </div>

      <ImportProjectModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(rootPath) => {
          setImportOpen(false)
          onOpen(rootPath)
        }}
      />

      {error && (
        <Card
          title="加载项目失败"
          extra={
            <Button size="sm" onClick={() => void load()}>
              重试
            </Button>
          }
        >
          <div style={{ fontSize: 12.5, color: 'var(--color-danger)', wordBreak: 'break-all' }}>{error}</div>
        </Card>
      )}

      {loading && projects.length === 0 && (
        <div style={GRID_STYLE}>
          {[0, 1, 2].map((index) => (
            <div key={index} className="card" style={{ padding: 14, minHeight: 168 }}>
              <div style={{ height: 18, width: '62%', borderRadius: 4, background: '#e2e8f0', marginBottom: 14 }} />
              <div style={{ height: 10, width: '88%', borderRadius: 4, background: '#f1f5f9', marginBottom: 8 }} />
              <div style={{ height: 10, width: '72%', borderRadius: 4, background: '#f1f5f9', marginBottom: 16 }} />
              <div style={{ height: 6, borderRadius: 999, background: '#f1f5f9', marginBottom: 14 }} />
              <span className="muted" style={{ fontSize: 12 }}>
                正在读取项目…
              </span>
            </div>
          ))}
        </div>
      )}

      {!loading && !error && projects.length === 0 && (
        <Card>
          <EmptyState
            title="还没有项目"
            description="先新建一个番剧项目，EpFlow 会按规范创建目录与集号对照表"
            action={
              <Button kind="primary" onClick={onNew}>
                ＋ 新建项目
              </Button>
            }
          />
        </Card>
      )}

      {projects.length > 0 && (
        <div style={GRID_STYLE}>
          {projects.map((summary) => {
            const total = summary.episodeCount
            const done = doneOf(summary)
            const percent = total > 0 ? (done / total) * 100 : 0
            return (
              <div
                key={`${summary.id}-${summary.rootPath}`}
                className="card"
                role="button"
                tabIndex={0}
                aria-disabled={!summary.exists}
                aria-label={`打开项目 ${summary.animeName}`}
                onClick={() => handleOpen(summary)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    handleOpen(summary)
                  }
                }}
                style={{
                  cursor: summary.exists ? 'pointer' : 'default',
                  display: 'flex',
                  flexDirection: 'column',
                  transition: 'border-color 160ms ease-out'
                }}
              >
                <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
                  <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                    <div
                      style={{
                        fontSize: 17,
                        fontWeight: 700,
                        lineHeight: 1.35,
                        wordBreak: 'break-word',
                        minWidth: 0
                      }}
                    >
                      {summary.animeName}
                    </div>
                    <span className="spacer" />
                    {summary.exists ? (
                      <Badge tone="teal" dot={false}>
                        {summary.episodeCount} 集
                      </Badge>
                    ) : (
                      <Badge tone="red" dot={false}>
                        状态库缺失
                      </Badge>
                    )}
                  </div>

                  <button
                    type="button"
                    className="mono"
                    title="点击复制路径"
                    onClick={(event) => {
                      event.stopPropagation()
                      void copyPath(summary.rootPath)
                    }}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      padding: 0,
                      textAlign: 'left',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11.5,
                      lineHeight: 1.45,
                      color: 'var(--color-text-muted)',
                      cursor: 'pointer',
                      wordBreak: 'break-all'
                    }}
                  >
                    {summary.rootPath}
                  </button>

                  <div className="row" style={{ fontSize: 12 }}>
                    <span className="muted">共 {summary.episodeCount} 集</span>
                    <span className="spacer" />
                    <span className="muted">
                      已完成 {done} / {total}
                    </span>
                  </div>
                  <Progress percent={percent} />

                  <div className="row" style={{ gap: 8 }}>
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      最近打开 {formatOpenedAt(summary.lastOpenedAt)}
                    </span>
                    <span className="spacer" />
                    {summary.exists ? (
                      <Button
                        size="sm"
                        kind="primary"
                        onClick={(event) => {
                          event.stopPropagation()
                          onOpen(summary.rootPath)
                        }}
                      >
                        打开
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        kind="danger"
                        onClick={(event) => {
                          event.stopPropagation()
                          removeHint()
                        }}
                      >
                        移除
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
