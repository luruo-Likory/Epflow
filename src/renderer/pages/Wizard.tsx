import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CreateProjectInputDto, ProjectPreviewDto } from '@shared/api'
import {
  applyReleaseTemplate,
  chooseDefaultCandidate,
  findReleaseCandidates,
  type ReleaseCandidate
} from '@shared/release-name'
import { validateAnimeName } from '@shared/filename'
import { invoke, errorText } from '../lib/api'
import {
  Badge,
  Button,
  Card,
  Field,
  Select,
  Tabs,
  TextArea,
  TextInput,
  useToast
} from '../components/ui'

type Step = 1 | 2 | 3
type StepKey = '1' | '2' | '3'
type ConflictMode = 'reuse' | 'abort' | 'rename'
type OutputMode = CreateProjectInputDto['outputMode']

interface FormState {
  animeName: string
  materialRoot: string
  episodeCount: string
  localStart: string
  releaseName: string
  releaseBase: string
  releaseWidth: string
  workNameTemplate: string
  subDirName: string
  outputMode: OutputMode
}

const PATTERN_LABEL: Record<ReleaseCandidate['pattern'], string> = {
  bracket: '方括号',
  dash: '连字符',
  cn: '第 N 集',
  en: 'E / EP',
  bare: '独立数字'
}

const OUTPUT_MODES: Array<{ value: OutputMode; label: string; hint: string }> = [
  { value: 'episode-output', label: '各集 output\\', hint: '每集目录下建 output\\ 子目录' },
  { value: 'project-release', label: '项目 release\\', hint: '项目根目录下建统一的 release\\ 目录' }
]

const CONFLICT_OPTIONS: Array<{ value: ConflictMode; label: string; hint: string }> = [
  { value: 'reuse', label: '复用已有目录', hint: '保留已有文件，只补建缺失目录，不会删除任何内容' },
  { value: 'abort', label: '中止', hint: '不创建项目，返回第 1 步修改番名或素材根目录' },
  { value: 'rename', label: '改名新建', hint: '用新番名新建项目目录，避免与已有目录冲突' }
]

const RADIO_ROW_STYLE: React.CSSProperties = {
  alignItems: 'flex-start',
  gap: 8,
  padding: '6px 10px',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  fontSize: 13,
  cursor: 'pointer',
  lineHeight: 1.55
}

function candidateKey(candidate: ReleaseCandidate): string {
  return `${candidate.start}-${candidate.end}`
}

function parseInteger(value: string): number {
  const text = value.trim()
  if (!/^\d+$/.test(text)) return Number.NaN
  return Number(text)
}

export default function Wizard(props: {
  onCreated: (rootPath: string) => void
  onCancel: () => void
}): React.ReactElement {
  const { onCreated, onCancel } = props
  const toast = useToast()

  const [step, setStep] = useState<Step>(1)
  const [touched, setTouched] = useState(false)
  const [form, setForm] = useState<FormState>({
    animeName: '',
    materialRoot: '',
    episodeCount: '12',
    localStart: '1',
    releaseName: '',
    releaseBase: '1',
    releaseWidth: '2',
    workNameTemplate: '{anime} - {ep}',
    subDirName: '[翻译用]',
    outputMode: 'episode-output'
  })
  const [selectedSpan, setSelectedSpan] = useState('')
  const [preview, setPreview] = useState<ProjectPreviewDto | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ConflictMode>('reuse')
  const [renameName, setRenameName] = useState('')
  const [templateFiles, setTemplateFiles] = useState<string[]>([])
  const [picking, setPicking] = useState(false)
  const [creating, setCreating] = useState(false)

  const previewSeq = useRef(0)
  const lastPreviewKey = useRef('')
  const createdRoot = useRef<string | null>(null)

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => {
      const next: FormState = { ...prev }
      next[key] = value
      return next
    })
  }

  // 默认值取自设置
  useEffect(() => {
    let alive = true
    void invoke('settings:get')
      .then((settings) => {
        if (!alive) return
        setForm((prev) => ({
          ...prev,
          materialRoot: prev.materialRoot || settings.materialRoot,
          subDirName: settings.subDirName || prev.subDirName
        }))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  // 打开发布名候选：默认选中优先级最高的数字位
  const candidates = useMemo(() => findReleaseCandidates(form.releaseName), [form.releaseName])
  const selectedCandidate = useMemo(() => {
    const matched = candidates.find((item) => candidateKey(item) === selectedSpan)
    return matched ?? chooseDefaultCandidate(candidates)
  }, [candidates, selectedSpan])
  const activeKey = selectedCandidate ? candidateKey(selectedCandidate) : ''
  const hasPlaceholder = form.releaseName.includes('{release}')
  const releaseTemplate = useMemo(() => {
    if (hasPlaceholder) return form.releaseName
    return selectedCandidate ? applyReleaseTemplate(form.releaseName, selectedCandidate) : ''
  }, [form.releaseName, hasPlaceholder, selectedCandidate])

  // 选中候选变化时，基准集数/补零宽度跟随候选的默认值
  useEffect(() => {
    if (!selectedCandidate) return
    setForm((prev) => ({
      ...prev,
      releaseBase: String(selectedCandidate.value),
      releaseWidth: String(Math.max(2, selectedCandidate.digits.length))
    }))
  }, [selectedCandidate])

  const numbers = useMemo(
    () => ({
      episodeCount: parseInteger(form.episodeCount),
      localStart: parseInteger(form.localStart),
      releaseBase: parseInteger(form.releaseBase),
      releaseWidth: parseInteger(form.releaseWidth)
    }),
    [form.episodeCount, form.localStart, form.releaseBase, form.releaseWidth]
  )

  const validation = useMemo(() => {
    const animeError = validateAnimeName(form.animeName)
    const materialError = form.materialRoot.trim() ? null : '请选择素材根目录'
    const countError =
      !Number.isInteger(numbers.episodeCount) || numbers.episodeCount < 1 || numbers.episodeCount > 999
        ? '总集数需为 1–999 的整数'
        : null
    const localError =
      !Number.isInteger(numbers.localStart) || numbers.localStart < 1 || numbers.localStart > 999
        ? '起始集号需为 1–999 的整数'
        : null
    const releaseError = !form.releaseName.trim()
      ? '发布名不能为空'
      : releaseTemplate.includes('{release}')
        ? null
        : '未能生成含 {release} 的模板，请选择一个集数位'
    const baseError =
      !Number.isInteger(numbers.releaseBase) || numbers.releaseBase < 0 || numbers.releaseBase > 9999
        ? '基准发布集数需为 0–9999 的整数'
        : null
    const widthError =
      !Number.isInteger(numbers.releaseWidth) || numbers.releaseWidth < 1 || numbers.releaseWidth > 4
        ? '补零宽度需为 1–4'
        : null
    const workError = form.workNameTemplate.trim() ? null : '工作名模板不能为空'
    const subError = form.subDirName.trim() ? null : '翻译用目录名不能为空'
    const messages = [
      animeError,
      materialError,
      countError,
      localError,
      releaseError,
      baseError,
      widthError,
      workError,
      subError
    ].filter((item): item is string => item !== null)
    return {
      animeError,
      materialError,
      countError,
      localError,
      releaseError,
      baseError,
      widthError,
      workError,
      subError,
      messages
    }
  }, [form, numbers, releaseTemplate])

  const formInput = useMemo<CreateProjectInputDto | null>(() => {
    if (validation.messages.length > 0) return null
    return {
      animeName: form.animeName,
      materialRoot: form.materialRoot.trim(),
      releaseNameTemplate: releaseTemplate,
      releaseEpisodeBase: numbers.releaseBase,
      releaseEpisodeWidth: numbers.releaseWidth,
      episodeCount: numbers.episodeCount,
      localStart: numbers.localStart,
      workNameTemplate: form.workNameTemplate,
      subDirName: form.subDirName,
      outputMode: form.outputMode
    }
  }, [validation, form, numbers, releaseTemplate])

  const step1Valid = formInput !== null
  const previewOk = preview !== null && preview.errors.length === 0
  const cannotCreate =
    preview?.conflicts.rootExists === true &&
    (conflict === 'abort' || (conflict === 'rename' && !renameName.trim()))
  const canCreate = previewOk && !previewLoading && !creating && !cannotCreate

  // 输入变化后使旧的项目创建结果失效（避免改名模式下重复建目录）
  useEffect(() => {
    createdRoot.current = null
  }, [formInput])

  useEffect(() => {
    setRenameName(form.animeName.trim() ? `${form.animeName.trim()} (2)` : '')
  }, [form.animeName])

  const runPreview = useCallback(async (input: CreateProjectInputDto): Promise<void> => {
    const seq = previewSeq.current + 1
    previewSeq.current = seq
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const result = await invoke('project:preview', input)
      if (previewSeq.current !== seq) return
      setPreview(result)
      lastPreviewKey.current = JSON.stringify(input)
    } catch (err) {
      if (previewSeq.current !== seq) return
      setPreview(null)
      setPreviewError(errorText(err))
    } finally {
      if (previewSeq.current === seq) setPreviewLoading(false)
    }
  }, [])

  // 进入第 2 步后：输入变化 debounce 300ms 自动预览
  useEffect(() => {
    if (step !== 2) return
    if (!formInput) return
    const key = JSON.stringify(formInput)
    if (key === lastPreviewKey.current) return
    const delay = lastPreviewKey.current ? 300 : 0
    const timer = window.setTimeout(() => {
      void runPreview(formInput)
    }, delay)
    return () => window.clearTimeout(timer)
  }, [step, formInput, runPreview])

  const refreshPreview = (): void => {
    if (!formInput) {
      toast.error('请先补全第 1 步的基本信息')
      setStep(1)
      return
    }
    void runPreview(formInput)
  }

  const pickMaterialRoot = async (): Promise<void> => {
    try {
      const picked = await invoke('dialog:pick-dir', {
        title: '选择素材根目录',
        defaultPath: form.materialRoot || undefined
      })
      if (picked) update('materialRoot', picked)
    } catch (err) {
      toast.error(errorText(err))
    }
  }

  const pickTemplateFiles = async (): Promise<void> => {
    if (picking) return
    setPicking(true)
    try {
      const picked = await invoke('dialog:pick-files', {
        title: '选择模板文件',
        filters: [{ name: 'OKEGui 模板', extensions: ['json', 'vpy'] }],
        multi: true
      })
      if (picked.length === 0) return
      setTemplateFiles((prev) => {
        const next = [...prev]
        for (const file of picked) {
          if (!next.includes(file)) next.push(file)
        }
        return next
      })
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setPicking(false)
    }
  }

  const handleCreate = async (): Promise<void> => {
    if (creating) return
    if (!formInput) {
      toast.error('请先补全第 1 步的基本信息')
      setStep(1)
      return
    }
    if (!preview || preview.errors.length > 0) {
      toast.error('目录预览存在错误，无法创建项目')
      setStep(2)
      return
    }
    if (preview.conflicts.rootExists && conflict === 'abort') {
      toast.warn('已选择中止：请返回第 1 步修改番名或素材根目录')
      return
    }
    if (preview.conflicts.rootExists && conflict === 'rename' && !renameName.trim()) {
      toast.error('改名不能为空')
      return
    }

    setCreating(true)
    try {
      let rootPath: string
      if (createdRoot.current) {
        rootPath = createdRoot.current
      } else {
        try {
          const snapshot = await invoke('project:create', {
            input: formInput,
            conflict,
            renamedAnime: conflict === 'rename' ? renameName.trim() : undefined
          })
          rootPath = snapshot.project.rootPath
          createdRoot.current = rootPath
        } catch (err) {
          toast.error(`创建项目失败：${errorText(err)}`)
          return
        }
      }

      if (templateFiles.length > 0) {
        try {
          await invoke('template:upload', { rootPath, files: templateFiles })
        } catch (err) {
          toast.error(`项目已创建（${rootPath}），但模板上传失败：${errorText(err)}。可再次点击完成重试，或先跳过。`)
          return
        }
      }

      toast.success('项目已创建')
      onCreated(rootPath)
    } finally {
      setCreating(false)
    }
  }

  const stepItems: Array<{ key: StepKey; label: string; disabled?: boolean }> = [
    { key: '1', label: '1 基本信息' },
    { key: '2', label: '2 目录预览', disabled: !step1Valid || creating },
    { key: '3', label: '3 模板上传（可跳过）', disabled: !step1Valid || !previewOk || creating }
  ]
  const stepKey: StepKey = step === 1 ? '1' : step === 2 ? '2' : '3'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.4 }}>新建项目</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            三步创建番剧项目：基本信息 → 目录预览 → 模板上传（可跳过）。
          </div>
        </div>
        <span className="spacer" />
        <Button kind="ghost" onClick={onCancel} disabled={creating}>
          取消
        </Button>
      </div>

      <Card bodyStyle={{ padding: 0 }}>
        <Tabs
          items={stepItems}
          value={stepKey}
          onChange={(key) => setStep(Number(key) as Step)}
        />
      </Card>

      {step === 1 && (
        <>
          <Card
            title="基本信息"
            extra={<span className="muted" style={{ fontSize: 12 }}>番名将作为项目根目录名</span>}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                gap: 12
              }}
            >
              <Field
                label="番名（必填）"
                error={touched || form.animeName ? validation.animeError : null}
                hint="最多 80 个字符，不能包含 < > : &quot; / \ | ? *"
              >
                <TextInput
                  value={form.animeName}
                  maxLength={80}
                  placeholder="例如：动物狂想曲 最终季"
                  onBlur={() => setTouched(true)}
                  onChange={(event) => update('animeName', event.target.value)}
                />
              </Field>
              <Field
                label="素材根目录（必填）"
                error={validation.materialError}
                hint="项目目录会创建为「素材根目录\番名」"
              >
                <div className="row">
                  <TextInput
                    value={form.materialRoot}
                    placeholder="D:\media\origin material"
                    onChange={(event) => update('materialRoot', event.target.value)}
                  />
                  <Button onClick={() => void pickMaterialRoot()}>选择目录</Button>
                </div>
              </Field>
              <Field label="总集数" error={validation.countError} hint="1–999 的整数，默认 12">
                <TextInput
                  type="number"
                  min={1}
                  max={999}
                  step={1}
                  value={form.episodeCount}
                  onChange={(event) => update('episodeCount', event.target.value)}
                  style={{ maxWidth: 180 }}
                />
              </Field>
              <Field label="本地起始集号" error={validation.localError} hint="默认 1，本地集号会自动补零">
                <TextInput
                  type="number"
                  min={1}
                  max={999}
                  step={1}
                  value={form.localStart}
                  onChange={(event) => update('localStart', event.target.value)}
                  style={{ maxWidth: 180 }}
                />
              </Field>
            </div>
          </Card>

          <Card
            title="发布名"
            extra={<span className="muted" style={{ fontSize: 12 }}>选中集数位后会替换为 {'{release}'}</span>}
          >
            <Field
              label="发布名（必填，一整条发布名）"
              error={touched || form.releaseName ? validation.releaseError : null}
              hint="把完整发布名粘进来，EpFlow 会识别其中的集数位"
            >
              <TextArea
                rows={3}
                value={form.releaseName}
                placeholder="[云光字幕组] 动物狂想曲 最终季 Part.2 BEASTARS Final Season [13][简体双语][1080p]招募翻译"
                onChange={(event) => update('releaseName', event.target.value)}
                onBlur={() => setTouched(true)}
              />
            </Field>

            {hasPlaceholder ? (
              <div
                style={{
                  marginTop: 10,
                  fontSize: 12.5,
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: 'var(--color-primary-soft)',
                  color: 'var(--color-primary)'
                }}
              >
                发布名中已包含 {'{release}'} 占位符，将直接作为模板使用。
              </div>
            ) : form.releaseName.trim() ? (
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  选择集数位（会替换为 {'{release}'}）
                </div>
                {candidates.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--color-warning)' }}>
                    未识别到集数位。请检查发布名，或手动写入 {'{release}'} 占位符。
                  </div>
                ) : (
                  candidates.map((candidate) => {
                    const key = candidateKey(candidate)
                    const checked = activeKey === key
                    return (
                      <label
                        key={key}
                        className="row"
                        style={{
                          ...RADIO_ROW_STYLE,
                          background: checked ? 'var(--color-primary-soft)' : 'var(--color-surface)',
                          borderColor: checked ? 'var(--color-primary)' : 'var(--color-border)'
                        }}
                      >
                        <input
                          type="radio"
                          name="release-candidate"
                          checked={checked}
                          onChange={() => setSelectedSpan(key)}
                          style={{ marginTop: 3 }}
                        />
                        <span style={{ whiteSpace: 'nowrap' }}>
                          第 <b>{candidate.value}</b> 集
                          <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
                            {PATTERN_LABEL[candidate.pattern]}
                          </span>
                        </span>
                        <span className="spacer" />
                        <span
                          className="mono muted"
                          style={{ fontSize: 11.5, wordBreak: 'break-all', textAlign: 'right' }}
                        >
                          {candidate.context}
                        </span>
                      </label>
                    )
                  })
                )}
              </div>
            ) : null}

            {releaseTemplate && releaseTemplate.includes('{release}') && (
              <div
                style={{
                  marginTop: 10,
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: 'var(--color-primary-soft)',
                  fontSize: 12
                }}
              >
                <span className="muted">发布名模板：</span>
                <span className="mono" style={{ wordBreak: 'break-all' }}>
                  {releaseTemplate}
                </span>
              </div>
            )}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 12,
                marginTop: 12
              }}
            >
              <Field label="基准发布集数" error={validation.baseError} hint="本地起始集对应的发布集数">
                <TextInput
                  type="number"
                  min={0}
                  max={9999}
                  step={1}
                  value={form.releaseBase}
                  onChange={(event) => update('releaseBase', event.target.value)}
                  style={{ maxWidth: 180 }}
                />
              </Field>
              <Field label="补零宽度" error={validation.widthError} hint="1–4 位，默认取候选数字长度（最少 2）">
                <Select
                  value={form.releaseWidth}
                  onChange={(event) => update('releaseWidth', event.target.value)}
                  options={[1, 2, 3, 4].map((width) => ({
                    value: String(width),
                    label: `${width} 位`
                  }))}
                  style={{ maxWidth: 180 }}
                />
              </Field>
            </div>
          </Card>

          <Card title="命名与目录">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                gap: 12
              }}
            >
              <Field
                label="工作名模板"
                error={validation.workError}
                hint="可用 {anime}、{ep}、{release} 等变量，默认 {anime} - {ep}"
              >
                <TextInput
                  value={form.workNameTemplate}
                  onChange={(event) => update('workNameTemplate', event.target.value)}
                />
              </Field>
              <Field
                label="翻译用目录名"
                error={validation.subError}
                hint="默认 [翻译用]，与存量工程「翻译用」兼容"
              >
                <TextInput
                  value={form.subDirName}
                  onChange={(event) => update('subDirName', event.target.value)}
                />
              </Field>
            </div>

            <div style={{ marginTop: 12 }}>
              <Field label="输出目录模式">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {OUTPUT_MODES.map((mode) => (
                    <label key={mode.value} className="row" style={RADIO_ROW_STYLE}>
                      <input
                        type="radio"
                        name="output-mode"
                        checked={form.outputMode === mode.value}
                        onChange={() => update('outputMode', mode.value)}
                        style={{ marginTop: 3 }}
                      />
                      <span>
                        <span className="mono">{mode.label}</span>
                        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
                          {mode.hint}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </Field>
            </div>
          </Card>

          <div className="row" style={{ gap: 8 }}>
            <Button onClick={onCancel} disabled={creating}>
              取消
            </Button>
            <span className="spacer" />
            <Button kind="primary" disabled={!step1Valid} onClick={() => setStep(2)}>
              下一步：目录预览
            </Button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <Card
            title="目录预览"
            extra={
              <div className="row" style={{ gap: 8 }}>
                {previewLoading && <span className="muted" style={{ fontSize: 12 }}>预览中…</span>}
                <Button size="sm" onClick={refreshPreview} disabled={previewLoading}>
                  刷新预览
                </Button>
              </div>
            }
          >
            {!formInput && (
              <div style={{ fontSize: 12.5, color: 'var(--color-danger)' }}>
                基本信息不完整，请返回第 1 步补全后再预览。
              </div>
            )}
            {previewError && (
              <div
                style={{
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: 'var(--color-danger-soft)',
                  color: 'var(--color-danger)',
                  fontSize: 12.5,
                  wordBreak: 'break-all'
                }}
              >
                预览失败：{previewError}
              </div>
            )}
            {!preview && !previewError && formInput && (
              <div className="muted" style={{ fontSize: 12.5 }}>
                正在生成目录预览…
              </div>
            )}
            {preview && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="row wrap">
                  <span className="muted" style={{ fontSize: 12 }}>
                    项目根目录
                  </span>
                  <span className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                    {preview.rootPath}
                  </span>
                  <span className="spacer" />
                  <Badge tone={preview.errors.length > 0 ? 'red' : preview.warnings.length > 0 ? 'orange' : 'teal'} dot={false}>
                    {preview.errors.length > 0
                      ? `${preview.errors.length} 个错误`
                      : preview.warnings.length > 0
                        ? `${preview.warnings.length} 个提示`
                        : '校验通过'}
                  </Badge>
                </div>

                {preview.errors.length > 0 && (
                  <div
                    style={{
                      padding: '8px 10px',
                      borderRadius: 6,
                      background: 'var(--color-danger-soft)',
                      color: 'var(--color-danger)',
                      fontSize: 12.5
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>错误（必须修正后才能创建）</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {preview.errors.map((message, index) => (
                        <li key={`${index}-${message}`}>{message}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {preview.warnings.length > 0 && (
                  <div
                    style={{
                      padding: '8px 10px',
                      borderRadius: 6,
                      background: 'var(--color-warning-soft)',
                      color: 'var(--color-warning)',
                      fontSize: 12.5
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>提示</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {preview.warnings.map((message, index) => (
                        <li key={`${index}-${message}`}>{message}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </Card>

          {preview && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
                gap: 12,
                alignItems: 'start'
              }}
            >
              <Card
                title="目录结构"
                extra={<span className="muted" style={{ fontSize: 12 }}>仅预览，尚未创建</span>}
              >
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.8 }}>
                  {preview.tree.map((line, index) => (
                    <div
                      key={`${index}-${line.name}`}
                      style={{
                        paddingLeft: line.depth * 16,
                        display: 'flex',
                        gap: 6,
                        alignItems: 'baseline'
                      }}
                    >
                      <span
                        style={{
                          color: line.kind === 'dir' ? 'var(--color-primary)' : 'var(--color-text-faint)',
                          flex: '0 0 auto'
                        }}
                      >
                        {line.kind === 'dir' ? '📁' : '·'}
                      </span>
                      <span
                        style={{
                          color: line.kind === 'dir' ? 'var(--color-text)' : 'var(--color-text-muted)',
                          wordBreak: 'break-all'
                        }}
                      >
                        {line.name}
                      </span>
                      {line.note && (
                        <span style={{ fontSize: 11, color: 'var(--color-text-faint)' }}>{line.note}</span>
                      )}
                    </div>
                  ))}
                </div>
              </Card>

              <Card
                title="集号对照表"
                extra={
                  <Badge tone="gray" dot={false}>
                    共 {preview.episodes.length} 集
                  </Badge>
                }
              >
                {preview.episodes.length === 0 ? (
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    没有可预览的集。
                  </div>
                ) : (
                  <>
                    <div className="table-wrap">
                      <table className="grid">
                        <thead>
                          <tr>
                            <th>本地集号</th>
                            <th>发布集数</th>
                            <th>工作名</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.episodes.slice(0, 12).map((episode) => (
                            <tr key={episode.localNo}>
                              <td className="mono">{episode.localNo}</td>
                              <td className="mono">{episode.releaseNo}</td>
                              <td
                                className="mono"
                                title={episode.workName}
                                style={{
                                  maxWidth: 320,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap'
                                }}
                              >
                                {episode.workName}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                      {preview.episodes.length > 12
                        ? `仅显示前 12 行，共 ${preview.episodes.length} 集`
                        : `共 ${preview.episodes.length} 集`}
                    </div>
                  </>
                )}
              </Card>
            </div>
          )}

          {preview && preview.conflicts.rootExists && (
            <Card
              title="目标目录已存在"
              extra={
                <Badge tone="orange" dot={false}>
                  需要选择处理方式
                </Badge>
              }
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                  项目目录 <span className="mono">{preview.rootPath}</span> 已存在，已发现{' '}
                  <b>{preview.conflicts.existingLocalDirs.length}</b> 个集目录
                  {preview.conflicts.hasState ? '，并包含 EpFlow 状态库。' : '，但没有 EpFlow 状态库。'}
                  {preview.conflicts.existingLocalDirs.length > 0 && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      已存在：{preview.conflicts.existingLocalDirs.slice(0, 12).join('、')}
                      {preview.conflicts.existingLocalDirs.length > 12 ? ' …' : ''}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {CONFLICT_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      className="row"
                      style={{
                        ...RADIO_ROW_STYLE,
                        background:
                          conflict === option.value ? 'var(--color-primary-soft)' : 'var(--color-surface)',
                        borderColor:
                          conflict === option.value ? 'var(--color-primary)' : 'var(--color-border)'
                      }}
                    >
                      <input
                        type="radio"
                        name="conflict-mode"
                        checked={conflict === option.value}
                        onChange={() => setConflict(option.value)}
                        style={{ marginTop: 3 }}
                      />
                      <span>
                        <b>{option.label}</b>
                        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
                          {option.hint}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>

                {conflict === 'rename' && (
                  <Field label="新番名" hint="默认在原名后追加 (2)，主进程会自动避让已存在的目录">
                    <TextInput
                      value={renameName}
                      onChange={(event) => setRenameName(event.target.value)}
                      style={{ maxWidth: 420 }}
                    />
                  </Field>
                )}

                {conflict === 'abort' && (
                  <div style={{ fontSize: 12.5, color: 'var(--color-warning)' }}>
                    已选择中止：不会创建项目，请返回第 1 步修改番名或素材根目录。
                  </div>
                )}
              </div>
            </Card>
          )}

          <div className="row" style={{ gap: 8 }}>
            <Button onClick={() => setStep(1)} disabled={creating}>
              上一步
            </Button>
            <span className="spacer" />
            <Button
              onClick={() => setStep(3)}
              disabled={!previewOk || previewLoading || creating}
            >
              下一步：模板上传
            </Button>
            <Button kind="primary" onClick={() => void handleCreate()} disabled={!canCreate}>
              {creating ? '创建中…' : '完成创建'}
            </Button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <Card title="模板上传（可跳过）" extra={<span className="muted" style={{ fontSize: 12 }}>第 3 步</span>}>
            <div style={{ fontSize: 13, lineHeight: 1.7 }}>
              可以先跳过，进入项目后再上传模板。选择 OKEGui 的 JSON 与 VPY 模板文件后，会在项目创建完成后自动上传并分析变量。
            </div>

            <div className="row" style={{ marginTop: 12 }}>
              <Button onClick={() => void pickTemplateFiles()} disabled={picking || creating}>
                {picking ? '选择中…' : '选择 JSON + VPY 文件'}
              </Button>
              <span className="muted" style={{ fontSize: 12 }}>
                支持 .json / .vpy，可多选
              </span>
            </div>

            <div style={{ marginTop: 12 }}>
              {templateFiles.length === 0 ? (
                <div className="muted" style={{ fontSize: 12 }}>
                  尚未选择文件，可直接完成，稍后在项目内上传模板。
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {templateFiles.map((file) => (
                    <div
                      key={file}
                      className="row"
                      style={{
                        gap: 8,
                        padding: '6px 10px',
                        border: '1px solid var(--color-border)',
                        borderRadius: 6
                      }}
                    >
                      <span className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>
                        {file}
                      </span>
                      <span className="spacer" />
                      <Button
                        size="sm"
                        kind="ghost"
                        disabled={creating}
                        onClick={() => setTemplateFiles((prev) => prev.filter((item) => item !== file))}
                      >
                        移除
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
              模板上传依赖项目已创建，因此点击「完成创建」后会按顺序执行：创建项目 → 上传模板 → 打开项目。
            </div>
          </Card>

          <div className="row" style={{ gap: 8 }}>
            <Button onClick={() => setStep(2)} disabled={creating}>
              上一步
            </Button>
            <span className="spacer" />
            <Button kind="primary" onClick={() => void handleCreate()} disabled={!canCreate}>
              {creating ? '创建中…' : '完成创建'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
