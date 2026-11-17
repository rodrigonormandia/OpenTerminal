import { Router } from "express";
import { cached, cacheGet, cacheStore, staleGet } from "../cache.js";
import { tracked, withFallback } from "../providers/registry.js";
import * as yahoo from "../providers/yahoo.js";
import * as stooq from "../providers/stooq.js";
import * as nasdaq from "../providers/nasdaq.js";
import { isForeignListing, isUsListing, toProviderSymbol } from "../providerSymbol.js";
import * as fred from "../providers/fred.js";
import * as ecb from "../providers/ecb.js";
import * as bcb from "../providers/bcb.js";
import * as tradingview from "../providers/tradingview.js";
import * as coingecko from "../providers/coingecko.js";
import * as binance from "../providers/binance.js";
import * as news from "../providers/news.js";
import * as econcalendar from "../providers/econcalendar.js";
import * as finra from "../providers/finra.js";
import * as secedgar from "../providers/secedgar.js";
import { dayAfterEarningsChange } from "../earnings.js";
import { normalizeExpiry } from "../expiry.js";
import { normalizeSymbol } from "../symbol.js";
import { mergeLiveCandle } from "../livecandle.js";
import { parseExpiry, withGreeks } from "../greeks.js";
import { BENCHMARK, SECTOR_ETFS, completedSessions, periodReturns, relativeStrength } from "../sectorStrength.js";
import { etSessionDay } from "../livecandle.js";
import { mapWithConcurrency } from "../concurrency.js";
import * as clindicators from "../providers/clindicators.js";
import * as currencyapi from "../providers/currencyapi.js";
import { DEFAULT_FX_SYMBOLS, fxDigits, fxPairFor, searchFx, type FxPair } from "../fx.js";

export const marketRouter = Router();

// Every /:symbol route: reject non-ticker input with 400 before it reaches a
// provider URL or a cache key, and hand handlers the normalized form.
marketRouter.param("symbol", (req, res, next, raw) => {
  const symbol = normalizeSymbol(raw);
  if (!symbol) return res.status(400).json({ error: "invalid symbol" });
  req.params.symbol = symbol;
  next();
});

const QUOTE_TTL = 1_000;
const HISTORY_TTL = 20_000;
const INTRADAY_TTL = 5_000;
const NEWS_TTL = 60_000;
// Same set the chart offers (web/components/widgets/ChartWidget.tsx).
const HISTORY_RANGES = new Set(["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"]);

function fail(req: any, res: any, err: unknown) {
  const detail = err instanceof Error ? err.message : String(err);
  console.error("[market]", req.path, detail);
  res.status(502).json({ error: "All data providers are temporarily unavailable. Try again shortly." });
}

// ---- VIX: served from FRED (daily close), since it's an index rather than a
// tradable stock/ETF — Nasdaq's stock API doesn't carry it, and routing it
// through Yahoo would make it depend on Yahoo's flaky rate limits for no reason.

function isVix(symbol: string): boolean {
  return symbol.toUpperCase() === "^VIX" || symbol.toUpperCase() === "VIX";
}

async function vixQuote(): Promise<yahoo.Quote> {
  const points = await fred.series("VIXCLS", 5);
  if (points.length === 0) throw new Error("fred: no VIX data");
  const last = points[points.length - 1];
  const prev = points.length > 1 ? points[points.length - 2] : null;
  const price = last.value;
  const previousClose = prev?.value ?? null;
  const change = previousClose !== null ? price - previousClose : null;
  const changePercent = previousClose ? (change! / previousClose) * 100 : null;
  return {
    symbol: "^VIX",
    name: "CBOE Volatility Index",
    price,
    change,
    changePercent,
    open: null,
    high: null,
    low: null,
    previousClose,
    bid: null,
    ask: null,
    volume: null,
    avgVolume: null,
    marketCap: null,
    pe: null,
    eps: null,
    dividendYield: null,
    week52High: null,
    week52Low: null,
    beta: null,
    sharesOutstanding: null,
    currency: "USD",
    exchange: "CBOE",
    marketState: null,
    time: null,
    source: "fred",
  };
}

const VIX_RANGE_N: Record<string, number> = {
  "1D": 5,
  "5D": 5,
  "1M": 22,
  "6M": 130,
  YTD: 200,
  "1Y": 252,
  "5Y": 1260,
  MAX: 20_000,
};

async function vixHistory(rangeKey: string): Promise<yahoo.Candle[]> {
  const n = VIX_RANGE_N[rangeKey] ?? 130;
  const points = await fred.series("VIXCLS", n);
  return points.map((p) => {
    const time = Math.floor(new Date(p.date + "T00:00:00Z").getTime() / 1000);
    return { time, open: p.value, high: p.value, low: p.value, close: p.value, volume: 0 };
  });
}

function fxQuote(symbol: string, p: FxPair, r: tradingview.FxRow): yahoo.Quote {
  return {
    symbol,
    name: `${p.pair} — ${p.name}`,
    price: r.price,
    change: r.change,
    changePercent: r.changePercent,
    open: r.open,
    high: r.high,
    low: r.low,
    previousClose: r.price !== null && r.change !== null ? r.price - r.change : null,
    bid: null,
    ask: null,
    volume: null,
    avgVolume: null,
    marketCap: null,
    pe: null,
    eps: null,
    dividendYield: null,
    week52High: null,
    week52Low: null,
    beta: null,
    sharesOutstanding: null,
    currency: p.quote,
    exchange: "FX",
    marketState: null,
    time: null,
    source: "tradingview",
  };
}

// ---- quotes (per-symbol cache, so overlapping widgets share one fetch) ----

/**
 * Resolve quotes for a symbol list, reusing a per-symbol cache across every
 * caller (single quote widget, watchlist, screener, heatmap all share hits).
 * Nasdaq's public quote API is primary (no key, generous limits); Yahoo and
 * Stooq are fallbacks. A symbol that fails everywhere still falls back to
 * its last-known value instead of failing the whole batch.
 *
 * Fan-out bound: the /quotes route caps `symbols` at 150, so a single call
 * here does at most ~150 crypto lookups (only for recognized crypto symbols,
 * mutually exclusive with the stages below) + up to 300 Nasdaq calls (2 per
 * miss) + 1 batched Yahoo call + up to FALLBACK_PER_SYMBOL_CAP per-symbol
 * Yahoo chart calls + up to FALLBACK_PER_SYMBOL_CAP Stooq calls + 1 batched
 * TradingView call. Repetition beyond that is bounded by marketRouter's
 * per-IP rate limit (see index.ts).
 */
const FALLBACK_PER_SYMBOL_CAP = 20;
export async function getQuotes(symbols: string[]): Promise<yahoo.Quote[]> {
  const fresh = new Map<string, yahoo.Quote>();
  const missing: string[] = [];
  for (const sym of symbols) {
    const hit = cacheGet<yahoo.Quote>(`quote:${sym}`);
    if (hit) fresh.set(sym, hit);
    else missing.push(sym);
  }
  if (missing.length === 0) return symbols.map((s) => fresh.get(s)!).filter(Boolean);

  const fetched = new Map<string, yahoo.Quote>();
  let remaining = missing;

  const cryptoSymbols = remaining.filter((s) => binance.CRYPTO_SYMBOLS.has(s));
  if (cryptoSymbols.length > 0) {
    const results = await Promise.allSettled(cryptoSymbols.map((s) => binance.quote(s)));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(cryptoSymbols[i], r.value);
    });
    remaining = remaining.filter((s) => !fetched.has(s));
  }

  const vixSymbols = remaining.filter((s) => isVix(s));
  if (vixSymbols.length > 0) {
    const results = await Promise.allSettled(vixSymbols.map(() => vixQuote()));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(vixSymbols[i], r.value);
    });
    remaining = remaining.filter((s) => !fetched.has(s));
  }

  const fxSymbols = remaining.filter((s) => fxPairFor(s));
  if (fxSymbols.length > 0) {
    try {
      const rows = await tracked("tradingview-fx", () =>
        tradingview.fxScan(fxSymbols.map((s) => fxPairFor(s)!.ticker))
      );
      for (const s of fxSymbols) {
        const p = fxPairFor(s)!;
        const r = rows.get(p.ticker);
        if (r?.price != null) fetched.set(s, fxQuote(s, p, r));
      }
    } catch {
      // falls back to the last-known quote below
    }
    // Never send FX symbols on to the stock providers: "USDCLP=X" means nothing to Nasdaq.
    remaining = remaining.filter((s) => !fxPairFor(s));
  }

  const nasdaqResults = await Promise.allSettled(remaining.map((s) => nasdaq.quote(s)));
  nasdaqResults.forEach((r, i) => {
    if (r.status === "fulfilled") fetched.set(remaining[i], r.value);
  });
  remaining = remaining.filter((s) => !fetched.has(s));

  if (remaining.length > 0) {
    try {
      const rows = await yahoo.quotes(remaining);
      for (const q of rows) fetched.set(q.symbol, q);
      remaining = remaining.filter((s) => !fetched.has(s));
    } catch {
      // fall through to chart-based per-symbol fetch below
    }
  }

  if (remaining.length > 0) {
    const batch = remaining.slice(0, FALLBACK_PER_SYMBOL_CAP);
    const results = await Promise.allSettled(batch.map((s) => yahoo.quoteFromChart(s)));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(batch[i], r.value);
    });
    remaining = remaining.filter((s) => !fetched.has(s));
  }

  if (remaining.length > 0) {
    const batch = remaining.slice(0, FALLBACK_PER_SYMBOL_CAP);
    const results = await Promise.allSettled(batch.map((s) => stooq.quote(s)));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(batch[i], r.value);
    });
  }

  // Fill gaps Nasdaq's quote endpoints don't cover (open, P/E, EPS, dividend
  // yield, beta, shares outstanding) from TradingView's public scanner API,
  // in one batched request for every quote that resolved an exchange.
  const needsFundamentals = [...fetched.values()].filter((q) => q.exchange && q.pe === null);
  if (needsFundamentals.length > 0) {
    try {
      const fundamentals = await tradingview.scanFundamentals(
        needsFundamentals.map((q) => ({ symbol: q.symbol, exchange: q.exchange }))
      );
      for (const q of needsFundamentals) {
        const f = fundamentals.get(q.symbol);
        if (!f) continue;
        q.open = q.open ?? f.open;
        q.pe = q.pe ?? f.pe;
        q.eps = q.eps ?? f.eps;
        q.dividendYield = q.dividendYield ?? f.dividendYield;
        q.beta = q.beta ?? f.beta;
        q.sharesOutstanding = q.sharesOutstanding ?? f.sharesOutstanding;
      }
    } catch {
      // best-effort enrichment only — never fails the quote request
    }
  }

  for (const [sym, q] of fetched) cacheStore(`quote:${sym}`, q, QUOTE_TTL);

  const out: yahoo.Quote[] = [];
  for (const sym of symbols) {
    const q = fresh.get(sym) ?? fetched.get(sym) ?? staleGet<yahoo.Quote>(`quote:${sym}`);
    if (q) out.push(q);
  }
  return out;
}

marketRouter.get("/quotes", async (req, res) => {
  const raw = String(req.query.symbols ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 150);
  const symbols = [...new Set(raw.map(normalizeSymbol))].filter((s): s is string => s !== null);
  if (raw.length === 0) return res.status(400).json({ error: "symbols required" });
  if (symbols.length !== new Set(raw.map((s) => s.toUpperCase())).size) {
    return res.status(400).json({ error: "invalid symbol in list" });
  }
  try {
    // Bare B3 tickers are fetched under their provider symbol (PETR4 -> PETR4.SA)
    // but answered under the symbol requested, since clients match quotes back to
    // their own symbols. Everything else passes through unchanged.
    const aliases = symbols.filter((s) => toProviderSymbol(s) !== s);
    const direct = new Set(symbols.filter((s) => toProviderSymbol(s) === s));
    const quotes = await getQuotes([...new Set(symbols.map(toProviderSymbol))]);
    const data = quotes.filter((q) => direct.has(q.symbol) || !aliases.some((a) => toProviderSymbol(a) === q.symbol));
    for (const alias of aliases) {
      const q = quotes.find((x) => x.symbol === toProviderSymbol(alias));
      if (q) data.push({ ...q, symbol: alias });
    }
    if (data.length === 0) throw new Error("no quotes from any provider");
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- history / candles ----

/** A US-only provider attempt, dropped for symbols that provider cannot serve. */
function usOnly<T>(symbol: string, attempt: [string, () => Promise<T>]): Array<[string, () => Promise<T>]> {
  return isUsListing(symbol) ? [attempt] : [];
}

marketRouter.get("/history/:symbol", async (req, res) => {
  const symbol = toProviderSymbol(req.params.symbol.toUpperCase());
  const rangeKey = String(req.query.range ?? "6M");
  // Allowlisted: every distinct string was a distinct cache key, so arbitrary
  // values bypassed the cache and forced a fresh upstream fan-out each time.
  if (!HISTORY_RANGES.has(rangeKey)) return res.status(400).json({ error: "unsupported range" });
  // Extended hours (4:00-20:00 ET) only exist for the 1D intraday view. Only the
  // literal "1" enables it, so the cache key space stays two values per symbol.
  const ext = rangeKey === "1D" && req.query.ext === "1";
  try {
    // 1D is the live view (the chart polls it every 8s), so it gets a short TTL.
    const ttl = rangeKey === "1D" ? INTRADAY_TTL : HISTORY_TTL;
    const data = await cached(`history:${symbol}:${rangeKey}${ext ? ":ext" : ""}`, ttl, () =>
      binance.CRYPTO_SYMBOLS.has(symbol)
        ? binance.history(symbol, rangeKey)
        : fxPairFor(symbol)
        ? tracked("currency-api", () => currencyapi.history(fxPairFor(symbol)!.base, fxPairFor(symbol)!.quote, rangeKey))
        : isVix(symbol)
        ? vixHistory(rangeKey)
        : withFallback([
            // 1D = today's session at 5-minute resolution. Previously Nasdaq's
            // daily chart answered first, so "1D" showed a few daily bars with
            // no candle for the session in progress. Both Nasdaq attempts only
            // apply to US listings (see usOnly).
            ...(rangeKey === "1D"
              ? usOnly<yahoo.Candle[]>(symbol, ["nasdaq-intraday", () => nasdaq.intraday(symbol, 5, ext)])
              : []),
            ...usOnly(symbol, ["nasdaq", () => nasdaq.history(symbol, rangeKey)]),
            ["yahoo", () => yahoo.history(symbol, yahooRange(rangeKey).range, yahooRange(rangeKey).interval)],
            ["stooq", () => stooq.history(symbol)],
          ])
    );
    if (!Array.isArray(data) || data.length === 0) throw new Error("empty history from all providers");
    // Daily ranges end at the last completed session; add today's in-progress
    // candle from the live quote (1s cache). Crypto/VIX and 1D already cover today.
    if (rangeKey !== "1D" && !binance.CRYPTO_SYMBOLS.has(symbol) && !isVix(symbol)) {
      const [q] = await getQuotes([symbol]).catch(() => []);
      if (q) return res.json(mergeLiveCandle(data, q));
    }
    res.json(data);
  } catch (err) {
    // A pair with no history source (e.g. the UF) is a known gap, not an outage.
    if (fxPairFor(symbol) && err instanceof Error && err.message.startsWith("No daily history")) {
      return res.status(404).json({ error: err.message });
    }
    fail(req, res, err);
  }
});

function yahooRange(rangeKey: string): { range: string; interval: string } {
  const map: Record<string, { range: string; interval: string }> = {
    "1D": { range: "1d", interval: "5m" },
    "5D": { range: "5d", interval: "15m" },
    "1M": { range: "1mo", interval: "1h" },
    "6M": { range: "6mo", interval: "1d" },
    YTD: { range: "ytd", interval: "1d" },
    "1Y": { range: "1y", interval: "1d" },
    "5Y": { range: "5y", interval: "1wk" },
    MAX: { range: "max", interval: "1mo" },
  };
  return map[rangeKey] ?? map["6M"];
}

// ---- search ----

marketRouter.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.json([]);
  // FX pairs are matched locally and listed first — the remote searches
  // below only return stocks/funds, so "usd/clp" would otherwise find
  // unrelated tickers like "CLP Holdings".
  const fx = searchFx(q);
  try {
    const data = await cached(`search:${q.toLowerCase()}`, 300_000, () =>
      withFallback([
        ["tradingview", () => tradingview.search(q)],
        ["yahoo", () => yahoo.search(q)],
      ])
    );
    res.json([...fx, ...data]);
  } catch (err) {
    if (fx.length > 0) return res.json(fx);
    fail(req, res, err);
  }
});

// ---- news ----

const GLOBAL_CRYPTO_NEWS_LIMIT = 8;

marketRouter.get("/news", async (req, res) => {
  const symbol = req.query.symbol === undefined ? null : normalizeSymbol(req.query.symbol);
  if (req.query.symbol !== undefined && !symbol) return res.status(400).json({ error: "invalid symbol" });
  try {
    const data = await cached(`news:${symbol ?? "top"}`, NEWS_TTL, async () => {
      if (symbol) {
        const isCrypto = binance.CRYPTO_SYMBOLS.has(symbol);
        const name = isCrypto ? binance.cryptoName(symbol) : undefined;
        const lists = await Promise.allSettled(
          isCrypto
            ? [
                // Publisher feeds before Google News so dedupe keeps their suffix-free titles.
                news.symbolNews(symbol),
                news.cryptoNews(symbol, name),
                news.topNews(`${name ?? symbol} crypto`),
              ]
            : [news.symbolNews(symbol), news.topNews(symbol + " stock")]
        );
        const ok = lists.filter((r) => r.status === "fulfilled").map((r) => (r as any).value);
        if (ok.length === 0) throw new Error("all news sources failed");
        return news.dedupe(ok).slice(0, 40);
      }
      const lists = await Promise.allSettled([
        // Capped so the high-volume crypto feeds don't crowd out the macro/equity headlines;
        // listed first so dedupe prefers them over Google News' " - Publisher" copies.
        news.cryptoNews().then((items) => items.slice(0, GLOBAL_CRYPTO_NEWS_LIMIT)),
        news.topNews("stock market"),
        news.topNews("federal reserve economy"),
      ]);
      const ok = lists.filter((r) => r.status === "fulfilled").map((r) => (r as any).value);
      if (ok.length === 0) throw new Error("all news sources failed");
      return news.dedupe(ok).slice(0, 40);
    });
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- economic calendar (Fed / ECB / CPI / NFP with forecast + actual) ----

marketRouter.get("/econ-calendar", async (req, res) => {
  try {
    const data = await cached("econ-calendar", 900_000, () => econcalendar.weeklyEvents());
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- US-only data (options, earnings history, insider filings) ----

/**
 * These datasets (options chains, earnings history, SEC filings) only cover US
 * markets. Answer a foreign listing with a clear 404 instead of trying
 * providers that cannot have it and reporting "all providers are temporarily
 * unavailable". Indexes are let through: Yahoo serves ^SPX and ^VIX options.
 */
function rejectNonUs(res: any, symbol: string, what: string): boolean {
  if (!isForeignListing(symbol)) return false;
  res.status(404).json({ error: `${what} is only available for US listings.` });
  return true;
}

// ---- options ----

marketRouter.get("/options/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const expiry = req.query.expiry === undefined ? undefined : normalizeExpiry(String(req.query.expiry));
  if (expiry === null) return res.status(400).json({ error: "invalid expiry date" });
  try {
    if (rejectNonUs(res, symbol, "Options data")) return;
    const data = await cached(`options:${symbol}:${expiry ?? "front"}`, 60_000, () =>
      withFallback([
        ["nasdaq", () => nasdaq.optionChain(symbol, expiry)],
        [
          "yahoo",
          async () => {
            const y = await yahoo.options(symbol, expiry ? Date.parse(`${expiry}T00:00:00Z`) / 1000 : undefined);
            const selectedDate = y.selectedDate ? new Date(y.selectedDate * 1000).toISOString().slice(0, 10) : null;
            if (expiry && selectedDate !== expiry) throw new Error("yahoo: requested expiry unavailable");
            return {
              symbol: y.symbol,
              underlyingPrice: y.underlyingPrice,
              expirationDates: y.expirationDates.map((d: number) => new Date(d * 1000).toISOString().slice(0, 10)),
              selectedDate,
              calls: y.calls,
              puts: y.puts,
            };
          },
        ],
      ])
    );
    // Greeks are computed per request (not cached) so time-to-expiry stays current.
    const r = await riskFreeRate();
    const exp = data.selectedDate ? parseExpiry(data.selectedDate) : null;
    res.json({
      ...data,
      riskFreeRate: r,
      calls: withGreeks(data.calls, "call", data.underlyingPrice, exp, r),
      puts: withGreeks(data.puts, "put", data.underlyingPrice, exp, r),
    });
  } catch (err) {
    fail(req, res, err);
  }
});

/** 3-month T-bill yield (FRED DGS3MO) as a decimal; 4% if FRED is unavailable. */
async function riskFreeRate(): Promise<number> {
  try {
    const v = (await cached("fred:DGS3MO", 300_000, () => fred.latest("DGS3MO")))?.value;
    return typeof v === "number" && Number.isFinite(v) && v > -5 && v < 25 ? v / 100 : 0.04;
  } catch {
    return 0.04;
  }
}

// ---- crypto ----

/** Top-50 crypto board (shared by GET /crypto and the live stream). */
export function cryptoBoard() {
  return cached("crypto:markets", 5_000, () =>
    withFallback([
      ["coingecko", () => coingecko.markets(50)],
      ["binance", () => binance.markets()],
    ])
  );
}

marketRouter.get("/crypto", async (req, res) => {
  try {
    res.json(await cryptoBoard());
  } catch (err) {
    fail(req, res, err);
  }
});

marketRouter.get("/crypto/global", async (req, res) => {
  try {
    const data = await cached("crypto:global", 120_000, () =>
      withFallback([["coingecko", () => coingecko.globalStats()]])
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

marketRouter.get("/crypto/orderbook/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!binance.CRYPTO_SYMBOLS.has(symbol)) {
    return res.status(400).json({ error: "unsupported crypto symbol" });
  }
  try {
    const data = await cached(`orderbook:${symbol}`, 5_000, () =>
      withFallback([["binance", () => binance.orderBook(symbol)]])
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- macro: treasury yield curve (FRED) + key indexes via ETF proxies (Nasdaq) ----

const YIELD_SERIES: Array<{ id: string; tenor: string }> = [
  { id: "DGS3MO", tenor: "3M" },
  { id: "DGS5", tenor: "5Y" },
  { id: "DGS10", tenor: "10Y" },
  { id: "DGS30", tenor: "30Y" },
];

const INDEX_PROXIES: Record<string, string> = {
  SPY: "S&P 500 (SPY)",
  DIA: "Dow Jones (DIA)",
  QQQ: "Nasdaq 100 (QQQ)",
  IWM: "Russell 2000 (IWM)",
  GLD: "Gold (GLD)",
  USO: "WTI Crude (USO)",
  TLT: "20Y+ Treasury (TLT)",
  UUP: "Dollar Index (UUP)",
};

// ---- EU macro: ECB AAA euro-area yield curve + policy rate + HICP inflation,
// plus key European indexes via US-listed ETF proxies (same trick as the US
// index proxies above — Nasdaq/Yahoo already carry these tickers, so no new
// quote provider is needed).

const EU_YIELD_SERIES: Array<{ flowRef: string; key: string; tenor: string }> = [
  { flowRef: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_3M", tenor: "3M" },
  { flowRef: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_5Y", tenor: "5Y" },
  { flowRef: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y", tenor: "10Y" },
  { flowRef: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_30Y", tenor: "30Y" },
];

// Deposit facility rate — the ECB's operative policy rate since the 2024
// operational framework review (not the main refinancing rate).
const EU_POLICY_RATE = { flowRef: "FM", key: "D.U2.EUR.4F.KR.DFR.LEV" };
const EU_INFLATION = { flowRef: "ICP", key: "M.U2.N.000000.4.ANR" }; // HICP, y/y

const EU_INDEX_PROXIES: Record<string, string> = {
  FEZ: "Euro Stoxx 50 (FEZ)",
  IEUR: "MSCI Europe (IEUR)",
  EWG: "Germany (EWG)",
  EWU: "UK (EWU)",
  EWQ: "France (EWQ)",
  EWI: "Italy (EWI)",
};

const BR_INDEXES: Record<string, string> = {
  "^BVSP": "Ibovespa",
  "IFIX.SA": "IFIX (real estate funds)",
  "SMAL11.SA": "Small Caps (SMAL11)",
  "USDBRL=X": "USD/BRL",
  "EURBRL=X": "EUR/BRL",
};

// Yahoo's B3 quotes are 15-minute delayed and the macro widget polls every
// second, so serving this from a short cache costs nothing and keeps those
// polls from turning into one Yahoo request per second.
const BR_MACRO_TTL = 15_000;

/** No free source publishes a current Brazilian yield curve (BCB's DI swap
 * series stopped in 2019), so the panel shows the Selic target and IPCA instead. */
async function brazilMacro() {
  const [selic, ipca, quotes] = await Promise.all([
    cached(`bcb:${bcb.BCB_SERIES.selicTarget}`, 3_600_000, () => bcb.latest(bcb.BCB_SERIES.selicTarget)).catch(() => null),
    cached(`bcb:${bcb.BCB_SERIES.ipca12m}`, 3_600_000, () => bcb.latest(bcb.BCB_SERIES.ipca12m)).catch(() => null),
    getQuotes(Object.keys(BR_INDEXES)),
  ]);
  const indexes = quotes.map((q) => ({
    symbol: q.symbol,
    label: BR_INDEXES[q.symbol] ?? q.symbol,
    price: q.price,
    changePercent: q.changePercent,
  }));
  if (indexes.length === 0 && !selic && !ipca) throw new Error("no BR macro data from any provider");
  return { yields: [], vix: null, indexes, policyRate: selic?.value ?? null, inflation: ipca?.value ?? null };
}

/** US, EU or BR macro snapshot (shared by GET /macro and the live stream). */
export async function macroData(region: "us" | "eu" | "br") {
  if (region === "br") return cached("macro:br", BR_MACRO_TTL, brazilMacro);
  if (region === "eu") {
    const [yieldResults, policyRate, inflation, quotes] = await Promise.all([
      Promise.allSettled(
        EU_YIELD_SERIES.map((s) => cached(`ecb:${s.key}`, 300_000, () => ecb.latest(s.flowRef, s.key)))
      ),
      cached(`ecb:${EU_POLICY_RATE.key}`, 300_000, () => ecb.latest(EU_POLICY_RATE.flowRef, EU_POLICY_RATE.key)).catch(
        () => null
      ),
      cached(`ecb:${EU_INFLATION.key}`, 300_000, () => ecb.latest(EU_INFLATION.flowRef, EU_INFLATION.key)).catch(
        () => null
      ),
      getQuotes(Object.keys(EU_INDEX_PROXIES)),
    ]);
    const yields = EU_YIELD_SERIES.map((s, i) => {
      const r = yieldResults[i];
      return { tenor: s.tenor, value: r.status === "fulfilled" ? r.value?.value ?? null : null };
    }).filter((y) => y.value !== null);

    const indexes = quotes.map((q) => ({
      symbol: q.symbol,
      label: EU_INDEX_PROXIES[q.symbol] ?? q.symbol,
      price: q.price,
      changePercent: q.changePercent,
    }));

    if (yields.length === 0 && indexes.length === 0) throw new Error("no EU macro data from any provider");
    return {
      yields,
      vix: null,
      indexes,
      policyRate: policyRate?.value ?? null,
      inflation: inflation?.value ?? null,
    };
  }

  const [yieldResults, vix, quotes] = await Promise.all([
    Promise.allSettled(YIELD_SERIES.map((s) => cached(`fred:${s.id}`, 300_000, () => fred.latest(s.id)))),
    cached("fred:VIXCLS", 300_000, () => fred.latest("VIXCLS")).catch(() => null),
    getQuotes(Object.keys(INDEX_PROXIES)),
  ]);
  const yields = YIELD_SERIES.map((s, i) => {
    const r = yieldResults[i];
    return { tenor: s.tenor, value: r.status === "fulfilled" ? r.value?.value ?? null : null };
  }).filter((y) => y.value !== null);

  const indexes = quotes.map((q) => ({
    symbol: q.symbol,
    label: INDEX_PROXIES[q.symbol] ?? q.symbol,
    price: q.price,
    changePercent: q.changePercent,
  }));

  if (yields.length === 0 && indexes.length === 0) throw new Error("no macro data from any provider");
  return { yields, vix: vix?.value ?? null, indexes, policyRate: null, inflation: null };
}

marketRouter.get("/macro", async (req, res) => {
  try {
    const region = req.query.region === "eu" ? "eu" : req.query.region === "br" ? "br" : "us";
    res.json(await macroData(region));
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- heatmap + screener over the full market (TradingView scanner — live) ----
// ?market=eu switches from the whole-US scan to the merged major-European-
// exchanges scan (see tradingview.europeMarketScan).

type Market = "us" | "eu" | "br";

function marketParam(req: any): Market {
  return req.query.market === "eu" ? "eu" : req.query.market === "br" ? "br" : "us";
}

// TradingView reports market cap in each stock's own listing currency (SEK,
// GBP, CHF, ...), not EUR — left unconverted, a 1.2T SEK Swedish company would
// outrank a 550B EUR Dutch one in the merged EU scan. Reference rates come
// from the same ECB source as the EU macro widget, so this needs no new
// provider (rate = local-currency units per 1 EUR).
const EU_FX_SERIES: Record<string, { flowRef: string; key: string }> = {
  GBP: { flowRef: "EXR", key: "D.GBP.EUR.SP00.A" },
  SEK: { flowRef: "EXR", key: "D.SEK.EUR.SP00.A" },
  CHF: { flowRef: "EXR", key: "D.CHF.EUR.SP00.A" },
};

async function eurFxRates(): Promise<Record<string, number>> {
  const rates: Record<string, number> = { EUR: 1 };
  const entries = await Promise.all(
    Object.entries(EU_FX_SERIES).map(async ([ccy, s]) => {
      const point = await cached(`ecb:fx:${ccy}`, 3_600_000, () => ecb.latest(s.flowRef, s.key)).catch(() => null);
      return [ccy, point?.value ?? null] as const;
    })
  );
  for (const [ccy, rate] of entries) if (rate) rates[ccy] = rate;
  return rates;
}

async function marketRows(market: Market): Promise<tradingview.MarketRow[]> {
  if (market === "br") return cached("marketscan:br", 5_000, () => tradingview.brazilMarketScan(1500));
  if (market === "eu") {
    return cached("marketscan:eu", 5_000, async () => {
      const [rows, fx] = await Promise.all([tradingview.europeMarketScan(1500), eurFxRates()]);
      return rows.map((r) => {
        const rate = r.currency ? fx[r.currency] : undefined;
        return rate && r.marketCap ? { ...r, marketCap: r.marketCap / rate } : r;
      });
    });
  }
  return cached("marketscan:full", 3_000, () => tradingview.marketScan(1500));
}

marketRouter.get("/heatmap", async (req, res) => {
  try {
    const rows = await marketRows(marketParam(req));
    const top = rows.filter((r) => r.marketCap).slice(0, 150);
    res.json(top);
  } catch (err) {
    fail(req, res, err);
  }
});

// Columns the screener can sort by. Anything else (e.g. "__proto__",
// "constructor") is rejected rather than used as a property lookup.
const SCREENER_SORT_KEYS = new Set(["symbol", "name", "price", "changePercent", "volume", "marketCap", "sector"]);

marketRouter.get("/screener", async (req, res) => {
  const sortKey = String(req.query.sort ?? "marketCap");
  if (!SCREENER_SORT_KEYS.has(sortKey)) return res.status(400).json({ error: "unsupported sort column" });
  const num = (v: unknown) => (v === undefined ? undefined : Number(v));
  for (const k of ["marketCapMin", "changeMin", "changeMax", "volumeMin"]) {
    const v = num(req.query[k]);
    if (v !== undefined && !Number.isFinite(v)) return res.status(400).json({ error: `${k} must be a number` });
  }
  try {
    let rows = await marketRows(marketParam(req));
    const f = {
      sector: req.query.sector ? String(req.query.sector) : undefined,
      marketCapMin: num(req.query.marketCapMin),
      changeMin: num(req.query.changeMin),
      changeMax: num(req.query.changeMax),
      volumeMin: num(req.query.volumeMin),
    };
    rows = rows.filter((r) => {
      if (f.sector && r.sector !== f.sector) return false;
      if (f.marketCapMin !== undefined && (r.marketCap ?? 0) < f.marketCapMin) return false;
      if (f.changeMin !== undefined && (r.changePercent ?? -Infinity) < f.changeMin) return false;
      if (f.changeMax !== undefined && (r.changePercent ?? Infinity) > f.changeMax) return false;
      if (f.volumeMin !== undefined && (r.volume ?? 0) < f.volumeMin) return false;
      return true;
    });
    const key = sortKey as keyof tradingview.MarketRow;
    const dir = req.query.dir === "asc" ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const av = (a[key] as number | null) ?? -Infinity;
      const bv = (b[key] as number | null) ?? -Infinity;
      return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
    });
    res.json(rows.slice(0, 500));
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- sector relative strength (SPDR sector ETFs vs SPY) ----

/** 6M of daily history for one ETF; changes once a day, so cached for 10 minutes. */
function sectorHistory(symbol: string) {
  return cached(`sector-hist:${symbol}`, 600_000, () =>
    withFallback([
      ["nasdaq", () => nasdaq.history(symbol, "6M")],
      ["yahoo", () => yahoo.history(symbol, "6mo", "1d")],
    ])
  );
}

marketRouter.get("/sector-strength", async (req, res) => {
  try {
    const symbols = [BENCHMARK, ...Object.keys(SECTOR_ETFS)];
    const [quotes, histories] = await Promise.all([
      getQuotes(symbols),
      // Polite to the provider: at most 4 history fetches in flight.
      mapWithConcurrency(symbols, 4, (s) => sectorHistory(s).catch(() => [])),
    ]);
    const price = new Map(quotes.map((q) => [q.symbol, q.price]));
    const today = etSessionDay().time;
    const returnsOf = (i: number) => periodReturns(completedSessions(histories[i], today), price.get(symbols[i]) ?? null);
    const bench = returnsOf(0);
    const sectors = symbols.slice(1).map((symbol, k) => {
      const returns = returnsOf(k + 1);
      return { symbol, name: SECTOR_ETFS[symbol], returns, rs: relativeStrength(returns, bench) };
    });
    if (sectors.every((x) => x.returns.d1 === null && x.returns.m1 === null)) throw new Error("no sector data from any provider");
    res.json({ benchmark: { symbol: BENCHMARK, returns: bench }, sectors, asOf: new Date().toISOString() });
  } catch (err) {
    fail(req, res, err);
  }
});

marketRouter.get("/sectors", async (req, res) => {
  try {
    const rows = await marketRows(marketParam(req));
    res.json([...new Set(rows.map((r) => r.sector))].sort());
  } catch (err) {
    res.json([]);
  }
});

// ---- market recap: templated end-of-day-style narrative + supporting stats ----

const RECAP_TTL = 15_000;

function pct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "flat";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function buildRecapSummary(d: {
  indexes: Array<{ symbol: string; label: string; changePercent: number | null }>;
  bestSector?: { sector: string; avgChangePercent: number };
  worstSector?: { sector: string; avgChangePercent: number };
  gainers: tradingview.MarketRow[];
  losers: tradingview.MarketRow[];
  vix: number | null;
}): string {
  const spy = d.indexes.find((i) => i.symbol === "SPY");
  const qqq = d.indexes.find((i) => i.symbol === "QQQ");
  const dia = d.indexes.find((i) => i.symbol === "DIA");
  const spyChange = spy?.changePercent ?? 0;
  const dir = spyChange > 0.15 ? "trading higher" : spyChange < -0.15 ? "trading lower" : "little changed";

  const parts: string[] = [];
  parts.push(
    `US stocks are ${dir}, with the S&P 500 ${pct(spy?.changePercent)}, the Nasdaq 100 ${pct(qqq?.changePercent)} and the Dow ${pct(dia?.changePercent)}.`
  );
  if (d.bestSector && d.worstSector && d.bestSector.sector !== d.worstSector.sector) {
    parts.push(
      `${d.bestSector.sector} is leading sector performance (${pct(d.bestSector.avgChangePercent)}), while ${d.worstSector.sector} lags (${pct(d.worstSector.avgChangePercent)}).`
    );
  }
  if (d.gainers[0] && d.losers[0]) {
    parts.push(
      `${d.gainers[0].name} paces advancers, up ${pct(d.gainers[0].changePercent)}, while ${d.losers[0].name} is the biggest decliner, down ${pct(
        d.losers[0].changePercent
      )}.`
    );
  }
  if (d.vix !== null) {
    parts.push(`The VIX volatility index is at ${d.vix.toFixed(2)}.`);
  }
  return parts.join(" ");
}

marketRouter.get("/recap", async (req, res) => {
  try {
    const data = await cached("recap:full", RECAP_TTL, async () => {
      const [quotes, vix, rows, headlines] = await Promise.all([
        getQuotes(Object.keys(INDEX_PROXIES)),
        cached("fred:VIXCLS", 300_000, () => fred.latest("VIXCLS")).catch(() => null),
        marketRows("us"),
        cached("news:recap", NEWS_TTL, async () => {
          const lists = await Promise.allSettled([
            news.topNews("stock market"),
            news.topNews("federal reserve economy"),
          ]);
          const ok = lists.filter((r) => r.status === "fulfilled").map((r) => (r as any).value);
          if (ok.length === 0) throw new Error("all news sources failed");
          return news.dedupe(ok);
        }),
      ]);

      const indexes = quotes.map((q) => ({
        symbol: q.symbol,
        label: INDEX_PROXIES[q.symbol] ?? q.symbol,
        price: q.price,
        changePercent: q.changePercent,
      }));

      const ranked = rows.filter((r) => (r.marketCap ?? 0) > 2_000_000_000 && r.changePercent !== null);
      const gainers = [...ranked].sort((a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0)).slice(0, 5);
      const losers = [...ranked].sort((a, b) => (a.changePercent ?? 0) - (b.changePercent ?? 0)).slice(0, 5);

      const sectorMap = new Map<string, { sum: number; count: number }>();
      for (const r of rows) {
        if (r.changePercent === null || !r.sector) continue;
        const cur = sectorMap.get(r.sector) ?? { sum: 0, count: 0 };
        cur.sum += r.changePercent;
        cur.count += 1;
        sectorMap.set(r.sector, cur);
      }
      const sectors = [...sectorMap.entries()]
        .map(([sector, { sum, count }]) => ({ sector, avgChangePercent: sum / count }))
        .sort((a, b) => b.avgChangePercent - a.avgChangePercent);

      const bestSector = sectors[0];
      const worstSector = sectors[sectors.length - 1];

      const summary = buildRecapSummary({ indexes, bestSector, worstSector, gainers, losers, vix: vix?.value ?? null });

      return {
        summary,
        updatedAt: new Date().toISOString(),
        indexes,
        vix: vix?.value ?? null,
        gainers,
        losers,
        sectors: sectors.slice(0, 3).concat(sectors.length > 3 ? sectors.slice(-3) : []),
        news: headlines.slice(0, 6),
      };
    });
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- earnings calendar for a list of symbols ----

marketRouter.get("/calendar", async (req, res) => {
  const symbols = String(req.query.symbols ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 30);
  if (symbols.length === 0) return res.status(400).json({ error: "symbols required" });
  try {
    const data = await cached(`calendar:${symbols.join(",")}`, 3_600_000, () => tradingview.earningsCalendar(symbols));
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- earnings history: forecast vs actual per quarter, plus next-day price move ----

marketRouter.get("/earnings-history/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (rejectNonUs(res, symbol, "Earnings history")) return;
  try {
    const data = await cached(`earnings-history:${symbol}`, 3_600_000, async () => {
      const [surprises, candles] = await Promise.all([
        nasdaq.earningsSurprise(symbol),
        withFallback([
          ["nasdaq", () => nasdaq.history(symbol, "1Y")],
          ["yahoo", () => yahoo.history(symbol, yahooRange("1Y").range, yahooRange("1Y").interval)],
          ["stooq", () => stooq.history(symbol)],
        ]),
      ]);
      return surprises.map((s) => ({
        ...s,
        dayAfterChangePercent: dayAfterEarningsChange(candles, s.dateReported),
      }));
    });
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- short sale volume (FINRA Reg SHO daily file) ----

marketRouter.get("/short-volume/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  // FINRA's Reg SHO file only covers US listings; null is the "no data" answer.
  if (isForeignListing(symbol)) return res.json(null);
  try {
    const day = await cached("finra-shortvol-day", 6 * 3_600_000, () => finra.latestDay());
    const row = day.get(symbol);
    if (!row) return res.json(null);
    res.json({ ...row, shortVolumePercent: (row.shortVolume / row.totalVolume) * 100 });
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- FX (TradingView forex scanner + Chile's dólar observado) ----

// The widget's board: ?symbols=USDCLP=X,USDBRL=X (defaults when omitted).
// Unknown symbols are dropped; one TradingView request serves the whole board.
marketRouter.get("/fx", async (req, res) => {
  const requested = req.query.symbols
    ? String(req.query.symbols).split(",").map((s) => s.trim().toUpperCase())
    : DEFAULT_FX_SYMBOLS;
  const pairs = [...new Set(requested)].map((s) => fxPairFor(s)).filter((p): p is FxPair => !!p).slice(0, 40);
  try {
    const key = pairs.map((p) => p.symbol).join(",");
    const rows = await cached(`fx:board:${key}`, 2_000, () =>
      tracked("tradingview-fx", () => tradingview.fxScan(pairs.map((p) => p.ticker)))
    );
    res.json(
      pairs.map((p) => {
        const r = rows.get(p.ticker);
        return {
          symbol: p.symbol,
          pair: p.pair,
          ticker: p.ticker,
          digits: fxDigits(r?.price ?? null),
          price: r?.price ?? null,
          change: r?.change ?? null,
          changePercent: r?.changePercent ?? null,
          high: r?.high ?? null,
          low: r?.low ?? null,
          perfWeek: r?.perfWeek ?? null,
          perfMonth: r?.perfMonth ?? null,
          perfYtd: r?.perfYtd ?? null,
          perfYear: r?.perfYear ?? null,
        };
      })
    );
  } catch (err) {
    fail(req, res, err);
  }
});

// Published once per banking day, so a long TTL is plenty — and it keeps a
// flaky mirror from being hammered by the widget's polling.
marketRouter.get("/fx/observado", async (req, res) => {
  try {
    const data = await cached("fx:observado", 1_800_000, () =>
      withFallback([
        ["mindicador", () => clindicators.fromMindicador()],
        ["boostr", () => clindicators.fromBoostr()],
      ])
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- insider transactions (SEC EDGAR Form 4) ----

marketRouter.get("/insider/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (rejectNonUs(res, symbol, "Insider trading data (SEC Form 4)")) return;
  try {
    const data = await cached(`insider:${symbol}`, 3_600_000, () => secedgar.insiderTransactions(symbol));
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});
