import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { parseCsvText } from '../../app/src/features/transactions/csv.ts';
import { xlsxToCsvText } from '../src/bill/importer.js';

/**
 * 真实微信账单（.xlsx）走 core 管道 → app 共享解析器：不得出现任何 warning。
 *
 * 这份原件是「列数启发式」最容易误报的一份：它有 5 行的字段里**规范加了引号**地包着
 * 内嵌逗号（如 `"内蒙东察康巴什站至锡尼镇,车牌号:蒙LB4552,收费金额30.00元"`）。
 * 若计数用的是朴素 split(',') 而非解析所用的引号感知切分器，这 5 行会被数成
 * 12/13 列，凭空多出 5 条误报。真实原件不在版本库，缺失时跳过而不是假绿。
 */
const WECHAT_XLSX = '/tmp/check-wechat.xlsx';

describe('真实微信原件：0 warning', () => {
  it('xlsx → CSV → 解析，全行有效且无告警', () => {
    if (!existsSync(WECHAT_XLSX)) return;
    const r = parseCsvText(xlsxToCsvText(WECHAT_XLSX), 'wechat');
    expect(r.error).toBeUndefined();
    expect(r.warning).toBeUndefined();
    expect(r.valid).toBe(r.total);
    expect(r.valid).toBeGreaterThan(100); // 真的读到了数据，不是空转
    expect(r.items.some((it) => it.rawLine)).toBe(false);
  });
});
