import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DshOps } from "../src/dsh/ops.js";
import { AgentStore } from "../src/dsh/sessions.js";
import { defaultConfig } from "../src/config.js";
import { MessageType } from "../src/weixin/types.js";

const { sendTextMessage } = vi.hoisted(() => ({ sendTextMessage: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/weixin/send.js", () => ({
  sendTextMessage,
  sendMediaMessage: vi.fn(),
  splitText: (text: string) => [text],
}));
import { WeChatDSHBridge } from "../src/bridge/bridge.js";

function context(services: Record<string, unknown>) {
  return { get: (name: string) => services[name], on: () => () => {} };
}

const temporaryDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  sendTextMessage.mockClear();
  for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("default Preset settings compatibility", () => {
  it.each(["agent-preset-registry", "include:agent-preset-registry"])(
    "writes selectedDefault to the advertised %s namespace",
    async (ns) => {
      let selectedDefault = "standard";
      const settings = {
        describe: () => [{ ns, value: { selectedDefault } }],
        update: vi.fn(async (namespace: string, patch: { selectedDefault: string }) => {
          if (namespace !== ns || Object.keys(patch).join() !== "selectedDefault") {
            throw new Error("Invalid settings target");
          }
          selectedDefault = patch.selectedDefault;
        }),
      };
      const services = {
        settings,
        agentPresets: { get defaultId() { return selectedDefault; } },
        agents: { create: vi.fn(async () => ({ agent: { id: "new-session" } })) },
      };
      const ctx = context(services);
      const ops = new DshOps(ctx);
      await expect(ops.saveDefaultPreset("cordis")).resolves.toBe(true);
      expect(settings.update).toHaveBeenCalledWith(ns, { selectedDefault: "cordis" });
      expect(ops.defaultPresetId()).toBe("cordis");
      const store = new AgentStore(ctx);
      await store.ensure({ userId: "u1", sessionId: "", cwd: "C:\\work" });
      expect(services.agents.create).toHaveBeenCalledWith(expect.objectContaining({
        meta: { cwd: "C:\\work", agentPreset: "cordis" },
      }));
    },
  );

  it("keeps the legacy agent-presets.default document contract", async () => {
    for (const describe of [undefined, () => [{ ns: "agent-presets" }]]) {
      const update = vi.fn().mockResolvedValue(undefined);
      const ops = new DshOps(context({ settings: { describe, update } }));
      await expect(ops.saveDefaultPreset("cordis")).resolves.toBe(true);
      expect(update).toHaveBeenCalledWith("agent-presets", { default: "cordis" });
    }
  });

  it("does not write an unregistered namespace", async () => {
    const update = vi.fn();
    const ops = new DshOps(context({ settings: { describe: () => [], update } }));
    await expect(ops.saveDefaultPreset("cordis")).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("reports a rejected write without changing the default", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ops = new DshOps(context({
      settings: {
        describe: () => [{ ns: "agent-preset-registry" }],
        update: vi.fn().mockRejectedValue(new Error("Write refused")),
      },
      agentPresets: { defaultId: "standard" },
    }));
    await expect(ops.saveDefaultPreset("cordis")).resolves.toBe(false);
    expect(ops.defaultPresetId()).toBe("standard");
  });

  it("reports missing settings as a failure", async () => {
    await expect(new DshOps(context({})).saveDefaultPreset("cordis")).resolves.toBe(false);
  });
});

/**
 * Bridge harness. `started` mirrors DSH's `turnBoundary` projection — the one
 * predicate that decides whether a session's preset may still change.
 */
function makeBridge(options: {
  started: boolean;
  rejectWrite?: boolean;
  missingSettings?: boolean;
  noSession?: boolean;
  lockedDespiteBlank?: boolean;
  /**
   * Simulate a fresh process: the session is bound on disk but not loaded, so
   * `agents.get` misses until `resume` runs.
   */
  cold?: boolean;
}) {
  let selectedDefault = "standard";
  const recompose = vi.fn().mockResolvedValue(undefined);
  const resume = vi.fn(async () => ({ agent }));
  const select = vi.fn(async () => {
    if (options.lockedDespiteBlank) {
      throw Object.assign(new Error("This session has already started"), {
        code: "agent-preset/locked",
      });
    }
    return "cordis";
  });
  const append = vi.fn();
  const settings = {
    describe: () => [{ ns: "agent-preset-registry", value: { selectedDefault } }],
    update: vi.fn(async (_ns: string, patch: { selectedDefault: string }) => {
      if (options.rejectWrite) throw new Error("Write refused");
      selectedDefault = patch.selectedDefault;
    }),
  };
  const agent = {
    id: "s-live", status: "idle", ctx: {},
    session: { seq: 1, header: { agentPreset: "standard" }, append, snapshotEvents: () => [] },
  };
  const presets = {
    list: async () => [{ id: "standard", name: "标准模式" }, { id: "cordis", name: "创造模式" }],
    get defaultId() { return selectedDefault; },
    recompose,
    select,
  };
  const projections = {
    snapshot: () => ({ asOfSeq: 0, values: {} }),
    stateOf: (_session: unknown, key: string) =>
      key === "turnBoundary" ? { openTurnStartSeq: null, lastTurn: options.started ? 1 : 0 } : undefined,
  };
  const ctx = context({
    agentPresets: presets,
    agents: {
      get: (id: string) => (!options.cold && id === agent.id ? agent : undefined),
      resume,
    },
    sessionProjections: projections,
    ...(!options.missingSettings ? { settings } : {}),
  });
  const cfg = defaultConfig();
  cfg.storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-preset-switch-"));
  temporaryDirs.push(cfg.storageDir);
  const bridge = new WeChatDSHBridge(ctx, cfg);
  const harness = bridge as unknown as {
    token: unknown;
    state: { ensureUser(userId: string, cwd: string): unknown; update(userId: string, patch: unknown): void };
    handleMessage(message: unknown): Promise<void>;
  };
  harness.token = { baseUrl: "https://gw", token: "t", accountId: "b1", userId: "u", savedAt: "" };
  harness.state.ensureUser("u1", "C:\\work");
  if (!options.noSession) harness.state.update("u1", { sessionId: agent.id });
  return { harness, settings, recompose, select, resume, presets, agent, append };
}

async function run(harness: { handleMessage(message: unknown): Promise<void> }, text: string) {
  await harness.handleMessage({
    message_type: MessageType.USER,
    from_user_id: "u1",
    context_token: "ctx-token",
    item_list: [{ type: 1, text_item: { text } }],
  });
  return sendTextMessage.mock.calls.map((call) => String(call[1])).join("\n");
}

describe("WeChat /preset switch — session-scoped, before the first turn", () => {
  it("switches the bound session through the host select, leaving the default alone", async () => {
    const { harness, settings, select, agent } = makeBridge({ started: false });
    const reply = await run(harness, "/preset switch cordis");
    expect(select).toHaveBeenCalledWith(agent, "cordis");
    // The whole point of the change: a session switch must NOT rewrite the
    // deployment default every future session inherits.
    expect(settings.update).not.toHaveBeenCalled();
    expect(reply).toContain("✅ 当前会话 Preset 已切换: 创造模式");
    expect(reply).toContain("新会话默认不变");
  });

  it("resolves a number target against the roster", async () => {
    const { harness, select, agent } = makeBridge({ started: false });
    // 2 = cordis in the roster order.
    expect(await run(harness, "/p switch 2")).toContain("创造模式");
    expect(select).toHaveBeenCalledWith(agent, "cordis");
  });

  it("refuses a session that already ran a turn, and points at /s new", async () => {
    const { harness, select, settings } = makeBridge({ started: true });
    const reply = await run(harness, "/preset switch cordis");
    expect(select).not.toHaveBeenCalled();
    expect(settings.update).not.toHaveBeenCalled();
    expect(reply).toContain("当前会话已经开始");
    expect(reply).toContain("未切换");
    expect(reply).toContain("/s new");
    expect(reply).toContain("/preset default");
    expect(reply).not.toContain("✅");
  });

  it("still refuses honestly when the host locks the switch despite a blank read", async () => {
    // The pre-check reads the projection; the host is the authority. A lock
    // raised by `select` must be reported as a lock, not as a generic failure.
    const { harness } = makeBridge({ started: false, lockedDespiteBlank: true });
    const reply = await run(harness, "/preset switch cordis");
    expect(reply).toContain("当前会话已经开始");
    expect(reply).toContain("未切换");
    expect(reply).not.toContain("✅");
  });

  it("reports an unknown target without touching anything", async () => {
    const { harness, select, settings } = makeBridge({ started: false });
    const reply = await run(harness, "/preset switch nope");
    expect(select).not.toHaveBeenCalled();
    expect(settings.update).not.toHaveBeenCalled();
    expect(reply).toContain("未知 Preset: nope");
  });

  it("reports an out-of-range index", async () => {
    const { harness, select } = makeBridge({ started: false });
    expect(await run(harness, "/preset switch 9")).toContain("编号超出范围（1-2）");
    expect(select).not.toHaveBeenCalled();
  });

  it("asks for a session when none is bound", async () => {
    const { harness, select } = makeBridge({ started: false, noSession: true });
    const reply = await run(harness, "/preset switch cordis");
    expect(select).not.toHaveBeenCalled();
    expect(reply).toContain("没有可用会话");
    expect(reply).toContain("/s new");
  });

  it("resumes a bound-but-unloaded session instead of telling the user to send a message", async () => {
    // After a DSH restart the binding exists on disk but no Agent is loaded.
    // Answering "send a message first" would be actively wrong: sending a
    // message starts the turn, which is the very thing that locks the preset.
    const { harness, resume, select, agent } = makeBridge({ started: false, cold: true });
    const reply = await run(harness, "/preset switch cordis");
    expect(resume).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(agent, "cordis");
    expect(reply).toContain("✅ 当前会话 Preset 已切换");
  });
});

describe("WeChat /preset default — deployment default, new sessions", () => {
  it("writes the settings document and does not switch the live session", async () => {
    const { harness, settings, select, recompose, presets } = makeBridge({ started: false });
    const reply = await run(harness, "/preset default cordis");
    expect(settings.update).toHaveBeenCalledWith("agent-preset-registry", { selectedDefault: "cordis" });
    expect(presets.defaultId).toBe("cordis");
    expect(select).not.toHaveBeenCalled();
    expect(recompose).not.toHaveBeenCalled();
    expect(reply).toContain("✅ 新会话默认 Preset 已切换: 创造模式");
    expect(reply).not.toContain("无法写入");
  });

  it("works even when the bound session is already running", async () => {
    // The default is about FUTURE sessions, so a started session is not a
    // reason to refuse — unlike `switch`.
    const { harness, settings } = makeBridge({ started: true });
    expect(await run(harness, "/preset default cordis")).toContain("✅ 新会话默认 Preset 已切换");
    expect(settings.update).toHaveBeenCalled();
  });

  it("says the live session still runs its own preset", async () => {
    const { harness } = makeBridge({ started: true });
    const reply = await run(harness, "/preset default cordis");
    expect(reply).toContain("当前会话仍是");
    expect(reply).toContain("/s new");
  });

  it("bare /preset default only reports the current default", async () => {
    const { harness, settings } = makeBridge({ started: false });
    const reply = await run(harness, "/preset default");
    expect(settings.update).not.toHaveBeenCalled();
    expect(reply).toContain("新会话默认 Preset: 标准模式");
  });

  it.each(["rejected", "missing"])("does not claim success when settings are %s", async (reason) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { harness, presets } = makeBridge({
      started: false,
      rejectWrite: reason === "rejected",
      missingSettings: reason === "missing",
    });
    const reply = await run(harness, "/preset default cordis");
    expect(reply).toContain("默认 Preset 切换失败");
    expect(reply).toContain("默认 Preset 未更改");
    expect(reply).not.toContain("✅");
    expect(presets.defaultId).toBe("standard");
  });
});

describe("WeChat /preset list and status", () => {
  it("marks the live session and the new-session default separately", async () => {
    const { harness } = makeBridge({ started: true });
    const reply = await run(harness, "/preset list");
    expect(reply).toContain("◀ 新会话默认");
    expect(reply).toContain("/preset default");
    expect(reply).toContain("标准模式");
  });

  it("reports both facts on status", async () => {
    const { harness } = makeBridge({ started: true });
    const reply = await run(harness, "/preset status");
    expect(reply).toMatch(/新会话默认 Preset:\s*标准模式/);
    expect(reply).toContain("当前会话 Preset:");
    expect(reply).toContain("/preset switch");
    expect(reply).toContain("/preset default");
  });

  it("says the session is unbound instead of inventing a live preset", async () => {
    const { harness } = makeBridge({ started: false, noSession: true });
    const reply = await run(harness, "/preset status");
    expect(reply).toMatch(/新会话默认 Preset:\s*标准模式/);
    expect(reply).toContain("当前会话 Preset: （未绑定）");
  });
});

describe("DshOps.sessionStarted — the host's own blank predicate", () => {
  const opsWith = (stateOf: (key: string) => unknown) => new DshOps(context({
    sessionProjections: { snapshot: () => ({ asOfSeq: 0, values: {} }), stateOf: (_s: unknown, key: string) => stateOf(key) },
  }));

  it("reads turnBoundary: an open turn or a completed one means started", () => {
    const session = { seq: 1 };
    expect(opsWith(() => ({ openTurnStartSeq: null, lastTurn: 0 })).sessionStarted(session)).toBe(false);
    expect(opsWith(() => ({ openTurnStartSeq: 3, lastTurn: 0 })).sessionStarted(session)).toBe(true);
    expect(opsWith(() => ({ openTurnStartSeq: null, lastTurn: 2 })).sessionStarted(session)).toBe(true);
  });

  it("treats a missing projection as not started (the attempt decides)", () => {
    expect(opsWith(() => undefined).sessionStarted({ seq: 1 })).toBe(false);
  });

  it("falls back to the event log on a host without stateOf", () => {
    const ops = new DshOps(context({}));
    expect(ops.sessionStarted({ seq: 1, snapshotEvents: () => [] })).toBe(false);
    expect(ops.sessionStarted({
      seq: 2,
      snapshotEvents: () => [{ type: "user/message" }],
    })).toBe(true);
  });

  it("treats a missing session as started (nothing can be switched)", () => {
    expect(new DshOps(context({})).sessionStarted(undefined)).toBe(false);
  });
});
