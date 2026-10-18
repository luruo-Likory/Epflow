import { useCallback, useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import type { DetectedProjectDto } from '@shared/api'
import { invoke, errorText } from '../lib/api'
import { Badge, Button, Field, Modal, TextInput, useToast } from './ui'

/** 导入存量工程：只读取识别信息，不改名、不移动、不删除任何文件 */
export function ImportProjectModal({
  open,
  onClose,
  onImported
}: {
  open: boolean
  onClose: () => void
  onImported: (rootPath: string) => void
}): React.ReactElement | null {
  const toast = useToast()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [materialRoot, setMaterialRoot] = useState('')
  const [items, setItems] = useState<DetectedProjectDto[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<DetectedProjectDto | null>(null)
  const [releaseBase, setReleaseBase] = useState('1')

  useEffect(() => {
    if (!open) return
    void invoke('settings:get')
      .then((s) => {
        setSettings(s)
        setMaterialRoot(s.materialRoot)
      })
      .catch((err) => toast.error(errorText(err)))
  }, [open, toast])

  const scan = useCallback(
    async (root: string) => {
      if (!root.trim()) return
      setBusy(true)
      try {
        const rows = await invoke('project:scan', { materialRoot: root.trim() })
        setItems(rows)
        if (rows.length === 0) toast.warn('该目录下没有识别到可导入的工程')
      } catch (err) {
        toast.error(errorText(err))
      } finally {
        setBusy(false)
      }
    },
    [toast]
  )

  useEffect(() => {
    if (open && materialRoot) void scan(materialRoot)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, settings])

  const doImport = async () => {
    if (!selected || !settings) return
    setBusy(true)
    try {
      const base = Number(releaseBase) || selected.guessedReleaseBase || 1
      const snapshot = await invoke('project:create', {
        input: {
          animeName: selected.animeName,
          materialRoot,
          releaseNameTemplate: '[{release}]',
          releaseEpisodeBase: base,
          releaseEpisodeWidth: Math.max(2, selected.guessedReleaseWidth || 2),
          episodeCount: Math.max(1, selected.episodeDirs.length),
          localStart: 1,
          workNameTemplate: '{anime} - {ep}',
          subDirName: settings.subDirName,
          outputMode: 'episode-output'
        },
        conflict: 'reuse'
      })
      toast.success(`已导入「${selected.animeName}」`)
      onImported(snapshot.project.rootPath)
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <Modal
      open
      wide
      title="导入现有工程"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button kind="primary" disabled={busy || !selected} onClick={() => void doImport()}>
            导入并打开
          </Button>
        </>
      }
    >
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        扫描素材根目录下已有的集目录与模板文件，只读取识别结果用于建立状态库；不会改名、移动或删除任何文件。
      </div>
      <div className="row" style={{ marginBottom: 10 }}>
        <TextInput value={materialRoot} onChange={(e) => setMaterialRoot(e.target.value)} placeholder="素材根目录" />
        <Button onClick={() => void scan(materialRoot)} disabled={busy}>
          扫描
        </Button>
        <Button
          onClick={() =>
            void invoke('dialog:pick-dir', { title: '选择素材根目录' })
              .then((dir) => {
                if (dir) {
                  setMaterialRoot(dir)
                  void scan(dir)
                }
              })
              .catch((e) => toast.error(errorText(e)))
          }
        >
          选择…
        </Button>
      </div>

      {items === null ? (
        <div className="muted">正在扫描…</div>
      ) : items.length === 0 ? (
        <div className="muted">没有识别到可导入的工程。</div>
      ) : (
        <div className="table-wrap" style={{ maxHeight: 340 }}>
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 44 }} />
                <th>番名</th>
                <th style={{ width: 90 }}>集目录</th>
                <th style={{ width: 110 }}>发布基准（猜测）</th>
                <th style={{ width: 100 }}>状态库</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.rootPath}
                  className={selected?.rootPath === item.rootPath ? 'selected clickable' : 'clickable'}
                  onClick={() => {
                    setSelected(item)
                    setReleaseBase(String(item.guessedReleaseBase ?? 1))
                  }}
                >
                  <td>
                    <input type="radio" checked={selected?.rootPath === item.rootPath} readOnly />
                  </td>
                  <td>
                    <div>{item.animeName}</div>
                    <div className="mono muted" style={{ fontSize: 11 }}>{item.rootPath}</div>
                  </td>
                  <td>{item.episodeDirs.length}</td>
                  <td>{item.guessedReleaseBase ?? '—'}</td>
                  <td>
                    <Badge tone={item.hasState ? 'green' : 'gray'} dot={false}>
                      {item.hasState ? '已存在' : '新建'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <div style={{ marginTop: 12 }}>
          <Field label="基准发布集数" hint="导入后可在「集号对照表」逐集修正">
            <TextInput
              value={releaseBase}
              onChange={(e) => setReleaseBase(e.target.value)}
              style={{ width: 120 }}
            />
          </Field>
          {selected.sampleFiles.length > 0 && (
            <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
              识别到的文件：<span className="mono">{selected.sampleFiles.slice(0, 6).join('、')}</span>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
