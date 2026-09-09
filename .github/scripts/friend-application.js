'use strict';

// Issue is the only review API. The write-capable executor consumes an approved
// snapshot from the preceding job, never a PR event, label or comment body.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isIP } = require('node:net');
const { checkUrlReachability } = require('./pr-helpers');
const MARKER = '<!-- friend-application-status:v2 -->';
const PREFIX = '[友链申请]';
const FIELDS = ['站点名称', '网站 URL', '头像 URL', '站点简介', '友链页面 URL', '确认'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = entry => `${JSON.stringify(entry, null, 2)}\n`;
const normalize = value => new URL(value).href.replace(/\/$/, '');
const snapshotHash = issue => hash(JSON.stringify([issue.id, issue.user.id, issue.title, issue.body]));
const repoArgs = context => ({ owner: context.repo.owner, repo: context.repo.repo });

function publicUrl(value, label) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\u0000-\u001f\u007f\\]/u.test(value)) {
    throw new Error(`${label} 必须是完整的 HTTP(S) 地址，不能包含空白、控制字符或反斜杠。`);
  }
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} 不是有效网址。`); }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (url.href.length > 2048) throw new Error(`${label} 编码后不能超过 2048 字符。`);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
      isIP(host) || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)) {
    throw new Error(`${label} 必须使用公开域名及标准 HTTP(S) 端口，不能含账号密码或内网地址。`);
  }
  return url.href;
}

function parseIssue(body) {
  if (typeof body !== 'string' || body.length > 16000) throw new Error('申请内容为空或过长。');
  const sections = new Map();
  let current;
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1];
      if (!FIELDS.includes(current) || sections.has(current)) throw new Error('请保留表单字段名称，不要添加额外字段或重复字段。');
      sections.set(current, []);
    } else if (current) sections.get(current).push(line);
    else if (line.trim()) throw new Error('请使用友链申请表单，不要在字段之外添加内容。');
  }
  const get = label => {
    const value = (sections.get(label) || []).join('\n').trim();
    return value === '_No response_' ? '' : value;
  };
  const text = (label, max, required = true) => {
    const value = get(label);
    if ((required && !value) || value.length > max || /[<>\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error(`${label} ${required ? '为必填项，' : ''}请填写不含 HTML 或换行的纯文本（最多 ${max} 字符）。`);
    }
    return value;
  };
  const name = text('站点名称', 80);
  const description = text('站点简介', 240, false);
  const url = publicUrl(get('网站 URL'), '网站 URL');
  const avatar = publicUrl(get('头像 URL'), '头像 URL');
  const backlink = publicUrl(get('友链页面 URL'), '友链页面 URL');
  if (new URL(url).host !== new URL(backlink).host) throw new Error('友链页面 URL 必须与网站 URL 同域。');
  if (!/^- \[[xX]\] 我已在上述友链页面添加指向 https:\/\/2x\.nz\/ 的友链。$/.test(get('确认'))) {
    throw new Error('请勾选确认：我已在友链页面添加本站链接。');
  }
  // Construct a new object: callers cannot supply vip, filename, branch or other keys.
  return { name, avatar, ...(description ? { description } : {}), url, backlink };
}

function loadEntries(root) {
  const dir = path.join(root, 'data', 'friends');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(file => file.endsWith('.json')).map(file => ({
    file, entry: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')),
  }));
}

async function eligibleIssue(github, context) {
  if (!['issues', 'issue_comment'].includes(context.eventName) || context.payload.issue?.pull_request) return null;
  if (context.eventName === 'issues' && !['opened', 'edited', 'reopened'].includes(context.payload.action)) return null;
  if (context.eventName === 'issues' && context.payload.action === 'edited' && !context.payload.changes?.body) return null;
  const { data: issue } = await github.rest.issues.get({ ...repoArgs(context), issue_number: context.payload.issue.number });
  if (issue.pull_request || issue.state !== 'open' || !issue.title.startsWith(PREFIX)) return null;
  if (context.eventName === 'issue_comment') {
    const comment = context.payload.comment;
    if (context.payload.action !== 'created' || comment?.body?.trim() !== '重新检查' || comment.user.type === 'Bot') return null;
    if (comment.user.id !== issue.user.id) {
      const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ ...repoArgs(context), username: comment.user.login });
      if (!['admin', 'maintain', 'write'].includes(data.permission)) return null;
    }
  }
  return issue;
}

async function setStatus(github, context, issueNumber, message, { commentId, pullUrl } = {}) {
  const args = repoArgs(context);
  const runUrl = `${context.serverUrl}/${args.owner}/${args.repo}/actions/runs/${context.runId}`;
  const body = [MARKER, '## 友链申请状态', '', message, '', '---',
    '信息填错：编辑本 Issue 正文并保存。站外内容已修好：回复 `重新检查`。',
    '所有审核均在 Issue 完成；未通过不会创建执行 PR。',
    pullUrl ? `[查看执行记录](${pullUrl}) · [本次检查](${runUrl})` : `[本次检查](${runUrl})`,
  ].join('\n');
  if (!commentId) {
    const comments = await github.paginate(github.rest.issues.listComments, { ...args, issue_number: issueNumber, per_page: 100 });
    // Never overwrite a user-created comment that merely copies our marker.
    commentId = comments.find(c => c.user?.login === 'github-actions[bot]' && c.body?.startsWith(MARKER))?.id;
  }
  if (commentId) {
    const { data: comment } = await github.rest.issues.getComment({ ...args, comment_id: commentId });
    if (comment.user?.login !== 'github-actions[bot]' || !comment.body?.startsWith(MARKER)) throw new Error('状态评论来源异常，已停止。');
    await github.rest.issues.updateComment({ ...args, comment_id: commentId, body });
    return commentId;
  }
  const { data } = await github.rest.issues.createComment({ ...args, issue_number: issueNumber, body });
  return data.id;
}

async function stillCurrent(github, context, approval) {
  const { data: issue } = await github.rest.issues.get({ ...repoArgs(context), issue_number: approval.issueNumber });
  return issue.state === 'open' && !issue.pull_request && issue.title.startsWith(PREFIX) && snapshotHash(issue) === approval.issueHash;
}

async function review({ github, context, core, root = process.env.GITHUB_WORKSPACE || process.cwd(), check = checkUrlReachability, entries = loadEntries(root) }) {
  core.setOutput('approved', 'false');
  const issue = await eligibleIssue(github, context);
  if (!issue) return;
  const issueNumber = issue.number;
  const issueHash = snapshotHash(issue);
  const args = repoArgs(context);
  const commentId = await setStatus(github, context, issueNumber, '⏳ 正在审核申请信息、头像、网站及双向友链。');
  let entry;
  const progress = [];
  const report = async message => {
    if (await stillCurrent(github, context, { issueNumber, issueHash })) {
      await setStatus(github, context, issueNumber, message, { commentId });
    }
  };
  try {
    entry = parseIssue(issue.body);
    const site = JSON.parse(fs.readFileSync(path.join(root, 'config', 'site.json'), 'utf8')).url;
    if (normalize(entry.url) === normalize(site)) throw new Error('网站 URL 应填写你的网站，不能填写本站。');
    if (entries.some(e => e.file === `issue-${issueNumber}.json` || normalize(e.entry.url) === normalize(entry.url))) {
      throw new Error('该网站已在友链名单中。本表单仅用于新增；修改或删除已有条目请联系维护者。');
    }
    progress.push('✅ 申请字段与重复检查通过');
    for (const [label, url] of [['头像', entry.avatar], ['网站', entry.url], ['友链页面', entry.backlink]]) {
      const result = await check(url);
      if (!result.ok) throw new Error(`${label}无法访问（${result.status ? `HTTP ${result.status}` : '请求失败或地址不可访问'}）。请检查对应地址是否公开可访问。`);
      if (label === '头像' && !/^image\//i.test(result.contentType || '')) throw new Error('头像 URL 没有返回图片，请填写图片直链。');
      if (label === '友链页面') {
        if (new URL(result.finalUrl).host !== new URL(entry.url).host) throw new Error('友链页面跳转到了其他域名，请使用自己站点的友链页。');
        if (!Array.isArray(result.links) || !result.links.some(href => {
          try { return /^https?:\/\//.test(href) && normalize(href) === normalize(site); } catch { return false; }
        })) throw new Error(`未在友链页面找到指向 ${site} 的实际链接。添加后在此 Issue 回复“重新检查”。`);
      }
      progress.push(`✅ ${label === '友链页面' ? '双向友链验证通过' : `${label}可访问`}`);
    }
  } catch (error) {
    await report(`${progress.join('\n')}\n\n❌ ${error.message}\n\n尚未创建执行 PR，正式数据未改动。`);
    return;
  }
  if (!(await stillCurrent(github, context, { issueNumber, issueHash }))) return;
  const approval = {
    version: 1, repository: `${args.owner}/${args.repo}`, issueNumber, issueHash,
    baseSha: context.sha, runId: String(context.runId), commentId, entry,
  };
  await report(`${progress.join('\n')}\n\n✅ Issue 审核通过，准备创建执行 PR。`);
  core.setOutput('approval', Buffer.from(JSON.stringify(approval)).toString('base64'));
  core.setOutput('approved', 'true');
}

function validateApproval(encoded, context) {
  if (typeof encoded !== 'string' || encoded.length > 24000) throw new Error('缺少审核结果。');
  const a = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (a.version !== 1 || a.repository !== `${context.repo.owner}/${context.repo.repo}` ||
      a.issueNumber !== context.payload.issue?.number || !Number.isSafeInteger(a.issueNumber) || a.issueNumber <= 0 ||
      a.runId !== String(context.runId) || a.baseSha !== context.sha || !/^[0-9a-f]{40}$/.test(a.baseSha) ||
      !/^[0-9a-f]{64}$/.test(a.issueHash) || !Number.isSafeInteger(a.commentId) ||
      !a.entry || Object.keys(a.entry).some(k => !['name', 'avatar', 'description', 'url', 'backlink'].includes(k))) {
    throw new Error('审核结果来源或字段不匹配，拒绝执行。');
  }
  return a;
}

function assertExecutionPull(pull, { repository, branch, base, sha, marker }) {
  if (pull.state !== 'open' || pull.head.repo?.full_name !== repository || pull.base.repo?.full_name !== repository ||
      pull.head.ref !== branch || pull.base.ref !== base || pull.head.sha !== sha || pull.body !== marker) {
    throw new Error('执行 PR 来源、目标、内容版本或关联标记不匹配，拒绝合并。');
  }
}

async function execute({ github, context, core, encoded = process.env.APPROVAL, wait = sleep }) {
  const a = validateApproval(encoded, context);
  const args = repoArgs(context);
  const base = context.payload.repository.default_branch;
  const dataPath = `data/friends/issue-${a.issueNumber}.json`;
  // New prefix distinguishes audited execution PRs from the retired unreviewed bridge.
  const branch = `friend-approved-${a.issueNumber}`;
  const marker = `<!-- friend-execution:${a.issueNumber} -->\n\nIssue 审核通过后的执行记录。此 PR 不接受独立审核或评论指令。\n\nCloses #${a.issueNumber}`;
  let pull;
  let merged = false;
  const status = message => setStatus(github, context, a.issueNumber, message, { commentId: a.commentId, pullUrl: pull?.html_url });
  try {
    if (!(await stillCurrent(github, context, a))) throw new Error('Issue 已修改或关闭，原审核结果已失效。请等待新审核或回复“重新检查”。');
    const { data: currentIssue } = await github.rest.issues.get({ ...args, issue_number: a.issueNumber });
    if (canonical(parseIssue(currentIssue.body)) !== canonical(a.entry)) throw new Error('待执行内容与已审核 Issue 不一致。');
    const { data: ref } = await github.rest.git.getRef({ ...args, ref: `heads/${base}` });
    if (ref.object.sha !== a.baseSha) throw new Error('正式名单在审核期间发生更新，请回复“重新检查”后重新审核，避免覆盖新数据。');
    try {
      await github.rest.repos.getContent({ ...args, path: dataPath, ref: a.baseSha });
      throw new Error('该申请已经执行过，不允许通过本入口覆盖现有数据。');
    } catch (error) { if (error.status !== 404) throw error; }

    const { data: openPulls } = await github.rest.pulls.list({ ...args, state: 'open', head: `${args.owner}:${branch}`, base });
    pull = openPulls[0];
    if (pull && (pull.body !== marker || pull.head.repo?.full_name !== a.repository)) throw new Error('同名执行分支已被占用，请维护者处理。');
    if (!pull) {
      try {
        await github.rest.git.getRef({ ...args, ref: `heads/${branch}` });
        throw new Error('执行分支已存在但没有匹配的开放 PR，请维护者检查，不能自动接管。');
      } catch (error) { if (error.status !== 404) throw error; }
    }
    // Build a one-file tree from the trusted, audited base, never from a PR head.
    const { data: baseCommit } = await github.rest.git.getCommit({ ...args, commit_sha: a.baseSha });
    const content = canonical(a.entry);
    const { data: tree } = await github.rest.git.createTree({ ...args, base_tree: baseCommit.tree.sha,
      tree: [{ path: dataPath, mode: '100644', type: 'blob', content }] });
    const { data: commit } = await github.rest.git.createCommit({ ...args, tree: tree.sha, parents: [a.baseSha], message: `friend: apply approved issue #${a.issueNumber}` });
    if (!(await stillCurrent(github, context, a))) throw new Error('申请内容已变化，停止执行旧审核结果。');
    if (pull) await github.rest.git.updateRef({ ...args, ref: `heads/${branch}`, sha: commit.sha, force: true });
    else {
      await github.rest.git.createRef({ ...args, ref: `refs/heads/${branch}`, sha: commit.sha });
      ({ data: pull } = await github.rest.pulls.create({ ...args, base, head: branch, title: `执行友链申请 #${a.issueNumber}`, body: marker }));
    }
    await status('✅ Issue 审核通过。执行 PR 已生成，正在写入正式名单。');
    const expected = { repository: a.repository, branch, base, sha: commit.sha, marker };
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: currentPull } = await github.rest.pulls.get({ ...args, pull_number: pull.number });
      assertExecutionPull(currentPull, expected);
      const files = await github.paginate(github.rest.pulls.listFiles, { ...args, pull_number: pull.number, per_page: 100 });
      if (files.length !== 1 || files[0].filename !== dataPath || files[0].status !== 'added') throw new Error('执行 PR 必须仅新增本 Issue 对应的数据文件。');
      const { data: file } = await github.rest.repos.getContent({ ...args, path: dataPath, ref: commit.sha });
      if (file.type !== 'file' || Buffer.from(file.content, 'base64').toString('utf8') !== content) throw new Error('执行文件与审核快照不一致。');
      if (!(await stillCurrent(github, context, a))) throw new Error('Issue 已修改或关闭，禁止合并旧快照。');
      const { data: latestBase } = await github.rest.git.getRef({ ...args, ref: `heads/${base}` });
      if (latestBase.object.sha !== a.baseSha) throw new Error('正式名单已变化，请回复“重新检查”后重试。');
      try {
        const { data: result } = await github.rest.pulls.merge({ ...args, pull_number: pull.number, sha: commit.sha, merge_method: 'squash' });
        if (!result.merged) throw new Error('平台尚未允许合并，请联系维护者。');
        merged = true;
        break;
      } catch (error) {
        if (error.status !== 405 || attempt === 4) throw error;
        // GitHub may still be computing mergeability. Never bypass branch rules.
        await wait(2000);
      }
    }
    await status('✅ Issue 审核已通过，执行 PR 已合并，友链已写入正式名单。部署完成后将在页面显示。');
    await github.rest.issues.update({ ...args, issue_number: a.issueNumber, state: 'closed', state_reason: 'completed' });
    try { await github.rest.git.deleteRef({ ...args, ref: `heads/${branch}` }); }
    catch (error) { core.warning(`执行分支清理未完成：${error.status || 'unknown'}`); }
  } catch (error) {
    await status(merged ? '✅ 执行 PR 已合并。申请收尾同步遇到错误，请维护者检查 Issue 状态。' : `⚠️ 执行已停止：${error.message}\n\n本次没有合并任何数据。`);
    core.setFailed(error.message);
  }
}

module.exports = { parseIssue, publicUrl, snapshotHash, canonical, eligibleIssue, setStatus, stillCurrent, review, validateApproval, assertExecutionPull, execute, MARKER };
