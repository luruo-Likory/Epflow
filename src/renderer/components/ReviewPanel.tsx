import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EpisodeDetailDto, PlayerStatusDto, SubtitleEventDto, SubtitleViewDto } from '@shared/api'
import type { IssueStatus, ReviewIssue } from '@shared/types'
import { SEVERITY_META } from '@shared/state-machine'
import { formatTimecode, formatClock } from '@shared/time'
import { invoke, errorText, subscribe } from '../lib/api'
import { Badge, Button, ReasonDialog, Select, TextInput, useToast } from '../components/ui'
import { VirtualTable, type Column } from '../components/VTable'

type ViewKey = 'all' | 'issues' | 'ignored'

const STATUS_META: Record<IssueStatus, { label: string; tone: string }> = {
  open: { label: '未处理', tone: 'orange' },
  fixed: { label: '已修复', tone: 'green' },
  ignored: { label: '已忽略', tone: 'gray' },
  false_positive: { label: '误报', tone: 'gray' }
}

/** 内置播放器的 ASS 字幕叠加层：按当前播放时间渲染对白/屏幕字 */
function SubtitleOverlay({ events, ms }: { events: SubtitleEventDto[]; ms: number }): React.ReactElement | null {
  const active = events.filter(
    (e) => !e.isComment && e.plain.trim().length > 0 && ms >= e.startMs && ms <= e.endMs
  )
  if (active.length === 0) return null

  const isTop = (text: string): boolean => /\\an[789]/.test(text)
  const line = (e: SubtitleEventDto): React.ReactElement => (
    <div
      key={e.index}
      style={{
        whiteSpace: 'pre-line',
        fontSize: 'clamp(12px, 4.4cqh, 40px)',
        lineHeight: 1.25,
        color: '#ffffff',
        fontWeight: 600,
        textAlign: 'center',
        textShadow:
          '0 0 3px #000, 1px 1px 2px #000, -1px 1px 2px #000, 1px -1px 2px #000, -1px -1px 2px #000'
      }}
    >
      {e.plain}
    </div>
  )

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        containerType: 'size',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '6% 5% 9%'
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
        {active.filter((e) => isTop(e.text)).map(line)}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
        {active.filter((e) => !isTop(e.text)).map(line)}
      </div>
    </div>
  )
}

export function ReviewPanel({
  rootPath,
  detail,
  onRefresh
}: {
  rootPath: string
  detail: EpisodeDetailDto
  onRefresh: () => void
}): React.ReactElement {
  const toast = useToast()
  const [subtitle, setSubtitle] = useState<SubtitleViewDto | null>(null)
  const [templateVideo, setTemplateVideo] = useState<string | null>(null)
  const [videoError, setVideoError] = useState(false)
  const [view, setView] = useState<ViewKey>('all')
  const [severityFilter, setSeverityFilter] = useState<'all' | 'blocker' | 'major'>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | IssueStatus>('all')
  const [keyword, setKeyword] = useState('')
  const [selectedEvent, setSelectedEvent] = useState<number | null>(null)
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null)
  const [reasonTarget, setReasonTarget] = useState<{ issueId: string; status: IssueStatus } | null>(null)
  const [busy, setBusy] = useState(false)
  const [narrow, setNarrow] = useState(window.innerWidth < 1280)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [checklist, setChecklist] = useState<string[]>([])
  const [humanNote, setHumanNote] = useState('')
  const [rejectOpen, setRejectOpen] = useState(false)
  const [loop, setLoop] = useState(false)
  const [currentMs, setCurrentMs] = useState(0)
  const [dshMode, setDshMode] = useState<'paste' | 'cli' | 'http'>('paste')
  const [allowForce, setAllowForce] = useState(false)
  const [forceOpen, setForceOpen] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const videoBoxRef = useRef<HTMLDivElement | null>(null)
  const [engine, setEngine] = useState<'mpv' | 'builtin'>(() =>
    localStorage.getItem('epflow.player') === 'mpv' ? 'mpv' : 'builtin'
  )
  const [mpvStatus, setMpvStatus] = useState<PlayerStatusDto | null>(null)
  const [mpvError, setMpvError] = useState<string | null>(null)
  const mpvWasRunning = useRef(false)

  const ep = detail.episode
  const issues = detail.issues

  const load = useCallback(async () => {
    try {
      const data = await invoke('subtitle:read', { rootPath, localNo: ep.localNo })
      setSubtitle(data)
      if (selectedEvent === null) {
        const first = data.events.find((e) => !e.isComment)
        if (first) setSelectedEvent(first.index)
      }
    } catch (err) {
      toast.error(errorText(err))
    }
  }, [rootPath, ep.localNo, selectedEvent, toast])

  const importSubtitleFile = async () => {
    try {
      const files = await invoke('dialog:pick-files', {
        title: '选择字幕文件（ASS / SSA）',
        filters: [{ name: 'ASS/SSA 字幕', extensions: ['ass', 'ssa'] }]
      })
      if (files.length === 0) return
      setBusy(true)
      await invoke('subtitle:import', { rootPath, localNo: ep.localNo, filePath: files[0]! })
      toast.success('字幕已导入（已统一为 UTF-8，原文件已备份为 .orig）')
      setSelectedEvent(null)
      await load()
      onRefresh()
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void invoke('settings:get')
      .then((s) => {
        setDshMode(s.dsh.mode)
        setAllowForce(s.allowForcePass)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    void invoke('template:analyze', { rootPath })
      .then((a) => {
        const file = a.info.inputFiles[0]
        if (file) setTemplateVideo(file)
      })
      .catch(() => undefined)
  }, [rootPath])

  const videoPath = ep.reviewVideo?.path ?? templateVideo
  const videoName = videoPath ? videoPath.split(/[\\/]/).pop() ?? videoPath : null
  const subtitlePath = subtitle?.info?.path ?? null

  useEffect(() => {
    setVideoError(false)
  }, [videoPath])

  const switchEngine = (next: 'mpv' | 'builtin') => {
    setEngine(next)
    localStorage.setItem('epflow.player', next)
    if (next === 'builtin') setMpvStatus(null)
  }

  /** mpv 内嵌：把视频区域的屏幕矩形交给主进程，由子窗口承载 mpv 画面与 ASS 字幕 */
  useEffect(() => {
    if (engine !== 'mpv' || !videoPath || subtitle === null) {
      setMpvStatus(null)
      void invoke('player:stop').catch(() => undefined)
      return
    }
    let disposed = false
    let rectTimer: number | null = null
    const sendBounds = () => {
      const box = videoBoxRef.current
      if (!box) return
      const r = box.getBoundingClientRect()
      void invoke('player:bounds', {
        rect: { x: r.x, y: r.y, width: r.width, height: r.height }
      }).catch(() => undefined)
    }
    const scheduleBounds = () => {
      if (rectTimer !== null) return
      rectTimer = window.setTimeout(() => {
        rectTimer = null
        sendBounds()
      }, 100)
    }
    const start = async () => {
      const box = videoBoxRef.current
      if (!box) return
      const r = box.getBoundingClientRect()
      try {
        const result = await invoke('player:start', {
          rootPath,
          localNo: ep.localNo,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height }
        })
        if (disposed) {
          void invoke('player:stop').catch(() => undefined)
          return
        }
        if (!result.ok) {
          setMpvError(result.reason ?? 'mpv 启动失败')
          switchEngine('builtin')
          toast.warn(`${result.reason ?? 'mpv 启动失败'}，已切换为内置播放器`)
        }
      } catch (err) {
        if (!disposed) {
          toast.warn(`${errorText(err)}，已切换为内置播放器`)
          switchEngine('builtin')
        }
      }
    }
    void start()
    const observer = new ResizeObserver(scheduleBounds)
    if (videoBoxRef.current) observer.observe(videoBoxRef.current)
    window.addEventListener('resize', scheduleBounds)
    window.addEventListener('scroll', scheduleBounds, true)
    const off = subscribe('mpv:status', (payload) => {
      const status = payload as PlayerStatusDto
      setMpvStatus(status)
      if (status.running) {
        mpvWasRunning.current = true
      } else if (mpvWasRunning.current) {
        mpvWasRunning.current = false
        setMpvError('mpv 已退出')
        toast.warn('mpv 已退出，已切换为内置播放器')
        switchEngine('builtin')
      }
    })
    return () => {
      disposed = true
      if (rectTimer !== null) window.clearTimeout(rectTimer)
      observer.disconnect()
      window.removeEventListener('resize', scheduleBounds)
      window.removeEventListener('scroll', scheduleBounds, true)
      off()
      void invoke('player:stop').catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, videoPath, subtitlePath, rootPath, ep.localNo])

  useEffect(() => {
    if (engine !== 'mpv' || !mpvStatus?.running) return
    const ms = mpvStatus.timePos * 1000
    setCurrentMs(ms)
    const active = (subtitle?.events ?? []).find((e) => e.index === selectedEvent)
    if (loop && active && ms > active.endMs + 80) {
      void invoke('player:command', {
        command: ['seek', active.startMs / 1000, 'absolute']
      }).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, mpvStatus, loop, selectedEvent, subtitle])

  const chooseVideo = async () => {
    try {
      const files = await invoke('dialog:pick-files', {
        title: '选择审阅用视频',
        filters: [{ name: '视频文件', extensions: ['mkv', 'mp4', 'avi', 'mov', 'webm', 'ts', 'm2ts'] }]
      })
      if (files.length === 0 || !files[0]) return
      await invoke('episode:set-video', { rootPath, localNo: ep.localNo, path: files[0] })
      toast.success('已设置本集审阅视频')
      onRefresh()
    } catch (err) {
      toast.error(errorText(err))
    }
  }

  const clearVideo = async () => {
    try {
      await invoke('episode:set-video', { rootPath, localNo: ep.localNo, path: null })
      toast.info('已恢复为模板源视频')
      onRefresh()
    } catch (err) {
      toast.error(errorText(err))
    }
  }

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1280)
    window.addEventListener('resize', onResize)
    const off1 = subscribe('watch:subtitle-changed', () => {
      toast.warn('字幕已变更，审阅结论已失效')
      onRefresh()
    })
    const off2 = subscribe('episode:state', () => onRefresh())
    return () => {
      window.removeEventListener('resize', onResize)
      off1()
      off2()
    }
  }, [onRefresh, toast])

  const events = subtitle?.events ?? []
  const dialogue = useMemo(() => events.filter((e) => !e.isComment), [events])

  const issuesByLine = useMemo(() => {
    const map = new Map<number, ReviewIssue[]>()
    for (const issue of issues) {
      if (issue.line === null) continue
      const list = map.get(issue.line) ?? []
      list.push(issue)
      map.set(issue.line, list)
    }
    return map
  }, [issues])

  const counts = useMemo(() => {
    const open = issues.filter((i) => i.status === 'open')
    return {
      total: issues.length,
      blocker: open.filter((i) => i.severity === 'blocker').length,
      major: open.filter((i) => i.severity === 'major').length,
      minor: open.filter((i) => i.severity === 'minor').length,
      handled: issues.filter((i) => i.status !== 'open').length
    }
  }, [issues])

  const filteredEvents = useMemo(() => {
    let rows = dialogue
    if (view !== 'all') {
      const allowed = new Set(
        issues
          .filter((i) => (view === 'issues' ? i.status === 'open' : i.status !== 'open'))
          .map((i) => i.line)
          .filter((x): x is number => x !== null)
      )
      rows = rows.filter((e) => allowed.has(e.index))
    }
    if (severityFilter !== 'all') {
      const allowed = new Set(
        issues
          .filter((i) => i.severity === severityFilter || (severityFilter === 'major' && i.severity === 'blocker'))
          .map((i) => i.line)
          .filter((x): x is number => x !== null)
      )
      rows = rows.filter((e) => allowed.has(e.index))
    }
    if (statusFilter !== 'all') {
      const allowed = new Set(
        issues
          .filter((i) => i.status === statusFilter)
          .map((i) => i.line)
          .filter((x): x is number => x !== null)
      )
      rows = rows.filter((e) => allowed.has(e.index))
    }
    if (keyword.trim()) {
      const q = keyword.trim().toLowerCase()
      rows = rows.filter((e) => e.plain.toLowerCase().includes(q))
    }
    return rows
  }, [dialogue, view, issues, severityFilter, statusFilter, keyword])

  const filteredIssues = useMemo(() => {
    let rows = issues
    if (view === 'issues') rows = rows.filter((i) => i.status === 'open')
    if (view === 'ignored') rows = rows.filter((i) => i.status !== 'open')
    if (severityFilter !== 'all') {
      rows = rows.filter((i) => i.severity === severityFilter || (severityFilter === 'major' && i.severity === 'blocker'))
    }
    if (statusFilter !== 'all') rows = rows.filter((i) => i.status === statusFilter)
    if (keyword.trim()) {
      const q = keyword.trim().toLowerCase()
      rows = rows.filter(
        (i) =>
          i.original.toLowerCase().includes(q) ||
          i.suggestion.toLowerCase().includes(q) ||
          i.reason.toLowerCase().includes(q)
      )
    }
    return [...rows].sort((a, b) => SEVERITY_META[a.severity].order - SEVERITY_META[b.severity].order)
  }, [issues, view, severityFilter, statusFilter, keyword])

  const currentEvent = dialogue.find((e) => e.index === selectedEvent) ?? dialogue[0] ?? null
  const currentIssues = currentEvent ? issuesByLine.get(currentEvent.index) ?? [] : []
  const issue = issues.find((i) => i.id === selectedIssue) ?? currentIssues[0] ?? null

  const durationMs = Math.max(
    subtitle?.events.reduce((max, e) => Math.max(max, e.endMs), 0) ?? 0,
    mpvStatus?.duration ? mpvStatus.duration * 1000 : 0,
    1000
  )

  const seek = useCallback(
    (ms: number) => {
      setCurrentMs(ms)
      if (engine === 'mpv') {
        void invoke('player:command', {
          command: ['seek', Math.max(0, ms / 1000), 'absolute']
        }).catch(() => undefined)
        return
      }
      const video = videoRef.current
      if (video) {
        video.currentTime = Math.max(0, ms / 1000)
        if (loop && currentEvent) {
          if (ms / 1000 > currentEvent.endMs / 1000) video.currentTime = currentEvent.startMs / 1000
        }
      }
    },
    [loop, currentEvent, engine]
  )

  const togglePlay = useCallback(() => {
    if (engine === 'mpv') {
      void invoke('player:command', {
        command: ['set_property', 'pause', !(mpvStatus?.paused ?? true)]
      }).catch(() => undefined)
      return
    }
    const video = videoRef.current
    if (video) {
      if (video.paused) void video.play()
      else video.pause()
    }
  }, [engine, mpvStatus])

  const selectEvent = useCallback(
    (index: number) => {
      setSelectedEvent(index)
      const target = dialogue.find((e) => e.index === index)
      if (target) seek(target.startMs)
      if (narrow) setDrawerOpen(true)
    },
    [dialogue, seek, narrow]
  )

  const nextEvent = (delta: number) => {
    const idx = filteredEvents.findIndex((e) => e.index === currentEvent?.index)
    const next = filteredEvents[Math.max(0, Math.min(filteredEvents.length - 1, (idx < 0 ? 0 : idx) + delta))]
    if (next) selectEvent(next.index)
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (e.ctrlKey || e.metaKey) return
      switch (e.key) {
        case 'j':
        case 'J':
          e.preventDefault()
          nextEvent(1)
          break
        case 'k':
        case 'K':
          e.preventDefault()
          nextEvent(-1)
          break
        case ' ':
          e.preventDefault()
          togglePlay()
          break
        case 'f':
        case 'F':
          if (issue) void setStatus(issue.id, 'fixed')
          break
        case 'i':
        case 'I':
          if (issue) setReasonTarget({ issueId: issue.id, status: 'ignored' })
          break
        case 'Enter':
          e.preventDefault()
          if (currentEvent) seek(currentEvent.startMs)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  const setStatus = async (issueId: string, status: IssueStatus, note = '') => {
    setBusy(true)
    try {
      await invoke('review:set-issue', { rootPath, issueId, status, note })
      toast.success(`已标记为${STATUS_META[status].label}`)
      onRefresh()
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const runReview = async () => {
    setBusy(true)
    try {
      const result = await invoke('review:start', { rootPath, localNo: ep.localNo })
      toast.success(`AI 审阅完成：${result.issues.length} 条问题`)
      onRefresh()
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const preparePrompt = async () => {
    try {
      const result = await invoke('review:prepare', { rootPath, localNo: ep.localNo })
      await navigator.clipboard.writeText(result.prompt)
      toast.success('prompt 已复制到剪贴板，可粘贴到 DSH；把返回的 JSON 用「粘贴结果」导入')
    } catch (err) {
      toast.error(errorText(err))
    }
  }

  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')

  const submitPaste = async (text: string) => {
    try {
      setBusy(true)
      await invoke('review:submit-json', { rootPath, localNo: ep.localNo, json: text })
      setPasteOpen(false)
      setPasteText('')
      toast.success('已导入 AI 审阅结果')
      onRefresh()
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const humanPass = async () => {
    try {
      setBusy(true)
      await invoke('human:pass', { rootPath, localNo: ep.localNo, checklist, note: humanNote })
      setChecklist([])
      setHumanNote('')
      toast.success('人工审阅已通过，字幕已锁定')
      onRefresh()
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const openHuman = async () => {
    try {
      setBusy(true)
      await invoke('human:open', { rootPath, localNo: ep.localNo })
      toast.info('已打开字幕文件，请在外部编辑器中通读')
      onRefresh()
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const exportIssues = (format: 'json' | 'csv') => {
    const data =
      format === 'json'
        ? JSON.stringify({ episode: ep.localNo, release: ep.releaseNo, issues }, null, 2)
        : [
            'id,severity,category,line,start,end,original,suggestion,reason,status',
            ...issues.map((i) =>
              [i.id, i.severity, i.category, i.line ?? '', i.startMs ?? '', i.endMs ?? '', i.original, i.suggestion, i.reason, i.status]
                .map((v) => `"${String(v).replace(/"/g, '""')}"`)
                .join(',')
            )
          ].join('\r\n')
    const blob = new Blob([data], { type: format === 'json' ? 'application/json' : 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${ep.workName}.issues.${format}`
    a.click()
    URL.revokeObjectURL(url)
  }

  const eventColumns: Array<Column<(typeof dialogue)[number]>> = [
    {
      key: 'no',
      header: '#',
      width: 48,
      align: 'right',
      render: (row) => <span className="mono muted">{row.index}</span>
    },
    {
      key: 'time',
      header: '时间',
      width: 100,
      render: (row) => <span className="mono">{formatTimecode(row.startMs)}</span>
    },
    { key: 'style', header: '样式', width: 120, render: (row) => <span className="muted">{row.style}</span> },
    {
      key: 'text',
      header: '原文',
      render: (row) => {
        const rowIssues = issuesByLine.get(row.index) ?? []
        const worst = rowIssues
          .filter((i) => i.status === 'open')
          .sort((a, b) => SEVERITY_META[a.severity].order - SEVERITY_META[b.severity].order)[0]
        return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
            <span
              style={{
                width: 3,
                height: 16,
                borderRadius: 2,
                background: worst ? SEVERITY_META[worst.severity].color : 'transparent',
                flex: '0 0 auto'
              }}
            />
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                textDecoration: rowIssues.some((i) => i.status === 'fixed') ? 'line-through' : undefined,
                color: rowIssues.some((i) => i.status === 'ignored') ? 'var(--color-text-faint)' : undefined
              }}
            >
              {row.plain}
            </span>
          </span>
        )
      }
    },
    {
      key: 'issue',
      header: 'AI 建议',
      width: 240,
      render: (row) => {
        const first = (issuesByLine.get(row.index) ?? [])[0]
        return first ? (
          <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={first.suggestion}>
            {first.suggestion}
          </span>
        ) : (
          <span className="muted">—</span>
        )
      }
    },
    {
      key: 'status',
      header: '状态',
      width: 90,
      render: (row) => {
        const list = issuesByLine.get(row.index) ?? []
        if (list.length === 0) return <span className="muted">—</span>
        const open = list.filter((i) => i.status === 'open').length
        return open > 0 ? <Badge tone="orange" dot={false}>{open} 未处理</Badge> : <Badge tone="green" dot={false}>已处理</Badge>
      }
    }
  ]

  const issueColumns: Array<Column<ReviewIssue>> = [
    { key: 'sev', header: '严重度', width: 80, render: (i) => <Badge tone={SEVERITY_META[i.severity].tone}>{SEVERITY_META[i.severity].label}</Badge> },
    { key: 'cat', header: '类别', width: 76, render: (i) => <span className="muted">{i.category}</span> },
    { key: 'line', header: '行', width: 48, align: 'right', render: (i) => <span className="mono">{i.line ?? '—'}</span> },
    { key: 'time', header: '时间', width: 96, render: (i) => <span className="mono">{i.startMs !== null ? formatTimecode(i.startMs) : '—'}</span> },
    { key: 'orig', header: '原文', width: 220, render: (i) => <span title={i.original}>{i.original}</span> },
    { key: 'sug', header: '建议', render: (i) => <span>{i.suggestion}</span> },
    { key: 'status', header: '状态', width: 90, render: (i) => <Badge tone={STATUS_META[i.status].tone} dot={false}>{STATUS_META[i.status].label}</Badge> }
  ]

  const rightDetail = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {!subtitle?.exists ? (
        <div style={{ border: '1px dashed var(--color-border-strong)', borderRadius: 8, padding: 14, textAlign: 'center' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>还没有导入字幕</div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            导入时会统一转为 UTF-8 无 BOM，原文件保留为 <span className="mono">.orig</span> 备份。
          </div>
          <Button kind="primary" disabled={busy} onClick={() => void importSubtitleFile()}>
            导入字幕（ASS / SSA）
          </Button>
        </div>
      ) : null}
      <div className="row">
        <span style={{ fontWeight: 700 }}>#{currentEvent?.index ?? '—'}</span>
        <span className="muted">/ {dialogue.length}</span>
        <span className="spacer" />
        {currentEvent && <span className="mono muted" style={{ fontSize: 11.5 }}>{formatClock(currentEvent.startMs)}</span>}
      </div>
      <div className="row">
        <Button size="sm" onClick={() => currentEvent && seek(currentEvent.startMs)}>播放本句</Button>
        <Button size="sm" kind={loop ? 'primary' : 'default'} onClick={() => setLoop(!loop)}>循环</Button>
        <Button size="sm" onClick={() => nextEvent(-1)}>上一条</Button>
        <Button size="sm" onClick={() => nextEvent(1)}>下一条</Button>
      </div>
      {currentEvent && (
        <>
          <div className="field">
            <label>开始 / 结束</label>
            <span className="mono" style={{ fontSize: 12 }}>
              {formatTimecode(currentEvent.startMs)} → {formatTimecode(currentEvent.endMs)}
              <span className="muted"> · {((currentEvent.endMs - currentEvent.startMs) / 1000).toFixed(2)}s</span>
            </span>
          </div>
          <div className="field">
            <label>原文</label>
            <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{currentEvent.plain}</div>
          </div>
          <div className="field">
            <label>样式</label>
            <span className="muted">{currentEvent.style || '—'}</span>
          </div>
        </>
      )}
      <div className="divider" />
      {issue ? (
        <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: 10, background: '#fff' }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <Badge tone={SEVERITY_META[issue.severity].tone}>{SEVERITY_META[issue.severity].label}</Badge>
            <span className="muted" style={{ fontSize: 12 }}>{issue.category}</span>
            <span className="spacer" />
            <Badge tone={STATUS_META[issue.status].tone} dot={false}>{STATUS_META[issue.status].label}</Badge>
          </div>
          <div className="field" style={{ marginBottom: 6 }}>
            <label>AI 建议</label>
            <div style={{ fontSize: 13 }}>{issue.suggestion || '—'}</div>
          </div>
          <div className="field" style={{ marginBottom: 6 }}>
            <label>理由</label>
            <div className="muted" style={{ fontSize: 12.5 }}>{issue.reason || '—'}</div>
          </div>
          {issue.confidence !== null && (
            <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>置信度 {Math.round(issue.confidence * 100)}%</div>
          )}
          {issue.resolutionNote && (
            <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>处理说明：{issue.resolutionNote}</div>
          )}
          <div className="row wrap">
            <Button size="sm" onClick={() => currentEvent && seek(currentEvent.startMs)}>跳转视频</Button>
            <Button size="sm" kind="primary" disabled={busy} onClick={() => void setStatus(issue.id, 'fixed')}>标记已修复</Button>
            <Button size="sm" disabled={busy} onClick={() => setReasonTarget({ issueId: issue.id, status: 'ignored' })}>忽略</Button>
            <Button size="sm" disabled={busy} onClick={() => setReasonTarget({ issueId: issue.id, status: 'false_positive' })}>误报</Button>
            <Button size="sm" kind="ghost" disabled={busy} onClick={() => void setStatus(issue.id, 'open')}>重置</Button>
          </div>
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12.5 }}>本句没有 AI 问题</div>
      )}

      {ep.state === 'AI_REJECTED' && allowForce && (
        <div style={{ border: '1px dashed var(--color-warning)', borderRadius: 8, padding: 8, fontSize: 12 }}>
          <div style={{ color: 'var(--color-warning)', marginBottom: 6 }}>
            设置中已允许强制通过：所有未处理的阻断/重要问题将被标记为「已忽略」，并写入审计日志。
          </div>
          <Button size="sm" kind="danger" onClick={() => setForceOpen(true)}>
            豁免并强制通过
          </Button>
        </div>
      )}

      <div className="divider" />
      <div className="panel-title" style={{ fontSize: 12.5 }}>人工审阅</div>
      {ep.human ? (
        <div className="muted" style={{ fontSize: 12 }}>
          已于 {ep.human.at.slice(0, 19).replace('T', ' ')} 由 {ep.human.by} 通过（哈希 {ep.human.subtitleHash.slice(0, 8)}…）
        </div>
      ) : (
        <>
          <div className="row wrap" style={{ marginBottom: 6 }}>
            <Button size="sm" disabled={busy || ep.state !== 'AI_PASSED'} onClick={() => void openHuman()}>打开人工审阅</Button>
            <Button size="sm" disabled={busy || ep.state !== 'HUMAN_REVIEWING'} onClick={() => setRejectOpen(true)}>打回</Button>
            <Button
              size="sm"
              disabled={busy || ep.state !== 'HUMAN_REVIEWING'}
              onClick={() => void invoke('human:cancel', { rootPath, localNo: ep.localNo }).then(onRefresh).catch((e) => toast.error(errorText(e)))}
            >
              取消审阅
            </Button>
          </div>
          {ep.state === 'HUMAN_REVIEWING' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[
                '已通读全片字幕',
                '已核对时间轴与对白同步',
                '已检查样式、字体、特效标签',
                '已确认 AI 问题均已处理或豁免'
              ].map((item) => (
                <label key={item} style={{ display: 'flex', gap: 8, fontSize: 12.5 }}>
                  <input
                    type="checkbox"
                    checked={checklist.includes(item)}
                    onChange={(e) =>
                      setChecklist((prev) => (e.target.checked ? [...prev, item] : prev.filter((x) => x !== item)))
                    }
                  />
                  {item}
                </label>
              ))}
              <TextInput placeholder="审阅备注（可选）" value={humanNote} onChange={(e) => setHumanNote(e.target.value)} />
              <Button size="sm" kind="primary" disabled={busy || checklist.length < 4} onClick={() => void humanPass()}>
                人工审阅通过并锁定
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ flex: '0 0 58%', minWidth: 0, display: 'flex', flexDirection: 'column', padding: 12, gap: 8 }}>
          <div
            ref={videoBoxRef}
            style={{
              background: '#0b1220',
              borderRadius: 8,
              aspectRatio: '16 / 9',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden'
            }}
          >
            {engine === 'mpv' && videoPath ? (
              <div style={{ color: '#64748b', fontSize: 12.5 }}>
                {mpvError ? mpvError : mpvStatus?.running ? 'mpv 内嵌播放中（含 ASS 字幕）' : '正在启动 mpv…'}
              </div>
            ) : videoPath && !videoError ? (
              <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                <video
                  ref={videoRef}
                  src={`file:///${videoPath.replace(/\\/g, '/')}`}
                  controls
                  style={{ width: '100%', height: '100%' }}
                  onError={() => setVideoError(true)}
                  onTimeUpdate={(e) => setCurrentMs((e.target as HTMLVideoElement).currentTime * 1000)}
                />
                <SubtitleOverlay events={subtitle?.events ?? []} ms={currentMs} />
              </div>
            ) : (
              <div className="muted" style={{ color: '#94a3b8', fontSize: 12.5, textAlign: 'center', padding: 12 }}>
                {videoPath && videoError
                  ? `视频无法播放：${videoName}（文件可能已被移动，请重新选择）`
                  : '未关联视频（仍可按时间轴审阅字幕）'}
              </div>
            )}
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            <Badge tone={engine === 'mpv' ? 'teal' : 'gray'} dot={false}>
              {engine === 'mpv' ? 'mpv 内嵌' : '内置播放器'}
            </Badge>
            <Badge tone={ep.reviewVideo ? 'teal' : templateVideo ? 'gray' : 'orange'} dot={false}>
              {ep.reviewVideo ? '手动指定视频' : templateVideo ? '模板源视频' : '未选择视频'}
            </Badge>
            {videoName && (
              <span className="mono muted" style={{ fontSize: 11.5, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={videoPath ?? undefined}>
                {videoName}
              </span>
            )}
            <Button size="sm" aria-label="播放或暂停" disabled={!videoPath} onClick={togglePlay}>
              {engine === 'mpv' ? (mpvStatus?.paused === false ? '暂停' : '播放') : '播放/暂停'}
            </Button>
            <span className="spacer" />
            <Button size="sm" onClick={() => switchEngine(engine === 'mpv' ? 'builtin' : 'mpv')}>
              {engine === 'mpv' ? '用内置播放器' : '用 mpv 内嵌'}
            </Button>
            <Button size="sm" onClick={() => void chooseVideo()}>选择审阅视频…</Button>
            {ep.reviewVideo && (
              <Button size="sm" kind="ghost" onClick={() => void clearVideo()}>恢复模板源</Button>
            )}
          </div>
          <div>
            <div style={{ position: 'relative', height: 26, background: '#e2e8f0', borderRadius: 6, overflow: 'hidden' }}>
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: `${Math.min(100, (currentMs / durationMs) * 100)}%`,
                  background: 'var(--color-primary-soft)'
                }}
              />
              {issues
                .filter((i) => i.startMs !== null)
                .slice(0, 400)
                .map((i) => (
                  <div
                    key={i.id}
                    title={`${SEVERITY_META[i.severity].label}：${i.suggestion || i.reason}`}
                    onClick={() => {
                      if (i.line !== null) selectEvent(i.line)
                      if (i.startMs !== null) seek(i.startMs)
                      setSelectedIssue(i.id)
                    }}
                    style={{
                      position: 'absolute',
                      left: `${Math.min(100, ((i.startMs ?? 0) / durationMs) * 100)}%`,
                      top: 4,
                      width: 3,
                      height: 18,
                      background: SEVERITY_META[i.severity].color,
                      cursor: 'pointer',
                      borderRadius: 2
                    }}
                  />
                ))}
              <div
                style={{
                  position: 'absolute',
                  left: `${Math.min(100, (currentMs / durationMs) * 100)}%`,
                  top: 0,
                  bottom: 0,
                  width: 2,
                  background: 'var(--color-primary)'
                }}
              />
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <span className="mono muted" style={{ fontSize: 11.5 }}>
                {formatTimecode(currentMs)} / {formatClock(durationMs)}
              </span>
              <span className="spacer" />
              <Button size="sm" kind="ghost" onClick={() => void preparePrompt()}>复制 Prompt</Button>
              <Button size="sm" onClick={() => setPasteOpen(true)}>粘贴结果</Button>
              <Button size="sm" onClick={() => void importSubtitleFile()}>导入字幕</Button>
              <Button size="sm" onClick={() => exportIssues('json')}>导出问题</Button>
            </div>
          </div>
        </div>

        {!narrow && (
          <div style={{ flex: 1, borderLeft: '1px solid var(--color-border)', padding: 12, overflow: 'auto', background: '#fff' }}>
            {rightDetail}
          </div>
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', height: '38%', minHeight: 220, background: '#fff' }}>
        <div className="row wrap" style={{ padding: '6px 10px', gap: 6, borderBottom: '1px solid var(--color-border)' }}>
          <div className="row" style={{ gap: 2 }}>
            {(
              [
                ['all', '全部对白'],
                ['issues', 'AI 问题'],
                ['ignored', '已处理']
              ] as Array<[ViewKey, string]>
            ).map(([key, label]) => (
              <Button key={key} size="sm" kind={view === key ? 'primary' : 'default'} onClick={() => setView(key)}>
                {label}
              </Button>
            ))}
          </div>
          <div style={{ width: 120 }}>
            <TextInput placeholder="搜索…" value={keyword} onChange={(e) => setKeyword(e.target.value)} style={{ height: 26 }} />
          </div>
          <div style={{ width: 110 }}>
            <Select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value as typeof severityFilter)}
              options={[
                { value: 'all', label: '全部严重度' },
                { value: 'blocker', label: '仅阻断' },
                { value: 'major', label: '重要以上' }
              ]}
            />
          </div>
          <div style={{ width: 110 }}>
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'open', label: '未处理' },
                { value: 'fixed', label: '已修复' },
                { value: 'ignored', label: '已忽略' },
                { value: 'false_positive', label: '误报' }
              ]}
            />
          </div>
          <span className="spacer" />
          <span className="muted" style={{ fontSize: 11.5 }}>
            共 {filteredEvents.length} 行 · 未处理 {counts.blocker + counts.major + counts.minor} · 已完成 {counts.handled}
          </span>
          <Button
            size="sm"
            kind="primary"
            disabled={busy || ep.state === 'AI_REVIEWING'}
            title={dshMode === 'paste' ? '当前为粘贴 JSON 模式：请用左下角「复制 Prompt」→ DSH 审阅 →「粘贴结果」' : undefined}
            onClick={() => {
              if (dshMode === 'paste') {
                toast.info('当前为「粘贴 JSON」模式：请先复制 Prompt，审阅后粘贴结果')
                void preparePrompt()
                return
              }
              void runReview()
            }}
          >
            {detail.run ? '重新审阅' : 'AI 审阅'}
          </Button>
          {narrow && <Button size="sm" onClick={() => setDrawerOpen(true)}>详情</Button>}
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {view === 'all' ? (
            <VirtualTable
              rows={filteredEvents}
              columns={eventColumns}
              rowKey={(row) => String(row.index)}
              selectedKey={currentEvent ? String(currentEvent.index) : null}
              onRowClick={(row) => selectEvent(row.index)}
            />
          ) : (
            <VirtualTable
              rows={filteredIssues}
              columns={issueColumns}
              rowKey={(row) => row.id}
              selectedKey={issue?.id ?? null}
              onRowClick={(row) => {
                setSelectedIssue(row.id)
                if (row.line !== null) selectEvent(row.line)
                else if (row.startMs !== null) seek(row.startMs)
              }}
            />
          )}
        </div>
      </div>

      {narrow && drawerOpen && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setDrawerOpen(false)}>
          <div className="drawer" style={{ width: 420, position: 'relative' }}>
            <div className="card-header">
              <span>当前句 / 问题详情</span>
              <span className="spacer" />
              <Button size="sm" kind="ghost" onClick={() => setDrawerOpen(false)}>✕</Button>
            </div>
            <div style={{ padding: 12, overflow: 'auto', flex: 1 }}>{rightDetail}</div>
          </div>
        </div>
      )}

      <ReasonDialog
        open={reasonTarget !== null}
        title={reasonTarget?.status === 'ignored' ? '忽略该问题' : '标记为误报'}
        label="请填写理由（必填，将写入审计日志）"
        minLength={2}
        onCancel={() => setReasonTarget(null)}
        onSubmit={(text) => {
          if (!reasonTarget) return
          void setStatus(reasonTarget.issueId, reasonTarget.status, text)
          setReasonTarget(null)
        }}
      />

      <ReasonDialog
        open={pasteOpen}
        title="粘贴 DSH 返回的 JSON"
        label="把 AI 审阅结果（JSON）粘贴到下面"
        minLength={2}
        okText="导入"
        onCancel={() => setPasteOpen(false)}
        onSubmit={(text) => {
          setPasteText(text)
          void submitPaste(text)
        }}
      />

      <ReasonDialog
        open={rejectOpen}
        title="人工审阅打回"
        label="打回原因（至少 10 个字）"
        minLength={10}
        okText="打回并重审"
        onCancel={() => setRejectOpen(false)}
        onSubmit={(text) => {
          void invoke('human:reject', { rootPath, localNo: ep.localNo, reason: text, needReReview: true })
            .then(() => {
              toast.success('已打回')
              onRefresh()
            })
            .catch((e) => toast.error(errorText(e)))
          setRejectOpen(false)
        }}
      />
      <ReasonDialog
        open={forceOpen}
        title="强制通过 AI 审阅"
        label="请填写豁免理由（必填，将写入审计日志）"
        minLength={4}
        okText="确认强制通过"
        onCancel={() => setForceOpen(false)}
        onSubmit={(text) => {
          setForceOpen(false)
          setBusy(true)
          void invoke('review:force-pass', { rootPath, localNo: ep.localNo, note: text })
            .then(() => {
              toast.success('已强制通过（已留痕）')
              onRefresh()
            })
            .catch((e) => toast.error(errorText(e)))
            .finally(() => setBusy(false))
        }}
      />

      <div style={{ display: 'none' }}>{pasteText}</div>
    </div>
  )
}
