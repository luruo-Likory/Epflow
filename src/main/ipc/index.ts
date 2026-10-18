import { registerAppTopics } from './topics/app'
import { registerProjectTopics } from './topics/project'
import { registerTemplateTopics } from './topics/template'
import { registerSubtitleTopics } from './topics/subtitle'
import { registerReviewTopics } from './topics/review'
import { registerChapterTopics } from './topics/chapter'
import { registerPipelineTopics } from './topics/pipeline'

/** 所有 IPC 主题的注册入口；新增模块时在这里挂载 */
export function registerAllTopics(): void {
  registerAppTopics()
  registerProjectTopics()
  registerTemplateTopics()
  registerSubtitleTopics()
  registerReviewTopics()
  registerChapterTopics()
  registerPipelineTopics()
}
