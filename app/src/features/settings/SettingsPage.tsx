/**
 * 设置中心主页面（全页面 + 左侧菜单布局）
 *
 * 路由 `/settings`，子页通过 `?section=` 切换：
 *   profile / preferences / security / ai / space / import /
 *   categories / rules / tags / merchants / about
 *
 * 不合法或缺失 section 时回退到 profile。
 */
import { useMemo } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { IconSettings } from '@tabler/icons-react';
import { PageHeader } from '@/components/ui';
import {
  SETTINGS_GROUPS,
  resolveSection,
  type SettingsSectionKey,
} from './menu';
import { SettingsLayout } from './SettingsLayout';
import { ProfileSection } from './sections/ProfileSection';
import { PreferencesSection } from './sections/PreferencesSection';
import { SecuritySection } from './sections/SecuritySection';
import { AiSection } from './sections/AiSection';
import { SpaceSection } from './sections/SpaceSection';
import { ImportSection } from './sections/ImportSection';
import { CategoriesSection } from './sections/CategoriesSection';
import { RulesSection } from './sections/RulesSection';
import { TagsSection } from './sections/TagsSection';
import { MerchantsSection } from './sections/MerchantsSection';
import { AboutSection } from './sections/AboutSection';

export default function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const section = resolveSection(params.get('section'));

  // 当前 section 的元数据（用于右侧标题）
  const currentMeta = useMemo(() => {
    for (const g of SETTINGS_GROUPS) {
      const it = g.items.find((i) => i.key === section);
      if (it) return { ...it, groupLabel: g.label };
    }
    return null;
  }, [section]);

  function changeSection(next: SettingsSectionKey) {
    const np = new URLSearchParams(params);
    np.set('section', next);
    setParams(np, { replace: true });
  }

  if (!currentMeta) {
    return <Navigate to="/settings?section=profile" replace />;
  }

  const body = renderSection(section);

  return (
    <div className="min-h-full bg-bg dark:bg-bg-dark">
      <PageHeader
        title="设置"
        description="个性化、数据与本地空间相关配置"
        icon={<IconSettings size={18} />}
        titleLevel="h1"
      />
      <SettingsLayout active={section} onSelect={changeSection}>
        <div className="max-w-[920px]">
          {/* 标题 + 描述：分节名是"设置"(h1) 下的子标题，层级必须比 PageHeader 低一级 */}
          <div className="mb-6 flex items-center gap-3">
            <div
              className={clsx(
                'w-9 h-9 rounded-xl flex items-center justify-center',
                'bg-brand-soft dark:bg-brand/15 text-brand dark:text-brand-dark',
              )}
            >
              {currentMeta.icon}
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-medium text-text dark:text-text-dark truncate">
                {currentMeta.label}
              </h2>
              <div className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5">
                {currentMeta.groupLabel}
              </div>
            </div>
          </div>
          {body}
        </div>
      </SettingsLayout>
    </div>
  );
}

function renderSection(key: SettingsSectionKey) {
  switch (key) {
    case 'profile':
      return <ProfileSection />;
    case 'preferences':
      return <PreferencesSection />;
    case 'security':
      return <SecuritySection />;
    case 'ai':
      return <AiSection />;
    case 'space':
      return <SpaceSection />;
    case 'import':
      return <ImportSection />;
    case 'categories':
      return <CategoriesSection />;
    case 'rules':
      return <RulesSection />;
    case 'tags':
      return <TagsSection />;
    case 'merchants':
      return <MerchantsSection />;
    case 'about':
      return <AboutSection />;
    default:
      return null;
  }
}