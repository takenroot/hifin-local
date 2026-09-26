/**
 * 设置 → 用户信息
 *
 * - 昵称：可编辑，存 kv: 'nickname'
 * - 邮箱：占位（仅展示，无写入后端）
 * - 本地用户 ID：首次访问生成一次，存 kv: 'userId'
 *
 * 通过 useLiveQuery + 直接 db.put 保持实时。
 */
import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  IconUser,
  IconCopy,
  IconCheck,
  IconMail,
} from '@tabler/icons-react';
import { Button, Card, Input } from '@/components/ui';
import { db } from '@/db';
import { generateUserId } from '../format';

interface KvRow<T> {
  key: string;
  value: T;
}

export function ProfileSection() {
  const nicknameKv = useLiveQuery(() => db.kv.get('nickname'), []);
  // 把“无记录”规范化为 null，让 undefined 仅表示“加载中”，避免两个状态被混在一起。
  const userIdKv = useLiveQuery(
    () => db.kv.get('userId').then((r) => r ?? null),
    [],
  );
  const emailKv = useLiveQuery(() => db.kv.get('email'), []);

  const [nickname, setNickname] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [userIdEnsured, setUserIdEnsured] = useState(false);

  // 同步显示值（首次拉取 / 外部修改）
  useEffect(() => {
    if (nicknameKv === undefined) return;
    setNickname((nicknameKv?.value as string | undefined) ?? '');
  }, [nicknameKv]);

  // 首次写入 userId：useLiveQuery 首次拿到结果（不再是 undefined）说明已查完；
  // 此时 userIdKv === null 表示“无记录”，写入一次；已有记录则跳过（幂等）。
  useEffect(() => {
    if (userIdEnsured) return;
    if (userIdKv === undefined) return; // 仍在加载
    setUserIdEnsured(true);
    if (userIdKv === null) {
      void db.kv.put({ key: 'userId', value: generateUserId() });
    }
  }, [userIdKv, userIdEnsured]);

  const userId = (userIdKv?.value as string | undefined) ?? '—';
  const emailDisplay = (emailKv?.value as string | undefined) ?? '';

  async function saveNickname() {
    const v = nickname.trim();
    if (!v) return;
    setSaving(true);
    try {
      await db.kv.put({ key: 'nickname', value: v } as KvRow<string>);
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
              >
                保存
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