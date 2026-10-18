/**
 * 模板变量表（§7.2）。
 * 展开顺序：先算复合变量（{work}）→ 再单次扫描替换，避免二次替换。
 */

export interface TemplateInput {
  anime: string
  /** 两位本地集号，如 '01' */
  localNo: string
  localInt: number
  /** 发布集数（已按宽度补零），如 '13' */
  releaseNo: string
  releaseInt: number
  /** 发布集数原始写法（保留宽度），如 '1' */
  releaseRaw: string
  root: string
  project: string
  epDir: string
  subDir: string
  output: string
  ext: string
  workNameTemplate: string
  /** 工作名中的集数取发布集数还是本地集号 */
  epSource?: 'release' | 'local'
  /** 工作名是否带字面方括号 */
  bracketWorkName?: boolean
}

export type VariableMap = Record<string, string>

const BASE_KEYS = [
  'anime',
  'local',
  'local_int',
  'release',
  'release_int',
  'release_raw',
  'ep',
  'root',
  'project',
  'ep_dir',
  'sub_dir',
  'output',
  'ext'
] as const

export const KNOWN_VARIABLES = [...BASE_KEYS, 'work'] as const

export function buildWorkName(input: TemplateInput): string {
  const ep = input.epSource === 'local' ? input.localNo : input.releaseNo
  const base: VariableMap = {
    anime: input.anime,
    local: input.localNo,
    local_int: String(input.localInt),
    release: input.releaseNo,
    release_int: String(input.releaseInt),
    release_raw: input.releaseRaw,
    ep
  }
  let name = expandVariables(input.workNameTemplate, base).text
  if (input.bracketWorkName) name = name.replace(new RegExp(`^${escapeRegExp(input.anime)}`), `[${input.anime}]`)
  return name
}

export function createVariableMap(input: TemplateInput): VariableMap {
  const workName = buildWorkName(input)
  return {
    anime: input.anime,
    local: input.localNo,
    local_int: String(input.localInt),
    release: input.releaseNo,
    release_int: String(input.releaseInt),
    release_raw: input.releaseRaw,
    ep: input.epSource === 'local' ? input.localNo : input.releaseNo,
    work: workName,
    root: input.root,
    project: input.project,
    ep_dir: input.epDir,
    sub_dir: input.subDir,
    output: input.output,
    ext: input.ext
  }
}

export interface ExpandResult {
  text: string
  /** 未识别的 {xxx} 占位符（保留原样） */
  unknown: string[]
}

/** 单次扫描替换，未识别变量原样保留 */
export function expandVariables(text: string, vars: VariableMap): ExpandResult {
  const unknown = new Set<string>()
  const out = text.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name] ?? match
    unknown.add(name)
    return match
  })
  return { text: out, unknown: [...unknown] }
}

/** 展开复合变量（{work} / {ep_dir} 等含路径的变量会包含其它变量值） */
export function expandAll(text: string, vars: VariableMap): ExpandResult {
  return expandVariables(text, vars)
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 给 JSON 字符串值用：变量替换后不需要额外转义，交给 JSON.stringify 处理。
 * 给 vpy 用：保持模板原有引号与斜杠风格，不做转换。
 */
export function isVariablePlaceholder(token: string): boolean {
  return /^\{[a-zA-Z_][a-zA-Z0-9_]*\}$/.test(token)
}
