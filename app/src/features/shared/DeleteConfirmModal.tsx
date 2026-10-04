/**
 * 删除二次确认模态（accounts / budget / goals / reports 共用，全站唯一一份）。
 *
 * 2026-10-05 设计审查决策：破坏性确认走 UI 状态轴，底色 danger-soft、图标 warning。
 * 这与金额语义正交——income 红 / expense 绿只表示"赚到钱/钱出去"，
 * 拿绿色表达"删除有风险"会让用户把警告误读成金额。
 */
import type { ReactNode } from 'react';
import { IconAlertTriangle } from '@tabler/icons-react';
import { Button, Modal } from '@/components/ui';

export interface DeleteConfirmModalProps {
  open: boolean;
  title: string;
  /** 确认语，通常是"确定要删除「X」吗？此操作不可撤销。" */
  message: ReactNode;
  onClose: () => void;
  onConfirm: () => void;
  /** 额外的破坏性后果说明（如"关联流水将失去账户归属"），追加在 message 之后 */
  warning?: ReactNode;
  /** 服务端返回的删除失败原因 */
  errorMessage?: ReactNode;
}

export function DeleteConfirmModal({
  open,
  title,
  message,
  onClose,
  onConfirm,
  warning,
  errorMessage,
}: DeleteConfirmModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            确认删除
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded-xl bg-danger-soft dark:bg-danger-soft-dark px-3 py-2.5 text-sm text-danger dark:text-danger-dark">
          <IconAlertTriangle size={16} className="mt-0.5 flex-none text-warning" />
          <div className="min-w-0 flex-1 break-words">
            {message}
            {warning && <div className="mt-1.5">{warning}</div>}
          </div>
        </div>
        {errorMessage && <div className="text-xs text-danger dark:text-danger-dark">{errorMessage}</div>}
      </div>
    </Modal>
  );
}

export default DeleteConfirmModal;
