const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {ownership,validateChange,applyResults}=require('../.github/scripts/auto-pr.js');
const fixture={number:96,file:{filename:'data/friends/test.json',status:'modified'},previous:{url:'https://old.example'},current:{name:'test',avatar:'https://cdn.example/avatar.png',url:'https://new.example',backlink:'https://new.example/links'},siteBase:'https://2x.nz/'};
test('DNS must prove the original domain with an exact TXT value, including chunked records',async()=>{
 assert(await ownership('old.example',96,async()=>[['acofork-verification=','96']]));
 assert(!await ownership('old.example',96,async()=>[['prefix-acofork-verification=96']]));
 assert(!await ownership('old.example',96,async()=>[['acofork-verification=97']]));
});
test('verified external owner updates automatically; no repository collaborator permission needed',async()=>{
 let host;await validateChange(fixture,{ownership:async h=>{host=h;return true;},check:async()=>({ok:true,links:['https://www.acofork.com/']})});assert.equal(host,'old.example');
});
test('failed ownership never reaches browser checks; bad paths and VIP escalation cannot pass',async()=>{
 await assert.rejects(()=>validateChange(fixture,{ownership:async()=>false,check:()=>{throw Error('browser must not run');}}),/TXT/);
 await assert.rejects(()=>validateChange({...fixture,file:{...fixture.file,filename:'.github/workflows/a.yml'}},{}),/JSON/);
 await assert.rejects(()=>validateChange({...fixture,current:{...fixture.current,vip:true}},{ownership:async()=>true}),/VIP/);
});
test('every friend update must pass live backlink checks, never old labels',async()=>{
 for(const body of ['', '<a href="https://other.example">other</a>'])await assert.rejects(()=>validateChange(fixture,{ownership:async()=>true,check:async()=>({ok:true,body})}),/双向链接/);
 await assert.rejects(()=>validateChange(fixture,{ownership:async()=>true,check:async()=>({ok:true,body:'<!-- <a href="https://2x.nz/">fake</a> -->',links:[]})}),/双向链接/);
 await assert.rejects(()=>validateChange({...fixture,current:{...fixture.current,backlink:'https://other.example/links'}},{ownership:async()=>true,check:async()=>({ok:true})}),/域名/);
});
test('remove requires DNS ownership but no backlink; merge pins SHA and ignores changed heads',async()=>{
 await validateChange({...fixture,file:{...fixture.file,status:'removed'}},{ownership:async()=>true,check:()=>{throw Error('no browser');}});
 const calls=[];let sha='a'.repeat(40);const github={rest:{pulls:{get:async()=>({data:{state:'open',head:{sha}}}),merge:async x=>calls.push(x)},issues:{listComments:async()=>({data:[]}),createComment:async()=>{},updateComment:async()=>{}}}};
 const result={number:96,head:sha,passed:true,message:'pass'};await applyResults({github,context:{repo:{owner:'o',repo:'r'}}},[result]);assert.equal(calls[0].sha,sha);
 sha='b'.repeat(40);await applyResults({github,context:{repo:{owner:'o',repo:'r'}}},[result]);assert.equal(calls.length,1);
});
test('fork PRs are refused before merge; the error is a fixed message, never a live token or API dump',async()=>{
 const {checkRequests}=require('../.github/scripts/auto-pr.js');
 const logs=[];const github={rest:{pulls:{get:async()=>({data:{state:'open',draft:false,changed_files:1,head:{sha:'a'.repeat(40),repo:{full_name:'someone/fork'}}}}),listFiles:async()=>({data:[{filename:'data/friends/x.json',status:'added'}]}),merge:async()=>{throw Error('network must not be touched');},list:async()=>({data:[]})},repos:{getContent:async()=>({data:{content:Buffer.from('{}').toString('base64'),type:'file',size:2}})}}};
 const results=await checkRequests({github,context:{repo:{owner:'o',repo:'r'},eventName:'pull_request_target',payload:{pull_request:{number:96}}}},{ownership:async()=>true,check:async()=>({ok:true})});
 assert.equal(results.length,1);assert.equal(results[0].passed,false);assert(/副本/.test(results[0].message));assert(!/bearer|redacted/.test(results[0].message));
});
test('network/browser checks and write credentials are in separate trusted jobs',()=>{
 const source=fs.readFileSync('.github/workflows/auto-pr.yml','utf8');
 const check=source.split('  check:')[1].split('  apply:')[0],apply=source.split('  apply:')[1];
 assert(!check.includes('contents: write'));assert(apply.includes('contents: write'));assert(!apply.includes('playwright install'));
 assert(source.includes('persist-credentials: false'));assert(!source.includes('getCollaboratorPermissionLevel'));assert(source.includes('schedule:'));
});
