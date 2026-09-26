/**
 * 设置 → 个性偏好
 *
 * - 主题：写 themeAtom（ThemeProvider 同步 dark class）
 * - 语言：写 languageAtom（仅展示 UI，目前固定 zh-CN）
 * - 默认登录页：写 defaultPageAtom
 * - 菜单显隐：写 menuVisibilityAtom（看板/预算/目标/报表/发现）
 */
import { useAtom } from 'jotai';
import {
  IconLayoutDashboard,
  IconCirclePlus,
  IconTarget,
  IconChartBar,
  IconSparkles,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { Card, Switch, Select } from '@/components/ui';
import {
  themeAtom,
  languageAtom,
  defaultPageAtom,
  menuVisibilityAtom,
  type Theme,
} from '@/store/atoms';
import {
  DEFAULT_PAGE_OPTIONS,
  LANGUAGE_OPTIONS,
} from '../menu';

type MenuKey = 'budget' | 'goal' | 'report' | 'discover';

const MENU_ROWS: { key: MenuKey; label: string; icon: React.ReactNode }[] = [
  { key: 'budget', label: '预算', icon: <IconCirclePlus size={16} /> },
  { key: 'goal', label: '目标', icon: <IconTarget size={16} /> },
  { key: 'report', label: '报表', icon: <IconChartBar size={16} /> },
  { key: 'discover', label: '发现', icon: <IconSparkles size={16} /> },
];

export function PreferencesSection() {
  const [theme, setTheme] = useAtom(themeAtom);
  const [language, setLanguage] = useAtom(languageAtom);
  const [defaultPage, setDefaultPage] = useAtom(defaultPageAtom);
  const [mv, setMv] = useAtom(menuVisibilityAtom);

  return (
    <div className="space-y-4">
      {/* 主题 + 语言 */}
      <Card
        title={
          <div>
            <div className="text-base font-medium">外观与语言</div>
            <div className="text-xs text-text-muted mt-1">
              设置您的主题、字体大小和其他偏好设置
            </div>
          </div>
        }
      >
        <div className="divide-y divide-border dark:divide-border-dark">
          {/* 主题 */}
          <div className="flex items-center justify-between gap-4 py-3 first:pt-0">
            <div className="min-w-0">
              <div className="text-sm text-text dark:text-text-dark">主题</div>
              <div className="text-xs text-text-muted mt-1">
                选择您的主题，切换纯白或暗黑模式
              </div>
            </div>
            <div className="flex items-center gap-3 flex-none">
              <span className="text-xs text-text-muted">
                {theme === 'dark' ? '暗黑' : '浅色'}
              </span>
              <Switch
                checked={theme === 'dark'}
                onChange={(v) => setTheme((v ? 'dark' : 'light') as Theme)}
              />
            </div>
          </div>

          {/* 语言 */}
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="min-w-0">
              <div className="text-sm text-text dark:text-text-dark">语言</div>
              <div className="text-xs text-text-muted mt-1">
                切换语言（当前仅简体中文；其他为占位）
              </div>
            </div>
            <div className="w-[180px] flex-none">
              <Select
                value={language}
                options={LANGUAGE_OPTIONS}
                onChange={(e) => setLanguage(e.target.value)}
              />
            </div>
          </div>

          {/* 默认登录页 */}
          <div className="flex items-center justify-between gap-4 py-3 last:pb-0">
            <div className="min-w-0">
              <div className="text-sm text-text dark:text-text-dark">默认登录页</div>
              <div className="text-xs text-text-muted mt-1">
                选择您的默认登录页
              </div>
            </div>
            <div className="w-[180px] flex-none">
              <Select
                value={defaultPage}
                options={DEFAULT_PAGE_OPTIONS}
                onChange={(e) => setDefaultPage(e.target.value)}
              />
            </div>
          </div>
        </div>
      </Card>

      {/* 菜单显隐 */}
      <Card
        title={
          <div>
            <div className="text-base font-medium">菜单显隐</div>
            <div className="text-xs text-text-muted mt-1">
              可以隐藏部分菜单
            </div>
          </div>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <MenuRow
            icon={<IconLayoutDashboard size={16} />}
            label="看板"
            checked
            disabled
          />
          {MENU_ROWS.map((row) => (
            <MenuRow
              key={row.key}
              icon={row.icon}
              label={row.label}
              checked={mv[row.key]}
              onChange={(v) =>
                setMv((prev) => ({ ...prev, [row.key]: v }))
              }
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

function MenuRow({
  icon,
  label,
  checked,
  onChange,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={clsx(
        'flex items-center justify-between gap-3 px-4 h-12 rounded-xl',
        'border border-border dark:border-border-dark',
        disabled && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-text-muted">{icon}</span>
        <span className="text-sm truncate">{label}</span>
      </div>
      <Switch
        checked={checked}
        onChange={(v) => onChange?.(v)}
        disabled={disabled}
      />
    </div>
  );
}