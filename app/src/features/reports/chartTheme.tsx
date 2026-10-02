/**
 * recharts 暗黑模式适配层
 * ---------------------------------------------------------------
 * recharts 的默认 Tooltip / Legend 把颜色写死在 JS 里（#fff 背景、图例文字
 * 直接取系列色），不随 html.dark 变化，暗黑模式下会出现"白底浅字"或
 * 亮色图例压在深色卡片上。
 *
 * 这里提供两个自定义 content 组件，全部改用 Tailwind token：
 *   - ChartTooltip：卡片底色 / 边框 / 文字全部走 bg-card、border、text，
 *     formatter 与 labelFormatter 沿用 recharts 原签名，调用方无需改。
 *   - ChartLegend：色块保留系列色，文字改用 muted 前景色。
 *
 * 仅供图表使用（reports / dashboard），不参与业务计算。
 */
import type { CSSProperties, ReactNode } from 'react';

/** recharts payload 里我们实际用到的字段（其余字段忽略） */
export interface ChartPayloadEntry {
  name?: string | number;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
  hide?: boolean;
}

/** 与 recharts Formatter 同签名：返回 [格式化后的值, 格式化后的名称] */
export type ChartFormatter = (
  value: number | string,
  name: string,
  entry: ChartPayloadEntry,
  index: number,
) => [ReactNode, ReactNode];

export interface ChartTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<ChartPayloadEntry>;
  label?: string | number;
  labelFormatter?: (label: string) => ReactNode;
  formatter?: ChartFormatter;
  /** 保留 recharts 会透传的其他 props，避免 noUnused 之外的结构不匹配 */
  labelStyle?: CSSProperties;
  itemStyle?: CSSProperties;
  wrapperStyle?: CSSProperties;
}

/**
 * 主题感知的悬浮提示。
 * 显式给每一级文字上色，避免依赖祖先的 `color` 继承（图表卡片内是安全的，
 * 但浮层里 recharts 会把提示挂在 body 上）。
 */
export function ChartTooltip({
  active,
  payload,
  label,
  labelFormatter,
  formatter,
}: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  const showLabel = label != null && label !== '';

  return (
    <div className="rounded-xl border border-border dark:border-border-dark bg-bg-card dark:bg-bg-card-dark px-3 py-2 text-xs shadow-soft dark:shadow-soft-dark">
      {showLabel && (
        <div className="mb-1 font-medium text-text dark:text-text-dark">
          {labelFormatter ? labelFormatter(String(label)) : label}
        </div>
      )}
      <ul className="space-y-0.5">
        {payload.map((entry, i) => {
          if (entry.hide === true) return null;
          const rawName = String(entry.name ?? entry.dataKey ?? '');
          const rawValue = entry.value ?? '';
          let valueNode: ReactNode = typeof rawValue === 'number' ? rawValue : String(rawValue);
          let nameNode: ReactNode = rawName;
          if (formatter) {
            const formatted = formatter(rawValue, rawName, entry, i);
            if (Array.isArray(formatted)) {
              valueNode = formatted[0];
              nameNode = formatted[1];
            }
          }
          return (
            <li
              key={`${rawName}-${i}`}
              className="flex items-center gap-2 text-text-muted dark:text-text-muted-dark"
            >
              {entry.color && (
                <span
                  className="w-2 h-2 rounded-sm flex-none"
                  style={{ background: entry.color }}
                />
              )}
              <span className="text-text dark:text-text-dark font-medium tabular-nums">
                {valueNode}
              </span>
              <span>{nameNode}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export interface ChartLegendProps {
  payload?: ReadonlyArray<{
    value?: string | number;
    color?: string;
    type?: string;
  }>;
  formatter?: (value: string) => string;
}

/**
 * 主题感知的图例：色块用系列色（与图形对应），
 * 文字用 muted 前景色，避免红/绿文字直接压在深色卡片上导致发飘。
 */
export function ChartLegend({ payload, formatter }: ChartLegendProps) {
  if (!payload || payload.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-1 text-xs text-text-muted dark:text-text-muted-dark">
      {payload.map((item, i) => (
        <li key={`${item.value ?? i}`} className="inline-flex items-center gap-1.5">
          <span
            className="w-2.5 h-2.5 rounded-sm flex-none"
            style={{ background: item.color }}
          />
          <span>{formatter ? formatter(String(item.value ?? '')) : item.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** 柱状图悬浮光标：跟随 currentColor，深浅色下都是低透明度同色系 */
export const BAR_CURSOR = { fill: 'currentColor', fillOpacity: 0.08 };

/** 折线 / 面积图悬浮光标 */
export const LINE_CURSOR = {
  stroke: 'currentColor',
  strokeWidth: 1,
  strokeDasharray: '3 3',
};
