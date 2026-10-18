import React from 'react'
import { PUBLISH_STATES } from '@shared/types'
import { Badge, Card } from '../components/ui'

/* ------------------------------------------------------------------ */
/* 冻结的 v2 方向（只读清单）                                           */
/* ------------------------------------------------------------------ */

const FROZEN_TABLES = ['release_record', 'torrent', 'upload', 'seed_task']

const FROZEN_INTERFACES = ['PublishProvider', 'SeedMaker', 'SeedClient']

const V2_STEPS: Array<{ title: string; detail: string }> = [
  {
    title: 'PUBLISH_READY · 发布就绪',
    detail: 'v1 到达 DONE（已完成）后，v2 才会生成发布记录并进入发布队列；v1 到此为止。'
  },
  {
    title: 'TORRENT_CREATED · 种子制作',
    detail: '由 μTorrent 生成 .torrent：读取成品文件、写入 tracker 与分块大小（pieceSizeKb）。'
  },
  {
    title: 'UPLOADED · 发布站上传（可选）',
    detail: '通过 PublishProvider 适配器上传到发布站；当前按单站设计，上传失败不阻断做种。'
  },
  {
    title: 'SEEDING · 做种',
    detail: '把种子交给 qBittorrent，并按 publish.policy=required 强制做种，保证发布后持续供种。'
  },
  {
    title: 'SEEDING_INTERRUPTED / SEEDING_DONE · 做种监控',
    detail: '按 monitorIntervalMs 巡检做种状态：中断记录原因并可恢复，达到目标后记为完成。'
  },
  {
    title: 'PUBLISH_FAILED · 失败处理',
    detail: '任一步失败都写入 publish.* 审计并保留现场，允许人工重试；不影响 v1 已完成的本地产物。'
  }
]

function FrozenRow({ label, values }: { label: string; values: readonly string[] }): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '7px 0',
        borderBottom: '1px dashed var(--color-border)'
      }}
    >
      <span className="muted" style={{ flex: '0 0 96px', fontSize: 12, paddingTop: 1 }}>
        {label}
      </span>
      <span
        className="mono"
        style={{ fontSize: 11.5, lineHeight: 1.7, wordBreak: 'break-all', color: 'var(--color-text)' }}
      >
        {values.join(' / ')}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 页面（v1 占位，不触发任何 IPC）                                      */
/* ------------------------------------------------------------------ */

export default function PublishPage(): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 1080, margin: '0 auto', fontSize: 13 }}>
      <Card
        title={
          <div className="row" style={{ gap: 10 }}>
            <span style={{ fontSize: 16 }}>发布（v2）</span>
            <Badge tone="gray" dot={false}>
              v2 预留
            </Badge>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13 }}>发布能力将在后续版本提供，v2 规划包含：</div>
          <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
            <li>
              <span style={{ fontWeight: 600 }}>种子制作</span>：调用 μTorrent 生成种子文件。
            </li>
            <li>
              <span style={{ fontWeight: 600 }}>发布站上传</span>（可选）：当前按单站设计，通过适配器接入。
            </li>
            <li>
              <span style={{ fontWeight: 600 }}>做种</span>：交给 qBittorrent 强制做种，并持续监控做种状态。
            </li>
          </ul>
          <div
            style={{
              background: 'var(--color-warning-soft)',
              border: '1px solid #fde68a',
              color: '#92400e',
              borderRadius: 'var(--radius-control)',
              padding: '9px 11px',
              fontSize: 12.5,
              lineHeight: 1.7
            }}
          >
            v1 的流程在 <span className="mono">DONE</span>（已完成）结束：<strong>不制作种子、不上传发布站、不做种</strong>
            ，本页也不会出现任何可执行的制种 / 上传 / 做种按钮。
          </div>
        </div>
      </Card>

      <Card
        title="已冻结的接口 / 数据方向"
        extra={
          <Badge tone="teal" dot={false}>
            只读
          </Badge>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <FrozenRow label="数据表" values={FROZEN_TABLES} />
          <FrozenRow label="适配器接口" values={FROZEN_INTERFACES} />
          <FrozenRow label="审计前缀" values={['publish.*']} />
          <FrozenRow label="状态枚举" values={PUBLISH_STATES} />
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.7 }}>
          v1 只保留上述定义与 <span className="mono">publish</span> 设置分组（保存时强制禁用），不实现对应服务、不建表、不写入任何{' '}
          <span className="mono">publish.*</span> 审计记录。
        </div>
      </Card>

      <Card title="流程说明">
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--color-primary)', userSelect: 'none' }}>
            了解发布流程（v2 步骤）
          </summary>
          <ol style={{ margin: '10px 0 0', paddingLeft: 20, lineHeight: 1.7, fontSize: 12.5 }}>
            {V2_STEPS.map((step) => (
              <li key={step.title} style={{ marginBottom: 8 }}>
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--color-text)' }}>
                  {step.title}
                </span>
                <div className="muted" style={{ fontSize: 12 }}>
                  {step.detail}
                </div>
              </li>
            ))}
          </ol>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            以上仅为 v2 设计说明，v1 不提供执行入口。
          </div>
        </details>
      </Card>
    </div>
  )
}
