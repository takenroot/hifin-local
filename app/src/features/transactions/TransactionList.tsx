/**
 * 交易流水主页面
 * ---------------------------------------------------------------
 * - URL `?create=1` 自动打开新建模态
 * - URL `?import=1` 自动切到批量导入视图
 * - PageHeader 右上角常驻"新建流水"（流水列表 / 统计视图下）
 * - 空状态：标题 / 描述 / "新建流水" + "批量导入" 按钮
 * - 列表页：顶部筛选 + 列表（内含 日/周/月/年 分组切换）
 * - 统计页：月份翻页 + 支出/收入 + 分类饼图 / 排行
 * - 导入视图：账单导入 / 历史记录
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import {
  IconArrowsLeftRight,
  IconPlus,
  IconUpload,
} from '@tabler/icons-react';
import { PageHeader, Button, EmptyStateCard, Tabs } from '@/components/ui';
import { type Transaction, useSpaceId } from '@/db';
import { filterBySpace } from '@/space';
import { useApi } from '@/hooks/useApi';
import TransactionListView from './TransactionListView';
import TransactionStatsView from './TransactionStatsView';
import TransactionFilterBar from './TransactionFilterBar';
import TransactionFormModal from './TransactionFormModal';
import TransactionImportView from './TransactionImportView';
import TransactionCalendar from '@/features/shared/TransactionCalendar';
import type { RestTransaction } from './api';
import type { TxFilter } from './balance';

type View = 'list' | 'import' | 'stats' | 'calendar';

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

  const spaceId = useSpaceId();
  /** 全局写操作版本号：任一增删改成功后自增，驱动所有依赖 REST 的子组件重新拉取 */
  const [version, setVersion] = useState(0);
  const bumpVersion = useCallback(() => setVersion((v) => v + 1), []);

  // spaceId === 0 表示"全部空间"，此时不拼 spaceId 让服务端返回全量
  const spaceQ = spaceId === 0 ? '' : `?spaceId=${spaceId}`;
  const { data: txRows, loading } = useApi<RestTransaction[]>(`/api/transactions${spaceQ}`, [version]);
  const scopedCount = useMemo(
    () => filterBySpace(txRows ?? [], spaceId).length,
    [txRows, spaceId],
  );

  // 日历只依赖最小三字段；直接复用父级已加载的 txRows 与空间隔离结果，
  // 单独再发一次请求只会浪费带宽、引入两份数据不一致的风险。
  const calendarTx = useMemo(
    () =>
      filterBySpace(txRows ?? [], spaceId).map((r) => ({
        date: r.date,
        type: r.type,
        amount: r.amount,
      })),
    [txRows, spaceId],
  );

  // loading 时不算空：否则每次进页面都会先闪一帧"创建流水"空态
  const showEmpty = !loading && scopedCount === 0 && view === 'list';

  /**
   * 日历点日 → 切回列表 tab 并按当日过滤。
   * TxFilter 已有 from/to 日期筛选能力（见 TransactionFilterBar / balance.applyFilter），
   * 这里直接对接：from=startOfDay、to=endOfDay，覆盖用户的"按日查流水"意图。
   * 用函数式更新只覆盖日期维度，不冲掉用户已选的账户/分类等其它条件。
   */
  const onCalendarSelectDay = useCallback((dateKey: string) => {
    const d = dayjs(dateKey);
    setFilter((prev) => ({
      ...prev,
      from: d.startOf('day').valueOf(),
      to: d.endOf('day').valueOf(),
    }));
    setView('list');
  }, []);

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

  return (
    <div className="min-h-full bg-bg dark:bg-bg-dark">
      <PageHeader
        title="交易流水"
        icon={<IconArrowsLeftRight size={18} />}
        actions={
          // 新建入口统一常驻右上角（与账户/预算/目标/报表一致）；导入视图是批量工具页，不给新建入口
          view !== 'import' && (
            <Button icon={<IconPlus size={16} />} onClick={openCreate}>
              新建流水
            </Button>
          )
        }
      />

      <div className="p-4 lg:p-8 space-y-5 max-w-[1400px] mx-auto">
        <div className="flex items-center justify-between" data-testid="tx-view-tabs">
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
              { key: 'stats', label: '统计' },
              { key: 'calendar', label: '日历' },
              { key: 'import', label: '账单导入' },
            ]}
          />
        </div>

        {view === 'list' &&
          (showEmpty ? (
            <EmptyStateCard
              title="创建流水"
              description={
                <>
                  <div>流水记录每一笔收支，包括工资收入、日常消费、转账、投资理财等</div>
                </>
              }
              action={
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    icon={<IconPlus size={14} />}
                    onClick={openCreate}
                  >
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
              <TransactionFilterBar filter={filter} onChange={setFilter} version={version} />
              <TransactionListView
                filter={filter}
                onEdit={openEdit}
                version={version}
                onChanged={bumpVersion}
              />
            </>
          ))}

        {view === 'stats' && <TransactionStatsView version={version} />}

        {view === 'calendar' && (
          <TransactionCalendar transactions={calendarTx} onSelectDay={onCalendarSelectDay} />
        )}

        {view === 'import' && <TransactionImportView onImported={bumpVersion} />}
      </div>

      <TransactionFormModal
        open={creating}
        onClose={closeModal}
        editing={editing}
        version={version}
        onSaved={bumpVersion}
      />
    </div>
  );
}
