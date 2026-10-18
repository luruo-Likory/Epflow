import React, { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

export interface Column<T> {
  key: string
  header: string
  width?: number | string
  align?: 'left' | 'right' | 'center'
  render: (row: T, index: number) => React.ReactNode
}

export interface VirtualTableProps<T> {
  rows: T[]
  columns: Array<Column<T>>
  rowKey: (row: T, index: number) => string
  selectedKey?: string | null
  onRowClick?: (row: T, index: number) => void
  rowHeight?: number
  className?: string
  rowClassName?: (row: T, index: number) => string | undefined
  height?: number | string
}

/** 虚拟滚动表格：首屏只渲染可视行，5000 行也能 < 1s 打开 */
export function VirtualTable<T>({
  rows,
  columns,
  rowKey,
  selectedKey,
  onRowClick,
  rowHeight = 34,
  className,
  rowClassName,
  height
}: VirtualTableProps<T>): React.ReactElement {
  const parentRef = useRef<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 14
  })
  const items = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  return (
    <div
      ref={parentRef}
      className={`table-wrap${className ? ` ${className}` : ''}`}
      style={{ height: height ?? '100%', overflow: 'auto', position: 'relative' }}
    >
      <div style={{ minWidth: '100%', width: 'max-content' }}>
        <div
          style={{
            display: 'flex',
            position: 'sticky',
            top: 0,
            zIndex: 3,
            background: '#f8fafc',
            borderBottom: '1px solid var(--color-border)',
            height: 30,
            fontSize: 12,
            color: 'var(--color-text-muted)'
          }}
        >
          {columns.map((col) => (
            <div
              key={col.key}
              style={{
                width: col.width ?? 'auto',
                flex: col.width ? undefined : 1,
                minWidth: 60,
                padding: '0 8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: col.align === 'right' ? 'flex-end' : col.align === 'center' ? 'center' : 'flex-start',
                whiteSpace: 'nowrap'
              }}
            >
              {col.header}
            </div>
          ))}
        </div>

        <div style={{ height: totalSize, position: 'relative' }}>
          {items.map((item) => {
            const row = rows[item.index]
            if (!row) return null
            const key = rowKey(row, item.index)
            const selected = selectedKey === key
            return (
              <div
                key={key}
                className={rowClassName?.(row, item.index)}
                onClick={() => onRowClick?.(row, item.index)}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: rowHeight,
                  transform: `translateY(${item.start}px)`,
                  display: 'flex',
                  alignItems: 'center',
                  fontSize: 12.5,
                  borderBottom: '1px solid #f1f5f9',
                  cursor: onRowClick ? 'pointer' : 'default',
                  background: selected ? 'var(--color-primary-soft)' : undefined
                }}
                onMouseEnter={(e) => {
                  if (!selected) (e.currentTarget as HTMLDivElement).style.background = '#f8fafc'
                }}
                onMouseLeave={(e) => {
                  if (!selected) (e.currentTarget as HTMLDivElement).style.background = ''
                }}
              >
                {columns.map((col) => (
                  <div
                    key={col.key}
                    style={{
                      width: col.width ?? 'auto',
                      flex: col.width ? undefined : 1,
                      minWidth: 40,
                      padding: '0 8px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent:
                        col.align === 'right' ? 'flex-end' : col.align === 'center' ? 'center' : 'flex-start'
                    }}
                  >
                    {col.render(row, item.index)}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
      {rows.length === 0 && (
        <div className="empty" style={{ position: 'sticky', left: 0 }}>
          <div className="title">暂无数据</div>
        </div>
      )}
    </div>
  )
}
