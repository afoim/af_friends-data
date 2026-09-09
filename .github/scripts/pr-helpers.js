/**
 * Shared helpers for the auto-pr workflow.
 *
 * Pure utility functions and constants used by both the `triage`
 * and `verify_and_merge` jobs.  Functions that depend on the
 * github-script context (core, context, gh CLI) stay inline in
 * the workflow YAML.
 *
 * `checkUrlReachability(url, scriptPath)` wraps the standalone
 * Playwright script at `.github/scripts/check-url.js`.
 */

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

// ── Constants ──────────────────────────────────────────────────

const DIRS = {
  FRIENDS_DIR: 'data/friends/',
  SPONSORS_DIR: 'data/sponsors/',
};

const LABELS = {
  FRIEND: '友链',
  SPONSOR: '赞助',
  AVATAR_OK: '头像可达',
  AVATAR_BAD: '头像不可达',
  SITE_OK: '网站可达',
  SITE_BAD: '网站不可达',
  ALL_OK: 'URL全部可达',
  BIDIR: '双向链接验证',
  BIDIR_OK: '双向链接验证通过',
};

/** Messages shared identically across both jobs. */
const SHARED_MSG = {
  PR_ONE_FILE: 'PR 必须仅包含一个文件变更。',
  PR_PATH_ERROR: `只允许更改 ${DIRS.FRIENDS_DIR} 或 ${DIRS.SPONSORS_DIR} 下的文件。`,
  PR_ACTION_ERROR: '只允许新增、编辑或删除文件。',
  JSON_EXT_ERROR: '检测到友链/赞助目录下存在非 .json 文件，已停止处理：',
  JSON_PARSE_ERROR: ': JSON 解析失败',
  JSON_OBJECT_ERROR: ': JSON 必须是对象',
  VALIDATE_FAIL: '检测到数据文件校验失败：',
  URL_SELF_ERROR: '检测到友链 JSON 的 url 指向本站，请填写你自己的网站 URL。',
  BACKLINK_SELF_ERROR: '检测到友链 JSON 的 backlink 指向本站，请填写你自己网站的友链页 URL。',
  SITE_CONFIG_MISSING: '无法读取本站 site 配置，无法进行双向链接验证。',
  BIDIR_BACKLINK_INVALID: '双向链接验证失败：backlink 不是合法的 URL',
  BIDIR_BACKLINK_NOT_HTTP: '双向链接验证失败：backlink 必须以 http/https 开头',
  BIDIR_SITE_INVALID: '双向链接验证失败：友链 JSON 中 url 无效，无法比较主域名。',
  BIDIR_HOST_MISMATCH: '双向链接验证失败：backlink 的主域名必须与 url 的主域名一致。',
  BIDIR_FETCH_ERROR: '双向链接验证失败：访问 backlink 出错。',
  BIDIR_ACCESS_FAIL: '双向链接验证失败：无法访问 backlink',
  MERGE_FAIL: '自动合并失败：',
  DNS_VERIFY_FAIL: '域名所有权验证失败。',
};

/** Messages that differ between triage (PR-open flow) and verify (comment-triggered flow). */
const FLOW_MSG = {
  triage: {
    VIP_DETECTED:
      '检测到 JSON 存在 vip 字段，已终止自动流程。\n\n请从以下文件移除 vip 字段后再 push 更新（移除后才会继续自动校验/自动合并）：',
    BIDIR_INSTRUCTIONS(siteBase) {
      return [
        '基础校验已通过，需要进行双向链接验证：',
        '',
        `1) 请在你的友链页面添加本站友链（必须为绝对链接）：${siteBase}`,
        '2) 然后更新本 PR 的友链 JSON，增加字段 backlink（填写你的友链页面 URL，必须是 http/https 绝对链接）',
        '',
        '示例：',
        '',
        '```json',
        '{',
        '  "name": "...",',
        '  "avatar": "...",',
        '  "url": "...",',
        '  "backlink": "https://example.com/friends/"',
        '}',
        '```',
        '',
        `3) 请确保你的 backlink 页面中包含指向本站的链接 href=${siteBase} （必须完全一致的绝对链接）`,
        '4) push 更新后 Action 会自动重新校验并在通过后自动合并，无需额外评论',
      ].join('\n');
    },
    DNS_VERIFY_INSTRUCTIONS(isDelete, hostname, expected) {
      return [
        `检测到你正在${isDelete ? '删除' : '修改'}现有的友链/赞助数据。为了防止误操作，请完成域名所有权验证：`,
        '',
        `方法一（DNS）：在域名 ${hostname} 下添加 TXT 记录，内容：${expected}`,
        `方法二（文件）：在网站根目录放置 acofork-verification.html，内容：${expected}`,
        '完成后 push 更新以触发重新校验。',
      ].join('\n');
    },
  },
  verify: {
    VIP_DETECTED:
      '检测到 JSON 存在 vip 字段，已终止自动流程。\n\n请从以下文件移除 vip 字段后再 push 更新，然后再次回复"准备完毕"：',
    BIDIR_INSTRUCTIONS:
      '该 PR 走双向链接验证流程：请在友链 JSON 中填写 backlink 字段并 push 更新，无需回复"准备完毕"。',
    DNS_VERIFY_INSTRUCTIONS(isDelete, hostname, expected) {
      return [
        `检测到你正在${isDelete ? '删除' : '修改'}现有的友链/赞助数据。为了防止误操作，请完成域名所有权验证：`,
        '',
        `方法一（DNS）：在域名 ${hostname} 下添加 TXT 记录，内容：${expected}`,
        `方法二（文件）：在网站根目录放置 acofork-verification.html，内容：${expected}`,
        '完成后 push 更新以触发重新校验。',
      ].join('\n');
    },
    LINK_UNREACHABLE_DETAIL: '检测到链接不可达，请修复后再次回复"准备完毕"。',
  },
};

// Build unified MSG object with defaults from SHARED_MSG
const MSG = Object.assign({}, SHARED_MSG);

/**
 * Build BIDIR_NOT_FOUND message.
 */
function bidirNotFoundMsg(siteBase, backlinkUrl) {
  return [
    '双向链接验证未通过：在 backlink 页面未检测到本站友链。',
    '',
    `需要添加的绝对链接：${siteBase}`,
    `backlink 页面：${backlinkUrl}`,
    '',
  ].join('\n');
}

/** Retry hint / footer appended to every comment. */
function buildFooter(runUrl) {
  const retryHint =
    '💡 如果因网络波动等原因多次不通过，可尝试 **关闭后重新打开 PR** 以再次触发检查。仍然不行请联系 [afoim](https://github.com/afoim)（在[仓库首页](https://github.com/afoim/friends-and-sponsors)点击 About 可以找到联系方式）。';
  return `\n\n---\n该评论由 Action 自动化发送，无需回复。\n\n🔗 [查看 Action](${runUrl})\n\n${retryHint}`;
}

// ── Pure utilities ─────────────────────────────────────────────

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function parseJsonSafe(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Normalize a URL string.  Relative paths (starting with "/") are resolved
 * against `siteBase`.  Returns `null` if the input is not a valid URL.
 */
function normalizeUrl(rawUrl, siteBase) {
  if (!isNonEmptyString(rawUrl)) return null;
  const u = rawUrl.trim();
  if (u.startsWith('/')) {
    if (!siteBase) return null;
    try {
      return new URL(u, siteBase).toString();
    } catch {
      return null;
    }
  }
  try {
    return new URL(u).toString();
  } catch {
    return null;
  }
}

function extractTitle(html) {
  if (!isNonEmptyString(html)) return null;
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const t = String(m[1] || '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 200);
}

/**
 * Verify that `html` contains an `<a href="...">` pointing to `expected`.
 * Trailing slashes are normalised before comparison.
 */
function verifyBacklink(html, expected) {
  if (!html || !expected) return { found: false, links: [], reason: 'empty input' };
  const target = expected.replace(/\/$/, '');
  const patterns = [
    /href\s*=\s*["']([^"']+)["']/gi,
    /href\s*=\s*([^\s>]+)/gi,
  ];
  const foundLinks = [];
  const allMatches = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const href = (m[1] || '').trim();
      allMatches.push(href);
      if (!href.startsWith('http')) continue;
      foundLinks.push(href);
      const normalized = href.replace(/\/$/, '');
      if (normalized === target) {
        return { found: true, links: foundLinks, matchedHref: href };
      }
    }
  }
  return { found: false, links: foundLinks, allMatches: allMatches.slice(0, 20), target };
}

/**
 * Build a human-readable debug string for backlink verification failures.
 */
function formatBacklinkDebug(d) {
  const lines = ['调试信息：'];
  if (isNonEmptyString(d?.finalUrl)) lines.push(`- 最终 URL：${d.finalUrl}`);
  if (typeof d?.status === 'number') lines.push(`- 状态码：${d.status}`);
  if (isNonEmptyString(d?.contentType)) lines.push(`- Content-Type：${d.contentType}`);
  if (isNonEmptyString(d?.title)) lines.push(`- 标题：${d.title}`);
  if (typeof d?.foundLinksCount === 'number') lines.push(`- 找到的 HTTP(S) 链接数：${d.foundLinksCount}`);
  if (isNonEmptyString(d?.sampleLinks)) lines.push(`- 示例链接：${d.sampleLinks}`);
  return lines.join('\n');
}

/**
 * Build a debug info string for generic URL reachability failures.
 */
function formatReachabilityDebug(d) {
  const lines = ['可达性调试信息：'];
  if (typeof d?.status === 'number') lines.push(`- HTTP 状态码：${d.status}`);
  if (isNonEmptyString(d?.finalUrl)) lines.push(`- 最终 URL：${d.finalUrl}`);
  if (isNonEmptyString(d?.contentType)) lines.push(`- Content-Type：${d.contentType}`);
  if (isNonEmptyString(d?.error)) lines.push(`- 错误：${d.error}`);
  return lines.join('\n');
}

function validateEntry({ kind, data, path }) {
  const entryErrors = [];
  if (!isNonEmptyString(data.name)) entryErrors.push('name 必填');
  if (!isNonEmptyString(data.avatar)) entryErrors.push('avatar 必填');
  if (kind === 'friend') {
    if (!isNonEmptyString(data.url)) entryErrors.push('url 必填');
  }
  if (kind === 'sponsor') {
    if (!isNonEmptyString(data.date)) entryErrors.push('date 必填');
    if (!isNonEmptyString(data.amount)) entryErrors.push('amount 必填');
  }
  if (entryErrors.length) return `${path}: ${entryErrors.join('、')}`;
  return null;
}

// ── Playwright URL checker wrapper ─────────────────────────────

const CHECK_URL_TIMEOUT = 120000; // 30s * 3 retries + backoff + overhead

/**
 * Call the standalone `.github/scripts/check-url.js` script via
 * `execFileSync` (safe from command injection).
 *
 * @param {string} url - The URL to check.
 * @param {string} [scriptPath] - Absolute path to check-url.js.
 *        Defaults to `<GITHUB_WORKSPACE>/.github/scripts/check-url.js`.
 * @returns {{ ok: boolean, status?: number, finalUrl?: string, contentType?: string,
 *             bodyLength?: number, body?: string, error?: string }}
 */
function checkUrlReachability(url, scriptPath) {
  const resolvedScript =
    scriptPath ||
    path.join(process.env.GITHUB_WORKSPACE || process.cwd(), '.github', 'scripts', 'check-url.js');

  try {
    const result = execFileSync('node', [resolvedScript, url], {
      encoding: 'utf8',
      timeout: CHECK_URL_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    });
    const trimmed = (result || '').trim();
    if (!trimmed) return { ok: false, error: 'Empty response from check-url script' };
    return JSON.parse(trimmed);
  } catch (e) {
    // execFileSync throws on non-zero exit, timeout, or spawn failure.
    // Include stderr when available — it often contains the real error.
    let stderr = '';
    if (e?.stderr) {
      stderr = Buffer.isBuffer(e.stderr) ? e.stderr.toString('utf8').trim() : String(e.stderr).trim();
    }
    const message = stderr || e?.message || String(e);
    return { ok: false, error: message };
  }
}

// ── Exports ────────────────────────────────────────────────────

module.exports = {
  // Constants
  DIRS,
  LABELS,
  SHARED_MSG,
  FLOW_MSG,
  MSG,

  // Message builders
  bidirNotFoundMsg,
  buildFooter,

  // Pure utilities
  isNonEmptyString,
  parseJsonSafe,
  normalizeUrl,
  extractTitle,
  verifyBacklink,
  formatBacklinkDebug,
  formatReachabilityDebug,
  validateEntry,

  // URL checker
  checkUrlReachability,
};
