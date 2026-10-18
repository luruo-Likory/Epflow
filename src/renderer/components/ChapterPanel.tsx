import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChapterViewDto, EpisodeDetailDto } from '@shared/api'
import type { Chapter } from '@shared/types'
import { formatTimecode } from '@shared/time'
import { invoke, errorText } from '../lib/api'
import { Badge, Button, Card, Checkbox, Field, Modal, Select, TextInput, useToast } from '../components/ui'

const SOURCE_META: Record<Chapter['source'], { label: string; tone: string }> = {
  auto: { label: '自动', tone: 'blue' },
  manual: { label: '手动', tone: 'teal' },
  op: { label: 'OP', tone: 'orange' },
  ed: { label: 'ED', tone: 'orange' }
}

function parseTimeInput(text: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(text.trim())
  if (!m) return null
  const h = Number(m[1] ?? 0)
  const mi = Number(m[2])
  const s = Number(m[3])
  const ms = Number((m[4] ?? '0').padEnd(3, '0'))
  return ((h * 60 + mi) * 60 + s) * 1000 + ms
}

export function ChapterPanel({
  rootPath,
  detail,
  onRefresh
}: {
  rootPath: string
  detail: EpisodeDetailDto
  onRefresh: () => void
}): React.ReactElement {
  const toast = useToast()
  const ep = detail.episode
  const [view, setView] = useState<ChapterViewDto | null>(null)
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [busy, setBusy] = useState(false)
  const [lockOpen, setLockOpen] = useState(false)
  const [checks, setChecks] = useState<string[]>([])
  const [selected, setSelected] = useState<number>(0)

  const load = useCallback(async () => {
    try {
      const result = await invoke('chapter:read', { rootPath, localNo: ep.localNo })
      setView(result)
      setChapters(result.chapters)
    } catch (err) {
      toast.error(errorText(err))
    }
  }, [rootPath, ep.localNo, toast])

  useEffect(() => {
    void load()
  }, [load])

  const dirty = useMemo(() => {
    if (!view) return false
    return JSON.stringify(view.chapters) !== JSON.stringify(chapters)
  }, [view, chapters])

  const totalMs = useMemo(() => {
    const last = chapters[chapters.length - 1]
    return last ? last.startMs + 60_000 : 1
  }, [chapters])

  const generate = async () => {
    setBusy(true)
    try {
      const result = await invoke('chapter:generate', { rootPath, localNo: ep.localNo })
      setView(result)
      setChapters(result.chapters)
      toast.success(`已生成 ${result.chapters.length} 个章节`)
      onRefresh()
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    try {
      const result = await invoke('chapter:save', { rootPath, localNo: ep.localNo, chapters })
      setView(result)
      toast.success('章节草稿已保存')
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const lock = async () => {
    setBusy(true)
    try {
      await invoke('chapter:lock', { rootPath, localNo: ep.localNo, checklist: checks })
      toast.success('章节已锁定')
      setLockOpen(false)
      setChecks([])
      await load()
      onRefresh()
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const updateChapter = (index: number, patch: Partial<Chapter>) => {
    setChapters((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }

  const addChapter = () => {
    const prev = chapters[selected]
    const startMs = prev ? prev.startMs + 60_000 : 0
    const next: Chapter = {
      startMs,
      title: `Chapter ${String(chapters.length + 1).padStart(2, '0')}`,
      source: 'manual',
      uid: String(BigInt(Date.now()) * 1000n + BigInt(chapters.length + 1))
    }
    setChapters((prevList) => [...prevList, next].sort((a, b) => a.startMs - b.startMs))
  }

  const removeChapter = () => {
    setChapters((prev) => prev.filter((_, i) => i !== selected))
  }

  const mergeNext = () => {
    if (selected < 0 || selected >= chapters.length - 1) return
    setChapters((prev) => prev.filter((_, i) => i !== selected + 1))
  }

  const snapToDialogue = async () => {
    try {
      const data = await invoke('subtitle:read', { rootPath, localNo: ep.localNo })
      const current = chapters[selected]
      if (!current) return
      const nearest = data.events
        .filter((e) => !e.isComment)
        .reduce<{ index: number; startMs: number; plain: string } | null>((best, e) => {
          if (!best) return { index: e.index, startMs: e.startMs, plain: e.plain }
          return Math.abs(e.startMs - current.startMs) < Math.abs(best.startMs - current.startMs)
            ? { index: e.index, startMs: e.startMs, plain: e.plain }
            : best
        }, null)
      if (nearest) {
        updateChapter(selected, { startMs: nearest.startMs, title: current.title })
        toast.info(`已吸附到第 ${nearest.index} 行对白`)
      }
    } catch (err) {
      toast.error(errorText(err))
    }
  }

  const startDrag = (index: number, e: React.MouseEvent) => {
    e.preventDefault()
    const bar = (e.currentTarget as HTMLElement).parentElement
    if (!bar) return
    const rect = bar.getBoundingClientRect()
    const move = (ev: MouseEvent) => {
      const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
      const ms = Math.round((ratio * totalMs) / 500) * 500
      updateChapter(index, { startMs: ms, source: chapters[index]?.source === 'op' || chapters[index]?.source === 'ed' ? chapters[index]!.source : 'manual' })
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const locked = view?.locked ?? false

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12, height: '100%', overflow: 'auto' }}>
      <Card
        title={
          <div className="row" style={{ gap: 8 }}>
            <span>章节</span>
            <Badge tone="teal" dot={false}>{chapters.length} 章</Badge>
            {view?.stale && <Badge tone="red">草稿已过期</Badge>}
            {locked && <Badge tone="green">已锁定</Badge>}
          </div>
        }
        extra={
          <div className="row wrap">
            <Button size="sm" onClick={() => void load()}>刷新</Button>
            <Button size="sm" disabled={busy} onClick={() => void generate()}>
              {view?.chapters.length ? '重新生成初稿' : '生成初稿'}
            </Button>
            <Button size="sm" disabled={busy || dirty || locked || chapters.length === 0} onClick={() => void save()}>
              保存草稿
            </Button>
            <Button
              size="sm"
              kind="primary"
              disabled={busy || locked || chapters.length === 0 || dirty}
              onClick={() => setLockOpen(true)}
            >
              审阅通过并锁定
            </Button>
          </div>
        }
      >
        <div style={{ position: 'relative', height: 44, background: '#f1f5f9', borderRadius: 8, marginBottom: 6 }}>
          {chapters.map((chapter, index) => (
            <div
              key={`${chapter.uid}-${index}`}
              onMouseDown={(e) => !locked && startDrag(index, e)}
              title={`${chapter.title} · ${formatTimecode(chapter.startMs)}`}
              style={{
                position: 'absolute',
                left: `${Math.min(100, (chapter.startMs / totalMs) * 100)}%`,
                top: 6,
                height: 32,
                width: 3,
                background: chapter.source === 'op' || chapter.source === 'ed' ? 'var(--color-warning)' : 'var(--color-primary)',
                borderRadius: 2,
                cursor: locked ? 'default' : 'ew-resize'
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: -2,
                  left: 5,
                  fontSize: 10.5,
                  color: 'var(--color-text-muted)',
                  whiteSpace: 'nowrap'
                }}
              >
                {chapter.title}
              </span>
            </div>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 11.5 }}>
          拖动竖线调整章节时间（吸附 500ms）；时间轴仅供示意，不按真实视频时长比例。
        </div>
      </Card>

      <Card
        title="章节表格"
        extra={
          !locked && (
            <div className="row wrap">
              <Button size="sm" onClick={addChapter}>新增</Button>
              <Button size="sm" kind="danger" disabled={chapters.length <= 1} onClick={removeChapter}>删除</Button>
              <Button size="sm" disabled={selected >= chapters.length - 1} onClick={mergeNext}>与下一章合并</Button>
              <Button size="sm" onClick={() => void snapToDialogue()}>按对白吸附</Button>
            </div>
          )
        }
      >
        <div className="table-wrap" style={{ maxHeight: 360 }}>
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 44 }} className="num">#</th>
                <th style={{ width: 130 }}>开始时间</th>
                <th>标题</th>
                <th style={{ width: 80 }}>来源</th>
                <th style={{ width: 150 }}>UID</th>
              </tr>
            </thead>
            <tbody>
              {chapters.map((chapter, index) => (
                <tr
                  key={`${chapter.uid}-${index}`}
                  className={selected === index ? 'selected clickable' : 'clickable'}
                  onClick={() => setSelected(index)}
                >
                  <td className="num">{index + 1}</td>
                  <td>
                    {locked ? (
                      <span className="mono">{formatTimecode(chapter.startMs)}</span>
                    ) : (
                      <TextInput
                        defaultValue={formatTimecode(chapter.startMs)}
                        onBlur={(e) => {
                          const ms = parseTimeInput(e.target.value)
                          if (ms !== null) updateChapter(index, { startMs: ms })
                          else e.target.value = formatTimecode(chapter.startMs)
                        }}
                        style={{ height: 26, fontFamily: 'var(--font-mono)' }}
                      />
                    )}
                  </td>
                  <td>
                    {locked ? (
                      chapter.title
                    ) : (
                      <TextInput
                        value={chapter.title}
                        onChange={(e) => updateChapter(index, { title: e.target.value })}
                        style={{ height: 26 }}
                      />
                    )}
                  </td>
                  <td>
                    <Badge tone={SOURCE_META[chapter.source].tone} dot={false}>
                      {SOURCE_META[chapter.source].label}
                    </Badge>
                  </td>
                  <td className="mono muted" style={{ fontSize: 11 }}>
                    {chapter.uid}
                  </td>
                </tr>
              ))}
              {chapters.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">还没有章节，请先「生成初稿」</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {locked && view?.lockedInfo && (
          <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            已锁定：{view.lockedInfo.chapterCount} 章 · 哈希 {view.lockedInfo.sha256.slice(0, 8)}… · 审阅人 {view.lockedInfo.reviewedBy} ·
            {' '}{view.lockedInfo.reviewedAt.slice(0, 19).replace('T', ' ')}
          </div>
        )}
        {dirty && <div style={{ marginTop: 8, color: 'var(--color-warning)', fontSize: 12 }}>有未保存的章节修改</div>}
      </Card>

      <Modal
        open={lockOpen}
        title="章节审阅通过"
        onClose={() => setLockOpen(false)}
        footer={
          <>
            <Button onClick={() => setLockOpen(false)}>取消</Button>
            <Button kind="primary" disabled={busy || checks.length < 3} onClick={() => void lock()}>
              通过并锁定
            </Button>
          </>
        }
      >
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          锁定后章节 XML 会写入集目录并记录哈希，合并时哈希不一致将阻断。
        </div>
        {['章节切点与剧情段落一致', '标题/编号无误', '已确认首章从 0 开始'].map((item) => (
          <div key={item} style={{ marginBottom: 6 }}>
            <Checkbox
              checked={checks.includes(item)}
              onChange={(checked) => setChecks((prev) => (checked ? [...prev, item] : prev.filter((x) => x !== item)))}
              label={item}
            />
          </div>
        ))}
        {chapters.length > 0 && (
          <Field label="首章时间">
            <span className="mono">{formatTimecode(chapters[0]!.startMs)}</span>
          </Field>
        )}
      </Modal>
    </div>
  )
}
