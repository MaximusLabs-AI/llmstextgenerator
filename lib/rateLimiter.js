/**
 * Rate Limiter & Proxy Rotation Module
 * ─────────────────────────────────────
 * Provides request throttling (via Bottleneck) and an optional proxy rotation
 * strategy to avoid IP bans from aggressive anti-bot systems.
 */

const Bottleneck = require("bottleneck");

// ---------------------------------------------------------------------------
// Rate Limiter – uses a leaky-bucket / token-bucket approach
// ---------------------------------------------------------------------------

/**
 * Creates a pre-configured rate limiter.
 * @param {object} opts
 * @param {number} opts.maxConcurrent – max simultaneous requests (default 3)
 * @param {number} opts.minTimeMs     – min ms between request starts (default 500)
 * @param {number} opts.reservoir     – burst bucket size (default 10)
 * @param {number} opts.reservoirRefreshIntervalMs – refill interval (default 10 000)
 * @param {number} opts.reservoirRefreshAmount     – tokens added per refill (default 5)
 */
function createLimiter(opts = {}) {
    return new Bottleneck({
        maxConcurrent: opts.maxConcurrent ?? 3,
        minTime: opts.minTimeMs ?? 500,
        reservoir: opts.reservoir ?? 10,
        reservoirRefreshInterval: opts.reservoirRefreshIntervalMs ?? 10_000,
        reservoirRefreshAmount: opts.reservoirRefreshAmount ?? 5,
    });
}

// ---------------------------------------------------------------------------
// Proxy Rotation
// ---------------------------------------------------------------------------

class ProxyPool {
    /**
     * @param {string[]} proxyList – array of proxy URLs, e.g.
     *   ["http://user:pass@proxy1:8080", "socks5://proxy2:1080"]
     *   If empty, requests go direct (no proxy).
     */
    constructor(proxyList = []) {
        this.proxies = proxyList.filter(Boolean);
        this._index = 0;
        this._failures = new Map(); // proxy → consecutive failure count
    }

    get hasProxies() {
        return this.proxies.length > 0;
    }

    /** Round-robin next proxy, skipping any with ≥ 3 consecutive failures. */
    next() {
        if (!this.hasProxies) return null;

        const maxAttempts = this.proxies.length;
        for (let i = 0; i < maxAttempts; i++) {
            const proxy = this.proxies[this._index % this.proxies.length];
            this._index++;
            if ((this._failures.get(proxy) || 0) < 3) return proxy;
        }
        // All proxies have been failing – reset counters and try again
        this._failures.clear();
        const proxy = this.proxies[this._index % this.proxies.length];
        this._index++;
        return proxy;
    }

    /** Report a successful request through a proxy (reset its failure count). */
    reportSuccess(proxy) {
        if (proxy) this._failures.set(proxy, 0);
    }

    /** Report a failed request through a proxy (increment counter). */
    reportFailure(proxy) {
        if (proxy) {
            this._failures.set(proxy, (this._failures.get(proxy) || 0) + 1);
        }
    }
}

// ---------------------------------------------------------------------------
// Random delay helper – adds jitter to look more human
// ---------------------------------------------------------------------------
function randomDelay(minMs = 200, maxMs = 800) {
    return new Promise((resolve) =>
        setTimeout(resolve, minMs + Math.random() * (maxMs - minMs))
    );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { createLimiter, ProxyPool, randomDelay };
