/**
 * 设置 → 账单导入
 *
 * 说明卡片 + 跳转按钮：点击后路由到 /transaction?import=1。
 */
import { useNavigate } from 'react-router-dom';
import { IconUpload, IconArrowRight } from '@tabler/icons-react';
import { Button, Card } from '@/components/ui';

export function ImportSection() {
  const navigate = useNavigate();

  return (
    <Card
      title={
        <div>
          <div className="text-base font-medium">账单导入</div>
          <div className="text-xs text-text-muted mt-1">
            从银行 / 支付宝 / 微信账单导入历史流水
          </div>
        </div>
      }
    >
      <div className="space-y-4 max-w-[640px]">
        <ul className="text-sm text-text-muted list-disc pl-5 space-y-1">
          <li>支持 CSV / PDF 格式（最大 10MB）</li>
          <li>支持拖拽上传；自动识别平台</li>
          <li>支持 16 家主流银行 + 支付宝 + 微信</li>
          <li>解析后可二次校对，再批量入库</li>
        </ul>
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            icon={<IconUpload size={16} />}
            iconRight={<IconArrowRight size={14} />}
            onClick={() => navigate('/transaction?import=1')}
          >
            去导入
          </Button>
          <span className="text-xs text-text-muted">
            跳转后默认展示批量导入视图。
          </span>
        </div>
      </div>
    </Card>
  );
}