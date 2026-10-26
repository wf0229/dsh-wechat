/**
 * Secret masking for text that leaves the trust boundary.
 *
 * Scope — this function is for ERROR text, excerpts and telemetry only.
 * It must NEVER be applied to an agent's normal reply body: the hex and
 * base64 rules below are deliberately greedy (`32+` hex, `40+` base64)
 * and would mangle every commit SHA, content hash, file digest, hex
 * payload and long identifier in a legitimate answer. An agent that
 * explains a git rebase would come back with `***` where the SHAs were.
 *
 * Everything here is a heuristic over shapes, not an entropy detector.
 * It is intentionally cheap, pure and synchronous: it runs on the error
 * path where an exception must not become a second failure.
 */

/** What every matched secret collapses to. */
const MASK = "***";

/**
 * Ordered rules, longest / most specific first. Order matters twice:
 * a specific pattern must claim its span before a greedy generic rule
 * (hex, base64) sees the string, and masking must replace the WHOLE
 * span — a partial mask (`sk-***`) still leaks the live suffix.
 *
 * Split in two — see {@link maskCredentials} for why the generic shapes are
 * NOT part of the first list.
 */
const CREDENTIAL_RULES: readonly RegExp[] = [
  // JWT — three base64url segments. The signature segment is quantified
  // lazily so that when two tokens are concatenated (a log line holding
  // an access + refresh pair) the first match stops at the first
  // signature instead of swallowing the second token's header.
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  // OpenAI-style API keys.
  /\b[rs]k-[A-Za-z0-9_-]{16,}/g,
  // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_).
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  // Slack tokens (xoxb-/xoxa-/xoxp-/xoxr-/xoxs-).
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{12,}/g,
];

/**
 * Shapes that ARE often secrets (hashes, HMACs, session keys) and are also
 * routinely legitimate content in an answer: commit SHAs, file digests,
 * package integrity values, long identifiers. Safe on an excerpt, ruinous on
 * a whole reply — {@link maskSecrets} keeps them, {@link maskCredentials}
 * does not.
 */
const GENERIC_RULES: readonly RegExp[] = [
  // Long hex runs: hashes, HMACs, session keys.
  /\b[0-9a-fA-F]{32,}\b/g,
  // Long base64 / base64url runs.
  /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{40,}/g,
];

/** Every rule, applied by {@link maskSecrets} in this order. */
const RULES: readonly RegExp[] = [...CREDENTIAL_RULES, ...GENERIC_RULES];

/**
 * Mask the credential after every `Bearer` scheme word, keeping the word.
 *
 * A regex cannot do this cleanly. The lookbehind has to be case-insensitive
 * while the token class is not, JavaScript has no inline flag groups, and a
 * capture group is out (`String.replace` then passes the match OFFSET as the
 * replacer's second argument, and returning it prefixes every mask with a
 * number). A cursor scan has none of those problems and backtracks never.
 */
function maskBearerTokens(text: string): string {
  const KEYWORD = "Bearer";
  const TAB = String.fromCharCode(9);
  // Token characters, per the RFC 6750 b64token production. A Set keeps the
  // scan O(n) and off the (byte-indexing) `String.prototype.includes`.
  const TOKEN_CHARS = new Set(Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~+/="));
  let out = "";
  let cursor = 0;
  for (;;) {
    const at = text.toLowerCase().indexOf(KEYWORD.toLowerCase(), cursor);
    if (at === -1) break;
    // The scheme word stands alone and is followed by whitespace: `MyBearer`
    // is not a scheme word.
    const beforeOk = at === 0 || !/[A-Za-z0-9]/.test(text[at - 1]!);
    const space = text[at + KEYWORD.length];
    if (!beforeOk || (space !== " " && space !== TAB)) {
      cursor = at + KEYWORD.length;
      continue;
    }
    let tokenStart = at + KEYWORD.length;
    while (text[tokenStart] === " " || text[tokenStart] === TAB) tokenStart += 1;
    let tokenEnd = tokenStart;
    while (tokenEnd < text.length && TOKEN_CHARS.has(text[tokenEnd]!)) tokenEnd += 1;
    // Too short to be a credential: keep the text and step past the word, so
    // the scan always advances and always terminates.
    if (tokenEnd - tokenStart < 8) {
      out += text.slice(cursor, tokenStart);
      cursor = tokenStart;
      continue;
    }
    out += text.slice(cursor, tokenStart) + MASK;
    cursor = tokenEnd;
  }
  return out + text.slice(cursor);
}

/**
 * Mask secret-shaped substrings in one text.
 *
 * Idempotent by construction: every replacement yields `***`, and no
 * rule can match a run of asterisks or start inside one, so a second
 * pass over already-masked text is a no-op. That matters because error
 * text is masked on the way into a notification and again when the
 * notification is flushed from a hold.
 *
 * @param text - text about to leave for WeChat (an error, an excerpt, a
 *   telemetry line) — never a normal agent reply.
 * @returns the same text with every detected secret replaced by `***`.
 */
export function maskSecrets(text: string): string {
  return applyRules(text, RULES);
}

/**
 * Mask only the UNAMBIGUOUS credentials — API keys, JWTs, cloud access key
 * ids, `Bearer <token>` — and leave generic long-token shapes alone.
 *
 * This is the variant for text that may be a whole answer rather than a
 * snippet: {@link maskSecrets}' hex/base64 rules would replace every commit
 * SHA and digest in it, which is exactly the damage its own header warns
 * about. Used for the `notifyTaskFullReply` notice, where the body IS the
 * answer the user wants to read.
 *
 * `Bearer` masking is kept: the scheme word plus a token is a credential by
 * construction, never prose.
 */
export function maskCredentials(text: string): string {
  return applyRules(text, CREDENTIAL_RULES);
}

/** Run one rule list over `text` (shared by both entry points). */
function applyRules(text: string, rules: readonly RegExp[]): string {
  if (!text) return text;
  let out = text;
  for (const rule of rules) {
    // Each rule is a fresh literal, but a global RegExp keeps `lastIndex`
    // across calls — reset it so a shared module-level instance can never
    // skip a match on the second invocation.
    rule.lastIndex = 0;
    out = out.replace(rule, MASK);
  }
  return maskBearerTokens(out);
}

/**
 * Mask a WeChat user id for a LOG LINE.
 *
 * Logs are the one artifact that routinely leaves the machine (bug reports,
 * CI transcripts, pasted terminal output), and a WeChat user id is a stable
 * handle on a real person. The short head/tail are kept so an operator can
 * still correlate two lines about the same sender, and a very short id is
 * masked whole (there is nothing to keep that would not identify it).
 *
 * NOT used for text sent back to WeChat: the bound peer sees their own id in
 * `/status` on purpose (S3 — the owner must never have to guess it), and an
 * id must not be masked inside a message the user is supposed to read.
 */
export function maskUserId(userId: string): string {
  if (!userId) return "";
  if (userId.length <= 4) return MASK;
  return `${userId.slice(0, 2)}${MASK}${userId.slice(-2)}`;
}
