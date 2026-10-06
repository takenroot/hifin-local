/**
 * LabDataSwitch — 实验室数据源开关（静态样例 ↔ 真实数据）
 * ---------------------------------------------------------------
 * 放在两个 lab 页的横幅右侧。真实数据失败时横幅上显示红字错误（页面保留
 * mock 兜底渲染，见 useLabData 的失败语义）。
 */
import { useAtom } from 'jotai';
import clsx from 'clsx';
import { labRealDataAtom } from './useLabData';

export function LabDataSwitch({ error }: { error?: string | null }) {
  const [real, setReal] = useAtom(labRealDataAtom);
  return (
    <span className="flex items-center gap-2">
      {error && (
        <span className="text-expense dark:text-expense-dark" role="alert">
          真实数据加载失败（core 离线？已回退样例）
        </span>
      )}
      {/* role=group 命名约定（field-convergence）：aria-labelledby 指向真实存在的 span id */}
      <span
        role="group"
        aria-labelledby="lab-data-switch-label"
        className="inline-flex h-7 rounded-lg bg-bg dark:bg-bg-dark p-0.5 text-xs flex-none"
      >
        <span id="lab-data-switch-label" className="sr-only">
          实验室数据源
        </span>
        {(
          [
            [false, '静态样例'],
            [true, '真实数据'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={label}
            type="button"
            aria-pressed={real === value}
            onClick={() => setReal(value)}
            className={clsx(
              'px-2.5 h-6 rounded-md transition-colors',
              real === value
                ? 'bg-bg-card dark:bg-bg-card-dark shadow-sm font-medium text-text dark:text-text-dark'
                : 'text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark',
            )}
          >
            {label}
          </button>
        ))}
      </span>
    </span>
  );
}
