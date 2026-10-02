/**
 * 设置中心主布局：左 240px 分组菜单 + 右侧内容区。
 *
 * 内容区 padding 与 PageHeader 视觉一致；菜单与路由 section 通过 props 通讯，
 * 父组件 SettingsPage 控制 URL ?section。
 */
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { SETTINGS_GROUPS, type SettingsSectionKey } from './menu';

interface SettingsLayoutProps {
  active: SettingsSectionKey;
  onSelect: (key: SettingsSectionKey) => void;
  children: ReactNode;
}

export function SettingsLayout({ active, onSelect, children }: SettingsLayoutProps) {
  return (
    <div className="flex min-h-[calc(100vh-64px)]">
      {/* 左侧菜单 */}
      <aside className="w-[240px] flex-none border-r border-border dark:border-border-dark px-4 py-6 hidden md:block">
        <nav className="space-y-6">
          {SETTINGS_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="flex items-center justify-between px-2 mb-2">
                <span className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                  {group.label}
                </span>
                <span className="h-px flex-1 ml-3 bg-border dark:bg-border-dark" />
              </div>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const isActive = item.key === active;
                  return (
                    <li key={item.key}>
                      <button
                        type="button"
                        onClick={() => onSelect(item.key)}
                        className={clsx(
                          'w-full flex items-center gap-2.5 h-9 px-3 rounded-xl text-sm transition',
                          isActive
                            ? 'bg-bg dark:bg-bg-card-dark text-text dark:text-text-dark font-medium'
                            : 'text-text-muted dark:text-text-muted-dark hover:bg-bg dark:hover:bg-bg-card-dark hover:text-text dark:hover:text-text-dark',
                        )}
                      >
                        <span
                          className={clsx(
                            'flex-none',
                            isActive ? 'text-brand' : 'text-text-muted dark:text-text-muted-dark',
                          )}
                        >
                          {item.icon}
                        </span>
                        <span className="truncate">{item.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      {/* 移动端横向滚动菜单（< md 时显示） */}
      <div className="md:hidden w-full border-b border-border dark:border-border-dark px-4 py-3 overflow-x-auto">
        <div className="flex gap-2 min-w-max">
          {SETTINGS_GROUPS.flatMap((g) => g.items).map((it) => (
            <button
              key={it.key}
              type="button"
              onClick={() => onSelect(it.key)}
              className={clsx(
                'inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs whitespace-nowrap transition',
                it.key === active
                  ? 'bg-text text-bg-card dark:bg-bg-card-dark dark:text-text-dark'
                  : 'text-text-muted dark:text-text-muted-dark bg-bg dark:bg-bg-card-dark',
              )}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      </div>

      {/* 内容区 */}
      <main className="flex-1 min-w-0 px-4 py-8 lg:px-10">
        <div className="max-w-[960px] mx-auto">{children}</div>
      </main>
    </div>
  );
}