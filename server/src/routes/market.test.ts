import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { marketRouter } from "./market.js";
import * as nasdaq from "../providers/nasdaq.js";
import * as yahoo from "../providers/yahoo.js";

afterEach(() => vi.restoreAllMocks());

function fakeRes(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

function getHandler(path: string) {
  const layer = (marketRouter as any).stack.find((l: any) => l.route?.path === path);
  if (!layer) throw new Error(`no route registered for ${path}`);
  return layer.route.stack[0].handle as (req: Request, res: Response, next: () => void) => unknown;
}

describe("GET /crypto/orderbook/:symbol", () => {
  it("rejects a symbol outside the supported crypto whitelist with 400, before touching the network", async () => {
    const handler = getHandler("/crypto/orderbook/:symbol");
    const req = { params: { symbol: "AAA&limit=5000" } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "unsupported crypto symbol" });
  });

  it("accepts a whitelisted symbol (case-insensitive) and proceeds past validation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ bids: [], asks: [] }) })
    );
    try {
      const handler = getHandler("/crypto/orderbook/:symbol");
      const req = { params: { symbol: "btc" } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => {});

      expect(res.status).not.toHaveBeenCalledWith(400);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("GET /options/:symbol", () => {
  const expiry = "2027-01-15";
  const unixExpiry = Date.parse(`${expiry}T00:00:00Z`) / 1000;
  const yahooChain = {
    symbol: "MSFT", underlyingPrice: 100, expirationDates: [unixExpiry],
    selectedDate: unixExpiry, calls: [{ strike: 100 }], puts: [],
  };

  it("forwards the selected expiration to Yahoo when Nasdaq fails", async () => {
    vi.spyOn(nasdaq, "optionChain").mockRejectedValue(new Error("nasdaq unavailable"));
    const options = vi.spyOn(yahoo, "options").mockResolvedValue(yahooChain);
    const res = fakeRes();
    await getHandler("/options/:symbol")({
      params: { symbol: "MSFT" }, query: { expiry },
    } as unknown as Request, res, () => {});
    expect(options).toHaveBeenCalledWith("MSFT", unixExpiry);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ selectedDate: expiry }));
  });

  it("preserves the default expiration when none was requested", async () => {
    vi.spyOn(nasdaq, "optionChain").mockRejectedValue(new Error("nasdaq unavailable"));
    const options = vi.spyOn(yahoo, "options").mockResolvedValue(yahooChain);
    const res = fakeRes();
    await getHandler("/options/:symbol")({
      params: { symbol: "MSFT" }, query: {},
    } as unknown as Request, res, () => {});
    expect(options.mock.calls[0]?.[0]).toBe("MSFT");
    expect(options.mock.calls[0]?.[1]).toBeUndefined();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ selectedDate: expiry }));
  });

  it("does not return a different Yahoo expiration as if it were the requested one", async () => {
    vi.spyOn(nasdaq, "optionChain").mockRejectedValue(new Error("nasdaq unavailable"));
    vi.spyOn(yahoo, "options").mockResolvedValue(yahooChain);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeRes();
    await getHandler("/options/:symbol")({
      params: { symbol: "MSFT" }, query: { expiry: "2027-02-19" },
    } as unknown as Request, res, () => {});
    expect(res.status).toHaveBeenCalledWith(502);
  });

  it("rejects invalid expiration dates before calling a provider", async () => {
    const options = vi.spyOn(nasdaq, "optionChain").mockRejectedValue(new Error("nasdaq unavailable"));
    vi.spyOn(yahoo, "options").mockResolvedValue(yahooChain);
    const res = fakeRes();
    await getHandler("/options/:symbol")({
      params: { symbol: "MSFT" }, query: { expiry: "2026-02-30" },
    } as unknown as Request, res, () => {});
    expect(res.status).toHaveBeenCalledWith(400);
    expect(options).not.toHaveBeenCalled();
  });
});

describe("GET /earnings-history/:symbol", () => {
  it("uses report-date closes and leaves older reports without coverage empty", async () => {
    const timestamp = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;
    const report = {
      fiscalQtrEnd: "Sep 2026", dateReported: timestamp("2026-10-15"),
      eps: 1, consensusForecast: 1, surprisePercent: 0,
    };
    vi.spyOn(nasdaq, "earningsSurprise").mockResolvedValue([
      report, { ...report, dateReported: timestamp("2025-10-15") },
    ]);
    vi.spyOn(nasdaq, "history").mockResolvedValue([
      ["2026-10-12", 80], ["2026-10-13", 90], ["2026-10-15", 100], ["2026-10-16", 110],
    ].map(([date, close]) => ({
      time: timestamp(String(date)), open: Number(close), high: Number(close),
      low: Number(close), close: Number(close), volume: 1,
    })));
    const res = fakeRes();
    await getHandler("/earnings-history/:symbol")({ params: { symbol: "MSFT" } } as unknown as Request, res, () => {});
    expect(res.json).toHaveBeenCalledWith([
      expect.objectContaining({ dayAfterChangePercent: 10 }),
      expect.objectContaining({ dayAfterChangePercent: null }),
    ]);

describe("GET /news", () => {
  const rss = (title: string) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><item><title>${title}</title>` +
    `<link>https://example.com/${encodeURIComponent(title)}</link></item></channel></rss>`;

  async function newsFor(query: Record<string, string>) {
    const fetchMock = vi.fn(async (url: string) => {
      const host = new URL(url).hostname;
      const title =
        host === "feeds.finance.yahoo.com" ? "Yahoo Bitcoin AAPL headline"
        : host === "news.google.com" ? "Google Bitcoin AAPL headline"
        : `${host} Bitcoin headline`;
      return { ok: true, text: async () => rss(title) };
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = fakeRes();
      await getHandler("/news")({ query } as unknown as Request, res, () => {});
      const hosts = new Set(fetchMock.mock.calls.map(([u]) => new URL(u as string).hostname));
      const googleQueries = fetchMock.mock.calls
        .map(([u]) => new URL(u as string))
        .filter((u) => u.hostname === "news.google.com")
        .map((u) => u.searchParams.get("q"));
      return { hosts, googleQueries, body: (res.json as any).mock.calls[0][0] };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  const CRYPTO_HOSTS = ["www.coindesk.com", "cointelegraph.com", "decrypt.co"];

  it("adds the crypto publishers for a crypto ticker and searches Google by coin name", async () => {
    const { hosts, googleQueries, body } = await newsFor({ symbol: "btc" });
    for (const h of CRYPTO_HOSTS) expect(hosts.has(h)).toBe(true);
    expect(hosts.has("feeds.finance.yahoo.com")).toBe(true);
    expect(googleQueries).toEqual(["Bitcoin crypto"]);
    expect(body.map((i: any) => i.publisher)).toEqual(
      expect.arrayContaining(["CoinDesk", "Cointelegraph", "Decrypt", "Yahoo Finance", "Google News"])
    );
  });

  it("leaves stock tickers on Yahoo + Google only", async () => {
    const { hosts, googleQueries } = await newsFor({ symbol: "AAPL" });
    for (const h of CRYPTO_HOSTS) expect(hosts.has(h)).toBe(false);
    expect(googleQueries).toEqual(["AAPL stock"]);
  });

  it("includes crypto publishers in the global feed", async () => {
    const { hosts, body } = await newsFor({});
    for (const h of CRYPTO_HOSTS) expect(hosts.has(h)).toBe(true);
    expect(body.some((i: any) => i.publisher === "CoinDesk")).toBe(true);
  });
});
