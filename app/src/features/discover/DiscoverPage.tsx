/**
 * 发现页 — 基于本地数据的财务洞察
 */
import { useMemo } from 'react';
import dayjs from 'dayjs';
import { Link } from 'react-router-dom';
import {
  IconSparkles,
  IconTrendingUp,
  IconTrendingDown,
  IconPigMoney,
  IconReceipt2,
  IconFlame,
  IconAlertTriangle,
  IconTargetArrow,
  IconBulb,
} from '@tabler/icons-react';
import { Badge, Card, EmptyState, PageHeader, ProgressBar } from '@/components/ui';
import { useSpaceId } from '@/db';
import type { Budget, Category, Goal, Transaction } from '@/db';
import { useApi } from '@/hooks/useApi';
import {
  budgetAlerts,
  formatMoney,
  largestExpense,
  monthOverMonth,
  streakDays,
  sumByType,
  topCategories,
  upcomingGoals,
} from './insights';

const TIPS: { title: string; body: string }[] = [
  { title: '先储蓄，后消费', body: '工资到账先把 10%-20% 转入储蓄账户，剩下的再安排支出。' },
  { title: '50 / 30 / 20 法则', body: '50% 必要开支、30% 弹性消费、20% 储蓄与投资，简单易坚持的分配框架。' },
  { title: '应急基金', body: '常备 3-6 个月生活费的流动资金，放在随取随用的账户里。' },
  { title: '每周复盘一次', body: '每周花 5 分钟过一遍流水，及时发现“拿铁因子”式的隐形支出。' },
];

export function DiscoverPage() {
  const spaceId = useSpaceId();
  // 空间过滤直接拼 URL：spaceId=0 表示"全部空间"，不带参数由后端返回全量。
  const spaceQuery = spaceId ? `?spaceId=${spaceId}` : '';
  const today = useMemo(() => dayjs(), []);
  const monthFrom = today.startOf('month').valueOf();
  const monthTo = today.add(1, 'month').startOf('month').valueOf();
  const prevFrom = today.subtract(1, 'month').startOf('month').valueOf();

  const txsRes = useApi<Transaction[]>(`/api/transactions${spaceQuery}`, [spaceId]);
  const budgetsRes = useApi<Budget[]>(`/api/budgets${spaceQuery}`, [spaceId]);
  const goalsRes = useApi<Goal[]>(`/api/goals${spaceQuery}`, [spaceId]);
  const categoriesRes = useApi<Category[]>('/api/categories');

  const txs = txsRes.data ?? [];
  const budgets = budgetsRes.data ?? [];
  const goals = goalsRes.data ?? [];
  const categories = categoriesRes.data ?? [];

  const loading = txsRes.loading || budgetsRes.loading;
  const loadError = txsRes.error ?? budgetsRes.error ?? goalsRes.error ?? categoriesRes.error;

  const monthExpense = useMemo(() => sumByType(txs, 'expense', monthFrom, monthTo), [txs, monthFrom, monthTo]);
  const monthIncome = useMemo(() => sumByType(txs, 'income', monthFrom, monthTo), [txs, monthFrom, monthTo]);
  const prevExpense = useMemo(() => sumByType(txs, 'expense', prevFrom, monthFrom), [txs, prevFrom, monthFrom]);
  const expenseMoM = useMemo(() => monthOverMonth(monthExpense, prevExpense), [monthExpense, prevExpense]);
  const savingsRate = monthIncome > 0 ? Math.max(0, ((monthIncome - monthExpense) / monthIncome) * 100) : null;
  const largest = useMemo(() => largestExpense(txs), [txs]);
  const top3 = useMemo(() => topCategories(txs, categories, monthFrom, monthTo), [txs, categories, monthFrom, monthTo]);
  const streak = useMemo(() => streakDays(txs, today), [txs, today]);
  const alerts = useMemo(() => budgetAlerts(budgets, txs), [budgets, txs]);
  const dueSoon = useMemo(() => upcomingGoals(goals, 30, today), [goals, today]);

  const hasData = txs.length > 0;

  return (
    <div>
      <PageHeader
        icon={<IconSparkles size={18} />}
        title="发现"
        description="基于你的数据生成的财务洞察"
      />
      <div className="p-4 lg:p-8 max-w-[1200px] mx-auto space-y-6">
        {loadError ? (
          <EmptyState
            title="洞察数据加载失败"
            description={`无法从服务端读取数据：${loadError}`}
          />
        ) : loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-28 rounded-xl bg-bg dark:bg-bg-card-dark animate-pulse" />
            ))}
          </div>
        ) : !hasData ? (
          <EmptyState
            title="还没有数据可以洞察"
            description="先记录几笔流水，这里会生成你的专属财务洞察"
            action={
              <Link to="/transaction?create=1">
                <span className="inline-flex items-center gap-1 rounded-xl bg-text px-4 py-2 text-sm text-bg-card dark:bg-bg-card-dark dark:text-text-dark">
                  去记第一笔
                </span>
              </Link>
            }
          />
        ) : (
          <>
            {/* 数据洞察卡片 */}
            <section>
              <h2 className="section-title mb-3">数据洞察</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                <Card>
                  <div className="flex items-center gap-2 text-sm text-text-muted">
                    <IconReceipt2 size={16} /> 本月支出
                  </div>
                  <div className="mt-2 text-xl font-medium text-expense tabular-nums">
                    {formatMoney(monthExpense)}
                  </div>
                  {expenseMoM !== null && (
                    <div className="mt-1 flex items-center gap-1 text-xs">
                      {expenseMoM <= 0 ? (
                        <IconTrendingDown size={14} className="text-income" />
                      ) : (
                        <IconTrendingUp size={14} className="text-expense" />
                      )}
                      <span className={expenseMoM <= 0 ? 'text-income' : 'text-expense'}>
                        较上月 {expenseMoM > 0 ? '+' : ''}
                        {expenseMoM.toFixed(1)}%
                      </span>
                    </div>
                  )}
                </Card>

                <Card>
                  <div className="flex items-center gap-2 text-sm text-text-muted">
                    <IconPigMoney size={16} /> 本月储蓄率
                  </div>
                  <div className="mt-2 text-xl font-medium text-income tabular-nums">
                    {savingsRate === null ? '—' : `${savingsRate.toFixed(1)}%`}
                  </div>
                  <div className="mt-1 text-xs text-text-muted">
                    {savingsRate === null
                      ? '本月暂无收入记录'
                      : savingsRate >= 20
                      ? '很棒，超过了 20% 的健康线'
                      : '低于 20%，可以试试 50/30/20 法则'}
                  </div>
                </Card>

                <Card>
                  <div className="flex items-center gap-2 text-sm text-text-muted">
                    <IconFlame size={16} /> 连续记账
                  </div>
                  <div className="mt-2 text-xl font-medium tabular-nums">{streak} 天</div>
                  <div className="mt-1 text-xs text-text-muted">
                    {streak >= 7 ? '坚持就是胜利 🔥' : '每天记一笔，养成好习惯'}
                  </div>
                </Card>

                {largest && (
                  <Card>
                    <div className="text-sm text-text-muted">单笔最大支出</div>
                    <div className="mt-2 text-xl font-medium text-expense tabular-nums">
                      {formatMoney(largest.amount)}
                    </div>
                    <div className="mt-1 text-xs text-text-muted truncate">
                      {largest.name || '未命名'} · {dayjs(largest.date).format('MM月DD日')}
                    </div>
                  </Card>
                )}

                {top3.length > 0 && (
                  <Card className="md:col-span-2">
                    <div className="text-sm text-text-muted mb-3">本月支出 TOP{top3.length} 分类</div>
                    <div className="space-y-3">
                      {top3.map((c) => (
                        <div key={c.categoryId} className="flex items-center gap-3">
                          <span className="w-8 h-8 rounded-lg bg-bg dark:bg-bg-card-dark flex items-center justify-center flex-none">
                            {c.icon}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline justify-between gap-2 mb-1">
                              <span className="text-sm truncate">{c.name}</span>
                              <span className="text-sm tabular-nums text-text-muted">
                                {formatMoney(c.amount)} · {c.pct.toFixed(0)}%
                              </span>
                            </div>
                            <ProgressBar value={c.pct} tone="expense" size="sm" />
                          </div>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
              </div>
            </section>

            {/* 提醒区 */}
            <section>
              <h2 className="section-title mb-3">提醒</h2>
              {alerts.length === 0 && dueSoon.length === 0 ? (
                <Card>
                  <div className="py-4 text-center text-sm text-text-muted">✅ 一切正常，预算与目标都在轨道上</div>
                </Card>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {alerts.map(({ budget, spent, pct }) => (
                    <Card key={budget.id}>
                      <div className="flex items-center gap-2 text-sm">
                        <IconAlertTriangle size={16} className={pct >= 100 ? 'text-expense' : 'text-yellow-500'} />
                        <span className="font-medium">{budget.name}</span>
                        <Badge tone={pct >= 100 ? 'expense' : 'warning'}>
                          {pct >= 100 ? '已超支' : '接近上限'}
                        </Badge>
                      </div>
                      <div className="mt-3">
                        <ProgressBar value={Math.min(pct, 100)} tone={pct >= 100 ? 'expense' : 'brand'} size="sm" />
                      </div>
                      <div className="mt-2 text-xs text-text-muted tabular-nums">
                        已花 {formatMoney(spent)} / 预算 {formatMoney(budget.amount)}（{pct.toFixed(0)}%）
                      </div>
                    </Card>
                  ))}
                  {dueSoon.map((g) => (
                    <Card key={g.id}>
                      <div className="flex items-center gap-2 text-sm">
                        <IconTargetArrow size={16} className="text-brand" />
                        <span className="font-medium">{g.name}</span>
                        <Badge tone="brand">
                          还剩 {Math.max(0, dayjs(g.deadline).diff(today, 'day'))} 天
                        </Badge>
                      </div>
                      <div className="mt-3">
                        <ProgressBar
                          value={g.targetAmount > 0 ? (g.currentAmount / g.targetAmount) * 100 : 0}
                          tone="income"
                          size="sm"
                        />
                      </div>
                      <div className="mt-2 text-xs text-text-muted tabular-nums">
                        {formatMoney(g.currentAmount)} / {formatMoney(g.targetAmount)}
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {/* 财务小贴士 */}
        <section>
          <h2 className="section-title mb-3 flex items-center gap-2">
            <IconBulb size={16} /> 财务小贴士
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {TIPS.map((tip) => (
              <Card key={tip.title}>
                <div className="text-sm font-medium">{tip.title}</div>
                <div className="mt-2 text-xs text-text-muted leading-relaxed">{tip.body}</div>
              </Card>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
