# LLMs.txt Generator: GEO-First Documentation Engine

[![Live Demo](https://img.shields.io/badge/Live-Demo-brightgreen)](https://www.maximuslabs.ai/tools/llms-txt-generator)
[![GitHub Repository](https://img.shields.io/badge/GitHub-Repository-blue)](https://github.com/MaximusLabs-AI/llmstextgenerator)

A professional-grade backend and frontend system designed to crawl websites and generate technically precise `llms.txt` files following the official specification from [llmstxt.org](https://llmstxt.org/). This tool optimizes your site's visibility for Generative Engine Optimization (GEO) and Answer Engine Optimization (AEO).

## Features

- **Deep Crawl Engine**: Explores site architecture up to 5 levels deep with intelligent link discovery and rate limiting.
- **AI-Powered Categorization**: Uses Groq (gpt-oss-120b) to automatically categorize pages into logical groups (e.g., Products, Docs, Blog).
- **Hybrid Rendering**: Built-in Playwright (Chromium) support to render JavaScript-heavy SPAs and React sites that basic crawlers miss.
- **Sitemap Integration**: Automatically parses `sitemap.xml` for maximum structural coverage.
- **Premium UI/UX**: Scoped, brand-aligned interface with staggered animations, metric count-ups, and a modern technical aesthetic.
- **Security First**: Implements SSRF protection, API rate limiting, and request timeouts.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+ recommended)
- A Groq API Key (get one at [console.groq.com](https://console.groq.com))

### Installation

1. Clone or download the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Install Playwright browsers:
   ```bash
   npx playwright install chromium
   ```

### Configuration

Create a `.env` file in the root directory (or edit the existing one):
```env
GROQ_API_KEY=your_groq_key_here
PORT=3000
MAX_CRAWL_DEPTH=5
MAX_PAGES=200
```

### Running Locally

To start the server:
```bash
npm start
```
The application will be accessible at `http://localhost:3000`.

## Project Structure

```text
.
├── public/
│   └── index.html       # Self-contained Premium UI (HTML/CSS/JS)
├── lib/
│   ├── browserRenderer.js # Playwright/Chromium logic
│   ├── deepCrawler.js     # Recursive crawl engine
│   └── rateLimiter.js     # Bottleneck & Proxy logic
├── server.js            # Express API & Groq Integration
├── .env                 # Configuration variables
└── package.json         # Dependencies and scripts
```

## Technical Details

- **Backend**: Node.js, Express, Groq SDK, Playwright, Bottleneck.
- **Frontend**: Vanilla JS, Scoped CSS, SVG icons (zero external dependencies).
- **Optimization**: The frontend is a single-file embeddable solution (<50KB) designed for seamless integration into Webflow or static sites.

## License

Created for MaximusLabs AI. All rights reserved.
