/**
 * `/skill` 的文案层：把宿主返回的技能目录变成微信能读的文字。
 *
 * 只做展示，**不产出任何给模型的东西**。执行技能走的是另一条本来就在的通道：
 * 用户直接发 `/技能名`，宿主 `dsh-tool-skill` 扫到手势后自己注入技能正文——
 * 与 GUI 里在输入框打 `/技能名` 完全同一条路。所以这里没有任何标签拼装、
 * 转义或正文处理，那些全是宿主的职责。
 *
 * 纯函数、无 I/O，文案可以直接断言，不必起一个假 agent。
 */

import type { SkillEntry } from "../dsh/ops.js";

/**
 * 列表一次最多显示多少个技能。
 *
 * 微信单条 4000 字符，而装满技能的 profile 可以有一百多个（`office` 系列本身
 * 就十几个）。截断而不是分页：技能列表是「找编号」用的，翻页会把编号和页面
 * 的对应关系搞乱，直接说「另有 N 个未显示」更诚实。
 */
export const SKILL_LIST_LIMIT = 25;

/**
 * 列表里一句话描述的最大宽度（显示列）。
 *
 * 46 是「够认出是哪个技能」与「一行还读得下去」的折中：DSH 自带技能的描述多为
 * 英文长句，34 列会把它们全截成 `Helps users discover and install …`，等于没
 * 说；再宽下去，手机上一行折成三行，25 条就成了一屏半。
 */
const SKILL_LIST_DESC_MAX = 46;

/** 详情页描述的最大宽度——够长，纯粹防一段异常长的 frontmatter 撑爆气泡。 */
const SKILL_DETAIL_MAX = 800;

/** 折成一行：换行/连续空格压成单个空格，超长截断并加省略号。 */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  return chars.slice(0, Math.max(1, max - 1)).join("") + "…";
}

/**
 * 解析 `/skill <目标>` 的结果：编号（1 起）或名称。
 *
 * 名称先精确匹配（忽略大小写），再唯一前缀匹配——`/skill office` 必须选中
 * `office` 而不是它的 `office-docx` 兄弟，所以精确匹配永远优先。前缀命中多个
 * 时**不猜**，把候选交回调用方列出：猜错技能就是让用户按另一套说明干活。
 */
export type SkillMatch =
  | { kind: "one"; entry: SkillEntry; index: number }
  | { kind: "ambiguous"; candidates: SkillEntry[] }
  | { kind: "none" }
  | { kind: "out-of-range"; total: number };

export function matchSkillTarget(
  entries: readonly SkillEntry[],
  target: string,
): SkillMatch {
  const trimmed = target.trim();
  if (/^\d+$/.test(trimmed)) {
    const index = parseInt(trimmed, 10);
    if (index < 1 || index > entries.length) return { kind: "out-of-range", total: entries.length };
    return { kind: "one", entry: entries[index - 1]!, index };
  }
  const needle = trimmed.toLowerCase();
  const exact = entries.find((entry) => entry.name.toLowerCase() === needle);
  if (exact) return { kind: "one", entry: exact, index: entries.indexOf(exact) + 1 };
  const prefixed = entries.filter((entry) => entry.name.toLowerCase().startsWith(needle));
  if (prefixed.length === 1) {
    return { kind: "one", entry: prefixed[0]!, index: entries.indexOf(prefixed[0]!) + 1 };
  }
  if (prefixed.length > 1) return { kind: "ambiguous", candidates: prefixed };
  return { kind: "none" };
}

/**
 * 列表回复。
 *
 * 末尾那段「怎么用」是这个命令存在的理由：`/skill` 本身不执行技能，执行是把
 * `/技能名` 直接发出去。不写清楚，用户会以为 `/skill 1` 会替他跑起来。
 */
export function formatSkillList(entries: readonly SkillEntry[]): string {
  if (entries.length === 0) {
    return [
      "🧩 当前会话没有可用技能。",
      "",
      "技能放在项目的 .dsh/skills 或用户目录 ~/.dsh/skills 下（一个技能一个文件夹，里面有 SKILL.md），保存后重新发 /skill 即可看到。",
    ].join("\n");
  }
  const shown = entries.slice(0, SKILL_LIST_LIMIT);
  const lines = [`🧩 当前会话可用技能 ${entries.length} 个：`, ""];
  for (const [index, entry] of shown.entries()) {
    lines.push(`${index + 1}. ${entry.name} — ${oneLine(entry.description, SKILL_LIST_DESC_MAX)}`);
  }
  if (entries.length > shown.length) {
    lines.push(`…另有 ${entries.length - shown.length} 个未显示。`);
  }
  lines.push(
    "",
    "看某个技能的详细说明：/skill 编号，或 /skill 技能名。",
    "要执行技能，直接把 /技能名 发出来（和 GUI 里一样），例如 /office 把这份报告转成 PDF。",
    // 同名冲突是真实存在的：技能名与 bridge 自己的命令撞车时，`/名字` 会被
    // 当成命令执行而不是手势。逃生口是 `once` 而不是 `on`：只放行下一条，
    // 用完自动回到「命令优先」，不会留下一个不再响应命令的模式。
    "若技能名与命令同名（如 /help），先发 /raw once 强制透传，再发 /技能名。",
  );
  return lines.join("\n");
}

/**
 * 详情回复：完整描述 + 来源路径。
 *
 * 只展示 `description`，**不**展开技能正文——正文是给模型的操作说明（可能
 * 几千字），贴进聊天框既没人读，也会把用户真正要说的话淹没。
 *
 * 也不渲染 `whenToUse`：宿主的 `SkillSummary` 有这个字段，但真实技能（本机
 * 九个，含 `office` 全家）的 frontmatter 全都只写 `name` 和 `description`，
 * 所以那一行永远打不出来。留一个零命中的分支只会让人对着输出猜「这行哪来的」。
 *
 * 同样不附「执行：发 /xxx」那一行：一个技能名在别的技能里常是子技能名
 * （`office` 就带 `office-docx` 之类的兄弟），拼出来的命令未必是用户想执行
 * 的那条。
 */
export function formatSkillDetail(
  entry: SkillEntry,
  options: { position?: number } = {},
): string {
  const head = options.position === undefined ? entry.name : `${options.position}. ${entry.name}`;
  const lines = [`🧩 ${head}`, oneLine(entry.description, SKILL_DETAIL_MAX)];
  if (entry.path) lines.push(`来源：${entry.path}`);
  return lines.join("\n");
}

/** 前缀命中多个时的候选提示（不猜，让用户自己挑）。 */
export function formatSkillAmbiguous(target: string, candidates: readonly SkillEntry[]): string {
  const names = candidates.map((entry) => entry.name).join("、");
  return [
    `⚠️ 「${target}」匹配到 ${candidates.length} 个技能：${names}`,
    "请写全名，或先发 /skill 看编号。",
  ].join("\n");
}
