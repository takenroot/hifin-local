/**
 * 命令面板触发的帮助弹层。
 *
 * 由 CommandPalette 通过 props 触发显示；与 Modal 同样的 portal 行为。
 */
import { IconLifebuoy } from '@tabler/icons-react';
import { Modal, Button } from '@/components/ui';

/** 帮助说明文本（命令面板专属，不与其他 feature 共享） */
const HELP_TEXT = [
  'HiFin 是本地复刻版，所有数据仅保存在本机 core 服务的 SQLite 数据库中，不会上传云端。',
  '⌘K / Ctrl + K：唤起命令面板，快速跳转或新建。',
  '在「设置 → 数据安全」中可以导出全量 JSON 或清空数据库。',
  'AI 配置默认关闭，需要时请在「设置 → AI 配置」中自行添加模型。',
];

interface HelpDialogProps {
  open: boolean;
  onClose: () => void;
}

export function HelpDialog({ open, onClose }: HelpDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={460}
      title={
        <span className="inline-flex items-center gap-2">
          <IconLifebuoy size={16} />
          帮助说明
        </span>
      }
      footer={
        <Button variant="primary" onClick={onClose}>
          知道了
        </Button>
      }
    >
      <ul className="text-sm space-y-2.5 text-text dark:text-text-dark">
        {HELP_TEXT.map((line) => (
          <li key={line} className="flex items-start gap-2">
            <span className="text-brand mt-1.5">·</span>
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}