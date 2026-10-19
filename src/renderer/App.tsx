import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProjectSnapshot } from '@shared/types'
import { invoke, errorText } from './lib/api'
import { Button, ConfirmHost, ToastProvider, useConfirm, useToast } from './components/ui'
import ProjectList from './pages/ProjectList'
import Wizard from './pages/Wizard'
import ProjectHome from './pages/ProjectHome'
import Workbench from './pages/Workbench'
import SettingsPage from './pages/Settings'
import PublishPage from './pages/Publish'

export type Route =
  | { name: 'projects' }
  | { name: 'wizard' }
  | { name: 'project'; rootPath: string }
  | { name: 'workbench'; rootPath: string; localNo: string }
  | { name: 'settings' }
  | { name: 'publish'; rootPath?: string }

const NAV: Array<{ key: Route['name']; label: string; icon: string }> = [
  { key: 'projects', label: '项目', icon: '▤' },
  { key: 'settings', label: '设置', icon: '⚙' },
  { key: 'publish', label: '发布（v2）', icon: '⇪' }
]

function ShellInner(): React.ReactElement {
  const [route, setRoute] = useState<Route>({ name: 'projects' })
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null)
  const [version, setVersion] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const confirm = useConfirm()

  useEffect(() => {
    void invoke('app:info')
      .then((info) => setVersion(info.version))
      .catch(() => undefined)
  }, [])

  const openProject = useCallback(
    async (rootPath: string) => {
      setBusy(true)
      try {
        const snap = await invoke('project:open', { rootPath })
        setSnapshot(snap)
        setRoute({ name: 'project', rootPath })
        // 启动恢复：过渡态 + 哈希校验
        const recovered = await invoke('project:recover', { rootPath }).catch(() => null)
        if (recovered && (recovered.recovered.length > 0 || recovered.verified.length > 0)) {
          const parts: string[] = []
          if (recovered.recovered.length > 0) parts.push(`${recovered.recovered.length} 集从上次中断状态恢复`)
          if (recovered.verified.length > 0) parts.push(`${recovered.verified.length} 集字幕发生变化，需重新审阅`)
          toast.warn(parts.join('；'))
          const after = await invoke('project:open', { rootPath })
          setSnapshot(after)
        }
      } catch (err) {
        toast.error(errorText(err))
      } finally {
        setBusy(false)
      }
    },
    [toast]
  )

  const reloadProject = useCallback(async () => {
    if (!snapshot) return
    try {
      const snap = await invoke('project:open', { rootPath: snapshot.project.rootPath })
      setSnapshot(snap)
    } catch (err) {
      toast.error(errorText(err))
    }
  }, [snapshot, toast])

  const navActive = useMemo(() => {
    if (route.name === 'wizard') return 'projects'
    if (route.name === 'workbench' || route.name === 'project') return 'projects'
    return route.name
  }, [route])

  const breadcrumb = useMemo(() => {
    if (route.name === 'settings') return '设置'
    if (route.name === 'publish') return '发布（v2）'
    if (route.name === 'wizard') return '新建项目'
    if (!snapshot) return '项目'
    if (route.name === 'workbench') {
      const ep = snapshot.episodes.find((e) => e.localNo === route.localNo)
      return `${snapshot.project.animeName} / 第 ${ep?.releaseNo ?? route.localNo} 集`
    }
    return snapshot.project.animeName
  }, [route, snapshot])

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" style={{ cursor: 'pointer' }} onClick={() => setRoute({ name: 'projects' })}>
          <span className="logo">E</span>
          <span>EpFlow</span>
        </div>
        <div className="breadcrumb">
          <span className="crumb">主页</span>
          {breadcrumb !== '项目' && <span>/</span>}
          <span className="crumb current">{breadcrumb}</span>
        </div>
        <span className="spacer" />
        {busy && <span className="muted" style={{ fontSize: 12 }}>处理中…</span>}
        <span className="muted" style={{ fontSize: 12 }}>
          v{version || '1.0.0'}
        </span>
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <nav className="sidebar">
          {NAV.map((item) => (
            <button
              key={item.key}
              className={`nav-item${navActive === item.key ? ' active' : ''}`}
              onClick={() => {
                if (item.key === 'projects') setRoute({ name: 'projects' })
                else if (item.key === 'settings') setRoute({ name: 'settings' })
                else setRoute({ name: 'publish', rootPath: snapshot?.project.rootPath })
              }}
            >
              <span aria-hidden>{item.icon}</span>
              {item.label}
            </button>
          ))}
          <span className="spacer" />
          {snapshot && (
            <div style={{ padding: '6px 10px', fontSize: 11.5, color: 'var(--color-text-faint)', wordBreak: 'break-all' }}>
              当前项目
              <div style={{ color: 'var(--color-text-muted)' }}>{snapshot.project.animeName}</div>
            </div>
          )}
        </nav>

        <div className="main-area">
          <div className="content" style={{ padding: route.name === 'workbench' ? 0 : 14 }}>
            {route.name === 'projects' && (
              <ProjectList
                onOpen={(rootPath) => void openProject(rootPath)}
                onNew={() => setRoute({ name: 'wizard' })}
              />
            )}
            {route.name === 'wizard' && (
              <Wizard
                onCreated={(rootPath) => void openProject(rootPath)}
                onCancel={() => setRoute({ name: 'projects' })}
              />
            )}
            {route.name === 'project' && snapshot && (
              <ProjectHome
                snapshot={snapshot}
                onReload={() => void reloadProject()}
                onOpenEpisode={(localNo) => setRoute({ name: 'workbench', rootPath: snapshot.project.rootPath, localNo })}
                onBack={() => setRoute({ name: 'projects' })}
                onEditProject={() => setRoute({ name: 'settings' })}
              />
            )}
            {route.name === 'workbench' && snapshot && (
              <Workbench
                snapshot={snapshot}
                localNo={route.localNo}
                onChange={async () => {
                  await reloadProject()
                }}
                onBack={() => setRoute({ name: 'project', rootPath: snapshot.project.rootPath })}
              />
            )}
            {route.name === 'settings' && <SettingsPage onBack={() => setRoute({ name: 'projects' })} />}
            {route.name === 'publish' && <PublishPage />}
          </div>
          <footer className="statusbar">
            <span>EpFlow v{version || '1.0.1'}</span>
            {snapshot && (
              <>
                <span>·</span>
                <span>{snapshot.episodes.length} 集</span>
                <span>·</span>
                <span className="mono" style={{ fontSize: 11 }}>
                  {snapshot.project.rootPath}
                </span>
              </>
            )}
            <span className="spacer" />
            <span className="muted">单机本地模式</span>
            <Button
              size="sm"
              kind="ghost"
              onClick={() => {
                if (snapshot) void navigator.clipboard.writeText(snapshot.project.rootPath)
              }}
            >
              复制路径
            </Button>
          </footer>
        </div>
      </div>
      <ConfirmHost confirm={confirm} />
    </div>
  )
}

export default function App(): React.ReactElement {
  return (
    <ToastProvider>
      <ShellInner />
    </ToastProvider>
  )
}
