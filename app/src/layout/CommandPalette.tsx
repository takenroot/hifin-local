import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui';
import { IconSearch, IconArrowRight, IconCommand } from '@tabler/icons-react';

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  navigate: (to: string) => void;
}

interface CmdItem {
  id: string;
  label: string;
  hint?: string;
  group: string;
  to: string;
}

const DEFAULT_ITEMS: CmdItem[] = [
  { id: 'home', label: '看板', group: '目录', to: '/home' },
  { id: 'accounts', label: '账户', group: '目录', to: '/account/list' },
  { id: 'goals', label: '目标', group: '目录', to: '/goal/list' },
  { id: 'budgets', label: '预算', group: '目录', to: '/home' },
  { id: 'transactions', label: '交易', group: '目录', to: '/transaction' },
  { id: 'reports', label: '报表', group: '目录', to: '/report/list' },
  { id: 'discover', label: '发现', group: '目录', to: '/home' },
  { id: 'settings', label: '设置', group: '操作', to: '/settings' },
];

/**
 * 全局命令面板（⌘K）：列表 + 过滤 + Enter 跳转。
 */
export function CommandPalette({ open, onClose, navigate }: CommandPaletteProps) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return DEFAULT_ITEMS;
    return DEFAULT_ITEMS.filter((it) => it.label.toLowerCase().includes(q));
  }, [query]);

  return (
    <Modal open={open} onClose={onClose} width={520} hideClose>
      <div className="-mx-6 -mt-2">
        <div className="flex items-center gap-2 px-5 h-12 border-b border-border dark:border-border-dark">
          <IconSearch size={16} className="text-text-muted" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索或输入指令…"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-text-muted"
          />
          <span className="flex items-center gap-1 text-xs text-text-muted">
            <IconCommand size={12} />K
          </span>
        </div>
        <div className="max-h-[60vh] overflow-auto py-2">
          {items.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-text-muted">未找到结果</div>
          )}
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => {
                navigate(it.to);
                onClose();
              }}
              className="w-full flex items-center justify-between gap-3 px-5 h-10 hover:bg-bg dark:hover:bg-bg-dark text-left"
            >
              <span className="flex items-center gap-3 min-w-0">
                <span className="text-xs text-text-muted w-12 flex-none">{it.group}</span>
                <span className="text-sm truncate">{it.label}</span>
              </span>
              <IconArrowRight size={14} className="text-text-muted" />
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
