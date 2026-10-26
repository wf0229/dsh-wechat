/**
 * `/skill` — 列出当前会话的技能，或看某一个的详细说明。
 *
 * 这个命令刻意只做两件只读的事，测试主要钉住这个边界：
 *
 *   1. **它不执行技能**，也不产生任何给模型的内容。执行是把 `/技能名` 直接
 *      发出去，由宿主 `dsh-tool-skill` 的 `agent/pre-step` 注入技能正文——
 *      与 GUI 里在输入框打 `/技能名` 完全同一条路。所以这里断言的重点是
 *      「`/skill` 之后没有任何东西被转发给 agent」。
 *   2. **解析失败不转发**。`/skill 1 帮我做这个事` 既不是编号也不是技能名，
 *      回用法而不是把后半句丢掉或整句交给模型。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
const sendMediaMessage = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/weixin/send.js", () => ({
  sendTextMessage: (...args: unknown[]) => sendTextMessage(...args),
  sendMediaMessage: (...args: unknown[]) => sendMediaMessage(...args),
  splitText: (text: string, maxLen: number) =>
    text.length <= maxLen ? [text] : [text.slice(0, maxLen), text.slice(maxLen)],
}));

import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { defaultConfig } from "../src/config.js";
import { MessageType } from "../src/weixin/types.js";
import {
  formatHelp,
  isBypassSlashCommand,
  isMistypedLocalCommand,
  isSkillCommandAttempt,
  LOCAL_COMMAND_NAMES,
  parseAtCommand,
  parseHelpCommand,
  parseHistoryCommand,
  parseSessionCommand,
  parseSkillCommand,
  parseWorkspaceCommand,
} from "../src/bridge/slash.js";
import {
  formatSkillAmbiguous,
  formatSkillDetail,
  formatSkillList,
  matchSkillTarget,
  SKILL_LIST_LIMIT,
} from "../src/bridge/skill-catalog.js";
import type { SkillEntry } from "../src/dsh/ops.js";

const live: Array<{ stop(): Promise<void> }> = [];

// ─── Fixtures ───────────────────────────────────────────────────────────────

const SKILLS: SkillEntry[] = [
  {
    name: "office",
    description: "Create, edit, inspect, or convert Office documents, spreadsheets, presentations, and PDFs.",
    path: "C:\\Users\\u\\.dsh\\skills\\office\\SKILL.md",
  },
  {
    name: "office-docx",
    description: "Create, read, edit, and validate Word documents (.docx).",
  },
  {
    name: "office-xlsx",
    description: "Read, create, edit, and validate Excel workbooks (.xlsx).",
  },
  {
    name: "skill-creator",
    description: "Create new skills and improve existing ones.",
  },
];

interface HarnessOptions {
  /** Skills the host reports; `undefined` + `withCatalog: false` = no service. */
  skills?: SkillEntry[] | undefined;
  /** Report the session catalog service (default true). */
  withCatalog?: boolean;
}

/** Build a bridge whose host reports `skills`, recording delivered messages. */
function makeBridge(options: HarnessOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-skill-"));
  const cwd = dir;
  const received: Array<{ content: Array<{ type: string; text?: string }>; source: unknown }> = [];

  const agent = {
    id: "session-current",
    status: "idle",
    options: { provider: "deepseek", model: "deepseek-chat" },
    session: { header: { id: "session-current", cwd }, snapshotEvents: () => [] },
    followup: (m: { content: Array<{ type: string; text?: string }>; source: unknown }) => {
      received.push(m);
    },
    steer: () => {},
    cancel: () => {},
    whenIdle: async () => {},
    runMaintenance: async (task: () => Promise<unknown>) => task(),
  };
  const liveAgents = new Map<string, unknown>([[agent.id, agent]]);

  const agentsService = {
    create: async (opts: { sessionId: string }) => {
      const created = { ...agent, id: opts.sessionId };
      liveAgents.set(opts.sessionId, created);
      return { agent: created };
    },
    resume: async (opts: { resumeSessionId: string }) => {
      const resumed = { ...agent, id: opts.resumeSessionId };
      liveAgents.set(opts.resumeSessionId, resumed);
      return { agent: resumed };
    },
    get: (id: string) => liveAgents.get(id),
    list: () => [...liveAgents.values()],
  };

  const declared = options.skills ?? SKILLS;

  const ctx = {
    get: (name: string) => {
      if (name === "agents") return agentsService;
      if (name === "skills") {
        if (options.skills === undefined && options.withCatalog === false) return undefined;
        return { list: async () => declared };
      }
      if (name === "sessionSkillCatalog") {
        if (options.withCatalog === false) return undefined;
        return { list: async () => ({ skills: declared }) };
      }
      return undefined;
    },
    on: () => () => {},
  };

  const cfg = { ...defaultConfig(), storageDir: dir, cwd, mergeSilenceMs: 0 };
  const bridge = new WeChatDSHBridge(ctx as never, cfg as never);
  (bridge as unknown as { token: unknown }).token = {
    baseUrl: "https://gw",
    token: "t",
    accountId: "b1",
    userId: "u",
    savedAt: "",
  };
  live.push(bridge);
  return { bridge, received, dir, cwd };
}

function text(body: string) {
  return {
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "tok",
    item_list: [{ type: 1, text_item: { text: body } }],
  };
}

const asInbound = (bridge: unknown) => bridge as { handleMessage(m: unknown): Promise<void> };
const replies = () => sendTextMessage.mock.calls.map((call) => call[1] as string);
const lastReply = () => replies().at(-1) ?? "";

/** Bind the peer to the harness session so `agents.get()` finds a live agent. */
function bindSession(bridge: unknown, sessionId = "session-current") {
  const anyBridge = bridge as unknown as {
    state: {
      ensureUser(u: string, c: string): { userId: string };
      update(u: string, p: unknown): void;
    };
  };
  anyBridge.state.ensureUser("u1", "C:\\work");
  anyBridge.state.update("u1", { sessionId });
}

beforeEach(() => {
  sendTextMessage.mockClear();
  sendMediaMessage.mockClear();
});

afterEach(async () => {
  for (const bridge of live.splice(0)) {
    try {
      await bridge.stop();
    } catch {
      // teardown is best-effort in tests
    }
  }
});

// ─── Parser ─────────────────────────────────────────────────────────────────

describe("/skill parser", () => {
  it("treats a bare /skill and /skill list as the listing", () => {
    expect(parseSkillCommand("/skill")).toEqual({ kind: "list" });
    expect(parseSkillCommand("/SKILL")).toEqual({ kind: "list" });
    expect(parseSkillCommand("  /skill  ")).toEqual({ kind: "list" });
    expect(parseSkillCommand("/skill list")).toEqual({ kind: "list" });
    expect(parseSkillCommand("/skill ls")).toEqual({ kind: "list" });
  });

  it("reads a number or a name as 'show this one'", () => {
    expect(parseSkillCommand("/skill 1")).toEqual({ kind: "show", target: "1" });
    expect(parseSkillCommand("/skill 12")).toEqual({ kind: "show", target: "12" });
    expect(parseSkillCommand("/skill office")).toEqual({ kind: "show", target: "office" });
    expect(parseSkillCommand("/skill office-docx")).toEqual({ kind: "show", target: "office-docx" });
  });

  it("refuses a line that carries a task, since it never forwards anything", () => {
    // `/skill` 不转发，所以「编号 + 任务」这种形式只能解析失败。静默丢掉后半句
    // 是最坏的选择：用户会以为那句话被送出去了。
    expect(parseSkillCommand("/skill 1 帮我做这个事")).toBeNull();
    expect(parseSkillCommand("/skill office 把报告转成 PDF")).toBeNull();
    expect(parseSkillCommand("/skill 帮我做这个事")).toBeNull();
    expect(parseSkillCommand("/skill office_2")).toBeNull();
  });

  it("does not claim other commands", () => {
    expect(parseSkillCommand("/skills")).toBeNull();
    expect(parseSkillCommand("/at")).toBeNull();
    expect(parseSkillCommand("/help")).toBeNull();
    expect(parseSkillCommand("skill 1")).toBeNull();
    for (const input of ["/skill", "/skill 1", "/skill office"]) {
      expect(parseAtCommand(input)).toBeNull();
      expect(parseHelpCommand(input)).toBe(false);
      expect(parseSessionCommand(input)).toBeNull();
      expect(parseWorkspaceCommand(input)).toBeNull();
      expect(parseHistoryCommand(input)).toBeNull();
    }
  });

  it("is wired like every other local command", () => {
    expect(isBypassSlashCommand("/skill")).toBe(true);
    expect(isBypassSlashCommand("/skill 1")).toBe(true);
    // An invalid argument bypasses too: it is never a plausible card answer.
    expect(isBypassSlashCommand("/skill 1 做事")).toBe(true);
    expect(LOCAL_COMMAND_NAMES.has("skill")).toBe(true);
    expect(formatHelp()).toContain("/skill");
    // The attempt is ours, so it gets a usage reply — never a forwarded
    // sentence and never the "未知命令" hint.
    expect(isSkillCommandAttempt("/skill 1 做事")).toBe(true);
    expect(isMistypedLocalCommand("/skill 1 做事")).toBe(false);
  });
});

// ─── Target resolution ──────────────────────────────────────────────────────

describe("/skill target resolution", () => {
  it("resolves a number to the row it was printed as (1-based)", () => {
    const first = matchSkillTarget(SKILLS, "1");
    expect(first.kind === "one" && first.entry.name).toBe("office");
    expect(first.kind === "one" && first.index).toBe(1);
    const fourth = matchSkillTarget(SKILLS, "4");
    expect(fourth.kind === "one" && fourth.entry.name).toBe("skill-creator");
  });

  it("reports an out-of-range number instead of wrapping or guessing", () => {
    expect(matchSkillTarget(SKILLS, "0")).toEqual({ kind: "out-of-range", total: SKILLS.length });
    expect(matchSkillTarget(SKILLS, "5")).toEqual({ kind: "out-of-range", total: SKILLS.length });
    expect(matchSkillTarget([], "1")).toEqual({ kind: "out-of-range", total: 0 });
  });

  it("prefers an exact name over its siblings", () => {
    // `office` 必须选中 office，而不是 office-docx——否则「按名称查」就成了抽奖。
    const exact = matchSkillTarget(SKILLS, "office");
    expect(exact.kind === "one" && exact.entry.name).toBe("office");
    const upper = matchSkillTarget(SKILLS, "OFFICE");
    expect(upper.kind === "one" && upper.entry.name).toBe("office");
  });

  it("accepts a unique prefix but refuses to guess between several", () => {
    const unique = matchSkillTarget(SKILLS, "skill-");
    expect(unique.kind === "one" && unique.entry.name).toBe("skill-creator");
    const ambiguous = matchSkillTarget(SKILLS, "office-");
    expect(ambiguous.kind).toBe("ambiguous");
    expect(ambiguous.kind === "ambiguous" && ambiguous.candidates.map((c) => c.name)).toEqual([
      "office-docx",
      "office-xlsx",
    ]);
  });

  it("reports an unknown name as nothing at all", () => {
    expect(matchSkillTarget(SKILLS, "nope")).toEqual({ kind: "none" });
  });
});

// ─── Rendering ──────────────────────────────────────────────────────────────

describe("/skill rendering", () => {
  it("numbers the listing so /skill N addresses the printed row", () => {
    const listing = formatSkillList(SKILLS);
    expect(listing).toContain("1. office — ");
    expect(listing).toContain("4. skill-creator — ");
    // Every copyable line the listing offers must be one the bridge accepts.
    // The advice lines are prose, so only lines starting with the command count.
    for (const line of listing.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("/skill ")) continue;
      expect(isBypassSlashCommand(trimmed), trimmed).toBe(true);
    }
  });

  it("tells the user to run a skill by sending /name, and points at /raw once on collision", () => {
    // 这是整个命令存在的理由：`/skill` 只负责让你知道有什么，执行是另一条路。
    const listing = formatSkillList(SKILLS);
    expect(listing).toContain("/技能名");
    expect(listing).toContain("同名");
    // `once` 而不是 `on`：只放行下一条就自动回到「命令优先」，不会留下一个
    // 不再响应命令的模式。（注意 `/raw once` 本身就以 `/raw on` 开头，所以
    // 只能整行比对，不能用子串否定。）
    const hint = listing.split("\n").find((line) => line.includes("同名"))!;
    expect(hint).toContain("/raw once");
    expect(hint).not.toContain("/raw on ");
  });

  it("explains how to add a skill when there are none", () => {
    const listing = formatSkillList([]);
    expect(listing).toContain("没有可用技能");
    expect(listing).toContain(".dsh/skills");
    expect(listing).not.toContain("1. ");
  });

  it("caps a huge catalog instead of overflowing one WeChat bubble", () => {
    const many: SkillEntry[] = Array.from({ length: SKILL_LIST_LIMIT + 7 }, (_, i) => ({
      name: `skill-${i}`,
      description: "x".repeat(80),
    }));
    const listing = formatSkillList(many);
    expect(listing).toContain("…另有 7 个未显示。");
    expect(Array.from(listing).length).toBeLessThanOrEqual(2000);
    expect(listing.split("\n").length).toBeLessThanOrEqual(55);
  });

  it("keeps each listing row on one line", () => {
    const messy: SkillEntry[] = [{ name: "multi", description: "第一行\n\n第二行\t带制表符" }];
    const row = formatSkillList(messy).split("\n").find((line) => line.includes("multi"))!;
    expect(row).toBe("1. multi — 第一行 第二行 带制表符");
  });

  it("shows the full description and where the skill lives, but never the body", () => {
    const detail = formatSkillDetail(SKILLS[0]!, { position: 1 });
    expect(detail).toContain("office");
    expect(detail).toContain(SKILLS[0]!.description);
    expect(detail).toContain("来源：");
    expect(detail).not.toContain("<skill_content");
    expect(detail).not.toContain("<skill_instructions>");
  });

  it("never renders a 适用场景 line, since no real skill declares whenToUse", () => {
    // 宿主的 SkillSummary 有这个字段，但本机九个真实技能（含 office 全家）的
    // frontmatter 只有 name 和 description。渲染一个永远为空的字段，只会让人
    // 对着输出猜「这行哪来的」——上一版就这样误导过一次。
    const detail = formatSkillDetail(SKILLS[0]!, { position: 1 });
    expect(detail).not.toContain("适用场景");
  });

  it("stops at the source path — no synthesized /name execution line", () => {
    // 拼一句「发 /<技能名> 你的任务」看着贴心，但技能名在别的技能里常是子技能
    // 名（`office` 就带 `office-docx` 之类的兄弟），拼出来的命令未必是用户想
    // 执行的那条。这行容易误导，所以不写。
    const detail = formatSkillDetail(SKILLS[0]!);
    expect(detail).not.toContain("执行：");
    expect(detail.split("\n").at(-1)).toBe(`来源：${SKILLS[0]!.path}`);
  });

  it("lists every ambiguous candidate instead of picking one", () => {
    const message = formatSkillAmbiguous("office-", SKILLS.slice(1, 3));
    expect(message).toContain("office-docx");
    expect(message).toContain("office-xlsx");
  });
});

// ─── Bridge behaviour ───────────────────────────────────────────────────────

describe("/skill over WeChat", () => {
  it("lists the session's skills on a bare /skill", async () => {
    const { bridge, received } = makeBridge();
    bindSession(bridge);
    await asInbound(bridge).handleMessage(text("/skill"));
    expect(lastReply()).toContain("当前会话可用技能 4 个");
    expect(lastReply()).toContain("1. office");
    // Listing costs no agent turn.
    expect(received).toHaveLength(0);
  });

  it("shows one skill's details by number and by name", async () => {
    const { bridge, received } = makeBridge();
    bindSession(bridge);
    await asInbound(bridge).handleMessage(text("/skill 1"));
    expect(lastReply()).toContain("🧩 1. office");
    expect(lastReply()).toContain(SKILLS[0]!.description);

    await asInbound(bridge).handleMessage(text("/skill skill-creator"));
    expect(lastReply()).toContain("skill-creator");
    expect(received).toHaveLength(0);
  });

  it("never forwards anything to the agent — execution is /name's job", async () => {
    // 这是本命令的核心边界：它不注入技能、不暂存状态、不转发。
    const { bridge, received } = makeBridge();
    bindSession(bridge);
    for (const line of ["/skill", "/skill 1", "/skill office", "/skill list"]) {
      await asInbound(bridge).handleMessage(text(line));
    }
    expect(received).toHaveLength(0);
    // And nothing leaks into the chat reply either.
    for (const reply of replies()) {
      expect(reply).not.toContain("<skill_content");
      expect(reply).not.toContain("<skill_instructions>");
    }
  });

  it("refuses an out-of-range number with the valid range", async () => {
    const { bridge, received } = makeBridge();
    bindSession(bridge);
    await asInbound(bridge).handleMessage(text("/skill 9"));
    expect(lastReply()).toContain("编号 9 超出范围");
    expect(lastReply()).toContain("1-4");
    expect(received).toHaveLength(0);
  });

  it("refuses an unknown name", async () => {
    const { bridge, received } = makeBridge();
    bindSession(bridge);
    await asInbound(bridge).handleMessage(text("/skill nope"));
    expect(lastReply()).toContain("没有名为「nope」的技能");
    expect(received).toHaveLength(0);
  });

  it("answers a line carrying a task with usage, not a forwarded sentence", async () => {
    const { bridge, received } = makeBridge();
    bindSession(bridge);
    await asInbound(bridge).handleMessage(text("/skill 1 帮我做这个事"));
    expect(lastReply()).toContain("用法: /skill");
    // The usage line must teach the alternative, or the user is stuck.
    expect(lastReply()).toContain("/技能名");
    expect(received).toHaveLength(0);
  });

  it("asks which sibling was meant instead of picking one", async () => {
    // 真实歧义：没有 `office` 本体，只有它的两个兄弟，用户打 `/skill office`。
    const siblings = SKILLS.filter((entry) => entry.name !== "office");
    const { bridge, received } = makeBridge({ skills: siblings });
    bindSession(bridge);
    await asInbound(bridge).handleMessage(text("/skill office"));
    expect(lastReply()).toContain("匹配到 2 个技能");
    expect(lastReply()).toContain("office-docx");
    expect(lastReply()).toContain("office-xlsx");
    expect(received).toHaveLength(0);
  });

  it("says the host has no skill service instead of pretending there are none", async () => {
    const { bridge, received } = makeBridge({ skills: undefined, withCatalog: false });
    bindSession(bridge);
    await asInbound(bridge).handleMessage(text("/skill"));
    expect(lastReply()).toContain("未挂载技能服务");
    expect(received).toHaveLength(0);
  });

  it("hides a skill the user may not invoke", async () => {
    const restricted: SkillEntry[] = [
      { ...SKILLS[0]!, invocation: { userInvocable: false, modelInvocable: true } },
      SKILLS[3]!,
    ];
    const { bridge } = makeBridge({ skills: restricted });
    bindSession(bridge);
    await asInbound(bridge).handleMessage(text("/skill"));
    expect(lastReply()).toContain("1 个");
    expect(lastReply()).toContain("skill-creator");
    // Only the numbered rows matter here: the advice lines mention `/office` as
    // a generic example and say nothing about which skills are listed.
    const rows = lastReply().split("\n").filter((line) => /^\d+\. /.test(line));
    expect(rows).toEqual(["1. skill-creator — Create new skills and improve existing ones."]);
  });

  it("reads the session catalog's flat modelInvocable shape as well", async () => {
    // 两个宿主服务报的策略形状不同：`ctx.skills.list` 给嵌套的 `invocation`，
    // `ctx.sessionSkillCatalog.list` 给扁平的 `modelInvocable`（它本来就只返回
    // 用户可调用的技能）。把一种当成另一种，就会把只给模型用的技能列出来。
    const flat: SkillEntry[] = [
      { ...SKILLS[0]!, invocation: undefined, modelInvocable: true },
      { ...SKILLS[3]!, invocation: undefined, modelInvocable: false },
    ];
    const { bridge } = makeBridge({ skills: flat });
    bindSession(bridge);
    await asInbound(bridge).handleMessage(text("/skill"));
    // Neither flat entry declares `userInvocable: false`, so both stay visible —
    // the flat flag describes MODEL invocation and must not hide a row.
    expect(lastReply()).toContain("2 个");
    expect(lastReply()).toContain("office");
    expect(lastReply()).toContain("skill-creator");
  });

  it("does not arm any state: a later message is forwarded untouched", async () => {
    // 简版没有暂存，所以 `/skill 1` 之后那句普通消息必须原样发出，不带任何附加块。
    const { bridge, received } = makeBridge();
    bindSession(bridge);
    await asInbound(bridge).handleMessage(text("/skill 1"));
    await asInbound(bridge).handleMessage(text("把这份报告转成 PDF"));
    const delivered = received.map((m) => m.content.map((b) => b.text ?? "").join(""));
    expect(delivered).toEqual(["把这份报告转成 PDF"]);
  });
});
