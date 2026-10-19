/** Windows 文件名规则（纯函数，主进程与渲染层共用） */

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001F]/g
/** 非全局版本：用于 .test()，避免 lastIndex 在多次校验间残留 */
const ILLEGAL_CHAR = /[<>:"/\\|?*\u0000-\u001F]/
const RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9'
])

export interface SanitizeOptions {
  replacement?: string
  /** 连续空格压缩为单个 */
  collapseSpaces?: boolean
  maxLength?: number
}

/** 清理 Windows 文件名：非法字符、尾随空格与点、保留名 */
export function sanitizeFileName(name: string, options: SanitizeOptions = {}): string {
  const { replacement = '_', collapseSpaces = true, maxLength = 200 } = options
  let out = name.replace(ILLEGAL, replacement)
  if (collapseSpaces) out = out.replace(/\s+/g, ' ')
  out = out.trim()
  out = out.replace(/[. ]+$/g, '')
  if (maxLength > 0 && out.length > maxLength) {
    const extIndex = out.lastIndexOf('.')
    if (extIndex > 0 && out.length - extIndex <= 10) {
      const ext = out.slice(extIndex)
      out = `${out.slice(0, maxLength - ext.length)}${ext}`
    } else {
      out = out.slice(0, maxLength)
    }
    out = out.replace(/[. ]+$/g, '')
  }
  if (!out) out = 'untitled'
  const stem = (out.split('.')[0] ?? out).toUpperCase()
  if (RESERVED.has(stem)) out = `${out}_`
  return out
}

export function isReservedName(name: string): boolean {
  const stem = (name.split('.')[0] ?? name).toUpperCase()
  return RESERVED.has(stem)
}

/** 番名校验；返回 null 表示通过 */
export function validateAnimeName(name: string): string | null {
  if (!name || !name.trim()) return '番名不能为空'
  if (name !== name.trim()) return '番名首尾不能有空格'
  if (name.length > 80) return '番名长度不能超过 80 个字符'
  if (ILLEGAL_CHAR.test(name)) return '番名不能包含 < > : " / \\ | ? * 等字符'
  if (/[. ]$/.test(name)) return '番名不能以空格或点结尾'
  return null
}

export function validateReleaseTemplate(template: string): string | null {
  if (!template.includes('{release}')) return '发布名必须包含集数位（请选择后自动插入 {release}）'
  if (!template.trim()) return '发布名不能为空'
  return null
}

/**
 * 「翻译用」子目录名校验；空字符串合法，表示不使用子目录
 * （字幕、章节草稿等直接放在集目录下）。返回 null 表示通过。
 */
export function validateSubDirName(name: string): string | null {
  const value = name.trim()
  if (!value) return null
  if (value === '.' || value === '..') return '子目录名不能是「.」或「..」'
  if (ILLEGAL_CHAR.test(value)) return '子目录名不能包含 < > : " / \\ | ? * 等字符'
  if (/[. ]$/.test(value)) return '子目录名不能以点或空格结尾'
  if (value.length > 80) return '子目录名不能超过 80 个字符'
  return null
}
