/**
 * Kalshi API Client — Server-side only (Node.js).
 *
 * Handles RSA-PSS signed authentication, rate limiting, pagination,
 * and all Kalshi Exchange API v2 endpoints.
 *
 * API Docs: https://docs.kalshi.com
 * Base URLs:
 *   Demo: https://demo-api.kalshi.co/trade-api/v2
 *   Prod: https://api.elections.kalshi.com/trade-api/v2
 */

const crypto = require("crypto");

const API_URLS = {
  demo: "https://demo-api.kalshi.co/trade-api/v2",
  prod: "https://api.elections.kalshi.com/trade-api/v2",
};

/**
 * Generate RSA-PSS signature for Kalshi API authentication.
 * Message format: timestamp_ms + HTTP_METHOD + path (without query params)
 */
function signRequest(privateKeyPem, timestampMs, method, path) {
  const pathWithoutQuery = path.split("?")[0];
  const message = `${timestampMs}${method.toUpperCase()}${pathWithoutQuery}`;

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(message);
  sign.end();

  const signature = sign.sign(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    },
    "base64"
  );

  return signature;
}

/**
 * Build auth headers for a Kalshi API request.
 */
function getAuthHeaders(apiKey, privateKeyPem, method, path) {
  const timestampMs = Date.now().toString();
  const signature = signRequest(privateKeyPem, timestampMs, method, path);

  return {
    "KALSHI-ACCESS-KEY": apiKey,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": timestampMs,
    "Content-Type": "application/json",
  };
}

class KalshiClient {
  constructor(apiKey, privateKeyPem, env = "demo") {
    this.apiKey = apiKey;
    this.privateKeyPem = privateKeyPem;
    this.baseUrl = API_URLS[env] || API_URLS.demo;
    this.env = env;
  }

  /**
   * Execute an API request with authentication, retries, and error handling.
   */
  async _request(method, path, { params, body, authenticated = true } = {}) {
    let url = `${this.baseUrl}${path}`;

    if (params) {
      const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
      ).toString();
      if (qs) url += `?${qs}`;
    }

    const headers = authenticated && this.privateKeyPem
      ? getAuthHeaders(this.apiKey, this.privateKeyPem, method, `/trade-api/v2${path}`)
      : { "Content-Type": "application/json" };

    const maxRetries = 3;
    let lastError;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });

        if (res.status === 429) {
          const wait = Math.pow(2, attempt) * 500;
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }

        if (res.status === 204) return {};

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.message || `API error ${res.status}`);
        }

        return data;
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 500));
        }
      }
    }

    throw lastError;
  }

  // ─── Exchange ───────────────────────────────────────────────
  async getExchangeStatus() {
    return this._request("GET", "/exchange/status", { authenticated: false });
  }

  // ─── Market Data (Public) ──────────────────────────────────
  async getMarkets({ limit = 100, cursor, eventTicker, seriesTicker, status, maxCloseTs, minCloseTs } = {}) {
    return this._request("GET", "/markets", {
      authenticated: false,
      params: {
        limit,
        cursor,
        event_ticker: eventTicker,
        series_ticker: seriesTicker,
        status,
        max_close_ts: maxCloseTs,
        min_close_ts: minCloseTs,
      },
    });
  }

  async getAllMarketsForSeries(seriesTicker, status = "open") {
    const allMarkets = [];
    let cursor = "";
    do {
      const data = await this.getMarkets({ limit: 200, seriesTicker, status, cursor });
      allMarkets.push(...(data.markets || []));
      cursor = data.cursor || "";
    } while (cursor);
    return allMarkets;
  }

  async getMarket(ticker) {
    return this._request("GET", `/markets/${ticker}`, { authenticated: false });
  }

  async getOrderbook(ticker, depth = 10) {
    return this._request("GET", `/markets/${ticker}/orderbook`, {
      authenticated: false,
      params: { depth },
    });
  }

  async getEvents({ limit = 100, cursor, seriesTicker, status, withNestedMarkets } = {}) {
    return this._request("GET", "/events", {
      authenticated: false,
      params: {
        limit,
        cursor,
        series_ticker: seriesTicker,
        status,
        with_nested_markets: withNestedMarkets ? "true" : undefined,
      },
    });
  }

  async getSeries(seriesTicker) {
    return this._request("GET", `/series/${seriesTicker}`, { authenticated: false });
  }

  // ─── Portfolio (Authenticated) ─────────────────────────────
  async getBalance() {
    const data = await this._request("GET", "/portfolio/balance");
    return data.balance != null ? data.balance / 100 : 0;
  }

  async getPositions({ limit = 200, cursor, settlementStatus = "unsettled" } = {}) {
    return this._request("GET", "/portfolio/positions", {
      params: { limit, cursor, settlement_status: settlementStatus },
    });
  }

  async getAllPositions() {
    const all = [];
    let cursor = "";
    do {
      const data = await this.getPositions({ cursor });
      all.push(...(data.market_positions || []));
      cursor = data.cursor || "";
    } while (cursor);
    return all;
  }

  async getOrders({ ticker, status, limit = 100 } = {}) {
    return this._request("GET", "/portfolio/orders", {
      params: { ticker, status, limit },
    });
  }

  async getFills({ limit = 100, ticker } = {}) {
    return this._request("GET", "/portfolio/fills", {
      params: { limit, ticker },
    });
  }

  // ─── Orders (Authenticated) ────────────────────────────────
  async createOrder(order) {
    return this._request("POST", "/portfolio/orders", { body: order });
  }

  async cancelOrder(orderId) {
    return this._request("DELETE", `/portfolio/orders/${orderId}`);
  }
}

/**
 * Create a KalshiClient from environment variables.
 * Reads KALSHI_API_KEY, KALSHI_PRIVATE_KEY, KALSHI_ENV.
 */
function createClientFromEnv() {
  const apiKey = process.env.KALSHI_API_KEY;
  const privateKey = process.env.KALSHI_PRIVATE_KEY; // Full PEM content
  const env = process.env.KALSHI_ENV || "demo";

  if (!apiKey) throw new Error("KALSHI_API_KEY is not set");
  if (!privateKey) throw new Error("KALSHI_PRIVATE_KEY is not set");

  return new KalshiClient(apiKey, privateKey, env);
}

module.exports = { KalshiClient, createClientFromEnv, signRequest, getAuthHeaders };
