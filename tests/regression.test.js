'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
const client=fs.readFileSync(path.join(__dirname,'..','public','app.js'),'utf8');
test('server and browser scripts parse',()=>{new Function(server);new Function(client);});
const from=(start,end)=>{const a=server.indexOf(start),b=server.indexOf(end,a);assert.ok(a>=0&&b>a,'Missing '+start);return server.slice(a,b);};
const stats=new Function(from('function postEngagement(','function resolveWinner(')+'return stats;')();
const owner={id:'player-a',token:'secret-a',name:'Same',bonus:{}};
const other={id:'player-b',token:'secret-b',name:'Same',bonus:{}};
const post=(round,likes=[],comments=[])=>({owner:owner.id,challengeRound:round,likes,comments});
test('comment spam counts once per player per post',()=>{const comments=Array.from({length:100},()=>({playerId:other.id,author:'Same'}));const score=stats({posts:[post(0,[],comments)]},owner);assert.equal(score.followers,170);});
test('identical names still earn points for different public IDs',()=>{const score=stats({posts:[post(0,[],[{playerId:other.id,author:'Same'}])]},owner);assert.equal(score.followers,170);});
test('self comments never count',()=>{const score=stats({posts:[post(0,[],[{playerId:owner.id,author:'Renamed'}])]},owner);assert.equal(score.followers,140);});
test('only two posts per round score and engagement is capped',()=>{const likes=Array.from({length:100},(_,i)=>'player-'+i);const comments=Array.from({length:100},(_,i)=>({playerId:'commenter-'+i}));const score=stats({posts:[post(0,likes,comments),post(0),post(0),post(1)]},owner);assert.equal(score.followers,2420);});
test('event and quick challenge arrays have correct sizes',()=>{const constants=from('const PROMPTS=','const PERSONAS=');const {makeChallenges,makePostPrompts}=new Function(constants+'return {makeChallenges,makePostPrompts};')();for(const duration of [15,30,60]){assert.equal(makeChallenges(duration,'quick').length,duration/5+1);assert.equal(makePostPrompts(duration,'quick').length,duration/5+1);}for(const duration of [120,240,360,480]){assert.equal(makeChallenges(duration,'event').length,duration/30);assert.equal(makePostPrompts(duration,'event').length,duration/30);}});
test('host reset uses a second tap',()=>{assert.match(client,/resetArmedUntil=now\+5000/);assert.match(client,/TAP AGAIN TO RESET/);});
test('uploads require an active player',()=>{assert.match(server,/p\.token===req\.body\?\.token/);assert.match(client,/fd\.append\('token',playerToken/);});
test('surprise announcements and scheduled event extensions exist',()=>{assert.match(server,/action==='surprise'/);assert.match(server,/r\.endsAt\+=extension\*60\*1000/);assert.match(client,/EXTEND 30 MINUTES/);});

test('free-plan media cap allows up to 250 MB per game',()=>{assert.match(server,/MAX_MEDIA_BYTES=250\*1024\*1024/);assert.match(server,/const mediaLimit=!PERSIST\?48\*1024\*1024:MAX_MEDIA_BYTES/);});
test('finished games delete Supabase files and keep the winner',()=>{assert.match(server,/async function deleteRoomMedia\(code\)/);assert.match(server,/async function finishRoomMedia\(r\)/);assert.match(server,/r\.status='done';r\.winner=resolveWinner\(r\)/);assert.match(server,/finishRoomMedia\(r\)\.catch/);assert.match(server,/for\(const post of r\.posts\)post\.media=null/);});
test('cleanup retries and removes expired rooms only after media deletion',()=>{assert.match(server,/if\(r\.status==='done'&&!r\.mediaCleanedAt\)await finishRoomMedia\(r\)/);assert.match(server,/await deleteRoomMedia\(row\.code\)/);});

test('host reset deletes prior media before clearing the room',()=>{assert.match(server,/r\.status='resetting';cleaningRooms\.add\(r\.code\)/);assert.match(server,/await deleteRoomMedia\(r\.code\)/);assert.match(server,/Could not delete previous game media/);});

test('best engagement posts per round are scored regardless of feed order',()=>{
 assert.match(server,/group\.sort\(\(a,b\)=>postEngagement\(b,p\)-postEngagement\(a,p\)/);
 assert.match(server,/\.slice\(0,2\)/);
});
test('per-game and shared active-room media limits include pending uploads',()=>{
 assert.match(server,/MAX_MEDIA_BYTES=250\*1024\*1024/);
 assert.match(server,/GLOBAL_MEDIA_BUDGET=900\*1024\*1024/);
 assert.match(server,/totalMediaBytes\(\)\+req\.file\.size>GLOBAL_MEDIA_BUDGET/);
 assert.match(server,/r\.mediaBytes\+reservedBytes\(r\.code\)\+req\.file\.size>mediaLimit/);
});
test('media cache lifetime and late upload deletion',()=>{
 assert.match(server,/private, max-age=3600/);
 assert.match(server,/The game ended while your media was uploading/);
 assert.match(server,/prefixes:\[r\.code\+'\/'\+id\]/);
});
test('photo souvenir download is available before media cleanup',()=>{
 assert.match(client,/function saveSouvenir\(/);
 assert.match(client,/SAVE MY BEST POST/);
 assert.match(client,/canvas\.toDataURL\('image\/png'\)/);
});

test('third low-engagement post never displaces earlier popular posts',()=>{const popular=post(0,['player-b','player-c']),second=post(0,['player-d']),third=post(0);const before=stats({posts:[second,popular]},owner).followers;const after=stats({posts:[third,second,popular]},owner).followers;assert.equal(after,before);});
