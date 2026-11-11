'use strict';
const dns = require('node:dns').promises;
const H = require('./pr-helpers.js');
const MARKER = '<!-- acofork-auto-pr -->';
function httpUrl(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error('请填写有效的 http/https 网站或头像地址。');
  return u;
}
async function ownership(host, number, resolveTxt = dns.resolveTxt) {
  const expected = `acofork-verification=${number}`;
  for (const name of [host, `_acofork-verification.${host}`]) {
    try { if ((await resolveTxt(name)).some(chunks => chunks.join('') === expected)) return true; } catch { /* pending DNS */ }
  }
  return false;
}
async function validateChange({ number, file, current, previous, siteBase }, io = {}) {
  const owns = io.ownership || ownership;
  const check = io.check || H.checkUrlReachability;
  if (!/^data\/(friends|sponsors)\/[^/]+\.json$/.test(file.filename) || !['added', 'modified', 'removed'].includes(file.status)) throw Error('每个 PR 只能新增、修改或删除一份友链/赞助 JSON。');
  const kind = file.filename.startsWith('data/friends/') ? 'friend' : 'sponsor';
  if (file.status !== 'added') {
    const host = httpUrl(previous?.url).hostname;
    if (!await owns(host, number)) throw Error(`修改或删除前请验证原网站所有权：在 ${host} 或 _acofork-verification.${host} 添加 TXT 记录 acofork-verification=${number}。验证通过会自动处理，无需重新提交。`);
  }
  if (file.status === 'removed') return;
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw Error('JSON 必须是一个对象。');
  const error = H.validateEntry({ kind, data: current, path: file.filename });
  if (error) throw Error(error);
  if (JSON.stringify(current.vip ?? null) !== JSON.stringify(previous?.vip ?? null)) throw Error('VIP 字段不能通过自动申请修改。');
  const avatar = httpUrl(current.avatar);
  const avatarResult = await check(avatar.href);
  if (!avatarResult.ok) throw Error('头像暂时无法访问，请检查头像地址。');
  if (kind === 'sponsor') return;
  const site = httpUrl(current.url), backlink = httpUrl(current.backlink);
  if (site.host !== backlink.host) throw Error('双向链接页面必须在你的网站域名下。');
  if ([new URL(siteBase).host, 'www.acofork.com', 'acofork.com', '2x.nz'].includes(site.host)) throw Error('请填写你自己的网站地址。');
  const home = await check(site.href);
  if (!home.ok) throw Error('网站暂时无法访问，请检查网站地址。');
  const linked = await check(backlink.href);
  const accepted = new Set([siteBase,'https://www.acofork.com','https://acofork.com'].map(url=>url.replace(/\/$/,'')));
  if (!linked.ok || !Array.isArray(linked.links) || !linked.links.some(href=>accepted.has(String(href).replace(/\/$/,'')))) throw Error('没有找到本站的双向链接，请检查友链页面。');
}
async function content(github, repo, file, ref) {
  const {data} = await github.rest.repos.getContent({...repo,path:file,ref});
  if (Array.isArray(data) || data.type !== 'file' || data.size > 32768) throw Error('只接受小于 32KB 的 JSON 文件。');
  return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
}
async function checkRequests({github, context}, io = {}) {
  const repo = context.repo;
  const specified = Number(context.payload.pull_request?.number || context.payload.issue?.number || context.payload.inputs?.pr || 0);
  const numbers = specified ? [specified] : (await github.rest.pulls.list({...repo,state:'open',per_page:100})).data.map(pr=>pr.number);
  const results = [];
  for (const number of numbers.slice(0,100)) {
    const {data:pr} = await github.rest.pulls.get({...repo,pull_number:number});
    if (pr.state !== 'open' || pr.draft) continue;
    if (context.eventName === 'issue_comment' && context.payload.comment.user.login !== pr.user.login && !['OWNER','MEMBER','COLLABORATOR'].includes(context.payload.comment.author_association)) continue;
    // The apply job merges with the checks token; a fork head cannot be reached from upstream main, so refuse it before any merge attempt.
    const result = {number,head:pr.head.sha,passed:false,message:''};
    if (pr.head.repo?.full_name !== `${repo.owner}/${repo.repo}`) { result.message='这个提交来自仓库副本，无法在原始仓库自动合并。请在你的副本同步最新 main 后再提交到原始仓库，或直接联系我们处理。'; results.push(result); continue; }
    try {
      const {data:files} = await github.rest.pulls.listFiles({...repo,pull_number:number,per_page:2});
      if (files.length !== 1 || pr.changed_files !== 1) throw Error('每个 PR 请只修改一份友链/赞助 JSON。');
      const file=files[0];
      const current=file.status==='removed'?null:await content(github,repo,file.filename,pr.head.sha);
      const previous=file.status==='added'?null:await content(github,repo,file.filename,pr.base.sha);
      const config=await content(github,repo,'config/site.json',context.payload.repository.default_branch);
      await validateChange({number,file,current,previous,siteBase:config.url},io);
      result.passed=true;result.message='验证通过，正在自动合并。';
    } catch(error) { result.message=String(error.message || '检查失败，请稍后再试。').slice(0,1500); }
    results.push(result);
  }
  return results;
}
async function applyResults({github, context}, results) {
  for (const result of results) {
    const {number,head,passed,message}=result;
    if (!Number.isSafeInteger(number) || !/^[a-f0-9]{40}$/.test(head) || typeof passed!=='boolean') throw Error('Invalid check result');
    const args={...context.repo,pull_number:number};
    const {data:pr}=await github.rest.pulls.get(args);
    if(pr.state!=='open'||pr.head.sha!==head)continue;
    const body=`${MARKER}\n${message}`;
    const {data:comments}=await github.rest.issues.listComments({...context.repo,issue_number:number,per_page:100});
    const prior=comments.find(c=>c.user?.type==='Bot'&&c.body?.startsWith(MARKER));
    if(prior){if(prior.body!==body)await github.rest.issues.updateComment({...context.repo,comment_id:prior.id,body});}
    else await github.rest.issues.createComment({...context.repo,issue_number:number,body});
    if(passed)await github.rest.pulls.merge({...args,sha:head,merge_method:'squash'});
  }
}
module.exports={ownership,validateChange,checkRequests,applyResults};
