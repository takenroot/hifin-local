/**
 * 账单 ZIP 解压（基于 adm-zip）
 *
 * 微信 / 支付宝的邮件账单是"通知型"的：正文只说"账单文件已生成"，
 * 真正的交易流水在加密 ZIP 附件里。本模块负责把 ZIP 拆成磁盘文件，
 * 并从中挑出承载流水的表格文件。
 *
 *   unzipBill(zipPath, password, outDir?)  → 解压，返回解出的文件绝对路径列表
 *   findBillCsv(files)                     → 从文件列表里挑出账单表格（.csv 优先，.txt 兜底）
 *
 * 错误按可判别类型抛出，调用方不必去猜错误文案：
 *   BillPasswordError    密码错误（adm-zip: "Wrong Password"；密码错误蒙混过
 *                        verification byte 时，对外表现为 zlib / CRC 类报错）
 *   BillFormatError      不是 ZIP / 文件不存在 / 压缩包损坏
 *   BillCsvNotFoundError 解压成功但里面没有可识别的账单表格
 */

import AdmZip from 'adm-zip';
import { existsSync, mkdirSync, readdirSync, mkdtempSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';

// ── 错误类型 ────────────────────────────────────────────────

/** 账单 ZIP 相关错误的基类；上层可以只 catch 这一类 */
export class BillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillError';
  }
}

/**
 * 解压密码不正确。
 *
 * 不止 adm-zip 明说的 "Wrong Password"：ZipCrypto 密码校验只有 1 字节，
 * 错误密码约 1/256 概率蒙混过关，adm-zip 便放行，后续表现为 zlib / CRC 报错——
 * 归到 BillFormatError 会让用户去查文件，而不是去拿最新密码。详见 unzipBill 里的说明。
 */
export class BillPasswordError extends BillError {
  constructor(message = '解压密码错误：账单 ZIP 的密码不匹配') {
    super(message);
    this.name = 'BillPasswordError';
  }
}

/** 不是合法 ZIP、文件不存在或压缩包结构损坏 */
export class BillFormatError extends BillError {
  constructor(message: string) {
    super(message);
    this.name = 'BillFormatError';
  }
}

/** 解压成功，但没有找到 .csv / .txt 账单表格 */
export class BillCsvNotFoundError extends BillError {
  constructor(message: string) {
    super(message);
    this.name = 'BillCsvNotFoundError';
  }
}

// ── 表格识别 ────────────────────────────────────────────────

/** 压缩包里常见的、不承载流水的垃圾条目（按路径段判断，不能用 ^ 锚整串） */
function isJunkPath(file: string): boolean {
  return file.split(/[\\/]/).some((seg) => {
    if (!seg || seg === '.' || seg === '..') return false;
    // 隐藏文件（.DS_Store、._xxx 这类 macOS 资源叉）与 __MACOSX 目录
    return seg === '__MACOSX' || seg === 'Thumbs.db' || seg.startsWith('.');
  });
}

/** 文件名里出现这些词，说明它比同后缀的其它文件更像"账单正文" */
const BILL_NAME_HINTS = ['bill', '账单', '交易明细', '明细', '流水', 'record'];

/** 文件名里出现这些词，多半是配套的说明文档而不是流水 */
const NOISE_NAME_HINTS = [
  '说明',
  '须知',
  '声明',
  '客服',
  '常见问题',
  '关于',
  'readme',
  'help',
  'faq',
];

/** 是否是候选账单表格：先看后缀，再排除垃圾条目 */
function isBillTableCandidate(file: string): boolean {
  if (isJunkPath(file)) return false;
  const ext = extname(file).toLowerCase();
  return ext === '.csv' || ext === '.txt';
}

/** 排序打分：像账单的 0 分 → 其余 1 分 → 像说明文档的 2 分 */
function billness(file: string): number {
  const name = basename(file).toLowerCase();
  if (NOISE_NAME_HINTS.some((kw) => name.includes(kw))) return 2;
  if (BILL_NAME_HINTS.some((kw) => name.includes(kw))) return 0;
  return 1;
}

/** 命中"账单关键词"的文件排前面，其次名称短的（说明文档通常更长），保证结果可复现 */
function byBillness(a: string, b: string): number {
  const diff = billness(a) - billness(b);
  if (diff !== 0) return diff;
  const byLen = basename(a).length - basename(b).length;
  return byLen !== 0 ? byLen : a.localeCompare(b);
}

/**
 * 从解压出的文件列表里挑出账单表格。
 * 规则：.csv 优先于 .txt（支付宝部分账单导出为 txt），同类按"像账单"程度排序。
 * 找不到返回 null，由调用方决定抛错还是忽略。
 */
export function findBillCsv(files: string[]): string | null {
  const candidates = files.filter(isBillTableCandidate);
  if (candidates.length === 0) return null;
  const csvs = candidates.filter((f) => extname(f).toLowerCase() === '.csv');
  const pool = csvs.length > 0 ? csvs : candidates;
  return [...pool].sort(byBillness)[0];
}

// ── ZIP 识别 ────────────────────────────────────────────────

/**
 * 粗判一个文件是不是 ZIP：只读前 4 字节比对魔数 "PK\x03\x04" / "PK\x05\x06"。
 * 之所以不直接 new AdmZip，是因为很多服务器对"不是 zip"只抛一句
 * "No END header found"，对用户毫无指向性。
 */
export function isZipFile(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'r');
    const head = Buffer.alloc(4);
    // 账单 ZIP 动辄几十 MB，只读魔数，别整包进内存
    if (readSync(fd, head, 0, 4, 0) < 4) return false;
    if (head[0] !== 0x50 || head[1] !== 0x4b) return false; // "PK"
    const sig3 = head[2];
    const sig4 = head[3];
    return (
      (sig3 === 0x03 && sig4 === 0x04) || // 本地文件头
      (sig3 === 0x05 && sig4 === 0x06) || // 空压缩包 EOCD
      (sig3 === 0x07 && sig4 === 0x08) // 分卷
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ── 解压 ────────────────────────────────────────────────────

/** 递归收集目录下的所有普通文件（返回绝对路径） */
function listFilesRecursive(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listFilesRecursive(full, acc);
    else acc.push(full);
  }
  return acc;
}

/** 判断 outDir 是否由 unzipBill 自动创建（决定能不能顺手清掉） */
function looksLikeTempBillDir(dir: string): boolean {
  return basename(dir).startsWith('hifin-bill-');
}

/**
 * zlib 错误码的形状：Z_DATA_ERROR / Z_BUF_ERROR / Z_MEM_ERROR / Z_VERSION_ERROR …
 * Z_* 是 zlib 自己的命名空间，adm-zip 抛的 "Wrong Password" 之类不带这个前缀。
 */
const ZLIB_ERROR_CODE_RE = /^Z_[A-Z_]+$/;

/**
 * zlib inflate 家族的错误文案，**只在错误对象的 code 丢失时才用作兜底**。
 *
 * adm-zip 0.6 的同步解压直接把 zlib 的 error 原样抛出（已实测：methods/inflater.js
 * 走 inflateRawSync，不包装），所以正常路径靠 code 判定即可，不受文案影响。
 * 万一将来某个版本包了一层把 code 抹掉，就退回比对下面这组文案。
 *
 * 清单是拿本机 zlib 随机灌了几十万条乱码实测出来的（Node v24 / zlib 1.3.x），
 * 加上 inflate.c 的全集：蒙混过关的乱码落在哪一条完全取决于运气，漏一条
 * 就等于又留了一次偶发误判——开发这个 ISSUE 时就漏过 "invalid literal/length code"。
 */
const ZLIB_INFLATE_ERRORS = [
  'invalid block type',
  'invalid stored block lengths',
  'invalid code lengths set',
  'invalid bit length repeat',
  'invalid code -- missing end-of-block',
  'invalid literal/lengths set',
  'invalid literal/length code',
  'invalid distance code',
  'invalid distance too far back',
  'invalid distance too far',
  'invalid too new length or distance',
  'too many length or distance symbols',
  'invalid compressed data',
  'invalid window size',
  'invalid zlib header',
  'invalid gzip header',
  'incorrect data check',
  'incorrect length check',
  'incorrect header check',
  'unexpected end of file',
  'unknown compression method',
  'unknown header flags set',
  'header crc mismatch',
  'need dictionary',
];

/** adm-zip 的 CRC 校验失败文案（"ADM-ZIP: CRC32 checksum failed 账单.csv"） */
const CRC_MISMATCH_RE = /crc32 checksum failed|bad crc|crc mismatch/i;

/** 压缩包里是否真的有加密条目（general purpose bit flag 的 bit0） */
function hasEncryptedEntries(zip: AdmZip): boolean {
  return zip.getEntries().some((e) => (((e.header as { flags?: number } | undefined)?.flags ?? 0) & 0x0001) !== 0);
}

/**
 * 这次解压失败是不是 zlib 报出来的（即"喂给 zlib 的数据本身就不合法"）。
 *
 * 优先看错误码：Z_* 前缀由 zlib 独占，比对文案更硬，也扛得住 zlib 换文案。
 * code 拿不到时（被中间层包过）再退回来比对文案。
 */
function isZlibInflateError(e: unknown, msg: string): boolean {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && ZLIB_ERROR_CODE_RE.test(code)) return true;
  const lower = msg.toLowerCase();
  return ZLIB_INFLATE_ERRORS.some((s) => lower.includes(s));
}

/**
 * 解压账单 ZIP，返回解出的文件绝对路径列表。
 *
 * @param zipPath  ZIP 路径
 * @param password 解压密码（每次申请账单时不同，见最新邮件/短信）
 * @param outDir   输出目录；省略时在系统临时目录建一个 hifin-bill-xxxx
 *
 * 抛 BillFormatError（文件不存在 / 非 ZIP / 损坏）、
 * BillPasswordError（密码不对）——不抛"无 CSV"，那是 findBillCsv 的职责。
 */
export function unzipBill(zipPath: string, password: string, outDir?: string): string[] {
  const absZip = resolve(zipPath);
  if (!existsSync(absZip)) {
    throw new BillFormatError(`ZIP 文件不存在: ${absZip}`);
  }
  const stat = statSync(absZip);
  if (!stat.isFile()) {
    throw new BillFormatError(`ZIP 路径不是文件: ${absZip}`);
  }
  if (!isZipFile(absZip)) {
    throw new BillFormatError(`不是有效的 ZIP 文件: ${absZip}（账单附件应为 .zip）`);
  }

  // 输出目录：自带的不动（调用方可能想留着复查），自建的用 hifin-bill- 前缀便于事后清理
  const target = outDir !== undefined ? resolve(outDir) : mkdtempSync(join(tmpdir(), 'hifin-bill-'));
  mkdirSync(target, { recursive: true });

  let zip: AdmZip;
  try {
    zip = new AdmZip(absZip);
  } catch (e: unknown) {
    throw new BillFormatError(`ZIP 解析失败: ${absZip}（${msgOf(e)}）`);
  }

  try {
    // overwrite=true：重复导入同一份账单时不因残留文件失败
    // keepOriginalPermission=false：压缩包里的权限位不可信，交给 Node 默认值
    zip.extractAllTo(target, true, false, password);
  } catch (e: unknown) {
    if (outDir === undefined) cleanupBillDir(target);
    const msg = msgOf(e);
    // adm-zip 0.6 实际抛的是 "ADM-ZIP: Wrong Password"；不同版本/其它实现
    // 也可能写 "Invalid password"，所以三种写法都认，兜底再兜一层裸 password。
    if (/wrong\s*password|invalid\s*password|password/i.test(msg)) {
      throw new BillPasswordError(`解压密码错误（${absZip}）：${msg}`);
    }
    // ISSUE-003：ZipCrypto 的密码校验只有 1 字节 verification byte，错误密码有
    // 约 1/256 概率蒙混过关，于是 adm-zip 认定密码正确、照常往下走，zlib 收到的
    // 却是解密乱码，只会抛 inflate 家族错误（invalid block type / incorrect data
    // check / invalid distance …），轮不到它说 "Wrong Password"。这类报错发生在
    // 调用方确实给了密码的前提下，就只可能出自密码错误——归到格式错误会让用户
    // 去检查文件、而不是去看最新邮件/短信里的新密码。压根没给密码时，格式错误
    // 仍然老老实实归 BillFormatError。
    if (Boolean(password) && isZlibInflateError(e, msg)) {
      throw new BillPasswordError(`解压密码错误（${absZip}）：密码未通过校验，解压出乱码（${msg}）`);
    }
    // 同一批乱码还有个小概率（实测约 0.5%）恰好拼出一棵"合法"的 deflate 树，
    // 于是 zlib 解压没报错、改由 CRC 校验拦下。密码正确时 CRC 必然对得上，
    // 所以对**加密条目**而言，调用方给了密码却 CRC 不符，同样只可能是密码不对。
    // 特意加上 hasEncryptedEntries 这一层：未加密的压缩包 CRC 对不上是文件真损坏，
    // 那种情况必须老老实实报格式错误，不能被密码错误的口径盖过去。
    if (Boolean(password) && CRC_MISMATCH_RE.test(msg) && hasEncryptedEntries(zip)) {
      throw new BillPasswordError(`解压密码错误（${absZip}）：密码未通过校验，解压内容校验失败（${msg}）`);
    }
    throw new BillFormatError(`ZIP 解压失败: ${msg}`);
  }

  return listFilesRecursive(target);
}

/**
 * 清理 unzipBill 自建的临时解压目录。
 * 传入自己指定过的 outDir 时是 no-op —— 不擅自删调用方的目录。
 * 判据是 hifin-bill- 前缀（mkdtempSync 生成的目录名），删错目录的代价远高于此。
 */
export function cleanupBillDir(dir: string): void {
  if (!existsSync(dir)) return;
  if (!looksLikeTempBillDir(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}

/** 统一取错误文案（adm-zip 抛的都是普通 Error，但别赌） */
function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
