import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface FieldProps {
  /** 字段名（作为 label 文案） */
  label: ReactNode;
  /**
   * 关联控件的 id。传了就渲染成 <label htmlFor>，读屏点击标签能聚焦控件，
   * 也能把字段名读出来——这是原来 5 份副本各自用 <div> 丢掉的东西。
   */
  htmlFor?: string;
  /**
   * label 自身的 id。给「一组」控件用（颜色/图标这种一排按钮）：
   * label 只能 htmlFor 到单个 labelable 元素，一组控件得靠
   * 子容器上的 role="group" aria-labelledby={这个 id}。
   */
  labelId?: string;
  /** 右侧灰色辅助文案（字数/单位提示） */
  hint?: ReactNode;
  /** 必填星号 */
  required?: boolean;
  /** label 文字样式：需要弱化成 muted 时覆盖 */
  labelClassName?: string;
  /** label 行与控件的间距，默认 6px（账号表单原本用 space-y-2=8px，传 'mb-2'） */
  className?: string;
  children?: ReactNode;
}

/**
 * 表单字段容器：label + 右侧 hint + 控件槽位。
 * Modal 通过 portal 挂到 body，脱离 AppLayout 的 text-text 根色，
 * 所以 label 必须显式声明颜色，否则暗黑模式下退回浏览器默认纯黑不可见。
 */
export function Field({
  label,
  htmlFor,
  labelId,
  hint,
  required,
  labelClassName,
  className,
  children,
}: FieldProps) {
  // 星号是纯视觉装饰。不加 aria-hidden 的话，它会混进 label 的可访问名，
  // 读屏把「分类 *」念成「分类 星号」——aria-hidden 在 label 内部同样生效。
  const star = required ? (
    <span aria-hidden className="text-danger dark:text-danger-dark ml-0.5">
      *
    </span>
  ) : null;
  const labelCls = clsx(labelClassName ?? 'text-sm text-text dark:text-text-dark');

  return (
    <div>
      <div className={clsx('flex items-center justify-between', className ?? 'mb-1.5')}>
        {htmlFor ? (
          <label htmlFor={htmlFor} id={labelId} className={labelCls}>
            {label}
            {star}
          </label>
        ) : (
          <div id={labelId} className={labelCls}>
            {label}
            {star}
          </div>
        )}
        {hint && <span className="text-xs text-text-muted dark:text-text-muted-dark">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
