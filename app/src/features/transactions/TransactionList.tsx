/**
 * 交易流水主页面
 * ---------------------------------------------------------------
 * - URL `?create=1` 自动打开新建模态
 * - URL `?import=1` 自动切到批量导入视图
 * - 空状态：标题 / 描述 / "新建流水" + "批量导入" 按钮
 * - 列表页：顶部筛选 + 列表
 * - 导入视图：账单导入 / 历史记录
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  IconArrowsLeftRight,
  IconPlus,
  IconUpload,
  IconEye,
  IconShare,
} from '@tabler/icons-react';
import { PageHeader, Button, EmptyState, Tabs } from '@/components/ui';
import { db, type Transaction } from '@/db';
import TransactionListView from './TransactionListView';
import TransactionFilterBar from './TransactionFilterBar';
import TransactionFormModal from './TransactionFormModal';
import TransactionImportView from './TransactionImportView';
import type { TxFilter } from './balance';

type View = 'list' | 'import';

export default function TransactionList() {
  const [params, setParams] = useSearchParams();
  const initialView: View = params.get('import') === '1' ? 'import' : 'list';
  const [view, setView] = useState<View>(initialView);

  const [filter, setFilter] = useState<TxFilter>({});
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [creating, setCreating] = useState(initialView !== 'list' ? false : params.get('create') === '1');

  // 通过 URL 自动打开新建模态
  useEffect(() => {
    if (params.get('create') === '1') {
      setCreating(true);
      setView('list');
    }
  }, [params]);

  const totalCount = useLiveQuery(() => db.transactions.count(), [], 0);

  const showEmpty = totalCount === 0 && view === 'list';

  function openCreate() {
    setEditing(null);
    setCreating(true);
  }

  function openEdit(tx: Transaction) {
    setEditing(tx);
    setCreating(true);
  }

  function closeModal() {
    setCreating(false);
    setEditing(null);
    // 同时清理 URL 中的 ?create=1
    if (params.get('create')) {
      const np = new URLSearchParams(params);
      np.delete('create');
      setParams(np, { replace: true });
    }
  }

  const headerActions = useMemo(
    () => (
      <div className="flex items-center gap-2 text-text-muted">
        <IconEye size={18} className="cursor-pointer hover:text-text dark:hover:text-text-dark" />
        <IconShare size={18} className="cursor-pointer hover:text-text dark:hover:text-text-dark" />
      </div>
    ),
    [],
  );

  return (
    <div className="min-h-full bg-bg dark:bg-bg-dark">
      <PageHeader
        title="交易流水"
        icon={<IconArrowsLeftRight size={18} />}
        actions={headerActions}
      />

      <div className="p-8 space-y-5 max-w-[1200px] mx-auto">
        <div className="flex items-center justify-between">
          <Tabs
            variant="line"
            activeKey={view}
            onChange={(k) => {
              const nv = k as View;
              setView(nv);
              // 切到 import 时清掉 import/create 参数避免歧义
              if (nv === 'import') {
                if (params.get('import') !== '1') {
                  const np = new URLSearchParams(params);
                  np.set('import', '1');
                  setParams(np, { replace: true });
                }
              } else {
                if (params.get('import')) {
                  const np = new URLSearchParams(params);
                  np.delete('import');
                  setParams(np, { replace: true });
                }
              }
            }}
            items={[
              { key: 'list', label: '流水列表' },
              { key: 'import', label: '账单导入' },
            ]}
          />
          {view === 'list' && (
            <Button icon={<IconPlus size={14} />} onClick={openCreate}>
              新建流水
            </Button>
          )}
        </div>

        {view === 'list' &&
          (showEmpty ? (
            <EmptyState
              title="创建流水"
              description={
                <>
                  <div>流水记录每一笔收支，包括工资收入、日常消费、转账、投资理财等</div>
                </>
              }
              action={
                <div className="flex items-center gap-2">
                  <Button icon={<IconPlus size={14} />} onClick={openCreate}>
                    新建流水
                  </Button>
                  <Button
                    variant="secondary"
                    icon={<IconUpload size={14} />}
                    onClick={() => setView('import')}
                  >
                    批量导入
                  </Button>
                </div>
              }
            />
          ) : (
            <>
              <TransactionFilterBar filter={filter} onChange={setFilter} />
              <TransactionListView filter={filter} onEdit={openEdit} />
            </>
          ))}

        {view === 'import' && <TransactionImportView />}
      </div>

      <TransactionFormModal open={creating} onClose={closeModal} editing={editing} />
    </div>
  );
}
