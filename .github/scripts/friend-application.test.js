'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseIssue, review, execute, eligibleIssue, validateApproval, MARKER } = require('./friend-application');
const { browserEnvironment } = require('./pr-helpers');
const { isPublicAddress, assertPublicUrl } = require('./public-url');

function form(changes = {}) {
  const fields = { '站点名称': 'Test Site', '网站 URL': 'https://example.com/', '头像 URL': 'https://example.com/avatar.png', '站点简介': '简介', '友链页面 URL': 'https://example.com/friends/', '确认': '- [x] 我已在上述友链页面添加指向 https://2x.nz/ 的友链。', ...changes };
  return Object.entries(fields).map(([k, v]) => `### ${k}\n\n${v}`).join('\n\n');
}
const notFound = () => { throw Object.assign(new Error('Not Found'), { status: 404 }); };
function fixture() {
  const s = { issue: { id: 70, number: 7, user: { id: 42, login: 'applicant' }, state: 'open', title: '[友链申请] Test', body: form() }, comments: [], writes: [], outputs: {}, errors: [], baseSha: 'a'.repeat(40), commitSha: 'c'.repeat(40), branch: null, pull: null, merges: 0 };
  const context = { eventName: 'issues', payload: { action: 'opened', issue: s.issue, repository: { default_branch: 'main' } }, repo: { owner: 'owner', repo: 'test' }, sha: s.baseSha, runId: 123, serverUrl: 'https://github.com' };
  const core = { setOutput: (key, value) => s.outputs[key] = value, setFailed: message => s.errors.push(message), warning() {} };
  const github = { rest: {
    issues: {
      get: async () => ({ data: structuredClone(s.issue) }),
      listComments: async () => ({ data: s.comments }),
      getComment: async ({ comment_id }) => ({ data: s.comments.find(c => c.id === comment_id) }),
      createComment: async ({ body }) => { const c = { id: s.comments.length + 1, user: { login: 'github-actions[bot]' }, body }; s.comments.push(c); return { data: c }; },
      updateComment: async ({ comment_id, body }) => { s.comments.find(c => c.id === comment_id).body = body; },
      update: async ({ state }) => { s.issue.state = state; },
    },
    repos: {
      getCollaboratorPermissionLevel: async () => ({ data: { permission: s.permission || 'read' } }),
      getContent: async ({ ref }) => ref === s.baseSha ? notFound() : ({ data: { type: 'file', content: Buffer.from(s.tamperedContent || s.content).toString('base64') } }),
    },
    git: {
      getRef: async ({ ref }) => ref === 'heads/main' ? ({ data: { object: { sha: s.baseSha } } }) : s.branch ? ({ data: { object: { sha: s.commitSha } } }) : notFound(),
      getCommit: async () => ({ data: { tree: { sha: 'b'.repeat(40) } } }),
      createTree: async ({ tree }) => { s.writes.push(['tree', tree]); s.content = tree[0].content; return { data: { sha: 'd'.repeat(40) } }; },
      createCommit: async () => { s.writes.push(['commit']); return { data: { sha: s.commitSha } }; },
      createRef: async ({ ref }) => { s.writes.push(['branch', ref]); s.branch = ref; },
      updateRef: async () => { s.writes.push(['update-branch']); },
      deleteRef: async () => { s.branch = null; },
    },
    pulls: {
      list: async () => ({ data: s.pull ? [s.pull] : [] }),
      create: async ({ head, base, body }) => { s.writes.push(['pr']); s.pull = { number: 8, html_url: 'https://github.com/owner/test/pull/8', state: 'open', body, head: { ref: head, sha: s.commitSha, repo: { full_name: 'owner/test' } }, base: { ref: base, repo: { full_name: 'owner/test' } } }; return { data: s.pull }; },
      get: async () => { if (s.beforePullGet) s.beforePullGet(); return { data: s.pull }; },
      listFiles: async () => ({ data: s.files || [{ filename: 'data/friends/issue-7.json', status: 'added' }] }),
      merge: async options => { s.mergeOptions = options; if (s.mergeError) throw s.mergeError; s.merges++; s.pull.state = 'closed'; return { data: { merged: true } }; },
    },
  }, paginate: async (fn, args) => (await fn(args)).data };
  const check = async url => ({ ok: true, status: 200, finalUrl: url, contentType: url.includes('avatar') ? 'image/png' : 'text/html', links: ['https://2x.nz/'] });
  return { s, context, github, core, check, entries: [] };
}
const runReview = f => review(f);
const runExecute = f => execute({ ...f, encoded: f.s.outputs.approval, wait: async () => {} });

test('form yields only the allowed fields, optional description and CRLF work', () => {
  const e = parseIssue(form({ '站点简介': '_No response_' }).replace(/\n/g, '\r\n'));
  assert.deepEqual(Object.keys(e), ['name', 'avatar', 'url', 'backlink']);
});
for (const [name, body] of [
  ['extra vip', form() + '\n\n### vip\ntrue'], ['path injection', form() + '\n\n### filename\n../../main.js'],
  ['duplicate fields', form() + '\n\n### 网站 URL\nhttps://evil.example/'], ['raw JSON', '{"vip":true}'],
  ['HTML', form({ '站点名称': '<img src=x onerror=alert(1)>' })], ['multiline name', form({ '站点名称': 'a\nb' })],
  ['missing confirmation', form({ '确认': '- [ ] 我已在上述友链页面添加指向 https://2x.nz/ 的友链。' })],
  ['different backlink host', form({ '友链页面 URL': 'https://other.example/friends/' })],
  ['long field', form({ '站点简介': 'a'.repeat(241) })],
]) test(`rejects ${name}`, () => assert.throws(() => parseIssue(body)));
for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'http://127.0.0.1/', 'http://2130706433/', 'http://[::1]/', 'https://u:p@example.com/', 'http://example.com:8080/', 'http://a.local/', 'http://localhost/', 'https://example.com/\ninject']) {
  test(`rejects unsafe URL ${JSON.stringify(url)}`, () => assert.throws(() => parseIssue(form({ '头像 URL': url }))));
}
test('shell and expression text stays data; file path never uses the name', async () => {
  const f = fixture(); f.s.issue.body = form({ '站点名称': '$(echo_owned); ${{ secrets.PAT }} ../data' });
  await runReview(f); await runExecute(f);
  assert.equal(f.s.merges, 1); assert.equal(f.s.writes[0][1][0].path, 'data/friends/issue-7.json');
  assert.equal(JSON.parse(f.s.content).name, '$(echo_owned); ${{ secrets.PAT }} ../data');
});
test('review failure causes zero repository writes and zero PRs', async () => {
  const f = fixture(); f.check = async () => ({ ok: false, status: 404 }); await runReview(f);
  assert.equal(f.s.outputs.approved, 'false'); assert.equal(f.s.outputs.approval, undefined); assert.deepEqual(f.s.writes, []);
  assert.match(f.s.comments[0].body, /头像无法访问/);
});
test('HTML masquerading as an avatar does not pass', async () => {
  const f = fixture(); f.check = async url => ({ ok: true, finalUrl: url, contentType: 'text/html', links: ['https://2x.nz/'] });
  await runReview(f); assert.equal(f.s.outputs.approved, 'false'); assert.deepEqual(f.s.writes, []);
});
test('missing real anchor is rejected even if raw HTML text mentions href', async () => {
  const f = fixture(); const original = f.check; f.check = async url => ({ ...await original(url), links: [], body: '<!-- href="https://2x.nz/" -->' });
  await runReview(f); assert.equal(f.s.outputs.approved, 'false'); assert.deepEqual(f.s.writes, []);
});
test('backlink cross-host redirect fails', async () => {
  const f = fixture(); const original = f.check; f.check = async url => ({ ...await original(url), finalUrl: 'https://other.example/' });
  await runReview(f); assert.equal(f.s.outputs.approved, 'false');
});
test('duplicate and self-site cannot enter execution', async () => {
  for (const self of [false, true]) {
    const f = fixture();
    if (self) f.s.issue.body = form({ '网站 URL': 'https://2x.nz/', '友链页面 URL': 'https://2x.nz/links/' });
    else f.entries = [{ file: 'existing.json', entry: { url: 'https://example.com' } }];
    await runReview(f); assert.equal(f.s.outputs.approved, 'false'); assert.deepEqual(f.s.writes, []);
  }
});
test('second review succeeds, reuses one status comment; PR is created only afterwards', async () => {
  const f = fixture(); const good = f.check; f.check = async () => ({ ok: false, status: 404 });
  await runReview(f); assert.deepEqual(f.s.writes, []); const commentId = f.s.comments[0].id;
  f.context.eventName = 'issue_comment'; f.context.payload.action = 'created';
  f.context.payload.comment = { body: '重新检查', user: { ...f.s.issue.user, type: 'User' } };
  f.check = good; await runReview(f); assert.equal(f.s.outputs.approved, 'true'); assert.deepEqual(f.s.writes, []);
  await runExecute(f); assert.equal(f.s.merges, 1); assert.equal(f.s.mergeOptions.sha, f.s.commitSha);
  assert.equal(f.s.comments.length, 1); assert.equal(f.s.comments[0].id, commentId);
  assert.equal(f.s.issue.state, 'closed'); assert.equal(f.s.branch, null);
  assert.match(f.s.comments[0].body, /执行 PR 已合并/);
});
test('editing the Issue during network review invalidates the snapshot', async () => {
  const f = fixture(); const original = f.check; f.check = async url => { f.s.issue.body = form({ '站点简介': 'changed' }); return original(url); };
  await runReview(f); assert.equal(f.s.outputs.approved, 'false'); assert.deepEqual(f.s.writes, []);
});
test('editing or closing Issue after approval prevents all repository writes', async () => {
  for (const closed of [false, true]) {
    const f = fixture(); await runReview(f);
    if (closed) f.s.issue.state = 'closed'; else f.s.issue.body = form({ '站点简介': 'changed' });
    await runExecute(f); assert.deepEqual(f.s.writes, []); assert.equal(f.s.merges, 0); assert.equal(f.s.errors.length, 1);
  }
});
test('main advancing after review fails closed', async () => {
  const f = fixture(); await runReview(f); f.s.baseSha = 'e'.repeat(40); await runExecute(f);
  assert.deepEqual(f.s.writes, []); assert.equal(f.s.merges, 0);
});
test('PR events and old prepare command are not review entry points', async () => {
  const f = fixture(); f.context.eventName = 'pull_request_target'; assert.equal(await eligibleIssue(f.github, f.context), null);
  f.context.eventName = 'issue_comment'; f.context.payload.issue.pull_request = {}; f.context.payload.comment = { body: '重新检查' };
  assert.equal(await eligibleIssue(f.github, f.context), null);
  delete f.context.payload.issue.pull_request; f.context.payload.comment.body = '准备完毕'; f.context.payload.action = 'created';
  assert.equal(await eligibleIssue(f.github, f.context), null);
});
test('unrelated commenters cannot cause reviews', async () => {
  const f = fixture(); f.context.eventName = 'issue_comment'; f.context.payload.action = 'created';
  f.context.payload.comment = { body: '重新检查', user: { id: 99, login: 'other', type: 'User' } };
  assert.equal(await eligibleIssue(f.github, f.context), null);
  f.s.permission = 'write'; assert.ok(await eligibleIssue(f.github, f.context));
});
test('forged marker never causes another user comment to be overwritten', async () => {
  const f = fixture(); const fake = { id: 1, user: { login: 'attacker' }, body: MARKER + ' forged' }; f.s.comments.push(fake);
  await runReview(f); assert.equal(fake.body, MARKER + ' forged'); assert.equal(f.s.comments.length, 2);
});
for (const kind of ['repo', 'run', 'vip']) test(`approval provenance rejects ${kind}`, async () => {
  const f = fixture(); await runReview(f); const a = JSON.parse(Buffer.from(f.s.outputs.approval, 'base64'));
  if (kind === 'repo') a.repository = 'attacker/fork'; else if (kind === 'run') a.runId = '0'; else a.entry.vip = true;
  assert.throws(() => validateApproval(Buffer.from(JSON.stringify(a)).toString('base64'), f.context));
});
for (const kind of ['sha', 'fork', 'extra-file', 'changed-content', 'removed', 'issue-edit', 'merge-conflict']) {
  test(`execution refuses tampered ${kind}`, async () => {
    const f = fixture(); await runReview(f);
    if (kind === 'sha') f.s.beforePullGet = () => f.s.pull.head.sha = 'f'.repeat(40);
    if (kind === 'fork') f.s.beforePullGet = () => f.s.pull.head.repo.full_name = 'attacker/test';
    if (kind === 'extra-file') f.s.files = [{ filename: 'data/friends/issue-7.json', status: 'added' }, { filename: '.github/workflows/pwn.yml', status: 'added' }];
    if (kind === 'removed') f.s.files = [{ filename: 'data/friends/issue-7.json', status: 'removed' }];
    if (kind === 'changed-content') f.s.tamperedContent = '{"vip":true}';
    if (kind === 'issue-edit') f.s.beforePullGet = () => f.s.issue.body = form({ '站点简介': 'changed after creating PR' });
    if (kind === 'merge-conflict') f.s.mergeError = Object.assign(new Error('SHA mismatch'), { status: 409 });
    await runExecute(f); assert.equal(f.s.merges, 0); assert.equal(f.s.errors.length, 1);
  });
}
test('browser child only inherits an environment allowlist, not GitHub tokens', () => {
  assert.deepEqual(browserEnvironment({ PATH: '/bin', HOME: '/tmp', PAT: 'x', GITHUB_TOKEN: 'x', GH_TOKEN: 'x', 'INPUT_GITHUB-TOKEN': 'x', ACTIONS_RUNTIME_TOKEN: 'x', APPROVAL: 'x', NODE_OPTIONS: '--require=pwn' }), { PATH: '/bin', HOME: '/tmp' });
});
for (const addr of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.1.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) {
  test(`network guard rejects ${addr}`, () => assert.equal(isPublicAddress(addr), false));
}
test('public addresses allowed but mixed public/private DNS rejected', async () => {
  assert.equal(isPublicAddress('1.1.1.1'), true); assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  await assert.rejects(() => assertPublicUrl('https://example.com/', async () => [{ address: '1.1.1.1' }, { address: '127.0.0.1' }]));
  assert.equal(await assertPublicUrl('https://example.com/', async () => [{ address: '1.1.1.1' }]), 'https://example.com/');
});

test('URL length limit also applies after percent encoding', () => {
  assert.throws(() => parseIssue(form({ '头像 URL': 'https://example.com/' + '图'.repeat(500) })));
});
