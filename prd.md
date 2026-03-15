Tool 6: LLMs.txt Generator
6.1 Overview
Tool Name: LLMs.txt Generator
Purpose: Crawl a website and automatically generate a properly formatted llms.txt file following the official specification from llmstxt.org. The llms.txt file helps AI systems understand the structure and content of a website.
Use Case: Website owners who want to make their site more accessible to AI systems. SEOs implementing AEO best practices. Developers building AI-friendly websites.
Complexity: HIGH - Requires web crawling (sitemap parsing + link discovery), page metadata extraction, and LLM-based content summarization and categorization.

6.2 UI Specification
6.2.1 Page Layout
•	Page Header: "LLMs.txt Generator"
•	Subtitle: "Generate an AI-optimized llms.txt file in seconds."

6.2.2 Input Section
•	URL text input with placeholder "eg. example.com"
•	"Generate ->" button

6.2.3 Loading State (Multi-Step Progress)
34.	Step 1: "Crawling your website..."
35.	Step 2: "Analyzing page metadata..."
36.	Step 3: "Generating descriptions..."
37.	Step 4: "Formatting llms.txt file..."

6.2.4 Output Section
•	Code block showing the generated llms.txt content with Markdown syntax highlighting
•	"Copy to Clipboard" button
•	"Download as .txt" button
•	Editable textarea version where users can modify before downloading
•	Explanation section below: "What is llms.txt?" and "How to install"

6.3 Complete Backend Logic
6.3.1 API Endpoint
Endpoint: POST /api/generate-llms-txt
Request Body: { "url": "https://example.com" }

6.3.2 Main Generation Function
async function generateLlmsTxt(siteUrl) {
  // Step 1: Normalize URL
  const baseUrl = normalizeUrl(siteUrl);
  
  // Step 2: Try to fetch sitemap.xml first
  let pages = [];
  try {
    const sitemapUrl = baseUrl + '/sitemap.xml';
    const sitemapResponse = await fetch(sitemapUrl);
    if (sitemapResponse.ok) {
      const sitemapXml = await sitemapResponse.text();
      pages = parseSitemap(sitemapXml);
    }
  } catch (e) {
    // Sitemap not found, will discover pages manually
  }
  
  // Step 3: Fetch homepage and discover links
  const homepageResponse = await fetch(baseUrl, {
    headers: { 'User-Agent': 'MaximusLabs-LlmsTxtGenerator/1.0' }
  });
  const homepageHtml = await homepageResponse.text();
  
  const siteTitle = extractTitle(homepageHtml);
  const siteDescription = extractMetaDescription(homepageHtml);
  
  // Discover internal links from homepage
  const discoveredLinks = extractInternalLinks(homepageHtml, baseUrl);
  
  // Merge sitemap URLs with discovered links (deduplicate)
  const allPages = deduplicateUrls([...pages, ...discoveredLinks]);
  
  // Step 4: Limit to top 30-50 most important pages
  const importantPages = prioritizePages(allPages, baseUrl);
  
  // Step 5: Fetch metadata for each page (parallel, max 10 concurrent)
  const pageDetails = await fetchPageDetails(importantPages.slice(0, 50));
  
  // Step 6: Use LLM to generate descriptions and categorize pages
  const llmResponse = await callLLMAPI('openai', LLMS_TXT_SYSTEM_PROMPT,
    JSON.stringify({
      siteName: siteTitle,
      siteDescription: siteDescription,
      pages: pageDetails.map(p => ({
        url: p.url, title: p.title,
        description: p.description, path: p.path
      }))
    })
  );
  
  return llmResponse;
}

6.3.3 Sitemap Parser
function parseSitemap(xml) {
  const urls = [];
  const locRegex = /<loc>(.*?)<\/loc>/g;
  let match;
  while ((match = locRegex.exec(xml)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

6.3.4 Internal Link Extractor
function extractInternalLinks(html, baseUrl) {
  const linkRegex = /href="([^"]*?)"/g;
  const links = new Set();
  const baseDomain = new URL(baseUrl).hostname;
  let match;
  
  while ((match = linkRegex.exec(html)) !== null) {
    try {
      const fullUrl = new URL(match[1], baseUrl).href;
      if (new URL(fullUrl).hostname === baseDomain) {
        links.add(fullUrl);
      }
    } catch (e) { /* skip invalid URLs */ }
  }
  return [...links];
}

6.3.5 Page Prioritization
function prioritizePages(urls, baseUrl) {
  const priority = {
    high: ['/about', '/pricing', '/features', '/products',
           '/services', '/contact', '/blog', '/docs', '/faq'],
    low: ['/tag/', '/author/', '/page/', '/search',
          '/wp-admin', '/cart', '/checkout']
  };
  
  return urls.sort((a, b) => {
    const pathA = new URL(a).pathname.toLowerCase();
    const pathB = new URL(b).pathname.toLowerCase();
    const scoreA = priority.high.some(p => pathA.includes(p)) ? 1
      : priority.low.some(p => pathA.includes(p)) ? -1 : 0;
    const scoreB = priority.high.some(p => pathB.includes(p)) ? 1
      : priority.low.some(p => pathB.includes(p)) ? -1 : 0;
    return scoreB - scoreA;
  });
}

6.4 System Prompt
The following system prompt is sent to the LLM to generate the final llms.txt content:
SYSTEM:
You are an expert at generating llms.txt files following the official
specification from llmstxt.org.
 
Given a website's name, description, and list of discovered pages
(with titles, descriptions, and URLs), generate a properly formatted
llms.txt file.
 
FORMAT RULES (from the official spec):
1. Start with an H1 (#) containing the site/brand name
2. Follow with a blockquote (>) containing a one-sentence summary
3. Optionally include 1-2 paragraphs of additional context
4. Group pages under H2 (##) section headers by category
5. Each page entry is a markdown list item:
   - [Page Title](URL): Brief description
6. Include an ## Optional section for secondary/less important pages
 
CATEGORIZATION RULES:
- Group pages logically (e.g., ## Products, ## Blog, ## Documentation,
  ## Company, ## Resources)
- Use clear, standard section names
- Put the most important pages first within each section
- Limit descriptions to one sentence per page
 
DESCRIPTION RULES:
- If the page has a good meta description, use/adapt it
- If not, write a clear, concise one-sentence description based on
  the page title and URL path
- Descriptions should help an AI understand what the page contains
- Avoid marketing fluff - be factual and specific
 
OUTPUT:
Return ONLY the raw markdown content of the llms.txt file.
No code fences, no explanations.

6.5 LLM API Recommendation
Recommended Model: OpenAI GPT-4o (not mini). The categorization and description generation benefits from the stronger model's ability to understand site structure and write concise, accurate descriptions. Cost: ~$0.02-0.05 per generation.

6.6 Infrastructure Considerations
•	Cloudflare Workers have a 30-second CPU time limit on free plan
•	Crawling 50 pages + LLM call may exceed this limit
•	Options: (a) Use Cloudflare Workers paid plan (50ms CPU per request), (b) Use Vercel Edge Functions (60s timeout), (c) Use a queued architecture with status polling
•	Rate Limit: 5 generations per IP per hour (expensive crawling + API)
