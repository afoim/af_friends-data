#!/usr/bin/env node
/**
 * Standalone Playwright URL checker with anti-detection measures.
 *
 * Usage: node check-url.js <url>
 *
 * Outputs a single JSON line to stdout:
 *   { ok: boolean, status?: number, finalUrl?: string, contentType?: string,
 *     bodyLength?: number, body?: string, error?: string }
 *
 * Features:
 *   - User-Agent dynamically matched to the actual Playwright Chromium version
 *   - navigator.webdriver disabled, fake plugins / languages / chrome runtime
 *   - --disable-blink-features=AutomationControlled
 *   - Retries with exponential backoff (up to 2 retries)
 *   - networkidle waitUntil for SPA compatibility
 *   - Body truncated at 5 MB to avoid OOM
 */

const { chromium } = require('@playwright/test');
const { assertPublicUrl } = require('./public-url');

// ── Configuration ──────────────────────────────────────────────
const MAX_RETRIES = 2;
const TIMEOUT_MS = 30000;
const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5 MB

// ── Helpers ────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a realistic Chrome User-Agent string matching the given version.
 * @param {string} browserVersion - e.g. "150.0.7871.33" from browser.version()
 */
function buildUserAgent(browserVersion) {
  const version = browserVersion || '150.0.0.0';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

/**
 * Build the anti-detection init script as a string so we can interpolate
 * the dynamically-resolved UA into navigator.userAgent.
 */
function buildAntiDetectionScript(userAgent) {
  // JSON.stringify safely embeds any string value (backticks, ${}, quotes,
  // newlines, etc.) into the generated JavaScript literal.
  const ua = JSON.stringify(userAgent);
  return `
    // Hide the webdriver property (most important)
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // Fake the plugins array (headless Chrome reports zero plugins)
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        var arr = [1, 2, 3, 4, 5];
        arr.item = function (i) { return arr[i]; };
        arr.namedItem = function () { return null; };
        arr.refresh = function () {};
        return arr;
      },
    });

    // Fake languages
    Object.defineProperty(navigator, 'languages', {
      get: function () { return ['zh-CN', 'zh', 'en-US', 'en']; },
    });

    // Fake chrome runtime (absent in headless by default)
    if (!window.chrome) {
      window.chrome = { runtime: {} };
    }

    // Fix Permissions API behavior (guard against missing permissions API)
    var _perms = window.navigator.permissions;
    if (_perms && _perms.query) {
      var _origQuery = _perms.query;
      _perms.query = function (parameters) {
        if (parameters.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission, onchange: null });
        }
        return _origQuery.call(_perms, parameters);
      };
    }

    // Override navigator.userAgent with the same dynamic UA
    Object.defineProperty(navigator, 'userAgent', {
      get: function () { return ${ua}; },
    });

    // Plug common headless detection holes
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: function () { return 8; } });
    Object.defineProperty(navigator, 'deviceMemory', { get: function () { return 8; } });
  `;
}

// ── Main logic ─────────────────────────────────────────────────

async function checkUrl(url) {
  await assertPublicUrl(url);
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-setuid-sandbox',
          '--disable-infobars',
          '--window-size=1920,1080',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        ],
      });

      // Dynamically read the actual browser version so the UA is always
      // in sync with the Chromium revision Playwright shipped.
      const browserVersion = browser.version();
      const userAgent = buildUserAgent(browserVersion);

      const context = await browser.newContext({
        userAgent,
        serviceWorkers: 'block',
        viewport: { width: 1920, height: 1080 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        extraHTTPHeaders: {
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      });

      const page = await context.newPage();
      let mainFinalUrl = url;
      // Validate each redirect ourselves. Native redirect chains can otherwise
      // escape a route handler after the first request. No write methods or WS.
      await context.routeWebSocket('**/*', socket => socket.close());
      await context.route('**/*', async route => {
        const request = route.request();
        if (!['GET', 'HEAD'].includes(request.method())) return route.abort();
        let next = request.url();
        try {
          for (let hop = 0; hop < 6; hop++) {
            await assertPublicUrl(next);
            const response = await route.fetch({ url: next, maxRedirects: 0, timeout: TIMEOUT_MS });
            const location = response.headers().location;
            if (response.status() >= 300 && response.status() < 400 && location) {
              next = new URL(location, next).href;
              await response.dispose();
              continue;
            }
            if (request.isNavigationRequest() && request.frame() === page.mainFrame()) mainFinalUrl = next;
            await route.fulfill({ response });
            await response.dispose();
            return;
          }
        } catch { /* Reject the request, never fall back to unchecked network access. */ }
        await route.abort();
      });
      await page.addInitScript(buildAntiDetectionScript(userAgent));

      // Use domcontentloaded first so we don't hang forever on pages with
      // persistent connections (WebSockets, analytics pings, etc.). Then give
      // the page a 5 s grace period to settle into network idle for SPAs.
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUT_MS,
      });

      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
        console.error(`[check-url] networkidle not reached for ${url} within 5 s – proceeding with current DOM`);
      });

      // ── Gather result before attempting to close ──────────
      // If browser.close() throws we must not lose the data we already
      // successfully fetched.
      const body = await page.content();
      const finalUrl = mainFinalUrl;
      const links = await page.locator('a[href]').evaluateAll(nodes => nodes.slice(0, 5000).map(node => node.getAttribute('href')));
      const status = response.status();
      const headers = response.headers();
      const contentType = headers['content-type'] || '';

      const result = {
        ok: status >= 200 && status < 400,
        status,
        finalUrl,
        contentType,
        links,
        bodyLength: body.length,
        body:
          body.length <= MAX_BODY_SIZE
            ? body
            : body.substring(0, MAX_BODY_SIZE),
      };

      // Emit result first — even if close fails, the caller already has the data
      process.stdout.write(JSON.stringify(result));

      // Best-effort cleanup (don't retry just because close failed)
      try {
        await browser.close();
      } catch (closeErr) {
        console.error(`[check-url] browser.close() warning: ${closeErr.message}`);
      }
      return;
    } catch (e) {
      // This path is hit when launch / goto / content extraction fails
      if (browser) await browser.close().catch(() => {});
      lastError = e;

      if (attempt < MAX_RETRIES) {
        const backoff = Math.pow(2, attempt); // 1s, 2s
        console.error(
          `[check-url] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed for ${url}: ${e.message}. Retrying in ${backoff}s...`
        );
        await sleep(backoff * 1000);
      }
    }
  }

  // All attempts exhausted
  process.stdout.write(
    JSON.stringify({ ok: false, error: lastError?.message || String(lastError) })
  );
}

// ── Entry point ────────────────────────────────────────────────

const url = process.argv[2];
if (!url) {
  process.stdout.write(JSON.stringify({ ok: false, error: 'No URL provided' }));
  process.exit(1);
}

checkUrl(url).catch((e) => {
  // Top-level safety net — should never be reached
  process.stdout.write(JSON.stringify({ ok: false, error: e?.message || String(e) }));
  process.exit(1);
});
