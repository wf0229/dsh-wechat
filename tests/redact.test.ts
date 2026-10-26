/**
 * `maskSecrets` — secret-shaped substring masking for ERROR text, excerpts
 * and telemetry.
 *
 * The rules are heuristics over shapes, so two properties matter as much as
 * the individual patterns:
 *   - specific patterns claim their span before the greedy hex/base64 rules
 *     see it (a partially masked key still leaks its live suffix);
 *   - the function is idempotent, because error text is masked on the way
 *     into a notification and again when that notification is flushed from
 *     a hold.
 *
 * The greedy rules are also why this is never applied to an agent's normal
 * reply body — see the "not for reply bodies" cases at the end.
 */

import { describe, expect, it } from "vitest";
import { maskCredentials, maskSecrets } from "../src/utils/redact.js";

/** A realistic 3-segment JWT. */
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

describe("maskSecrets: each rule masks", () => {
  it("masks a JWT", () => {
    expect(maskSecrets(`token=${JWT}`)).toBe("token=***");
  });

  it("masks sk- and rk- API keys", () => {
    expect(maskSecrets("key sk-abcdefghijklmnopqrstuvwxyz012345"))
      .toBe("key ***");
    expect(maskSecrets("key rk-abcdefghijklmnopqrstuvwxyz012345"))
      .toBe("key ***");
  });

  it("masks GitHub tokens (ghp/gho/ghu/ghs/ghr)", () => {
    for (const prefix of ["ghp", "gho", "ghu", "ghs", "ghr"]) {
      expect(maskSecrets(`${prefix}_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`)).toBe("***");
    }
  });

  it("masks Slack tokens (xoxb/xoxa/xoxp/xoxr/xoxs)", () => {
    for (const prefix of ["xoxb", "xoxa", "xoxp", "xoxr", "xoxs"]) {
      expect(maskSecrets(`${prefix}-1234567890-abcdefghijkl`)).toBe("***");
    }
  });

  it("masks AWS access key ids", () => {
    expect(maskSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("***");
  });

  it("masks the credential after a Bearer scheme word and keeps the word", () => {
    expect(maskSecrets("Authorization: Bearer abcDEF123._-xyz")).toBe("Authorization: Bearer ***");
  });

  it("matches a lowercase `bearer` too", () => {
    expect(maskSecrets("authorization: bearer abcDEF123456789"))
      .toBe("authorization: bearer ***");
  });

  it("masks a run of 32+ hex characters", () => {
    expect(maskSecrets("sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"))
      .toBe("sha256 ***");
    expect(maskSecrets("hash 0123456789abcdef0123456789abcdef")).toBe("hash ***");
  });

  it("masks a run of 40+ base64 characters", () => {
    expect(maskSecrets("blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXI="))
      .toBe("blob ***");
  });

  it("masks a raw hex secret at a boundary inside a longer word", () => {
    // The base64 rule fires on the hex run that the `\b`-anchored hex rule
    // cannot see (no word boundary inside a token).
    expect(maskSecrets("session=deadbeefdeadbeefdeadbeefdeadbeef")).toBe("session=***");
  });

  it("masks only the secrets in a multi-secret error line", () => {
    const line = `POST failed: Authorization: Bearer abcDEF1234567890, retry with sk-abcdefghijklmnopqrstuvwxyz012345`;
    expect(maskSecrets(line)).toBe("POST failed: Authorization: Bearer ***, retry with ***");
  });
});

describe("maskSecrets: clean prose is untouched", () => {
  const clean = [
    "The build failed because the tokenizer crashed at line 42.",
    "⚠️ Agent 出错: ret=-14 session timeout; re-scan the QR code",
    "已发送 3 条，剩余 2 条缓存，/next 继续。",
    "Error: ENOENT: no such file or directory, open 'C:\\work\\src\\index.ts'",
    "429 Too Many Requests after 3 attempts (backoff 1s, 2s, 4s)",
    "",
  ];
  for (const text of clean) {
    it(`leaves ${JSON.stringify(text.slice(0, 40))} alone`, () => {
      expect(maskSecrets(text)).toBe(text);
    });
  }

  it("leaves ordinary short identifiers alone", () => {
    expect(maskSecrets("commit a3f9c2e sha 1b2c3d4")).toBe("commit a3f9c2e sha 1b2c3d4");
    expect(maskSecrets("sess-2f4c1c2e-9b3a-4d5e-8f0")).toBe("sess-2f4c1c2e-9b3a-4d5e-8f0");
  });
});

describe("maskSecrets: idempotent", () => {
  const cases = [
    `token=${JWT}`,
    "Authorization: Bearer abcDEF1234567890",
    "hash 0123456789abcdef0123456789abcdef",
    "blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXI=",
    "AKIAIOSFODNN7EXAMPLE",
    "clean prose about a failed build",
  ];
  for (const text of cases) {
    it(`a second pass over ${JSON.stringify(text.slice(0, 30))} is a no-op`, () => {
      const once = maskSecrets(text);
      expect(maskSecrets(once)).toBe(once);
      expect(maskSecrets(maskSecrets(maskSecrets(text)))).toBe(once);
    });
  }

  it("never matches inside an already-written mask", () => {
    expect(maskSecrets("key=***")).toBe("key=***");
    expect(maskSecrets("*** and ***")).toBe("*** and ***");
  });
});

describe("maskSecrets: why it is not applied to reply bodies", () => {
  it("would mangle a long word — the reason the callers scope it to error text", () => {
    // Not a bug to fix here: this is the documented blast radius. A normal
    // assistant answer that quotes a 40-character identifier, hash or long
    // hyphenated path WOULD lose it, so the bridge only masks error text
    // and cross-session excerpts.
    expect(maskSecrets("unbelievably-long-hyphenated-directory-name-here"))
      .toBe("***");
  });

  it("would mangle a session id — the exact false positive the scope avoids", () => {
    // A 43-character session id is a valid base64url run, so the generic
    // rule claims it. Mask enough of those in a normal answer and the reply
    // stops being usable, which is why `maskSecrets` is wired ONLY at the
    // error paths and the cross-session excerpt.
    expect(maskSecrets("sess-2f4c1c2e-9b3a-4d5e-8f01-abcdef012345"))
      .toBe("***");
  });
});

/**
 * `maskCredentials` — the narrower variant used when the text may be a WHOLE
 * answer (`notifyTaskFullReply`) rather than a snippet.
 *
 * It exists because of the false positives pinned above: the same rules that
 * make an 80-character excerpt safe turn a real answer into `***` wherever it
 * names a commit, a digest or a long identifier. So the split is deliberate and
 * both halves have to hold — unambiguous credentials still masked, generic
 * long-token shapes left alone.
 */
describe("maskCredentials: only unambiguous credentials", () => {
  it("still masks every shape that IS a credential", () => {
    expect(maskCredentials(`token=${JWT}`)).toBe("token=***");
    expect(maskCredentials("key sk-abcdefghijklmnopqrstuvwxyz012345")).toBe("key ***");
    expect(maskCredentials("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")).toBe("***");
    expect(maskCredentials("xoxb-1234567890-abcdefghijkl")).toBe("***");
    expect(maskCredentials("AKIAIOSFODNN7EXAMPLE")).toBe("***");
    expect(maskCredentials("Authorization: Bearer abcDEF123._-xyz")).toBe("Authorization: Bearer ***");
  });

  it("leaves the false positives that ruin a whole answer alone", () => {
    // The three cases `maskSecrets` mangled above, now preserved: this is the
    // entire reason the narrower rule list exists.
    expect(maskCredentials("unbelievably-long-hyphenated-directory-name-here"))
      .toBe("unbelievably-long-hyphenated-directory-name-here");
    expect(maskCredentials("sess-2f4c1c2e-9b3a-4d5e-8f01-abcdef012345"))
      .toBe("sess-2f4c1c2e-9b3a-4d5e-8f01-abcdef012345");
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(maskCredentials(`commit ${sha} landed`)).toBe(`commit ${sha} landed`);
    const digest = "0123456789abcdef0123456789abcdef";
    expect(maskCredentials(`sha256 ${digest}`)).toBe(`sha256 ${digest}`);
  });

  it("keeps prose about a real answer intact", () => {
    const answer = [
      "## 修复内容",
      "把 `url` 拼接改成 URLSearchParams，commit 3f2a9c1 已提交。",
      "测试 1188 条全过，耗时 4.65s。",
    ].join("\n");
    expect(maskCredentials(answer)).toBe(answer);
  });

  it("is idempotent", () => {
    for (const text of [
      `token=${JWT}`,
      "Authorization: Bearer abcDEF1234567890",
      "commit 0123456789abcdef0123456789abcdef01234567",
    ]) {
      const once = maskCredentials(text);
      expect(maskCredentials(once)).toBe(once);
    }
  });
});
