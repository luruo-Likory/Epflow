import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { ToolProbeDto } from '@shared/api'
import type { AppSettings, ToolPaths } from '@shared/types'
import { validateSubDirName } from '@shared/filename'
import { errorText, invoke } from '../lib/api'
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmHost,
  EmptyState,
  Field,
  Select,
  Tabs,
  TextInput,
  useConfirm,
  useToast
} from '../components/ui'

/* ------------------------------------------------------------------ */
/* 常量与工具函数                                                       */
/* ------------------------------------------------------------------ */

const MINUTE = 60_000

const TOOL_KEYS: Array<keyof ToolPaths> = [
  'okegui',
  'ffmpeg',
  'ffprobe',
  'mkvpropedit',
  'mkvmerge',
  'aegisub',
  'mpv',
  'python',
  'dsh'
]

const TOOL_LABELS: Record<keyof ToolPaths, string> = {
  okegui: 'OKEGui（压制）',
  ffmpeg: 'ffmpeg（转码）',
  ffprobe: 'ffprobe（媒体信息/校验）',
  mkvpropedit: 'mkvpropedit（写章节）',
  mkvmerge: 'mkvmerge（章节合并回退）',
  aegisub: 'Aegisub（人工审阅）',
  mpv: 'mpv（预览播放）',
  python: 'Python（vpy 语法校验）',
  dsh: 'DSH（AI 审阅）'
}

const SOURCE_LABEL: Record<ToolProbeDto['source'], string> = {
  setting: '用户设置',
  candidate: '内置候选',
  path: 'PATH 环境变量',
  none: '未找到'
}

type DshMode = AppSettings['dsh']['mode']

const DSH_MODE_ITEMS: Array<{ key: DshMode; label: string; title: string }> = [
  { key: 'paste', label: '粘贴 JSON', title: '生成本地 prompt，用户在 DSH 中执行后把 JSON 粘回' },
  { key: 'http', label: 'HTTP 接口', title: '调用 OpenAI 兼容的 /chat/completions 接口' },
  { key: 'cli', label: '命令行', title: '直接调用本机 dsh 命令行' }
]

const DSH_MODE_HINT: Record<DshMode, string> = {
  paste: '默认模式：只生成本地 prompt 文件，不联网；由用户把 prompt 粘贴到 DSH，再把返回 JSON 粘回 EpFlow。',
  http: '调用 OpenAI 兼容接口（如 DeepSeek / 本地网关），需要配置接口地址与 API Key 所在的环境变量。',
  cli: '调用本机安装的 dsh 命令行，适合已在本机登录 DSH 的环境。'
}

const SECTIONS: Array<{ id: string; label: string }> = [
  { id: 'settings-general', label: '通用' },
  { id: 'settings-tools', label: '外部工具' },
  { id: 'settings-dsh', label: 'AI 审阅（DSH）' },
  { id: 'settings-review', label: '审阅范围' },
  { id: 'settings-chapter', label: '章节参数' },
  { id: 'settings-naming', label: '命名与输出' },
  { id: 'settings-mp4', label: 'MP4' },
  { id: 'settings-encode', label: '压制' },
  { id: 'settings-publish', label: '发布（v2）' }
]

function isToolKey(key: string): key is keyof ToolPaths {
  return (TOOL_KEYS as string[]).includes(key)
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/)[0] ?? ''
  return line.length > 48 ? `${line.slice(0, 47)}…` : line
}

function scrollToSection(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function splitKeywords(text: string): string[] {
  return text
    .split(/[,，、;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function cloneSettings(source: AppSettings): AppSettings {
  return {
    ...source,
    tools: { ...source.tools },
    dsh: { ...source.dsh },
    review: {
      effectStyleKeywords: [...source.review.effectStyleKeywords],
      screenStyleKeywords: [...source.review.screenStyleKeywords],
      excludeComments: source.review.excludeComments
    },
    chapter: { ...source.chapter },
    naming: { ...source.naming },
    mp4: { ...source.mp4 },
    encode: { ...source.encode },
    publish: { ...source.publish, trackers: [...source.publish.trackers] }
  }
}

function sameSettings(a: AppSettings, b: AppSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 只提交真正发生变化的字段（分组整体下发，主进程会深合并）。 */
function diffPatch(base: AppSettings, next: AppSettings): Partial<AppSettings> {
  const patch: Partial<AppSettings> = {}
  if (base.operator !== next.operator) patch.operator = next.operator
  if (base.materialRoot !== next.materialRoot) patch.materialRoot = next.materialRoot
  if (base.subDirName !== next.subDirName) patch.subDirName = next.subDirName
  if (base.allowForcePass !== next.allowForcePass) patch.allowForcePass = next.allowForcePass
  if (base.theme !== next.theme) patch.theme = next.theme
  if (JSON.stringify(base.tools) !== JSON.stringify(next.tools)) patch.tools = next.tools
  if (JSON.stringify(base.dsh) !== JSON.stringify(next.dsh)) patch.dsh = next.dsh
  if (JSON.stringify(base.review) !== JSON.stringify(next.review)) patch.review = next.review
  if (JSON.stringify(base.chapter) !== JSON.stringify(next.chapter)) patch.chapter = next.chapter
  if (JSON.stringify(base.naming) !== JSON.stringify(next.naming)) patch.naming = next.naming
  if (JSON.stringify(base.mp4) !== JSON.stringify(next.mp4)) patch.mp4 = next.mp4
  if (JSON.stringify(base.encode) !== JSON.stringify(next.encode)) patch.encode = next.encode
  if (JSON.stringify(base.publish) !== JSON.stringify(next.publish)) patch.publish = next.publish
  return patch
}

/* ------------------------------------------------------------------ */
/* 局部组件                                                             */
/* ------------------------------------------------------------------ */

function Grid({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(258px, 1fr))', gap: 12 }}>
      {children}
    </div>
  )
}

/** 数字输入：保留用户正在输入的原始文本，失焦后按数值规范化。 */
function NumberField({
  value,
  onValue,
  step = 1,
  min,
  max,
  suffix,
  disabled
}: {
  value: number
  onValue: (value: number) => void
  step?: number | 'any'
  min?: number
  max?: number
  suffix?: string
  disabled?: boolean
}): React.ReactElement {
  const [text, setText] = useState(String(value))
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused) setText(String(value))
  }, [value, focused])

  return (
    <div className="row" style={{ gap: 6 }}>
      <TextInput
        type="number"
        inputMode="decimal"
        value={text}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        style={{ flex: 1, minWidth: 0 }}
        onFocus={() => setFocused(true)}
        onChange={(event) => {
          setText(event.target.value)
          const parsed = Number(event.target.value)
          if (event.target.value.trim() !== '' && Number.isFinite(parsed)) onValue(parsed)
        }}
        onBlur={() => setFocused(false)}
      />
      {suffix && (
        <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {suffix}
        </span>
      )}
    </div>
  )
}

/** 以「分钟」展示、以毫秒保存的时长输入。 */
function DurationField({
  valueMs,
  onValueMs,
  suffix = '分钟',
  min = 0
}: {
  valueMs: number
  onValueMs: (ms: number) => void
  suffix?: string
  min?: number
}): React.ReactElement {
  const minutes = Math.round((valueMs / MINUTE) * 100) / 100
  return (
    <NumberField
      value={minutes}
      step="any"
      min={min}
      suffix={suffix}
      onValue={(next) => onValueMs(Math.round(next * MINUTE))}
    />
  )
}

function ToolProbeStatus({
  probe,
  dirty
}: {
  probe: ToolProbeDto | undefined
  dirty: boolean
}): React.ReactElement {
  if (!probe) {
    return (
      <span className="muted" style={{ fontSize: 12 }}>
        未探测
      </span>
    )
  }

  if (dirty) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Badge tone="orange" dot={false}>
          待保存
        </Badge>
        <span className="muted" style={{ fontSize: 11 }}>
          {probe.exists ? `保存前仍为：${SOURCE_LABEL[probe.source]}` : '保存后重新探测'}
        </span>
        {probe.version && (
          <span
            className="mono"
            style={{ fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={probe.version}
          >
            {firstLine(probe.version)}
          </span>
        )}
      </div>
    )
  }

  if (!probe.exists) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ color: 'var(--color-danger)', fontSize: 12, fontWeight: 500 }}>
          未找到{probe.required ? '（必需）' : ''}
        </span>
        <span className="muted" style={{ fontSize: 11 }}>
          {probe.required ? '请手动选择可执行文件' : '该工具为可选项'}
        </span>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div className="row" style={{ gap: 6 }}>
        <Badge tone="green" dot={false}>
          已找到
        </Badge>
        {probe.required && (
          <span className="muted" style={{ fontSize: 11 }}>
            必需
          </span>
        )}
      </div>
      <span className="muted" style={{ fontSize: 11 }}>
        来源：{SOURCE_LABEL[probe.source]}
      </span>
      {probe.version && (
        <span
          className="mono"
          style={{ fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={probe.version}
        >
          {firstLine(probe.version)}
        </span>
      )}
    </div>
  )
}

interface SettingsErrors {
  operator: string | null
  materialRoot: string | null
  subDirName: string | null
  dshModel: string | null
  dshTimeout: string | null
  dshRetries: string | null
  dshHttpUrl: string | null
  dshApiKeyEnv: string | null
  dshCommand: string | null
  dshArgs: string | null
  chapterGap: string | null
  chapterMinLen: string | null
  chapterMaxLen: string | null
  chapterLenOrder: string | null
  chapterMinCount: string | null
  chapterMaxCount: string | null
  chapterCountOrder: string | null
  chapterLanguage: string | null
  encodeMinSize: string | null
  encodeTimeout: string | null
  encodePoll: string | null
  namingOutputDir: string | null
}

function emptyErrors(): SettingsErrors {
  return {
    operator: null,
    materialRoot: null,
    subDirName: null,
    dshModel: null,
    dshTimeout: null,
    dshRetries: null,
    dshHttpUrl: null,
    dshApiKeyEnv: null,
    dshCommand: null,
    dshArgs: null,
    chapterGap: null,
    chapterMinLen: null,
    chapterMaxLen: null,
    chapterLenOrder: null,
    chapterMinCount: null,
    chapterMaxCount: null,
    chapterCountOrder: null,
    chapterLanguage: null,
    encodeMinSize: null,
    encodeTimeout: null,
    encodePoll: null,
    namingOutputDir: null
  }
}

/* ------------------------------------------------------------------ */
/* 页面                                                                 */
/* ------------------------------------------------------------------ */

export default function SettingsPage(props: { onBack: () => void }): React.ReactElement {
  const { onBack } = props
  const toast = useToast()
  const confirm = useConfirm()

  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [draft, setDraft] = useState<AppSettings | null>(null)
  const [probes, setProbes] = useState<ToolProbeDto[]>([])
  const [loading, setLoading] = useState(true)
  const [detecting, setDetecting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  const detect = useCallback(
    async (withVersion: boolean) => {
      setDetecting(true)
      try {
        const result = await invoke('settings:detect-tools', { withVersion })
        setProbes(result)
      } catch (err) {
        toast.error(errorText(err))
      } finally {
        setDetecting(false)
      }
    },
    [toast]
  )

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const loaded = await invoke('settings:get')
        if (!alive) return
        setSettings(loaded)
        setDraft(loaded)
        // 设置本身立即可编辑；工具版本探测在后台继续，不阻塞首屏
        setLoading(false)
      } catch (err) {
        if (!alive) return
        setError(errorText(err))
        toast.error(errorText(err))
        setLoading(false)
        return
      }
      try {
        const detected = await invoke('settings:detect-tools', { withVersion: true })
        if (alive) setProbes(detected)
      } catch (err) {
        // 探测失败不影响设置本身的编辑与保存
        if (alive) toast.error(errorText(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [toast, reloadToken])

  const mutate = useCallback((fn: (next: AppSettings) => void) => {
    setDraft((prev) => {
      if (!prev) return prev
      const next = cloneSettings(prev)
      fn(next)
      return next
    })
  }, [])

  const probeMap = useMemo(() => {
    const map: Partial<Record<keyof ToolPaths, ToolProbeDto>> = {}
    for (const probe of probes) {
      if (isToolKey(probe.key)) map[probe.key] = probe
    }
    return map
  }, [probes])

  const missingRequired = useMemo(
    () =>
      TOOL_KEYS.filter((key) => {
        const probe = probeMap[key]
        return Boolean(probe?.required) && !probe?.exists && !(draft?.tools[key] ?? '').trim()
      }),
    [probeMap, draft]
  )

  const dirty = useMemo(() => (settings && draft ? !sameSettings(settings, draft) : false), [settings, draft])

  const errors = useMemo<SettingsErrors>(() => {
    const result = emptyErrors()
    if (!draft) return result

    if (!draft.operator.trim()) result.operator = '请填写操作者名称，将写入审计日志'
    if (!draft.materialRoot.trim()) result.materialRoot = '请选择素材根目录'
    const subDirError = validateSubDirName(draft.subDirName)
    if (subDirError) result.subDirName = subDirError

    const dsh = draft.dsh
    if (!dsh.model.trim()) result.dshModel = '请填写模型名称'
    if (!Number.isFinite(dsh.timeoutMs) || dsh.timeoutMs <= 0) result.dshTimeout = '超时必须大于 0 分钟'
    if (!Number.isInteger(dsh.retries) || dsh.retries < 0 || dsh.retries > 20) {
      result.dshRetries = '重试次数需为 0–20 的整数'
    }
    if (dsh.mode === 'http') {
      if (!/^https?:\/\//i.test(dsh.httpUrl.trim())) {
        result.dshHttpUrl = '接口地址需以 http:// 或 https:// 开头'
      }
      if (!dsh.apiKeyEnv.trim()) result.dshApiKeyEnv = '请填写存放 API Key 的环境变量名'
    }
    if (dsh.mode === 'cli') {
      if (!dsh.command.trim()) result.dshCommand = '请填写 dsh 命令或可执行文件路径'
      if (!dsh.argsTemplate.trim()) result.dshArgs = '请填写参数模板'
    }

    const chapter = draft.chapter
    if (!Number.isFinite(chapter.gapThresholdMs) || chapter.gapThresholdMs < 0) {
      result.chapterGap = '章节间隔阈值不能为负数'
    }
    if (!Number.isFinite(chapter.minChapterLenMs) || chapter.minChapterLenMs <= 0) {
      result.chapterMinLen = '章节最短长度必须大于 0'
    }
    if (!Number.isFinite(chapter.maxChapterLenMs) || chapter.maxChapterLenMs <= 0) {
      result.chapterMaxLen = '章节最长长度必须大于 0'
    } else if (
      Number.isFinite(chapter.minChapterLenMs) &&
      chapter.minChapterLenMs > 0 &&
      chapter.minChapterLenMs >= chapter.maxChapterLenMs
    ) {
      result.chapterLenOrder = '章节最短长度必须小于最长长度'
    }
    if (!Number.isInteger(chapter.minChapters) || chapter.minChapters < 1) {
      result.chapterMinCount = '最少章节数至少为 1'
    }
    if (!Number.isInteger(chapter.maxChapters) || chapter.maxChapters < 1) {
      result.chapterMaxCount = '最多章节数至少为 1'
    } else if (Number.isInteger(chapter.minChapters) && chapter.minChapters > chapter.maxChapters) {
      result.chapterCountOrder = '最少章节数不能大于最多章节数'
    }
    if (!chapter.language.trim()) result.chapterLanguage = '请填写章节语言标签，如 und / zh-Hans'

    const encode = draft.encode
    if (!Number.isFinite(encode.minSizeMb) || encode.minSizeMb < 0) {
      result.encodeMinSize = '最小成品体积不能为负数'
    }
    if (!Number.isFinite(encode.timeoutMs) || encode.timeoutMs <= 0) {
      result.encodeTimeout = '压制超时必须大于 0 分钟'
    }
    if (!Number.isFinite(encode.pollIntervalMs) || encode.pollIntervalMs < 200) {
      result.encodePoll = '轮询间隔至少为 200 毫秒'
    }

    if (!draft.naming.outputDirName.trim()) result.namingOutputDir = '请填写输出目录名'

    return result
  }, [draft])

  const errorCount = useMemo(() => Object.values(errors).filter((value) => value !== null).length, [errors])
  const hasErrors = errorCount > 0

  const handleDetect = useCallback(() => {
    void detect(true)
  }, [detect])

  const handleApplyTools = useCallback(async () => {
    setDetecting(true)
    try {
      const applied = await invoke('settings:apply-tools')
      setSettings(applied)
      mutate((next) => {
        for (const key of TOOL_KEYS) {
          if (!next.tools[key].trim() && applied.tools[key]) next.tools[key] = applied.tools[key]
        }
      })
      await detect(true)
      toast.success('已自动探测并填充空白项')
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setDetecting(false)
    }
  }, [detect, mutate, toast])

  const handlePickTool = useCallback(
    async (key: keyof ToolPaths) => {
      try {
        const files = await invoke('dialog:pick-files', { title: '选择可执行文件' })
        const picked = files[0]
        if (picked) {
          mutate((next) => {
            next.tools[key] = picked
          })
        }
      } catch (err) {
        toast.error(errorText(err))
      }
    },
    [mutate, toast]
  )

  const handlePickMaterialRoot = useCallback(async () => {
    try {
      const dir = await invoke('dialog:pick-dir', {
        title: '选择素材根目录',
        defaultPath: draft?.materialRoot || undefined
      })
      if (dir) {
        mutate((next) => {
          next.materialRoot = dir
        })
      }
    } catch (err) {
      toast.error(errorText(err))
    }
  }, [draft?.materialRoot, mutate, toast])

  const handleSave = useCallback(async () => {
    if (!settings || !draft) return
    if (hasErrors) {
      toast.error('请先修正设置中的参数错误')
      return
    }
    const patch = diffPatch(settings, draft)
    if (Object.keys(patch).length === 0) {
      toast.info('没有需要保存的修改')
      return
    }
    setSaving(true)
    try {
      const saved = await invoke('settings:save', patch)
      setSettings(saved)
      setDraft(saved)
      toast.success('设置已保存')
      await detect(true)
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setSaving(false)
    }
  }, [settings, draft, hasErrors, detect, toast])

  const handleReset = useCallback(async () => {
    const ok = await confirm({
      title: '恢复默认设置',
      message: '将把全部设置恢复为默认值（包括工具路径、AI 审阅、章节、命名与压制参数）。此操作会立即写入 settings.json，且无法撤销。',
      okText: '恢复默认',
      danger: true
    })
    if (!ok) return
    setResetting(true)
    try {
      const reset = await invoke('settings:reset')
      setSettings(reset)
      setDraft(reset)
      toast.success('已恢复默认设置')
      await detect(true)
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setResetting(false)
    }
  }, [confirm, detect, toast])

  /* ---------------- 载入 / 失败 ---------------- */

  if (loading) {
    return (
      <Card title="设置">
        <div className="empty">
          <div className="title">正在载入设置…</div>
          <div className="muted" style={{ fontSize: 12 }}>
            读取 settings.json 并探测本机外部工具
          </div>
        </div>
      </Card>
    )
  }

  if (error || !settings || !draft) {
    return (
      <Card title="设置">
        <EmptyState
          title="无法载入设置"
          description={error ?? '设置数据为空'}
          action={
            <Button onClick={() => setReloadToken((token) => token + 1)} size="sm">
              重试
            </Button>
          }
        />
      </Card>
    )
  }

  const publishReadonly: Array<{ label: string; value: string }> = [
    { label: 'publish.enabled', value: 'false（v1 强制关闭）' },
    { label: 'publish.uploadEnabled', value: draft.publish.uploadEnabled ? 'true' : 'false（v1 强制关闭）' },
    { label: 'publish.policy', value: draft.publish.policy },
    { label: 'publish.provider', value: draft.publish.provider },
    { label: 'publish.torrentMaker', value: draft.publish.torrentMaker },
    { label: 'publish.seedClient', value: draft.publish.seedClient },
    { label: 'publish.trackers', value: draft.publish.trackers.length > 0 ? draft.publish.trackers.join(', ') : '（未配置）' },
    { label: 'publish.pieceSizeKb', value: String(draft.publish.pieceSizeKb) },
    { label: 'publish.autoStart', value: draft.publish.autoStart ? 'true' : 'false' },
    { label: 'publish.monitorIntervalMs', value: String(draft.publish.monitorIntervalMs) }
  ]

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 1080, margin: '0 auto', fontSize: 13 }}>
        {/* 顶部工具条 */}
        <Card
          title={
            <div className="row" style={{ gap: 10 }}>
              <span style={{ fontSize: 16 }}>设置</span>
              {dirty && (
                <Badge tone="orange" dot={false}>
                  有未保存修改
                </Badge>
              )}
            </div>
          }
          extra={
            <div className="row wrap">
              <Button size="sm" onClick={() => void handleReset()} disabled={saving || resetting}>
                恢复默认
              </Button>
              <Button size="sm" kind="primary" onClick={() => void handleSave()} disabled={saving || resetting || hasErrors}>
                保存设置
              </Button>
              <Button size="sm" onClick={onBack}>
                返回
              </Button>
            </div>
          }
        >
          <div className="row wrap" style={{ gap: 4 }}>
            {SECTIONS.map((section) => (
              <Button key={section.id} size="sm" kind="ghost" onClick={() => scrollToSection(section.id)}>
                {section.label}
              </Button>
            ))}
          </div>
          <div className="divider" />
          <div className="row wrap" style={{ gap: 12, fontSize: 12 }}>
            <span className="muted">
              设置保存在用户数据目录的 <span className="mono">settings.json</span>，仅在点击「保存设置」后写入。
            </span>
            <span className="spacer" />
            <span className="muted">
              当前操作者：<span className="mono">{settings.operator || '（未设置）'}</span>
            </span>
          </div>
        </Card>

        {/* 1. 通用 */}
        <div id="settings-general" style={{ scrollMarginTop: 8 }}>
          <Card title="通用">
            <Grid>
              <Field label="操作者名称" hint="写入每条审计记录的 actor 字段" error={errors.operator}>
                <TextInput
                  value={draft.operator}
                  placeholder="例如：字幕组-小明"
                  onChange={(event) =>
                    mutate((next) => {
                      next.operator = event.target.value
                    })
                  }
                />
              </Field>

              <Field
                label="素材根目录"
                hint="项目按 {素材根目录}\{番名} 组织，扫描与新建向导都以此为基准"
                error={errors.materialRoot}
              >
                <div className="row" style={{ gap: 6 }}>
                  <TextInput
                    value={draft.materialRoot}
                    placeholder="C:\EpFlow\materials"
                    onChange={(event) =>
                      mutate((next) => {
                        next.materialRoot = event.target.value
                      })
                    }
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <Button size="sm" onClick={() => void handlePickMaterialRoot()}>
                    选择目录
                  </Button>
                </div>
              </Field>

              <Field
                label="翻译用子目录名"
                hint="新建项目的默认值。留空 = 字幕与章节草稿直接放在集目录（强烈推荐）；填写如 [翻译用] 则额外建一层子目录。"
                error={errors.subDirName}
              >
                <TextInput
                  value={draft.subDirName}
                  placeholder="留空（推荐）"
                  onChange={(event) =>
                    mutate((next) => {
                      next.subDirName = event.target.value
                    })
                  }
                />
              </Field>

              <Field
                label="强制通过 AI 审阅"
                hint="默认关闭。开启后允许在 AI 审阅未通过时强制进入人工审阅，跳过 AI 门禁，存在放行错误字幕的风险；每次强制都会写入审计日志。"
              >
                <Checkbox
                  checked={draft.allowForcePass}
                  onChange={(checked) =>
                    mutate((next) => {
                      next.allowForcePass = checked
                    })
                  }
                  label={
                    <span>
                      允许强制通过 AI 审阅{' '}
                      <Badge tone="red" dot={false}>
                        默认关闭
                      </Badge>
                    </span>
                  }
                />
              </Field>
            </Grid>
          </Card>
        </div>

        {/* 2. 外部工具 */}
        <div id="settings-tools" style={{ scrollMarginTop: 8 }}>
          <Card
            title="外部工具"
            extra={
              <div className="row wrap" style={{ gap: 6 }}>
                {detecting && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    探测中…
                  </span>
                )}
                {missingRequired.length > 0 && (
                  <Badge tone="red" dot={false}>
                    {missingRequired.length} 项必需工具缺失
                  </Badge>
                )}
                <Button size="sm" onClick={handleDetect} disabled={detecting}>
                  重新探测
                </Button>
                <Button size="sm" kind="primary" onClick={() => void handleApplyTools()} disabled={detecting}>
                  自动探测并填充空白项
                </Button>
              </div>
            }
          >
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              留空的路径会按「用户设置 → 内置候选 → PATH」顺序自动查找；点击「自动探测并填充空白项」会把探测到的路径写入空白项，不会覆盖已填写内容。
            </div>
            <div className="table-wrap">
              <table className="grid" style={{ tableLayout: 'fixed' }}>
                <thead>
                  <tr>
                    <th style={{ width: 190 }}>工具</th>
                    <th>可执行文件路径</th>
                    <th style={{ width: 190 }}>探测状态</th>
                    <th style={{ width: 132 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {TOOL_KEYS.map((key) => {
                    const probe = probeMap[key]
                    const value = draft.tools[key]
                    const dirtyRow = value !== settings.tools[key]
                    const missing = Boolean(probe?.required) && !probe?.exists && !value.trim()
                    return (
                      <tr key={key}>
                        <td style={{ padding: '5px 8px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 13 }}>{probe?.label ?? TOOL_LABELS[key]}</span>
                            <span className="mono muted" style={{ fontSize: 11 }}>
                              {key}
                            </span>
                          </div>
                        </td>
                        <td style={{ padding: '5px 8px' }}>
                          <Field
                            hint={dirtyRow ? '已修改，保存后生效' : undefined}
                            error={missing ? '缺失：该工具为必需项' : null}
                          >
                            <TextInput
                              value={value}
                              placeholder="留空则使用自动探测结果"
                              style={{ fontSize: 12 }}
                              onChange={(event) =>
                                mutate((next) => {
                                  next.tools[key] = event.target.value
                                })
                              }
                            />
                          </Field>
                        </td>
                        <td style={{ padding: '5px 8px' }}>
                          <ToolProbeStatus probe={probe} dirty={dirtyRow} />
                        </td>
                        <td style={{ padding: '5px 8px' }}>
                          <div className="row" style={{ gap: 4 }}>
                            <Button size="sm" onClick={() => void handlePickTool(key)}>
                              选择…
                            </Button>
                            <Button
                              size="sm"
                              kind="ghost"
                              disabled={!value}
                              onClick={() =>
                                mutate((next) => {
                                  next.tools[key] = ''
                                })
                              }
                            >
                              清空
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        {/* 3. AI 审阅（DSH） */}
        <div id="settings-dsh" style={{ scrollMarginTop: 8 }}>
          <Card title="AI 审阅（DSH）">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Field label="调用模式" hint={DSH_MODE_HINT[draft.dsh.mode]}>
                <Tabs
                  items={DSH_MODE_ITEMS}
                  value={draft.dsh.mode}
                  onChange={(mode) =>
                    mutate((next) => {
                      next.dsh.mode = mode
                    })
                  }
                />
              </Field>

              <Grid>
                <Field label="模型" hint="例如 deepseek-chat；会写入审阅记录" error={errors.dshModel}>
                  <TextInput
                    value={draft.dsh.model}
                    onChange={(event) =>
                      mutate((next) => {
                        next.dsh.model = event.target.value
                      })
                    }
                  />
                </Field>

                <Field label="超时" hint="单次 AI 审阅的最长等待时间" error={errors.dshTimeout}>
                  <DurationField
                    valueMs={draft.dsh.timeoutMs}
                    onValueMs={(ms) =>
                      mutate((next) => {
                        next.dsh.timeoutMs = ms
                      })
                    }
                  />
                </Field>

                <Field label="重试次数" hint="失败后自动重试的次数（0–20）" error={errors.dshRetries}>
                  <NumberField
                    value={draft.dsh.retries}
                    min={0}
                    max={20}
                    step={1}
                    suffix="次"
                    onValue={(value) =>
                      mutate((next) => {
                        next.dsh.retries = Math.round(value)
                      })
                    }
                  />
                </Field>

                <Field
                  label="接口地址"
                  hint="仅 http 模式使用；填写 OpenAI 兼容的 /chat/completions 完整地址"
                  error={errors.dshHttpUrl}
                >
                  <TextInput
                    value={draft.dsh.httpUrl}
                    disabled={draft.dsh.mode !== 'http'}
                    placeholder="https://api.deepseek.com/chat/completions"
                    onChange={(event) =>
                      mutate((next) => {
                        next.dsh.httpUrl = event.target.value
                      })
                    }
                  />
                </Field>

                <Field
                  label="API Key 环境变量"
                  hint="密钥只从环境变量读取，不落盘；EpFlow 不会保存明文密钥"
                  error={errors.dshApiKeyEnv}
                >
                  <TextInput
                    value={draft.dsh.apiKeyEnv}
                    disabled={draft.dsh.mode !== 'http'}
                    placeholder="DEEPSEEK_API_KEY"
                    onChange={(event) =>
                      mutate((next) => {
                        next.dsh.apiKeyEnv = event.target.value
                      })
                    }
                  />
                </Field>
              </Grid>

              <Field
                label="发送字幕文本到外部 AI"
                hint="默认开启。开启后字幕正文会随审阅请求发送给外部 AI 服务；字幕可能包含未公开的剧情或译者信息，请确认符合授权与保密要求。关闭后仅使用本地预检结果，不发送字幕正文。"
              >
                <Checkbox
                  checked={draft.dsh.allowSubtitleUpload}
                  onChange={(checked) =>
                    mutate((next) => {
                      next.dsh.allowSubtitleUpload = checked
                    })
                  }
                  label={<span>允许把字幕文本发送给外部 AI 服务（默认开启）</span>}
                />
              </Field>

              {draft.dsh.mode === 'cli' && (
                <Grid>
                  <Field label="命令" hint="可执行文件名或绝对路径，例如 dsh" error={errors.dshCommand}>
                    <TextInput
                      value={draft.dsh.command}
                      placeholder="dsh"
                      onChange={(event) =>
                        mutate((next) => {
                          next.dsh.command = event.target.value
                        })
                      }
                    />
                  </Field>
                  <Field
                    label="参数模板"
                    hint="可用占位符：{promptFile}（本次 prompt 文件路径）、{model}"
                    error={errors.dshArgs}
                  >
                    <TextInput
                      className="input mono"
                      value={draft.dsh.argsTemplate}
                      placeholder='exec --prompt-file "{promptFile}" --model {model} --output-format json'
                      onChange={(event) =>
                        mutate((next) => {
                          next.dsh.argsTemplate = event.target.value
                        })
                      }
                    />
                  </Field>
                </Grid>
              )}
            </div>
          </Card>
        </div>

        {/* 3b. 审阅范围 */}
        <div id="settings-review" style={{ scrollMarginTop: 8 }}>
          <Card title="审阅范围">
            <div style={{ fontSize: 12.5, color: 'var(--color-text-muted)', marginBottom: 10, lineHeight: 1.7 }}>
              AI 只审三类问题：<b>错别字</b>、<b>语言是否通顺</b>、<b>同一时间两句是否上下排列</b>。
              特效行（绘图、字体特效、卡拉OK、动画、定位程序等）不会被审阅，也不会出现在发送给 AI 的表格里。
            </div>
            <Grid>
              <Field
                label="特效样式关键字"
                hint="样式名包含任一关键字即视为特效行，不审阅；多个用逗号分隔"
              >
                <TextInput
                  value={draft.review.effectStyleKeywords.join(', ')}
                  placeholder="特效, Effect, Title, OP, ED, Kara"
                  onChange={(event) =>
                    mutate((next) => {
                      next.review.effectStyleKeywords = splitKeywords(event.target.value)
                    })
                  }
                />
              </Field>
              <Field
                label="屏幕字样式关键字"
                hint="命中这些样式的行按「屏幕字」处理（仍然审阅）；多个用逗号分隔"
              >
                <TextInput
                  value={draft.review.screenStyleKeywords.join(', ')}
                  placeholder="ScreenText, Sign, Caption, 屏字"
                  onChange={(event) =>
                    mutate((next) => {
                      next.review.screenStyleKeywords = splitKeywords(event.target.value)
                    })
                  }
                />
              </Field>
            </Grid>
            <Field label="注释行" hint="Comment 行默认不审阅（多数是标注/特效说明）">
              <Checkbox
                checked={draft.review.excludeComments}
                onChange={(checked) =>
                  mutate((next) => {
                    next.review.excludeComments = checked
                  })
                }
                label={<span>忽略 Comment 行</span>}
              />
            </Field>
          </Card>
        </div>

        {/* 4. 章节参数 */}
        <div id="settings-chapter" style={{ scrollMarginTop: 8 }}>
          <Card title="章节参数">
            <Grid>
              <Field label="章节间隔阈值" hint="相邻章节起点差小于该值时合并，默认 2000" error={errors.chapterGap}>
                <NumberField
                  value={draft.chapter.gapThresholdMs}
                  min={0}
                  step={100}
                  suffix="毫秒"
                  onValue={(value) =>
                    mutate((next) => {
                      next.chapter.gapThresholdMs = Math.round(value)
                    })
                  }
                />
              </Field>

              <Field
                label="章节最短长度"
                hint="过短的章节会被合并，默认 90000 毫秒（90 秒）"
                error={errors.chapterMinLen ?? errors.chapterLenOrder}
              >
                <NumberField
                  value={draft.chapter.minChapterLenMs}
                  min={0}
                  step={1000}
                  suffix="毫秒"
                  onValue={(value) =>
                    mutate((next) => {
                      next.chapter.minChapterLenMs = Math.round(value)
                    })
                  }
                />
              </Field>

              <Field
                label="章节最长长度"
                hint="超过该长度会尝试在静音处切分，默认 480000 毫秒（8 分钟）"
                error={errors.chapterMaxLen ?? errors.chapterLenOrder}
              >
                <NumberField
                  value={draft.chapter.maxChapterLenMs}
                  min={0}
                  step={1000}
                  suffix="毫秒"
                  onValue={(value) =>
                    mutate((next) => {
                      next.chapter.maxChapterLenMs = Math.round(value)
                    })
                  }
                />
              </Field>

              <Field label="最少章节数" hint="少于该数量视为生成异常" error={errors.chapterMinCount ?? errors.chapterCountOrder}>
                <NumberField
                  value={draft.chapter.minChapters}
                  min={1}
                  step={1}
                  suffix="个"
                  onValue={(value) =>
                    mutate((next) => {
                      next.chapter.minChapters = Math.round(value)
                    })
                  }
                />
              </Field>

              <Field label="最多章节数" hint="超过该数量的候选章节会被裁剪" error={errors.chapterMaxCount ?? errors.chapterCountOrder}>
                <NumberField
                  value={draft.chapter.maxChapters}
                  min={1}
                  step={1}
                  suffix="个"
                  onValue={(value) =>
                    mutate((next) => {
                      next.chapter.maxChapters = Math.round(value)
                    })
                  }
                />
              </Field>

              <Field label="章节语言标签" hint="BCP-47 标签，如 und / zh-Hans / jpn" error={errors.chapterLanguage}>
                <TextInput
                  value={draft.chapter.language}
                  placeholder="und"
                  onChange={(event) =>
                    mutate((next) => {
                      next.chapter.language = event.target.value
                    })
                  }
                />
              </Field>
            </Grid>

            <div className="divider" />

            <Grid>
              <Field hint="识别片头 / 片尾区间，并把自动生成的章节标记为 op / ed 来源">
                <Checkbox
                  checked={draft.chapter.detectOpEd}
                  onChange={(checked) =>
                    mutate((next) => {
                      next.chapter.detectOpEd = checked
                    })
                  }
                  label={<span>自动识别 OP / ED 并标记章节来源</span>}
                />
              </Field>
              <Field hint="首章不依赖静音检测，直接固定在 00:00:00">
                <Checkbox
                  checked={draft.chapter.firstChapterAtZero}
                  onChange={(checked) =>
                    mutate((next) => {
                      next.chapter.firstChapterAtZero = checked
                    })
                  }
                  label={<span>首章强制从 00:00:00 开始</span>}
                />
              </Field>
            </Grid>
          </Card>
        </div>

        {/* 5. 命名与输出 */}
        <div id="settings-naming" style={{ scrollMarginTop: 8 }}>
          <Card title="命名与输出">
            <Grid>
              <Field label="工作名集号来源" hint="决定 {ep} 使用发布集号还是本地集号">
                <Select
                  value={draft.naming.workNameEpSource}
                  options={[
                    { value: 'release', label: '发布集号（release）' },
                    { value: 'local', label: '本地集号（local）' }
                  ]}
                  onChange={(event) =>
                    mutate((next) => {
                      next.naming.workNameEpSource = event.target.value === 'local' ? 'local' : 'release'
                    })
                  }
                />
              </Field>

              <Field label="重命名冲突策略" hint="目标文件已存在时的处理方式">
                <Select
                  value={draft.naming.conflict}
                  options={[
                    { value: 'suffix', label: '自动加后缀（suffix）' },
                    { value: 'ask', label: '询问（ask）' },
                    { value: 'trash', label: '移到回收站（trash）' }
                  ]}
                  onChange={(event) =>
                    mutate((next) => {
                      const value = event.target.value
                      next.naming.conflict = value === 'ask' || value === 'trash' ? value : 'suffix'
                    })
                  }
                />
              </Field>

              <Field label="输出目录策略" hint="最终成品的落盘位置">
                <Select
                  value={draft.naming.outputMode}
                  options={[
                    { value: 'episode-output', label: '各集 output 子目录（episode-output）' },
                    { value: 'project-release', label: '项目级 release 目录（project-release）' }
                  ]}
                  onChange={(event) =>
                    mutate((next) => {
                      next.naming.outputMode = event.target.value === 'project-release' ? 'project-release' : 'episode-output'
                    })
                  }
                />
              </Field>

              <Field label="输出目录名" hint="在集目录或项目根下创建该目录" error={errors.namingOutputDir}>
                <TextInput
                  value={draft.naming.outputDirName}
                  placeholder="output"
                  onChange={(event) =>
                    mutate((next) => {
                      next.naming.outputDirName = event.target.value
                    })
                  }
                />
              </Field>
            </Grid>
          </Card>
        </div>

        {/* 6. MP4 */}
        <div id="settings-mp4" style={{ scrollMarginTop: 8 }}>
          <Card title="MP4">
            <Grid>
              <Field label="字幕处理方式" hint="转 MP4 时的字幕轨策略：mov_text 写入软字幕，drop 直接丢弃">
                <Select
                  value={draft.mp4.subtitleMode}
                  options={[
                    { value: 'mov_text', label: '写入 mov_text 软字幕' },
                    { value: 'drop', label: '丢弃字幕轨' }
                  ]}
                  onChange={(event) =>
                    mutate((next) => {
                      next.mp4.subtitleMode = event.target.value === 'drop' ? 'drop' : 'mov_text'
                    })
                  }
                />
              </Field>
            </Grid>
          </Card>
        </div>

        {/* 7. 压制 */}
        <div id="settings-encode" style={{ scrollMarginTop: 8 }}>
          <Card title="压制">
            <Grid>
              <Field label="最小成品体积" hint="低于该体积视为压制异常，默认 50" error={errors.encodeMinSize}>
                <NumberField
                  value={draft.encode.minSizeMb}
                  min={0}
                  step={1}
                  suffix="MB"
                  onValue={(value) =>
                    mutate((next) => {
                      next.encode.minSizeMb = Math.round(value)
                    })
                  }
                />
              </Field>

              <Field label="压制超时" hint="等待 OKEGui 完成任务的最长时间" error={errors.encodeTimeout}>
                <DurationField
                  valueMs={draft.encode.timeoutMs}
                  onValueMs={(ms) =>
                    mutate((next) => {
                      next.encode.timeoutMs = ms
                    })
                  }
                />
              </Field>

              <Field label="轮询间隔" hint="检查 OKEGui 任务状态的间隔，默认 2000" error={errors.encodePoll}>
                <NumberField
                  value={draft.encode.pollIntervalMs}
                  min={200}
                  step={100}
                  suffix="毫秒"
                  onValue={(value) =>
                    mutate((next) => {
                      next.encode.pollIntervalMs = Math.round(value)
                    })
                  }
                />
              </Field>
            </Grid>

            <div className="divider" />

            <Grid>
              <Field hint="合并章节前后保留原 mkv，便于回滚">
                <Checkbox
                  checked={draft.encode.keepBackup}
                  onChange={(checked) =>
                    mutate((next) => {
                      next.encode.keepBackup = checked
                    })
                  }
                  label={<span>合并章节时保留原文件备份</span>}
                />
              </Field>
              <Field hint="源视频缺失或未识别到时直接阻断压制，避免空跑">
                <Checkbox
                  checked={draft.encode.requireSourceVideo}
                  onChange={(checked) =>
                    mutate((next) => {
                      next.encode.requireSourceVideo = checked
                    })
                  }
                  label={<span>压制前必须检测到源视频（缺失则阻断）</span>}
                />
              </Field>
            </Grid>
          </Card>
        </div>

        {/* 8. 发布（v2 预留） */}
        <div id="settings-publish" style={{ scrollMarginTop: 8 }}>
          <Card
            title="发布（v2）"
            extra={
              <div className="row" style={{ gap: 6 }}>
                <Badge tone="orange" dot={false}>
                  即将推出
                </Badge>
                <span className="muted" style={{ fontSize: 12 }}>
                  整组禁用
                </span>
              </div>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div
                style={{
                  background: 'var(--color-warning-soft)',
                  border: '1px solid #fde68a',
                  color: '#92400e',
                  borderRadius: 'var(--radius-control)',
                  padding: '8px 10px',
                  fontSize: 12,
                  lineHeight: 1.6
                }}
              >
                v1 不执行制种 / 上传 / 做种。流程在 <span className="mono">DONE</span>（已完成）结束；下列配置仅供 v2
                预留，保存时主进程会强制把 <span className="mono">publish.enabled</span> 与{' '}
                <span className="mono">publish.uploadEnabled</span> 置为 false。
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                  gap: '4px 20px',
                  opacity: 0.85
                }}
              >
                {publishReadonly.map((item) => (
                  <div key={item.label} className="row" style={{ gap: 8, minWidth: 0, fontSize: 12 }}>
                    <span className="muted mono" style={{ flex: '0 0 152px', fontSize: 11.5, wordBreak: 'break-all' }}>
                      {item.label}
                    </span>
                    <span
                      className="mono"
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={item.value}
                    >
                      {item.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </div>

        {/* 底部操作条 */}
        <div
          style={{
            position: 'sticky',
            bottom: 0,
            zIndex: 5,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 12px',
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-card)',
            boxShadow: 'var(--shadow-card)'
          }}
        >
          <span
            className="muted"
            style={{ fontSize: 12, color: hasErrors ? 'var(--color-danger)' : undefined }}
          >
            {hasErrors
              ? `有 ${errorCount} 处参数需要修正后才能保存`
              : dirty
                ? '有未保存的修改'
                : '设置已与磁盘一致'}
          </span>
          <span className="spacer" />
          <Button onClick={() => void handleReset()} disabled={saving || resetting}>
            恢复默认
          </Button>
          <Button kind="primary" onClick={() => void handleSave()} disabled={saving || resetting || hasErrors}>
            保存设置
          </Button>
          <Button onClick={onBack}>返回</Button>
        </div>
      </div>

      <ConfirmHost confirm={confirm} />
    </>
  )
}
