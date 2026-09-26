/**
 * 通用删除确认模态（reports 模块使用）。
 * 与 goals/DeleteConfirmModal 接口一致，但独立模块避免跨目录 import。
 */
import type { ReactNode } from 'react';
import { Button, Modal } from '@/components/ui';

interface Props {
  open: boolean;
  title: string;
  message: ReactNode;
  onClose: () => void;
  onConfirm: () => void;
}

export function DeleteConfirmModal({
  open,
  title,
  message,
  onClose,
  onConfirm,
}: Props) {
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
      <div className="text-sm text-text dark:text-text-dark">{message}</div>
    </Modal>
  );
}

export default DeleteConfirmModal;
