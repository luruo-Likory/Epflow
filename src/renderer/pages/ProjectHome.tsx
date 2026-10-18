import { useMemo, useState } from 'react'
import type { EpisodeRecord, ProjectSnapshot } from '@shared/types'
import { STATE_META } from '@shared/state-machine'
import { invoke, errorText } from '../lib/api'
import { Badge, Button, Card, Drawer, EmptyState, Modal, useToast } from '../components/ui'
import { TemplatePanel } from '../components/TemplatePanel'

export default function ProjectHome(props: {
  snapshot: ProjectSnapshot
  onReload: () => void
  onOpenEpisode: (localNo: string) => void
  onBack: () => void
  onEditProject: () => void
}): React.ReactElement {
  const { snapshot, onReload, onOpenEpisode, onBack } = props
  const toast = useToast()
  const [showTemplates, setShowTemplates] = useState(false)
  const [showMapping, setShowMapping] = useState(false)
  const [releaseEdits, setReleaseEdits] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const project = snapshot.project
  const episodes = snapshot.episodes

  const stats = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const ep of episodes) counts[ep.state] = (counts[ep.state] ?? 0) + 1
    const done = (counts.DONE ?? 0) + (counts.NAMED ?? 0)
    const reviewing = (counts.SUB_IMPORTED ?? 0) + (counts.AI_REJECTED ?? 0) + (counts.AI_PASSED ?? 0) +
      (counts.HUMAN_REVIEWING ?? 0) + (counts.HUMAN_REJECTED ?? 0) + (counts.HUMAN_PASSED ?? 0)
    const encoding = (counts.ENCODING ?? 0) + (counts.ENCODED ?? 0) + (counts.CHAPTER_MERGED ?? 0) + (counts.MP4_DONE ?? 0)
    const blocked = (counts.BLOCKED ?? 0) + (counts.ENCODE_FAILED ?? 0)
    return { counts, done, reviewing, encoding, blocked }
  }, [episodes])

  const saveMapping = async () => {
    setSaving(true)
    try {
      for (const [localNo, value] of Object.entries(releaseEdits)) {
        if (!value.trim()) continue
        await invoke('project:set-release-no', { rootPath: project.rootPath, localNo, releaseNo: value.trim() })
      }
      toast.success('集号对照表已更新')
      setReleaseEdits({})
      setShowMapping(false)
      onReload()
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card
        title={
          <div className="row" style={{ gap: 10 }}>
            <span style={{ fontSize: 16 }}>{project.animeName}</span>
            <Badge tone="teal" dot={false}>
              {episodes.length} 集
            </Badge>
            <Badge tone="gray" dot={false}>
              发布基准 {project.releaseEpisodeBase}
            </Badge>
          </div>
        }
        extra={
          <div className="row wrap">
            <Button size="sm" onClick={onBack}>
              ← 项目列表
            </Button>
            <Button size="sm" onClick={onReload}>
              刷新
            </Button>
            <Button size="sm" onClick={() => setShowMapping(true)}>
              集号对照表
            </Button>
            <Button size="sm" kind="primary" onClick={() => setShowTemplates(true)}>
              模板与实例化
            </Button>
            <Button
              size="sm"
              onClick={() =>
                void invoke('app:open-path', { path: project.rootPath }).catch((e) => toast.error(errorText(e)))
              }
            >
              打开目录
            </Button>
          </div>
        }
      >
        <div className="row wrap" style={{ gap: 16, fontSize: 12.5 }}>
          <span className="muted">素材根目录</span>
          <span className="mono">{project.materialRoot}</span>
          <span className="muted">翻译用</span>
          <span className="mono">{project.subDirName}</span>
          <span className="muted">工作名</span>
          <span className="mono">{project.workNameTemplate}</span>
          <span className="spacer" />
          <span className="muted">发布名模板</span>
          <span className="mono" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={project.releaseNameTemplate}>
            {project.releaseNameTemplate}
          </span>
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        {[
          { label: '总集数', value: episodes.length, hint: `本地 ${episodes[0]?.localNo ?? '01'} – ${episodes[episodes.length - 1]?.localNo ?? ''}` },
          { label: '已完成', value: stats.done, hint: '含已命名' },
          { label: '审阅中', value: stats.reviewing, hint: '字幕与审阅阶段' },
          { label: '压制/后处理', value: stats.encoding, hint: '压制、合并、转码' },
          { label: '需要处理', value: stats.blocked + (stats.counts.AI_REJECTED ?? 0), hint: '失败/阻断/AI 问题' }
        ].map((item) => (
          <div key={item.label} className="card" style={{ padding: 12 }}>
            <div className="muted" style={{ fontSize: 12 }}>{item.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-primary)' }}>{item.value}</div>
            <div className="muted" style={{ fontSize: 11.5 }}>{item.hint}</div>
          </div>
        ))}
      </div>

      {episodes.length === 0 ? (
        <Card>
          <EmptyState title="还没有集" description="回到新建向导检查总集数设置" />
        </Card>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
          {episodes.map((ep) => {
            const meta = STATE_META[ep.state]
            return (
              <div
                key={ep.id}
                className="card"
                style={{
                  padding: 12,
                  cursor: 'pointer',
                  borderColor: ep.state === 'BLOCKED' || ep.state === 'ENCODE_FAILED' ? '#fecaca' : undefined
                }}
                onClick={() => onOpenEpisode(ep.localNo)}
              >
                <div className="row" style={{ marginBottom: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>第 {ep.localNo} 集</span>
                  <span className="muted" style={{ fontSize: 12 }}>发布 {ep.releaseNo}</span>
                  <span className="spacer" />
                  <Badge tone={meta.tone} pulse={meta.animate}>
                    {meta.label}
                  </Badge>
                </div>
                <div className="mono muted" style={{ fontSize: 11.5, marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ep.workName}>
                  {ep.workName}
                </div>
                <div className="row wrap" style={{ gap: 6, fontSize: 11.5 }}>
                  {ep.subtitle ? (
                    <Badge tone="teal" dot={false}>字幕 {ep.subtitle.lineCount} 行</Badge>
                  ) : (
                    <Badge tone="gray" dot={false}>无字幕</Badge>
                  )}
                  {ep.templateJson ? <Badge tone="blue" dot={false}>模板就绪</Badge> : null}
                  {ep.chapters ? <Badge tone="green" dot={false}>章节锁定</Badge> : null}
                  {ep.encode?.outputPath ? <Badge tone="green" dot={false}>成品</Badge> : null}
                  {ep.final ? <Badge tone="deep-green" dot={false}>已命名</Badge> : null}
                </div>
                {ep.staleReasons.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--color-danger)' }}>
                    ⚠ {ep.staleReasons[ep.staleReasons.length - 1]}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <Drawer open={showMapping} title="集号对照表（本地序号 ≠ 发布集数）" onClose={() => setShowMapping(false)} width={520}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          默认 `{'{release}'} = 基准 + (本地 - 起始)`，可逐集手工修正（如总集篇、特别篇跳号）。保存后立即写入项目状态库。
        </div>
        <div className="table-wrap" style={{ maxHeight: 420 }}>
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 80 }}>本地集</th>
                <th style={{ width: 100 }}>发布集</th>
                <th>手工修正</th>
              </tr>
            </thead>
            <tbody>
              {episodes.map((ep) => (
                <tr key={ep.id}>
                  <td className="mono">{ep.localNo}</td>
                  <td className="mono">{ep.releaseNo}</td>
                  <td>
                    <input
                      className="input"
                      style={{ height: 26, width: 96 }}
                      placeholder={ep.releaseNo}
                      value={releaseEdits[ep.localNo] ?? ''}
                      onChange={(e) => setReleaseEdits((prev) => ({ ...prev, [ep.localNo]: e.target.value }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <span className="spacer" />
          <Button size="sm" onClick={() => setShowMapping(false)}>
            取消
          </Button>
          <Button size="sm" kind="primary" disabled={saving || Object.keys(releaseEdits).length === 0} onClick={() => void saveMapping()}>
            保存修改
          </Button>
        </div>
      </Drawer>

      <Modal
        open={showTemplates}
        wide
        title="模板与实例化"
        onClose={() => setShowTemplates(false)}
        footer={
          <Button
            onClick={() => {
              setShowTemplates(false)
              onReload()
            }}
          >
            关闭
          </Button>
        }
      >
        <TemplatePanel rootPath={project.rootPath} episodes={episodes} onChanged={onReload} />
      </Modal>
    </div>
  )
}

export type { EpisodeRecord }
