/**
 * 设置 → 关于
 *
 * HiFin 本地复刻版说明卡。
 */
import { IconBrandGithub, IconShieldLock, IconCloudOff } from '@tabler/icons-react';
import { Card, Badge } from '@/components/ui';

const FEATURES = [
  '看板：净资产 / 收支概览、趋势图、资产分布、收支日历',
  '账户管理：资金 / 资产 / 社保 / 投资 / 信用 / 债务 7 大类',
  '交易流水：支出 / 收入 / 转账 / 不计收支',
  '目标管理：储蓄目标 / 还款目标',
  '报表：自定义可视化',
  '分组分类：默认 33 个分类，9 个分组',
  '标签 / 商户：辅助元数据',
  '账单导入：CSV / PDF 解析',
];

export function AboutSection() {
  return (
    <div className="space-y-4">
      <Card>
        <div className="space-y-5">
          {/* 头部 */}
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-2xl bg-text text-bg-card dark:bg-bg-card-dark dark:text-text-dark flex items-center justify-center font-semibold text-xl">
              Hi
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-medium">HiFin · 本地复刻版</h2>
                <Badge tone="brand" className="dark:bg-brand/15 dark:text-brand-dark">v0.1.0</Badge>
              </div>
              <div className="text-sm text-text-muted dark:text-text-muted-dark mt-1">
                个人财务管理工具的本地化实现
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone="income" >
                  <IconCloudOff size={12} className="mr-1" />
                  离线 / 无登录
                </Badge>
                <Badge tone="neutral">
                  <IconShieldLock size={12} className="mr-1" />
                  数据本地存储
                </Badge>
              </div>
            </div>
          </div>

          {/* 介绍 */}
          <div className="text-sm text-text dark:text-text-dark leading-relaxed space-y-2">
            <p>
              HiFin 本地复刻版是一款运行在本机的个人财务工具，
              所有数据保存在本地 core 服务的 SQLite 数据库中，<strong>不会上传到任何服务器</strong>。
            </p>
            <p>
              支持账户、流水、目标、报表、分类、标签、商户等核心模块，并提供 ⌘K
              命令面板与可定制的菜单 / 主题偏好。
            </p>
          </div>

          {/* 功能列表 */}
          <div>
            <div className="text-sm font-medium mb-2">已实现功能</div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-sm text-text-muted dark:text-text-muted-dark">
              {FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <span className="text-income mt-1">·</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* 技术栈 */}
          <div>
            <div className="text-sm font-medium mb-2">技术栈</div>
            <div className="flex flex-wrap gap-1.5">
              {[
                'React 18',
                'Vite',
                'TypeScript',
                'Tailwind v3',
                'SQLite / Express（core）',
                'react-router-dom v6',
                'jotai',
                'recharts',
                'dayjs',
                '@tabler/icons-react',
              ].map((t) => (
                <Badge key={t} tone="neutral">{t}</Badge>
              ))}
            </div>
          </div>

          {/* 致谢 */}
          <div className="border-t border-border dark:border-border-dark pt-4 flex items-center gap-2 text-xs text-text-muted dark:text-text-muted-dark">
            <IconBrandGithub size={14} />
            <span>
              本项目为个人学习复刻，灵感与界面参考 HiFin.ai；如有问题请通过「设置 → 数据安全 → 导出」备份数据。
            </span>
          </div>
        </div>
      </Card>
    </div>
  );
}