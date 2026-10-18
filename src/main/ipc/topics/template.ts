import { z } from 'zod'
import { handle } from '../registry'
import { getSettings } from '../../store/settings'
import {
  analyzeTemplate,
  instantiateTemplates,
  previewTemplate,
  saveTemplateFiles,
  type Substitution
} from '../../services/template-service'
import type { TemplateAnalysisDto } from '@shared/api'

const substitutionSchema = z.object({
  id: z.string(),
  kind: z.enum(['work', 'anime', 'path', 'episode', 'subtitle', 'custom']),
  from: z.string(),
  to: z.string(),
  count: z.number(),
  enabled: z.boolean(),
  scope: z.enum(['json', 'vpy', 'both'])
})

function toDto(analysis: ReturnType<typeof analyzeTemplate>): TemplateAnalysisDto {
  const info = analysis.bundle.info
  return {
    info: {
      projectName: info?.projectName ?? null,
      inputScript: info?.inputScript ?? null,
      inputFiles: info?.inputFiles ?? [],
      vpyInput: info?.vpyInput ?? null,
      vpySubtitle: info?.vpySubtitle ?? null,
      oldEpDir: info?.oldEpDir ?? null,
      oldAnime: info?.oldAnime ?? null,
      oldLocal: info?.oldLocal ?? null,
      oldRelease: info?.oldRelease ?? null,
      oldWork: info?.oldWork ?? null,
      absolutePaths: info?.absolutePaths ?? []
    },
    substitutions: analysis.substitutions,
    warnings: analysis.warnings,
    hasPlaceholders: analysis.hasPlaceholders,
    hasJson: Boolean(analysis.bundle.jsonText),
    hasVpy: Boolean(analysis.bundle.vpyText),
    jsonText: analysis.bundle.jsonText,
    vpyText: analysis.bundle.vpyText
  }
}

export function registerTemplateTopics(): void {
  handle('template:analyze', z.object({ rootPath: z.string().min(1) }), ({ rootPath }) =>
    toDto(analyzeTemplate(rootPath))
  )

  handle(
    'template:upload',
    z.object({ rootPath: z.string().min(1), files: z.array(z.string().min(1)).min(1) }),
    ({ rootPath, files }) => {
      const settings = getSettings()
      const bundle = saveTemplateFiles(rootPath, files)
      void bundle
      const { openStore } = require('../../store/repository') as typeof import('../../store/repository')
      const store = openStore(rootPath)
      store.appendAudit('template.upload', { files }, null, settings.operator)
      return toDto(analyzeTemplate(rootPath))
    }
  )

  handle(
    'template:preview',
    z.object({
      rootPath: z.string().min(1),
      localNo: z.string().min(1),
      substitutions: z.array(substitutionSchema).optional()
    }),
    ({ rootPath, localNo, substitutions }) => {
      const settings = getSettings()
      const analysis = analyzeTemplate(rootPath)
      const subs = (substitutions as Substitution[] | undefined) ?? analysis.substitutions
      return previewTemplate(rootPath, localNo, subs, settings)
    }
  )

  handle(
    'template:instantiate',
    z.object({
      rootPath: z.string().min(1),
      localNos: z.array(z.string()).optional(),
      onExists: z.enum(['backup', 'skip']).default('backup'),
      substitutions: z.array(substitutionSchema).optional(),
      validateVpy: z.boolean().optional()
    }),
    async ({ rootPath, localNos, onExists, substitutions, validateVpy }) => {
      const settings = getSettings()
      return instantiateTemplates(rootPath, settings, {
        localNos,
        onExists: onExists ?? 'backup',
        substitutions: substitutions as Substitution[] | undefined,
        validateVpy
      })
    }
  )
}
