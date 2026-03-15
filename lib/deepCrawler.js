/**
 * Deep Crawler Module
 * ─────────────────────────────────────
 * Extends the original "shallow" discovery (sitemap + homepage links) with
 * configurable multi-level crawling.  Users can request depth 1 (default,
 * same as before), 2, or 3+ to follow links N levels deep.
 *
 * Uses BFS (breadth-first search) to explore the site graph, respecting
 * the rate limiter and proxy pool established in rateLimiter.js.
 */

/**
 * @typedef {object} DeepCrawlOptions
 * @property {number} depth         – how many levels to follow links (default 1)
 * @property {number} maxPages      – cap on total pages to discover (default 100)
 * @property {string[]} allowPaths  – if set, only follow links whose pathname starts with one of these
 * @property {string[]} blockPaths  – paths to never follow
 * @property {Function} fetchFn     – the function used to fetch a page (safeFetch or render)
 * @property {Function} extractLinksFn – function(html, baseUrl) → string[]
 * @property {import('./rateLimiter').Bottleneck} limiter – rate limiter instance
 */

const DEFAULT_BLOCK_PATHS = [
    "/tag/", "/author/", "/page/", "/search", "/wp-admin",
    "/cart", "/checkout", "/cdn-cgi", "/wp-json", "/feed",
    "/wp-content", "/wp-includes", "/admin", "/login", "/register",
    "/assets/", "/static/", "/.well-known",
];

/**
 * Crawl a website via BFS up to a given depth, starting from a set of seed URLs.
 *
 * @param {string}   baseUrl  – the origin (e.g. "https://example.com")
 * @param {string[]} seeds    – initial set of discovered URLs
 * @param {DeepCrawlOptions} opts
 * @returns {Promise<string[]>} – deduplicated list of discovered URLs
 */
async function deepCrawl(baseUrl, seeds, opts = {}) {
    const {
        depth = 1,
        maxPages = 100,
        allowPaths = [],
        blockPaths = DEFAULT_BLOCK_PATHS,
        fetchFn,
        extractLinksFn,
        limiter,
    } = opts;

    // If depth is 1 we already have what we need – just return the seeds
    if (depth <= 1) return seeds.slice(0, maxPages);

    const baseDomain = new URL(baseUrl).hostname;
    const visited = new Set(seeds.map(normalizeLink));
    let frontier = [...visited]; // current level's URLs
    let allDiscovered = [...visited];

    for (let level = 2; level <= depth; level++) {
        if (allDiscovered.length >= maxPages) break;

        const nextFrontier = [];

        // Process the current frontier in parallel (respecting limiter)
        const tasks = frontier.map((url) => {
            const execute = async () => {
                try {
                    const res = await fetchFn(url, 8000);
                    if (!res.ok) return [];
                    const html = typeof res.text === "function" ? await res.text() : res.html || "";
                    return extractLinksFn(html, baseUrl);
                } catch {
                    return [];
                }
            };

            return limiter ? limiter.schedule(execute) : execute();
        });

        const results = await Promise.allSettled(tasks);

        for (const result of results) {
            if (result.status !== "fulfilled") continue;
            for (const link of result.value) {
                const clean = normalizeLink(link);
                if (!clean) continue;

                try {
                    const parsed = new URL(clean);
                    if (parsed.hostname !== baseDomain) continue;
                    if (blockPaths.some((bp) => parsed.pathname.toLowerCase().includes(bp))) continue;
                    if (allowPaths.length > 0 && !allowPaths.some((ap) => parsed.pathname.toLowerCase().startsWith(ap))) continue;
                } catch {
                    continue;
                }

                if (!visited.has(clean)) {
                    visited.add(clean);
                    nextFrontier.push(clean);
                    allDiscovered.push(clean);
                    if (allDiscovered.length >= maxPages) break;
                }
            }
            if (allDiscovered.length >= maxPages) break;
        }

        frontier = nextFrontier;
        if (frontier.length === 0) break; // no new pages to explore

        console.log(`    Deep crawl level ${level}: +${nextFrontier.length} new pages (total: ${allDiscovered.length})`);
    }

    return allDiscovered.slice(0, maxPages);
}

/** Normalize a URL for deduplication (strip hash, trailing slash). */
function normalizeLink(url) {
    try {
        const u = new URL(url);
        return (u.origin + u.pathname).replace(/\/$/, "") + u.search;
    } catch {
        return null;
    }
}

module.exports = { deepCrawl, DEFAULT_BLOCK_PATHS };
