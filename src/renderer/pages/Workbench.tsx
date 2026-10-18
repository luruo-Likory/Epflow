import { useCallback, useEffect, useState } from 'react'
import type { EpisodeDetailDto } from '@shared/api'
import type { ProjectSnapshot } from '@shared/types'
import { STATE_META } from '@shared/state-machine'
import { invoke, errorText, subscribe } from '../lib/api'
import { Badge, Button, EmptyState, Tabs, useToast } from '../components/ui'
import { ReviewPanel } from '../components/ReviewPanel'
import { ChapterPanel } from '../components/ChapterPanel'
import { EncodePanel } from '../components/EncodePanel'

type TabKey = 'review' | 'chapter' | 'encode' | 'publish'

export default function Workbench(props: {
  snapshot: ProjectSnapshot
  localNo: string
  onChange: () => Promise<void> | void
  onBack: () => void
}): React.ReactElement {
  const { snapshot, localNo, onChange, onBack } = props
  const toast = useToast()
  const [tab, setTab] = useState<TabKey>('review')
  const [detail, setDetail] = useState<EpisodeDetailDto | null>(null)
  const [loading, setLoading] = useState(true)

  const rootPath = snapshot.project.rootPath
  const ep = snapshot.episodes.find((e) => e.localNo === localNo)

  const load = useCallback(async () => {
    try {
      const data = await invoke('episode:detail', { rootPath, localNo })
      setDetail(data)
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [rootPath, localNo, toast])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    const off = subscribe('episode:state', (payload) => {
      const data = payload as { localNo: string }
      if (data.localNo === localNo) {
        void load()
        void onChange()
      }
    })
    return off
  }, [localNo, load, onChange])

  const refresh = useCallback(() => {
    void load()
    void onChange()
  }, [load, onChange])

  if (!ep) {
    return (
      <div style={{ padding: 20 }}>
        <EmptyState title="找不到该集" action={<Button onClick={onBack}>返回项目</Button>} />
      </div>
    )
  }

  const meta = STATE_META[ep.state]
  const issues = detail?.issues ?? []
  const open = issues.filter((i) => i.status === 'open')
  const stats = {
    total: issues.length,
    blocker: open.filter((i) => i.severity === 'blocker').length,
    major: open.filter((i) => i.severity === 'major').length,
    handled: issues.filter((i) => i.status !== 'open').length
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--color-bg)' }}>
      <div className="row wrap" style={{ padding: '8px 14px', background: '#fff', borderBottom: '1px solid var(--color-border)', gap: 10 }}>
        <Button size="sm" onClick={onBack}>← 项目</Button>
        <span style={{ fontWeight: 700, fontSize: 15 }}>第 {ep.localNo} 集</span>
        <span className="muted" style={{ fontSize: 12 }}>发布 {ep.releaseNo}</span>
        <Badge tone={meta.tone} pulse={meta.animate}>{meta.label}</Badge>
        <span className="muted" style={{ fontSize: 12 }}>
          AI 问题 {stats.total} · 阻断 {stats.blocker} · 重要 {stats.major} · 已处理 {stats.handled}
        </span>
        <span className="spacer" />
        <Button
          size="sm"
          onClick={() =>
            void invoke('subtitle:open-external', { rootPath, localNo }).catch((e) => toast.error(errorText(e)))
          }
        >
          打开字幕
        </Button>
        <Button
          size="sm"
          onClick={() =>
            void invoke('app:open-path', { path: ep.dir }).catch((e) => toast.error(errorText(e)))
          }
        >
          集目录
        </Button>
        <Button size="sm" onClick={refresh}>刷新</Button>
      </div>

      {ep.staleReasons.length > 0 && (
        <div style={{ padding: '6px 14px', background: '#fef3c7', color: '#92400e', fontSize: 12 }}>
          ⚠ {ep.staleReasons.join('；')} — 上游变更后需重新审阅与锁定。
        </div>
      )}

      <Tabs<TabKey>
        value={tab}
        onChange={setTab}
        items={[
          { key: 'review', label: '审阅' },
          { key: 'chapter', label: '章节' },
          { key: 'encode', label: '压制' },
          { key: 'publish', label: '发布（v2）' }
        ]}
      />

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {loading || !detail ? (
          <div style={{ padding: 20 }} className="muted">加载中…</div>
        ) : (
          <>
            {tab === 'review' && <ReviewPanel rootPath={rootPath} detail={detail} onRefresh={refresh} />}
            {tab === 'chapter' && <ChapterPanel rootPath={rootPath} detail={detail} onRefresh={refresh} />}
            {tab === 'encode' && <EncodePanel rootPath={rootPath} detail={detail} snapshot={snapshot} onRefresh={refresh} />}
            {tab === 'publish' && (
              <div style={{ padding: 20 }}>
                <EmptyState
                  title="发布（v2）即将推出"
                  description="种子制作（μTorrent）、发布站上传（可选，当前单站）、做种（qBittorrent 强制做种）将在后续版本提供。v1 的流程在「已完成」结束，此页不提供任何可执行操作。"
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
