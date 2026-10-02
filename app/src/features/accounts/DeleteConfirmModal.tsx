/**
 * 删除账户的二次确认模态。
 *
 * - 当账户没有任何关联流水时，只展示确认对话框。
 * - 当存在关联流水时，给出警告（告知删除后这些流水将变成"无主账户"）。
 */
import { Button, Modal } from '@/components/ui';
import { IconAlertTriangle } from '@tabler/icons-react';

interface DeleteConfirmModalProps {
  open: boolean;
  accountName: string;
  relatedCount: number;
  onClose: () => void;
  onConfirm: () => void;
  /** 删除失败时的服务端错误；非空时在对话框内提示 */
  errorMessage?: string | null;
}

export function DeleteConfirmModal({
  open,
  accountName,
  relatedCount,
  onClose,
  onConfirm,
  errorMessage,
}: DeleteConfirmModalProps) {
  const hasRelated = relatedCount > 0;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="删除账户"
      width={440}
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
        <div className="text-sm">
          确定要删除账户「
          <span className="font-medium">{accountName}</span>
          」吗？此操作不可撤销。
        </div>
        {hasRelated && (
          <div className="flex items-start gap-2 p-3 rounded-xl bg-expense-soft dark:bg-expense-soft-dark text-expense text-sm">
            <IconAlertTriangle size={16} className="flex-none mt-0.5" />
            <div>
              该账户下有{' '}
              <span className="font-medium tabular-nums">{relatedCount}</span>{' '}
              条关联流水，删除后这些流水将失去账户归属。
            </div>
          </div>
        )}
        {errorMessage && (
          <div className="text-xs text-expense">{errorMessage}</div>
        )}
      </div>
    </Modal>
  );
}
