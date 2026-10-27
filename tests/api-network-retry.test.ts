import { afterEach, describe, expect, it, vi } from "vitest";
import { getQrcodeStatus } from "../src/weixin/api.js";

// A network blip during QR polling used to end the login at once. Connection
// failures are retried with backoff; HTTP errors are answers and are not.
describe("apiGet network retry", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries connection failures and returns the later answer", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "wait" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const pending = getQrcodeStatus({ baseUrl: "https://gw.example", qrcode: "q" });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ status: "wait" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("names the host after the last failed attempt", async () => {
    vi.useFakeTimers();
    const cause = new Error("getaddrinfo ENOTFOUND gw.example");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause })));
    const pending = getQrcodeStatus({ baseUrl: "https://gw.example", qrcode: "q" });
    const settled = expect(pending).rejects.toThrow(/无法连接微信服务器 gw\.example: getaddrinfo ENOTFOUND.*网络通/);
    await vi.runAllTimersAsync();
    await settled;
  });

  it("does not retry an HTTP error", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    await expect(getQrcodeStatus({ baseUrl: "https://gw.example", qrcode: "q" })).rejects.toThrow("HTTP 503: busy");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
