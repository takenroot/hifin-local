/**
 * 报表模板 / 图标元数据
 *
 * 仅供 reports 模块内部使用。
 */
import type { Report } from '@/db';

/** 模板 key 类型 */
export type ReportTemplate = 'monthly' | 'yearly' | 'distribution' | 'budget';

export interface ReportTemplateMeta {
  key: ReportTemplate;
  label: string;
  description: string;
  icon: string;
  tone: string;
}

export const REPORT_TEMPLATES: ReportTemplateMeta[] = [
  {
    key: 'monthly',
    label: '月度收支',
    description: '近 12 月的收入与支出趋势',
    icon: '📊',
    tone: '#6366f1',
  },
  {
    key: 'yearly',
    label: '年度总结',
    description: '当年收支汇总 + 月度趋势',
    icon: '📈',
    tone: '#10b981',
  },
  {
    key: 'distribution',
    label: '资产分布',
    description: '按账户/类型查看资产占比',
    icon: '🥧',
    tone: '#f59e0b',
  },
  {
    key: 'budget',
    label: '预算执行',
    description: '跟踪预算使用情况（占位）',
    icon: '🎯',
    tone: '#ec4899',
  },
];

/** 给模板 key 取元数据 */
export function templateMeta(key: string | undefined): ReportTemplateMeta {
  return REPORT_TEMPLATES.find((t) => t.key === key) ?? REPORT_TEMPLATES[0];
}

/** 报表图标选项 */
export const REPORT_ICON_CHOICES: string[] = [
  '📊',
  '📈',
  '🥧',
  '🎯',
  '💼',
  '💰',
  '📉',
  '🧾',
  '📋',
  '📁',
];

/** 报表颜色选项（与 goals 保持一致） */
export const REPORT_COLOR_CHOICES: string[] = [
  '#6366f1',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#ef4444',
  '#0ea5e9',
  '#a855f7',
  '#6b7280',
];

/** 类型守卫：检查 Report.template 是否是支持的模板 key */
export function isReportTemplateKey(
  key: string | undefined | null,
): key is ReportTemplate {
  if (!key) return false;
  return REPORT_TEMPLATES.some((t) => t.key === key);
}

/** 兼容读取模板 key（老数据可能为空字符串，统一安全降级） */
export function getTemplateKey(r: Report): ReportTemplate {
  return isReportTemplateKey(r.template) ? r.template! : 'monthly';
}
