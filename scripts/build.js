/**
 * Build script for friends-and-sponsors
 *
 * Scans data/ for individual JSON files, validates, sorts,
 * and generates friends.json / sponsors.json at repo root.
 *
 * Relative avatar paths are resolved against DOMAIN.
 *
 * Usage: node scripts/build.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
const DATA_FRIENDS = path.join(ROOT, 'data', 'friends');
const DATA_SPONSORS = path.join(ROOT, 'data', 'sponsors');
const IMG_SPONSORS = path.join(ROOT, 'data', 'sponsors-img');

/** Domain used to resolve relative avatar paths in output */
const DOMAIN = 'https://raw-fas.acofork.com';

function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function isNullOrString(v)   { return v === null || typeof v === 'string'; }

/** Normalize dates like "2026-1-12" → "2026-01-12" for correct sort order. */
function normalizeDate(dateStr) {
  if (typeof dateStr !== 'string') return dateStr;
  const m = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return dateStr;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/**
 * Resolve a relative avatar path to an absolute URL.
 * Only transforms strings starting with '/'; leaves null, absolute URLs, etc. untouched.
 */
function resolveAvatar(avatar) {
  if (typeof avatar === 'string' && avatar.startsWith('/')) {
    return DOMAIN + avatar;
  }
  return avatar;
}

function loadAndValidate(dir, label, rules) {
  if (!fs.existsSync(dir)) throw new Error(`${label} directory missing: ${dir}`);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const result = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        console.error(`  ❌ ${f}: must be an object`); continue;
      }
      const errs = rules.flatMap(r => r(data));
      if (errs.length) { console.error(`  ❌ ${f}: ${errs.join(', ')}`); continue; }
      result.push(data);
    } catch (e) { console.error(`  ❌ ${f}: ${e.message}`); }
  }
  console.log(`   → ${result.length}/${files.length} ${label} loaded`);
  if (result.length !== files.length) {
    throw new Error(`${label} validation failed; existing output has not been changed`);
  }
  return result;
}

// ── Load ──
console.log('\n📦 Friends...');
const friends = loadAndValidate(DATA_FRIENDS, 'friends', [
  d => !isNonEmptyString(d.name) ? ['name required'] : [],
  d => !isNullOrString(d.avatar) ? ['avatar must be string or null'] : [],
  d => !isNonEmptyString(d.url) ? ['url required'] : [],
]);
// VIP first, then alphabetical by name
friends.sort((a, b) => {
  if (a.vip && !b.vip) return -1;
  if (!a.vip && b.vip) return 1;
  return a.name.localeCompare(b.name, 'zh-CN');
});

console.log('\n📦 Sponsors...');
const sponsors = loadAndValidate(DATA_SPONSORS, 'sponsors', [
  d => !isNonEmptyString(d.name) ? ['name required'] : [],
  d => !isNullOrString(d.avatar) ? ['avatar must be string or null'] : [],
  d => !isNonEmptyString(d.date) ? ['date required'] : [],
  d => !isNonEmptyString(d.amount) ? ['amount required'] : [],
]);
// Apply date normalization before sorting
sponsors.forEach(d => { d.date = normalizeDate(d.date); });
sponsors.sort((a, b) => b.date.localeCompare(a.date));

// ── Resolve relative avatar paths ──
friends.forEach(d => { d.avatar = resolveAvatar(d.avatar); });
sponsors.forEach(d => { d.avatar = resolveAvatar(d.avatar); });

// ── Write ──
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'friends.json'), JSON.stringify(friends, null, 2));
fs.writeFileSync(path.join(OUT, 'sponsors.json'), JSON.stringify(sponsors, null, 2));

// Copy Cloudflare Workers headers/config
for (const file of ['_headers']) {
  const src = path.join(ROOT, 'src', file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(OUT, file));
  }
}

// Copy sponsor images
const OUT_SPONSORS_IMG = path.join(OUT, 'sponsors', 'img');
if (fs.existsSync(IMG_SPONSORS)) {
  fs.mkdirSync(OUT_SPONSORS_IMG, { recursive: true });
  for (const f of fs.readdirSync(IMG_SPONSORS)) {
    fs.copyFileSync(path.join(IMG_SPONSORS, f), path.join(OUT_SPONSORS_IMG, f));
  }
  console.log(`   🖼️  ${fs.readdirSync(IMG_SPONSORS).length} sponsor images copied`);
}

console.log(`\n✅ dist/friends.json (${friends.length})`);
console.log(`✅ dist/sponsors.json (${sponsors.length})`);
