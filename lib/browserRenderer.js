/**
 * Playwright-Powered Browser Renderer
 * ─────────────────────────────────────
 * Launches a headless Chromium via Playwright to render JavaScript-heavy pages
 * (SPAs, React apps, Cloudflare-protected sites, etc.).
 *
 * Used as a **fallback** when the lightweight `safeFetch` returns suspiciously
 * little content (indicating the page relies on client-side JS rendering).
 */

const { chromium } = require("playwright");

let _browser = null;

/**
 * Get or create the shared browser instance.
 * Re-uses a single browser to avoid the overhead of repeated cold starts.
 */
async function getBrowser() {
    if (_browser && _browser.isConnected()) return _browser;

    _browser = await chromium.launch({
        headless: true,
        args: [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
        ],
    });
    return _browser;
}

/**
 * Render a page in a real browser and return the **fully-rendered** HTML.
 *
 * @param {string} url            – the URL to render
 * @param {object} opts
 * @param {number} opts.timeoutMs – navigation timeout (default 20 000 ms)
 * @param {string|null} opts.proxy – optional proxy URL for this request
 * @returns {Promise<{ok: boolean, status: number, html: string, title: string, description: string}>}
 */
async function renderPage(url, opts = {}) {
    const { timeoutMs = 20_000, proxy = null } = opts;
    const browser = await getBrowser();

    const contextOpts = {
        userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        ignoreHTTPSErrors: true,
        locale: "en-US",
        timezoneId: "America/New_York",
    };

    if (proxy) {
        contextOpts.proxy = { server: proxy };
    }

    const context = await browser.newContext(contextOpts);
    const page = await context.newPage();

    try {
        // Block heavy resources we don't need (images, fonts, media) → faster loading
        await page.route("**/*", (route) => {
            const type = route.request().resourceType();
            if (["image", "media", "font", "stylesheet"].includes(type)) {
                return route.abort();
            }
            return route.continue();
        });

        const response = await page.goto(url, {
            waitUntil: "networkidle",
            timeout: timeoutMs,
        });

        const status = response ? response.status() : 0;
        const ok = status >= 200 && status < 400;

        // Wait a tiny moment for any lazy-fired JS to settle
        await page.waitForTimeout(1000);

        const html = await page.content();

        // Extract title and meta description while we're in the page context
        const title = await page.title();
        const description = await page
            .locator('meta[name="description"]')
            .getAttribute("content")
            .catch(() => "");

        return { ok, status, html, title: title || "", description: description || "" };
    } catch (err) {
        return { ok: false, status: 0, html: "", title: "", description: "", error: err.message };
    } finally {
        await context.close();
    }
}

/**
 * Determine whether raw HTML looks like it needs browser rendering.
 * Heuristic: Very short body or presence of SPA bootstrap markers.
 */
function needsBrowserRendering(html) {
    if (!html) return true;

    // Strip script/style tags and measure remaining text
    const textContent = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();

    // If visible text is very short, it's likely a JS-rendered shell
    if (textContent.length < 200) return true;

    // Common SPA bootstrap indicators
    const spaIndicators = [
        '<div id="root"></div>',
        '<div id="app"></div>',
        '<div id="__next">',
        '<div id="__nuxt">',
        "window.__NEXT_DATA__",
        "window.__NUXT__",
        '<noscript>You need to enable JavaScript',
        '<noscript>This app works best with JavaScript',
    ];

    const lowerHtml = html.toLowerCase();
    return spaIndicators.some((sig) => lowerHtml.includes(sig.toLowerCase()));
}

/**
 * Gracefully close the shared browser (call on server shutdown).
 */
async function closeBrowser() {
    if (_browser) {
        await _browser.close().catch(() => { });
        _browser = null;
    }
}

module.exports = { renderPage, needsBrowserRendering, closeBrowser, getBrowser };
