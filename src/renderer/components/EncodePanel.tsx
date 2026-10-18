import { useEffect, useMemo, useState } from 'react'
import type { EpisodeDetailDto, ProgressEventDto } from '@shared/api'
import type { ProjectSnapshot } from '@shared/types'
import type { OutputCandidateDto } from '@shared/api'
import { formatClock, formatTimecode } from '@shared/time'
import { invoke, errorText, subscribe } from '../lib/api'
import { Badge, Button, Card, Field, Modal, useToast } from '../components/ui'
import { TemplatePanel } from '../components/TemplatePanel'

function humanSize(bytes: number | null | undefined): string {
  if (!bytes) return '—'
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

export function EncodePanel({
  rootPath,
  detail,
  snapshot,
  onRefresh
}: {
  rootPath: string
  detail: EpisodeDetailDto
  snapshot: ProjectSnapshot
  onRefresh: () => void
}): React.ReactElement {
  const toast = useToast()
  const ep = detail.episode
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ProgressEventDto | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [templateOpen, setTemplateOpen] = useState(false)
  const [candidates, setCandidates] = useState<OutputCandidateDto[] | null>(null)
  const [transcodeOpen, setTranscodeOpen] = useState(false)
  const [naming, setNaming] = useState<{ name: string; dir: string; conflict: boolean } | null>(null)

  useEffect(() => {
    const off = subscribe('encode:progress', (payload) => {
      const data = payload as ProgressEventDto
      if (data.localNo !== ep.localNo) return
      setProgress(data)
      setLogs((prev) => [...prev.slice(-80), `${new Date().toLocaleTimeString()} ${data.message}`])
    })
    return off
  }, [ep.localNo])

  useEffect(() => {
    void invoke('naming:preview', { rootPath, localNo: ep.localNo })
      .then(setNaming)
      .catch(() => setNaming(null))
  }, [rootPath, ep.localNo, ep.state])

  const gates = detail.gates
  const encodeGate = gates.encode
  const mergeGate = gates.merge

  const run = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try {
      await fn()
      toast.success(success)
      onRefresh()
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const startEncode = () =>
    run(() => invoke('encode:start', { rootPath, localNo: ep.localNo }), '已启动 OKEGui，等待成品…')

  const cancelEncode = () => run(() => invoke('encode:cancel', { rootPath, localNo: ep.localNo }), '已取消等待')

  const rescan = async () => {
    setBusy(true)
    try {
      const list = await invoke('encode:rescan', { rootPath, localNo: ep.localNo })
      setCandidates(list)
      if (list.length === 0) toast.warn('没有扫描到符合条件的成品')
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const pickManual = async () => {
    try {
      const files = await invoke('dialog:pick-files', {
        title: '手动指定成品 MKV',
        filters: [{ name: 'Matroska', extensions: ['mkv'] }]
      })
      if (files.length === 0) return
      await run(
        () => invoke('encode:accept', { rootPath, localNo: ep.localNo, path: files[0]! }),
        '已登记成品'
      )
    } catch (err) {
      toast.error(errorText(err))
    }
  }

  const merge = () =>
    run(() => invoke('merge:run', { rootPath, localNo: ep.localNo }), '章节已合并')

  const transcode = (mode: 'mp4' | 'keep') => {
    setTranscodeOpen(false)
    void run(
      () => invoke('transcode:run', { rootPath, localNo: ep.localNo, mode }),
      mode === 'mp4' ? '已生成 MP4' : '保留 MKV'
    )
  }

  const rename = () =>
    run(() => invoke('naming:run', { rootPath, localNo: ep.localNo }), '已按发布名重命名')

  const done = () => run(() => invoke('episode:done', { rootPath, localNo: ep.localNo }), '该集已完成')

  const probe = ep.encode?.probe
  const blockers = encodeGate?.blockers ?? []
  const gateOk = encodeGate?.ok ?? false

  const mergeBlocks = useMemo(() => mergeGate?.blockers ?? [], [mergeGate])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) minmax(280px, 1fr)', gap: 12 }}>
        <Card title="压制前置门禁" extra={<Badge tone={gateOk ? 'green' : 'orange'}>{gateOk ? '全部满足' : `${blockers.length} 项未满足`}</Badge>}>
          {gateOk ? (
            <div style={{ fontSize: 12.5, color: 'var(--color-success)' }}>模板、AI 审阅、人工审阅、章节锁定与哈希校验均通过。</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
              {blockers.map((b) => (
                <li key={b.code} style={{ marginBottom: 4 }}>
                  <span style={{ color: 'var(--color-danger)' }}>{b.label}</span>
                  {b.hint && <span className="muted">（{b.hint}）</span>}
                </li>
              ))}
            </ul>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <Button size="sm" onClick={() => setTemplateOpen(true)}>模板与实例化</Button>
            <Button size="sm" onClick={() => void invoke('naming:preview', { rootPath, localNo: ep.localNo }).then(setNaming).catch(() => undefined)}>
              刷新命名预览
            </Button>
          </div>
        </Card>

        <Card
          title="压制"
          extra={
            <Badge tone={ep.state === 'ENCODING' ? 'blue' : ep.state === 'ENCODE_FAILED' ? 'red' : 'gray'} pulse={ep.state === 'ENCODING'}>
              {ep.state === 'ENCODING' ? '压制中' : ep.state === 'ENCODE_FAILED' ? '失败' : '未开始'}
            </Badge>
          }
        >
          <div className="row wrap" style={{ marginBottom: 10 }}>
            <Button size="sm" kind="primary" disabled={busy || !gateOk || ep.state === 'ENCODING'} onClick={() => void startEncode()}>
              压制本集
            </Button>
            <Button size="sm" disabled={busy || ep.state !== 'ENCODING'} onClick={() => void cancelEncode()}>取消等待</Button>
            <Button size="sm" disabled={busy} onClick={() => void rescan()}>重新扫描成品</Button>
            <Button size="sm" disabled={busy} onClick={() => void pickManual()}>手动指定</Button>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            点击后会在集目录（{ep.dir}）启动 OKEGui，请手动选择 <span className="mono">{ep.workName}.json</span>；软件会自动监视
            <span className="mono"> output\XXXXXXXX-XX\</span> 并识别成品。
          </div>
          {progress && <div style={{ marginTop: 8, fontSize: 12.5 }}>{progress.message}</div>}
          {logs.length > 0 && (
            <div className="mono" style={{ marginTop: 8, maxHeight: 90, overflow: 'auto', fontSize: 11, background: '#f8fafc', padding: 6, borderRadius: 6 }}>
              {logs.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="成品"
        extra={
          <Badge tone={ep.encode?.outputPath ? 'green' : 'gray'} dot={false}>
            {ep.encode?.outputPath ? '已识别' : '等待识别'}
          </Badge>
        }
      >
        {ep.encode?.outputPath ? (
          <>
            <div className="mono" style={{ fontSize: 12, marginBottom: 6, wordBreak: 'break-all' }}>{ep.encode.outputPath}</div>
            <div className="row wrap" style={{ fontSize: 12.5, gap: 16, marginBottom: 8 }}>
              <span>大小 {humanSize(ep.encode.outputSize)}</span>
              {probe?.durationMs && <span>时长 {formatClock(probe.durationMs)}</span>}
              {probe?.width && <span>{probe.width}×{probe.height}</span>}
              {probe?.videoCodec && <span>视频 {probe.videoCodec}</span>}
              {probe && <span>音轨 {probe.audioTracks} / 字幕轨 {probe.subtitleTracks}</span>}
              {probe?.chapterCount !== null && probe?.chapterCount !== undefined && <span>章节 {probe.chapterCount}</span>}
            </div>
            <div className="row wrap">
              <Button size="sm" onClick={() => void invoke('app:open-path', { path: ep.encode!.outputPath!, reveal: true })}>
                在文件夹中显示
              </Button>
              <Button size="sm" kind="primary" disabled={busy || mergeBlocks.length > 0 || Boolean(ep.merge)} onClick={() => void merge()}>
                {ep.merge ? '章节已合并' : '合并章节'}
              </Button>
            </div>
            {mergeBlocks.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-warning)' }}>
                合并被阻断：{mergeBlocks.map((b) => b.label).join('；')}
              </div>
            )}
            {ep.merge && (
              <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                合并工具 {ep.merge.tool} · 章节 {ep.merge.chapterCount} · 首章 {formatTimecode(ep.merge.firstChapterStartMs)} ·
                {' '}{ep.merge.at.slice(0, 19).replace('T', ' ')}
              </div>
            )}
          </>
        ) : (
          <div className="muted" style={{ fontSize: 12.5 }}>
            尚未识别到成品。若 OKEGui 已完成压制，可点「重新扫描成品」或手动指定文件。
          </div>
        )}
        {candidates && candidates.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="panel-title" style={{ fontSize: 12.5, marginBottom: 6 }}>扫描到的候选成品</div>
            <div className="table-wrap" style={{ maxHeight: 160 }}>
              <table className="grid">
                <thead>
                  <tr>
                    <th>路径</th>
                    <th style={{ width: 90 }}>大小</th>
                    <th style={{ width: 80 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.path}>
                      <td className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>{c.path}</td>
                      <td>{humanSize(c.size)}</td>
                      <td>
                        <Button size="sm" onClick={() => void run(() => invoke('encode:accept', { rootPath, localNo: ep.localNo, path: c.path }), '已登记成品')}>
                          选用
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>

      <Card title="转码与命名">
        <div className="row wrap" style={{ marginBottom: 10 }}>
          <Button size="sm" disabled={busy || !ep.merge} onClick={() => setTranscodeOpen(true)}>
            选择转码方式
          </Button>
          <Badge tone={ep.transcode?.ok ? 'green' : 'gray'} dot={false}>
            {ep.transcode?.ok ? '已转 MP4' : '当前为 MKV'}
          </Badge>
          {ep.transcode?.ok && ep.transcode.to && (
            <Button size="sm" onClick={() => void invoke('app:open-path', { path: ep.transcode!.to, reveal: true })}>显示 MP4</Button>
          )}
        </div>
        {naming && (
          <div style={{ marginBottom: 10, fontSize: 12.5 }}>
            <div className="muted">最终文件名预览</div>
            <div className="mono" style={{ wordBreak: 'break-all' }}>{naming.name}</div>
            <div className="muted" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>{naming.dir}</div>
            {naming.conflict && <div style={{ color: 'var(--color-warning)', fontSize: 11.5 }}>目标已存在，将按命名冲突策略处理</div>}
          </div>
        )}
        <div className="row wrap">
          <Button size="sm" kind="primary" disabled={busy || !ep.merge || Boolean(ep.final)} onClick={() => void rename()}>
            {ep.final ? '已按发布名命名' : '按发布名重命名'}
          </Button>
          <Button size="sm" disabled={busy || ep.state !== 'NAMED'} onClick={() => void done()}>标记完成</Button>
          {ep.final && (
            <Button size="sm" onClick={() => void invoke('app:open-path', { path: ep.final!.path, reveal: true })}>显示最终文件</Button>
          )}
        </div>
        {ep.final && (
          <div className="muted" style={{ marginTop: 8, fontSize: 12, wordBreak: 'break-all' }}>
            {ep.final.path} · {humanSize(ep.final.size)} · {ep.final.at.slice(0, 19).replace('T', ' ')}
          </div>
        )}
      </Card>

      <Modal
        open={templateOpen}
        wide
        title="模板与实例化"
        onClose={() => setTemplateOpen(false)}
        footer={
          <Button
            onClick={() => {
              setTemplateOpen(false)
              onRefresh()
            }}
          >
            关闭
          </Button>
        }
      >
        <TemplatePanel rootPath={rootPath} episodes={snapshot.episodes} onChanged={onRefresh} />
      </Modal>

      <Modal
        open={transcodeOpen}
        title="是否将本集转为 MP4？"
        onClose={() => setTranscodeOpen(false)}
        footer={
          <>
            <Button onClick={() => setTranscodeOpen(false)}>取消</Button>
            <Button onClick={() => transcode('keep')}>保留 MKV</Button>
            <Button kind="primary" onClick={() => transcode('mp4')}>转为 MP4</Button>
          </>
        }
      >
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          <p style={{ marginTop: 0 }}>
            转 MP4 使用 <span className="mono">-c copy</span> 无损转封装，不重新编码；字幕默认转 <span className="mono">mov_text</span>，
            ASS 特效与字体附件会丢失。
          </p>
          <p className="muted" style={{ fontSize: 12 }}>
            必须由你显式选择，软件不会默认转码。
          </p>
        </div>
      </Modal>

      <div style={{ display: 'none' }}>
        <Field label="debug">{ep.localNo}</Field>
      </div>
    </div>
  )
}
