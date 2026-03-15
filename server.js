require("dotenv").config();
const express = require("express");
const path = require("path");
const https = require("https");
const http = require("http");
const Groq = require("groq-sdk");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

// ── New modules ──────────────────────────────────────────────────────────────
const { renderPage, needsBrowserRendering, closeBrowser } = require("./lib/browserRenderer");
const { createLimiter, ProxyPool, randomDelay } = require("./lib/rateLimiter");
const { deepCrawl } = require("./lib/deepCrawler");

// Prevent server crash on unhandled promise rejections
process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err?.message || err);
});

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Groq client – reads GROQ_API_KEY from environment
// ---------------------------------------------------------------------------
const HAS_GROQ_KEY = Boolean(process.env.GROQ_API_KEY);
const groq = HAS_GROQ_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

// ---------------------------------------------------------------------------
// Rate Limiter & Proxy Pool  (Feature 2)
// ---------------------------------------------------------------------------
const limiter = createLimiter({
    maxConcurrent: parseInt(process.env.CRAWL_CONCURRENCY, 10) || 3,
    minTimeMs: parseInt(process.env.CRAWL_MIN_DELAY_MS, 10) || 500,
});

// Proxy list from env: comma-separated proxy URLs
// Example: PROXY_LIST="http://user:pass@p1:8080,http://user:pass@p2:8080"
const proxyPool = new ProxyPool(
    (process.env.PROXY_LIST || "").split(",").filter(Boolean)
);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
// Trust proxy if the app is behind a reverse proxy (e.g., Heroku, Render)
app.set("trust proxy", 1);

app.use(
    helmet({
        contentSecurityPolicy: {
            directives: {
                ...helmet.contentSecurityPolicy.getDefaultDirectives(),
                "script-src": ["'self'", "'unsafe-inline'"],
                "style-src": ["'self'", "'unsafe-inline'", "https://api.fontshare.com"],
                "font-src": ["'self'", "https://api.fontshare.com", "data:"],
            },
        },
    })
);
app.use(
    cors({
        origin: process.env.CORS_ORIGIN || "*",
    })
);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// API Rate Limiting
const apiLimiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000, // 15 minutes default
    max: parseInt(process.env.RATE_LIMIT_MAX_REQ, 10) || 10, // 10 requests per window
    message: { error: "Too many requests from this IP, please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use("/api/", apiLimiter);

// ---------------------------------------------------------------------------
// Helpers (unchanged from V1)
// ---------------------------------------------------------------------------

function normalizeUrl(raw) {
    let url = raw.trim();
    if (!url.startsWith("http")) url = "https://" + url;
    try {
        const parsed = new URL(url);
        return parsed.origin;
    } catch {
        return null;
    }
}

// SSRF Protection: Prevent scanning internal/private networks
const forbiddenHostRegex = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|169\.254\.169\.254|metadata\.google\.internal)$/i;
function isForbiddenUrl(host) {
    if (forbiddenHostRegex.test(host)) return true;
    if (host.startsWith("10.")) return true;
    if (host.startsWith("192.168.")) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return true;
    if (host.endsWith("localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
    return false;
}

function parseSitemap(xml) {
    const urls = [];
    const locRegex = /<loc>(.*?)<\/loc>/g;
    let match;
    while ((match = locRegex.exec(xml)) !== null) {
        urls.push(match[1].trim());
    }
    return urls;
}

function extractInternalLinks(html, baseUrl) {
    const hrefRegex = /href=["'](.*?)["']/gi;
    const links = new Set();
    const baseDomain = new URL(baseUrl).hostname;
    let match;
    while ((match = hrefRegex.exec(html)) !== null) {
        try {
            const fullUrl = new URL(match[1], baseUrl).href;
            if (new URL(fullUrl).hostname === baseDomain) {
                const clean = fullUrl.split("#")[0].replace(/\/$/, "");
                if (!clean.match(/\.(css|svg|png|jpg|jpeg|gif|js|json|xml|pdf|zip|ico|woff|woff2|ttf|eot|webp|mp4|webm|mp3|wav|ogg|exe)$/i)) {
                    links.add(clean);
                }
            }
        } catch { /* skip invalid URLs */ }
    }
    return [...links];
}

function extractTitle(html) {
    const m = html.match(/<title[^>]*>(.*?)<\/title>/i);
    return m ? m[1].trim() : "";
}

function extractMetaDescription(html) {
    const m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["'](.*?)["']/i);
    if (m) return m[1].trim();
    const m2 = html.match(/<meta[^>]+content=["'](.*?)["'][^>]+name=["']description["']/i);
    return m2 ? m2[1].trim() : "";
}

const PRIORITY_HIGH = ["/about", "/pricing", "/features", "/products", "/services", "/contact", "/blog", "/docs", "/faq", "/api"];
const PRIORITY_LOW = ["/tag/", "/author/", "/page/", "/search", "/wp-admin", "/cart", "/checkout", "/cdn-cgi", "?", "#"];

function prioritizePages(urls) {
    return urls.sort((a, b) => {
        const pa = new URL(a).pathname.toLowerCase();
        const pb = new URL(b).pathname.toLowerCase();
        const sa = PRIORITY_HIGH.some((p) => pa.includes(p)) ? 1 : PRIORITY_LOW.some((p) => pa.includes(p)) ? -1 : 0;
        const sb = PRIORITY_HIGH.some((p) => pb.includes(p)) ? 1 : PRIORITY_LOW.some((p) => pb.includes(p)) ? -1 : 0;
        if (sb !== sa) return sb - sa;
        return pa.split("/").length - pb.split("/").length;
    });
}

// ---------------------------------------------------------------------------
// Permissive HTTPS agent – avoids TLS handshake failures in local dev.
// ---------------------------------------------------------------------------
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * Fetch a URL using Node's http/https modules (lightweight, no JS execution).
 * Returns an object with { ok, status, text() } to mimic the Fetch API.
 */
function safeFetch(url, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const isHttps = parsedUrl.protocol === "https:";
        const client = isHttps ? https : http;
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: "GET",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "identity",
            },
            timeout: timeoutMs,
            agent: isHttps ? httpsAgent : undefined,
        };

        const req = client.request(options, (res) => {
            // Follow redirects (status 3xx)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                safeFetch(new URL(res.headers.location, url).href, timeoutMs)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            let data = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    text: async () => data,
                });
            });
        });

        req.on("error", (err) => reject(err));
        req.on("timeout", () => {
            req.destroy();
            reject(new Error(`Request to ${url} timed out after ${timeoutMs}ms`));
        });

        req.end();
    });
}

// ---------------------------------------------------------------------------
// Smart Fetch – tries lightweight safeFetch first, falls back to Playwright
//               if the page appears to need JS rendering.           (Feature 1)
// ---------------------------------------------------------------------------

/**
 * Fetch a page's HTML intelligently:
 *   1. Try safeFetch (fast, low-resource)
 *   2. Check if the returned html needs JS rendering (SPA heuristic)
 *   3. If yes, re-fetch with Playwright for full rendering
 *
 * Respects the rate limiter and proxy pool.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @param {object} opts
 * @param {boolean} opts.forcePlaywright – skip the lightweight attempt
 * @returns {Promise<{ok:boolean, status:number, html:string, usedPlaywright:boolean}>}
 */
async function smartFetch(url, timeoutMs = 10000, opts = {}) {
    const proxy = proxyPool.next();

    // ── Attempt 1: lightweight fetch ──────────────────────────────────────
    if (!opts.forcePlaywright) {
        try {
            const res = await safeFetch(url, timeoutMs);
            const html = await res.text();

            if (res.ok && !needsBrowserRendering(html)) {
                proxyPool.reportSuccess(proxy);
                return { ok: true, status: res.status, html, usedPlaywright: false, text: async () => html };
            }

            // If the page returned OK but looks like an SPA shell, fall through to Playwright
            if (res.ok) {
                console.log(`    ⚙ SPA detected for ${url} – escalating to Playwright`);
            }
        } catch {
            // Network / timeout error – try Playwright as last resort
        }
    }

    // ── Attempt 2: Playwright rendering ──────────────────────────────────
    try {
        const result = await renderPage(url, { timeoutMs: timeoutMs + 10000, proxy });
        if (result.ok) {
            proxyPool.reportSuccess(proxy);
        } else {
            proxyPool.reportFailure(proxy);
        }
        return {
            ok: result.ok,
            status: result.status,
            html: result.html,
            usedPlaywright: true,
            text: async () => result.html,
        };
    } catch (err) {
        proxyPool.reportFailure(proxy);
        return { ok: false, status: 0, html: "", usedPlaywright: true, text: async () => "" };
    }
}

// ---------------------------------------------------------------------------
// Rate-limited smart fetch – wraps smartFetch through the limiter
// ---------------------------------------------------------------------------
function rateLimitedFetch(url, timeoutMs = 10000, opts = {}) {
    return limiter.schedule(async () => {
        await randomDelay(100, 400);
        return smartFetch(url, timeoutMs, opts);
    });
}

/** Fetch title + meta description for a single page. */
async function fetchPageMeta(url) {
    try {
        const res = await rateLimitedFetch(url, 8000);
        if (!res.ok) return { url, title: "", description: "", path: new URL(url).pathname };
        const html = res.html || (await res.text());
        return {
            url,
            title: extractTitle(html) || new URL(url).pathname.split("/").pop() || "Home",
            description: extractMetaDescription(html),
            path: new URL(url).pathname,
            usedPlaywright: res.usedPlaywright || false,
        };
    } catch {
        return { url, title: new URL(url).pathname.split("/").pop() || "Home", description: "", path: new URL(url).pathname };
    }
}

/** Fetch metadata for pages in parallel batches. */
async function fetchPageDetails(urls, concurrency = 5) {
    const results = [];
    for (let i = 0; i < urls.length; i += concurrency) {
        const batch = urls.slice(i, i + concurrency).map(fetchPageMeta);
        results.push(...(await Promise.all(batch)));
    }
    return results;
}

// ---------------------------------------------------------------------------
// System prompt for LLM
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are an expert at generating llms.txt files following the official specification from llmstxt.org.

Given a website's name, description, and list of discovered pages (with titles, descriptions, and URLs), generate a properly formatted llms.txt file.

FORMAT RULES (from the official spec):
1. Start with an H1 (#) containing the site/brand name
2. Follow with a blockquote (>) containing a one-sentence summary
3. Optionally include 1-2 paragraphs of additional context
4. Group pages under H2 (##) section headers by category
5. Each page entry is a markdown list item:
   - [Page Title](URL): Brief description
6. Include an ## Optional section for secondary/less important pages

CATEGORIZATION RULES:
- Group pages logically (e.g., ## Products, ## Blog, ## Documentation, ## Company, ## Resources)
- Use clear, standard section names
- Put the most important pages first within each section
- Limit descriptions to one sentence per page

DESCRIPTION RULES:
- If the page has a good meta description, use/adapt it
- If not, write a clear, concise one-sentence description based on the page title and URL path
- Descriptions should help an AI understand what the page contains
- Avoid marketing fluff - be factual and specific

OUTPUT:
Return ONLY the raw markdown content of the llms.txt file.
No code fences, no explanations.`;

// ---------------------------------------------------------------------------
// Fallback: build llms.txt without an LLM
// ---------------------------------------------------------------------------
function buildLlmsTxtFallback(siteName, siteDescription, pageDetails) {
    const lines = [];
    lines.push(`# ${siteName}`);
    lines.push("");
    lines.push(`> ${siteDescription || `Website of ${siteName}`}`);
    lines.push("");

    // Rough categorization by URL path
    const categories = {};
    for (const p of pageDetails) {
        const seg = p.path.split("/").filter(Boolean)[0] || "main";
        const cat = seg.charAt(0).toUpperCase() + seg.slice(1);
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push(p);
    }

    for (const [cat, pages] of Object.entries(categories)) {
        lines.push(`## ${cat}`);
        for (const p of pages) {
            const desc = p.description || `Page at ${p.path}`;
            lines.push(`- [${p.title}](${p.url}): ${desc}`);
        }
        lines.push("");
    }

    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main API endpoint
// ---------------------------------------------------------------------------
app.post("/api/generate-llms-txt", async (req, res) => {
    const { url, crawlDepth, maxPages, allowPaths, blockPaths, forcePlaywright } = req.body;
    if (!url) return res.status(400).json({ error: "URL is required." });

    const baseUrl = normalizeUrl(url);
    if (!baseUrl) return res.status(400).json({ error: "Invalid URL." });

    const host = new URL(baseUrl).hostname;
    if (isForbiddenUrl(host)) {
        return res.status(403).json({ error: "Access to internal/private targets is forbidden." });
    }

    // Sanitize crawl options
    const maxAllowedDepth = parseInt(process.env.MAX_CRAWL_DEPTH, 10) || 5;
    const maxAllowedPages = parseInt(process.env.MAX_PAGES, 10) || 200;
    
    const depth = Math.min(Math.max(parseInt(crawlDepth, 10) || 1, 1), maxAllowedDepth);
    const pageLimit = Math.min(Math.max(parseInt(maxPages, 10) || 50, 10), maxAllowedPages);

    console.log(`\n  → Generating llms.txt for ${baseUrl} (depth=${depth}, max=${pageLimit}) ...`);

    try {
        // ── Step 1: Crawl sitemap + homepage ─────────────────────────────
        let sitemapPages = [];
        try {
            const smRes = await rateLimitedFetch(`${baseUrl}/sitemap.xml`);
            if (smRes.ok) {
                const xml = smRes.html || (await smRes.text());
                sitemapPages = parseSitemap(xml);
                console.log(`    Sitemap: ${sitemapPages.length} URLs found`);
            }
        } catch { console.log("    Sitemap: not found or inaccessible"); }

        const homepageRes = await rateLimitedFetch(baseUrl, 15000, { forcePlaywright: !!forcePlaywright });
        if (!homepageRes.ok) {
            return res.status(502).json({ error: `Could not reach ${baseUrl} (status ${homepageRes.status}).` });
        }
        const homepageHtml = homepageRes.html || (await homepageRes.text());
        console.log(`    Homepage fetched${homepageRes.usedPlaywright ? " (via Playwright)" : ""}`);

        const siteTitle = extractTitle(homepageHtml) || new URL(baseUrl).hostname;
        const siteDescription = extractMetaDescription(homepageHtml);
        console.log(`    Site title: "${siteTitle}"`);

        const discoveredLinks = extractInternalLinks(homepageHtml, baseUrl);
        console.log(`    Homepage links: ${discoveredLinks.length}`);

        let allPages = [...new Set([...sitemapPages, ...discoveredLinks])];

        // ── Step 1b: Deep Crawl  (Feature 3) ────────────────────────────
        if (depth > 1) {
            console.log(`    Starting deep crawl (depth ${depth}, limit ${pageLimit})...`);
            allPages = await deepCrawl(baseUrl, allPages, {
                depth,
                maxPages: pageLimit,
                allowPaths: Array.isArray(allowPaths) ? allowPaths : [],
                blockPaths: Array.isArray(blockPaths) ? blockPaths : undefined,
                fetchFn: (u, t) => rateLimitedFetch(u, t),
                extractLinksFn: extractInternalLinks,
                limiter,
            });
        }

        const importantPages = prioritizePages(allPages).slice(0, Math.min(50, pageLimit));
        console.log(`    Total unique pages: ${allPages.length}, analyzing top ${Math.min(30, importantPages.length)}`);

        // ── Step 2: Fetch metadata for pages ─────────────────────────────
        const pageDetails = await fetchPageDetails(importantPages.slice(0, 30));

        const playwrightCount = pageDetails.filter((p) => p.usedPlaywright).length;
        if (playwrightCount > 0) {
            console.log(`    ⚡ ${playwrightCount}/${pageDetails.length} pages rendered via Playwright`);
        }

        // ── Step 3: Generate llms.txt via LLM (or fallback) ──────────────
        let llmsTxt;

        if (HAS_GROQ_KEY) {
            console.log("    Using gpt-oss-120b for categorization...");
            const userContent = JSON.stringify({
                siteName: siteTitle,
                siteDescription,
                pages: pageDetails.map((p) => ({
                    url: p.url,
                    title: p.title,
                    description: p.description,
                    path: p.path,
                })),
            });

            const completion = await groq.chat.completions.create({
                model: "openai/gpt-oss-120b",
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: userContent },
                ],
                temperature: 1,
                max_completion_tokens: 8192,
                top_p: 1,
                reasoning_effort: "medium",
                stream: false
            });

            llmsTxt = completion.choices[0].message.content;
        } else {
            console.log("    Using fallback rule-based generation...");
            llmsTxt = buildLlmsTxtFallback(siteTitle, siteDescription, pageDetails);
        }

        console.log("  ✓ Generation complete\n");

        return res.json({
            llmsTxt,
            meta: {
                pagesDiscovered: allPages.length,
                pagesAnalyzed: pageDetails.length,
                usedLLM: HAS_GROQ_KEY,
                crawlDepth: depth,
                playwrightPages: playwrightCount,
                proxiesAvailable: proxyPool.hasProxies,
            },
        });
    } catch (err) {
        console.error("  ✗ Generation error:", err.message);
        return res.status(500).json({ error: err.message || "Internal server error." });
    }
});

// ---------------------------------------------------------------------------
// Graceful shutdown – close the Playwright browser
// ---------------------------------------------------------------------------
async function gracefulShutdown() {
    console.log("\n  Shutting down...");
    await closeBrowser();
    process.exit(0);
}
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`\n  🚀 LLMs.txt Generator running at  http://localhost:${PORT}\n`);
    if (!HAS_GROQ_KEY) {
        console.log("  ⚠️  No GROQ_API_KEY set – running in fallback mode (rule-based generation).");
        console.log("     Set GROQ_API_KEY env variable for powered categorization.\n");
    }
    if (proxyPool.hasProxies) {
        console.log(`  🔄 Proxy rotation active: ${proxyPool.proxies.length} proxies configured.`);
    } else {
        console.log("  ℹ️  No proxies configured. Set PROXY_LIST env var for IP rotation.");
    }
    console.log(`  ⚡ Playwright (Chromium) available for JavaScript-heavy sites.`);
    console.log(`  🕸️  Deep crawling enabled (set crawlDepth in request body, max 5).\n`);
});
