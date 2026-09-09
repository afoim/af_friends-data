'use strict';

// Historical filename retained for the URL checker import; no PR review helpers
// or PR comment commands remain. The browser child never inherits credentials.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const SAFE_ENV = new Set(['path', 'systemroot', 'windir', 'home', 'userprofile', 'localappdata', 'temp', 'tmp', 'tmpdir', 'playwright_browsers_path', 'ci']);

function browserEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => SAFE_ENV.has(key.toLowerCase())));
}

function checkUrlReachability(url, scriptPath) {
  const script = scriptPath || path.join(process.env.GITHUB_WORKSPACE || process.cwd(), '.github', 'scripts', 'check-url.js');
  try {
    const result = execFileSync(process.execPath, [script, url], {
      encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024,
      env: browserEnvironment(),
    });
    return JSON.parse(result.trim());
  } catch {
    return { ok: false, error: 'URL check failed' };
  }
}

module.exports = { checkUrlReachability, browserEnvironment };
