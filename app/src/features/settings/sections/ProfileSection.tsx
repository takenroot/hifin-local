/**
 * 设置 → 用户信息
 *
 * - 昵称：可编辑，存 kv: 'nickname' → PUT /api/kv/nickname
 * - 邮箱：占位（仅展示，无写入后端）
 * - 本地用户 ID：首次访问生成一次，存 kv: 'userId' → PUT /api/kv/userId
 *
 * core 的 GET /api/kv/:key 对不存在的键返回 404，useKv() 已把它归一成 null。
 */
import { useEffect, useState } from 'react';
import {
  IconUser,
  IconCopy,
  IconCheck,
  IconMail,
} from '@tabler/icons-react';
import { Button, Card, Input } from '@/components/ui';
import { kvPut, useKv } from '../restApi';
import { generateUserId } from '../format';

export function ProfileSection() {
  const nicknameKv = useKv<string>('nickname');
  // 把"无记录"规范化为 null，让 undefined 仅表示"加载中"，避免两个状态被混在一起。
  const userIdKv = useKv<string>('userId');
  const emailKv = useKv<string>('email');

  const [nickname, setNickname] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [userIdEnsured, setUserIdEnsured] = useState(false);

  // 同步显示值（首次拉取 / 外部修改）
  useEffect(() => {
    if (nicknameKv.loading) return;
    setNickname(nicknameKv.value ?? '');
  }, [nicknameKv.loading, nicknameKv.value]);

  // 首次写入 userId：加载完成说明已查完；
  // 此时 userIdKv.value === null 表示"无记录"，写入一次；已有记录则跳过（幂等）。
  useEffect(() => {
    if (userIdEnsured) return;
    if (userIdKv.loading) return; // 仍在加载
    setUserIdEnsured(true);
    if (userIdKv.value === null) {
      void kvPut('userId', generateUserId()).then(() => userIdKv.refetch());
    }
  }, [userIdKv.loading, userIdKv.value, userIdKv.refetch, userIdEnsured]);

  const userId = userIdKv.value ?? '—';
  const emailDisplay = emailKv.value ?? '';

  async function saveNickname() {
    const v = nickname.trim();
    if (!v) return;
    setSaving(true);
    try {
      await kvPut('nickname', v);
      nicknameKv.refetch();
    } finally {
      setSaving(false);
    }
  }

  async function copyUserId() {
    try {
      await navigator.clipboard.writeText(userId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 浏览器拒绝时静默失败：仍有复制按钮视觉反馈
    }
  }

  return (
    <div className="space-y-4">
      <Card title="基础信息">
        <div className="space-y-4 max-w-[560px]">
          <div>
            <label className="block text-xs text-text-muted mb-2">
              <IconUser size={12} className="inline mr-1 -mt-0.5" />
              昵称
            </label>
            <div className="flex gap-2">
              <Input
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="设置一个昵称"
                maxLength={20}
                invalid={nickname.length > 20}
              />
              <Button
                variant="primary"
                onClick={saveNickname}
                disabled={!nickname.trim() || saving}
                className="flex-none whitespace-nowrap min-w-[80px] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {saving ? '保存中…' : '保存'}
              </Button>
            </div>
            <div className="mt-1 text-xs text-text-muted">
              {nickname.length}/20
            </div>
          </div>

          <div>
            <label className="block text-xs text-text-muted mb-2">
              <IconMail size={12} className="inline mr-1 -mt-0.5" />
              邮箱（占位）
            </label>
            <Input
              value={emailDisplay}
              placeholder="本地版本不进行云端同步，邮箱仅展示"
              readOnly
            />
            <div className="mt-1 text-xs text-text-muted">
              本地复刻版不会上传邮箱；此字段仅为 UI 兼容占位。
            </div>
          </div>
        </div>
      </Card>

      <Card title="本地用户 ID">
        <div className="space-y-2 max-w-[560px]">
          <div className="text-xs text-text-muted">
            本 ID 在首次访问时自动生成并保存在本机，用于本地识别不同浏览器档案。
          </div>
          <div className="flex items-center gap-2">
            <Input value={userId} readOnly />
            <Button
              variant="secondary"
              icon={
                copied ? <IconCheck size={16} /> : <IconCopy size={16} />
              }
              onClick={copyUserId}
            >
              {copied ? '已复制' : '复制'}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}