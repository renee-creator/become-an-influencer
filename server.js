const express=require('express'),http=require('http'),{Server}=require('socket.io'),multer=require('multer'),path=require('path'),fs=require('fs'),QRCode=require('qrcode'),{randomUUID}=require('crypto');
const app=express(),server=http.createServer(app),io=new Server(server,{maxHttpBufferSize:12e6});
app.use(express.static(path.join(__dirname,'public')));app.use(express.json());
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024},fileFilter:(req,f,cb)=>{const allowed=/^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime))$/.test(f.mimetype);cb(allowed?null:new Error('Unsupported file type'),allowed);}});
const MAX_MEDIA_BYTES=48*1024*1024;

const SB_URL=(()=>{try{const raw=(process.env.SUPABASE_URL||'').trim();const u=new URL(raw);if(u.protocol!=='https:'||!u.hostname.endsWith('.supabase.co'))throw Error('Invalid Supabase project URL');return u.origin;}catch(e){console.error('Invalid SUPABASE_URL configuration:',e.message);return '';}})();
const SB_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY||'';
const PERSIST=!!(SB_URL&&SB_KEY);
async function sb(url,options={}){
 const response=await fetch(SB_URL+url,{...options,headers:{apikey:SB_KEY,...(SB_KEY.startsWith('eyJ')?{Authorization:'Bearer '+SB_KEY}:{}),...options.headers}});
 if(!response.ok)throw Error('Supabase '+response.status+': '+(await response.text()).slice(0,200));
 return response;
}
const saves=new Map();
function migrateRoom(r){const previous=new Map();for(const p of r.players||[]){const old=p.id;if(!p.id||!p.id.startsWith('player-'))p.id='player-'+randomUUID();previous.set(old,p.id);previous.set(p.token,p.id);}for(const post of r.posts||[]){if(previous.has(post.owner))post.owner=previous.get(post.owner);post.likes=(post.likes||[]).map(id=>previous.get(id)||id);for(const comment of post.comments||[]){if(comment.playerId)comment.playerId=previous.get(comment.playerId)||comment.playerId;else{const matches=(r.players||[]).filter(p=>p.name===comment.author);if(matches.length===1)comment.playerId=matches[0].id;}}}for(const [voter,target] of Object.entries(r.finalVotes||{})){const voterId=previous.get(voter)||voter,targetId=previous.get(target)||target;delete r.finalVotes[voter];if(voterId!==targetId)r.finalVotes[voterId]=targetId;}}

function saveRoom(r){
 if(!PERSIST)return Promise.resolve();
 const state={...r,media:undefined,mediaBytes:undefined};
 const prior=saves.get(r.code)||Promise.resolve();
 const task=prior.catch(()=>{}).then(()=>sb('/rest/v1/influencer_games?on_conflict=code',{method:'POST',headers:{'Content-Type':'application/json',Prefer:'resolution=merge-duplicates'},body:JSON.stringify({code:r.code,state,created_at:new Date(r.createdAt).toISOString(),expires_at:new Date(r.expiresAt).toISOString()})})).catch(e=>{console.error('Save failed',r.code,e.message);throw e;});
 saves.set(r.code,task);
 task.then(()=>{if(saves.get(r.code)===task)saves.delete(r.code);},()=>{if(saves.get(r.code)===task)saves.delete(r.code);});
 return task;
}
async function restoreRooms(){
 if(!PERSIST){console.warn('Supabase not configured; rooms are temporary');return;}
 try{
  const q='/rest/v1/influencer_games?select=code,state,expires_at&expires_at=gt.'+encodeURIComponent(new Date().toISOString())+'&limit=200';
  for(const row of await (await sb(q)).json()){
   const r=row.state;if(!r||!r.code)continue;
   r.media=new Map();r.mediaBytes=0;r.createdAt=r.createdAt||Date.now();r.expiresAt=Date.parse(row.expires_at);
   migrateRoom(r);rooms.set(r.code,r);
  }
  console.log('Restored '+rooms.size+' games');
 }catch(e){console.error('Room restoration failed',e.message);}
}
async function purgeExpired(){
 const now=Date.now();
 for(const [code,r] of rooms)if(r.expiresAt<=now){rooms.delete(code);io.to(code).emit('expired');}
 if(!PERSIST)return;
 try{
  const q='/rest/v1/influencer_games?select=code&expires_at=lte.'+encodeURIComponent(new Date().toISOString());
  const rows=await (await sb(q)).json();
  for(const row of rows){
   const response=await sb('/storage/v1/object/list/game-media',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefix:row.code+'/',limit:1000})});
   const objects=await response.json();
   if(objects.length)await sb('/storage/v1/object/game-media',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefixes:objects.map(o=>row.code+'/'+o.name)})});
  }
  await sb('/rest/v1/influencer_games?expires_at=lte.'+encodeURIComponent(new Date().toISOString()),{method:'DELETE'});
 }catch(e){console.error('Cleanup failed',e.message);}
}

const PROMPTS=[
['Create a lifestyle brand around your most questionable habit.','Introduce your influencer persona and invent a wildly specific niche.','Announce your rise to fame with a completely unnecessary origin story.','Reveal the bizarre daily ritual that makes you iconic.','Launch a personal brand built around something nobody asked for.','Introduce your followers to your absurd signature catchphrase.'],
['Pitch a wellness trend with absolutely no scientific basis.','Promote an overpriced product that solves an imaginary problem.','Invent a sponsorship for the least glamorous object in your home.','Announce a luxury collaboration with an unlikely brand.','Sell your followers a premium version of something free.','Post a dramatic unboxing of an ordinary household item.'],
['Issue an apology for a scandal you accidentally created.','Start a petty feud with another influencer over something trivial.','Reveal a shocking secret about your fake influencer lifestyle.','Announce a collaboration with a rival, then make it awkward.','Respond to a ridiculous rumor about your brand.','Stage a dramatic comeback after a completely avoidable controversy.'],
['Launch a questionable masterclass and defend its price.','Post a desperate attempt to go viral before your fame fades.','Announce a rebrand that contradicts everything you said earlier.','Share an emotional statement about losing a fictional sponsorship.','Invent a new trend and insist you started it.','Reveal the outrageous product your fans have been begging for.']
];
const INTRO_CHALLENGE='Introduce yourself to the feed. Who are you, what is your influencer niche, and why should everyone follow you? Publish your first post.';
function makeChallenges(duration){const count=duration/5;const used=new Set();const result=[INTRO_CHALLENGE];for(let i=0;i<count;i++){const pool=PROMPTS[Math.min(3,Math.floor(i*4/count))].filter(p=>!used.has(p));const choice=pool[Math.floor(Math.random()*pool.length)];used.add(choice);result.push(choice);}return result;}
const POST_PROMPTS=["Post a behind-the-scenes update about your influencer routine.","Share a sponsored confession about an ordinary product.","Make a dramatic announcement about your personal brand.","Post a humblebrag disguised as gratitude.","Ask followers to settle a silly debate.","Reveal your unusual morning routine.","Share a playful rumor about your fictional fame.","Post a polite response to a rival influencer.","Announce a giveaway with an amusing prize.","Share a fictional message from your management team.","Announce a short social media break.","Write an apology for an imaginary misunderstanding.","Reveal your newest fictional brand partnership.","Ask fans to name a new product.","Show off an unnecessary luxury purchase.","Describe a household object as your new personality.","Ask other influencers to collaborate.","Share an inspirational quote about fame.","Respond to a rival copying your style.","Invent funny rules for your fan club.","Start a silly hashtag challenge.","Announce an unexpected limited-edition product.","Share a staged candid moment.","Explain your latest fictional viral post."];
function makePostPrompts(duration){return ['Write your first introduction post. Tell the feed who you are, what you post about, and why people should follow you.',...[...POST_PROMPTS].sort(()=>Math.random()-.5).slice(0,duration/5)];}
const PERSONAS=['Beauty Guru','Wellness Expert','Lifestyle Influencer','Fitness Personality','Family Vlogger','Luxury Influencer','Conspiracy Creator','Aspiring Celebrity'];
const BASE={followers:100,credibility:50,earnings:0,notoriety:0};
function stats(r,p){const posts=r.posts.filter(x=>x.owner===p.id||x.owner===p.token),likes=posts.reduce((n,x)=>n+(x.likes||[]).filter(id=>id!==p.id&&id!==p.token).length,0),comments=posts.reduce((n,x)=>n+new Set((x.comments||[]).map(c=>c.playerId).filter(id=>id&&id!==p.id)).size,0);return {followers:Math.max(0,100+posts.length*40+likes*80+comments*30+(p.bonus?.followers||0)),credibility:Math.max(0,Math.min(100,50+likes*3+comments-posts.length*2+(p.bonus?.credibility||0))),earnings:Math.max(0,posts.length*25+likes*15+comments*5+(p.bonus?.earnings||0)),notoriety:Math.max(0,posts.length*5+likes*4+comments*2+(p.bonus?.notoriety||0))};}
function resolveWinner(r){const tally={};for(const id of Object.values(r.finalVotes))tally[id]=(tally[id]||0)+1;return [...r.players].sort((a,b)=>(tally[b.id]||0)-(tally[a.id]||0)||stats(r,b).followers-stats(r,a).followers||a.id.localeCompare(b.id))[0]?.name||null;}
const EVENTS=[
{title:'A BRAND WANTS YOU',body:'A suspicious energy drink offers a paid partnership. Do you take the money?',options:[{label:'TAKE THE DEAL',delta:{earnings:450,followers:120,credibility:-14,notoriety:10}},{label:'TURN IT DOWN',delta:{credibility:14,followers:35}}]},
{title:'YOU ARE GETTING CANCELED',body:'An old fictional post resurfaces. Your publicist is panicking.',options:[{label:'ISSUE AN APOLOGY',delta:{credibility:12,followers:-35,notoriety:-8}},{label:'DOUBLE DOWN',delta:{followers:180,credibility:-20,notoriety:25}}]},
{title:'THE COLLAB OFFER',body:'A rival wants to film a suspiciously staged friendship video.',options:[{label:'COLLABORATE',delta:{followers:180,earnings:125,credibility:5}},{label:'START A FEUD',delta:{followers:220,notoriety:25,credibility:-12}}]},
{title:'A LUXURY SPONSOR CALLS',body:'They will pay you to endorse an expensive invisible product.',options:[{label:'SIGN THE CONTRACT',delta:{earnings:600,followers:80,credibility:-12}},{label:'EXPOSE THE BRAND',delta:{followers:160,credibility:12,notoriety:12}}]},
{title:'THE ALGORITHM CHANGES',body:'Your engagement is dropping. Time for a desperate pivot.',options:[{label:'REBRAND COMPLETELY',delta:{followers:150,credibility:-8,notoriety:10}},{label:'STAY AUTHENTIC',delta:{credibility:16,followers:-30}}]},
{title:'YOUR FAN CLUB REVOLTS',body:'Fans demand an explanation for your latest imaginary controversy.',options:[{label:'GO LIVE AND EXPLAIN',delta:{credibility:15,followers:45}},{label:'POST A CRYPTIC STORY',delta:{followers:130,notoriety:20,credibility:-10}}]}
];
const PERSONA_BONUS={'Beauty Guru':{earnings:50},'Wellness Expert':{credibility:8},'Lifestyle Influencer':{followers:70},'Fitness Personality':{credibility:6,followers:35},'Family Vlogger':{credibility:10},'Luxury Influencer':{earnings:125},'Conspiracy Creator':{notoriety:15,followers:75},'Aspiring Celebrity':{followers:100}};
function eventFor(r){return EVENTS[(r.eventSeed+r.round)%EVENTS.length];}
function addStats(p,delta){for(const [k,v] of Object.entries(delta)){p.bonus[k]=(p.bonus[k]||0)+v;}}
const rooms=new Map();
const sessions=new Map();
const MAX_ROOMS=200;
const ROOM_TTL=24*60*60*1000;
setInterval(()=>{purgeExpired().catch(console.error);},60*60*1000).unref();const generateCode=()=>Math.random().toString(36).slice(2,8).toUpperCase();
const safe=s=>String(s||'').slice(0,300);
function emit(r,changed=true){r.lastActivity=Date.now();if(changed)saveRoom(r).catch(()=>{});io.to(r.code).emit('state',{code:r.code,status:r.status,players:r.players.map(p=>({id:p.id,name:p.name,persona:p.persona,stats:stats(r,p),eventRounds:p.eventRounds||[]})),posts:r.posts.map(post=>({...post,owner:post.owner?.startsWith('player-')?post.owner:(r.players.find(p=>p.token===post.owner)?.id||(post.owner==='system'?'system':null)),likes:(post.likes||[]).map(id=>r.players.find(p=>(p.token===id||p.id===id))?.id||null).filter(Boolean)})),challenges:r.challenges,postPrompts:r.postPrompts,round:r.round,duration:r.duration,endsAt:r.endsAt,roundEndsAt:r.roundEndsAt||0,finalVotes:Object.keys(r.finalVotes||{}).length,winner:r.status==='done'?r.winner:null,event:r.status==='live'?{title:eventFor(r).title,body:eventFor(r).body,options:eventFor(r).options.map(x=>({label:x.label}))}:null,voteEndsAt:r.voteEndsAt||0});}
app.post('/api/create',async(req,res)=>{const duration=[15,30,60].includes(Number(req.body?.duration))?Number(req.body.duration):15;if(rooms.size>=MAX_ROOMS)return res.status(503).json({error:'Room capacity reached'});let c;do{c=generateCode()}while(rooms.has(c));let key=generateCode()+generateCode();const r={code:c,key,createdAt:Date.now(),expiresAt:Date.now()+ROOM_TTL,lastActivity:Date.now(),players:[],posts:[{id:'WELCOME',author:'THE ALGORITHM',persona:'Official account',owner:'system',text:'Welcome to the feed. Build your following, post your most convincing influencer content, and see who survives the algorithm. Your fifteen minutes start now. ✨',media:null,likes:[],comments:[],created:Date.now(),pinned:true}],duration,challenges:makeChallenges(duration),postPrompts:makePostPrompts(duration),round:0,status:'lobby',endsAt:0,roundEndsAt:0,finalVotes:{},winner:null,media:new Map(),mediaBytes:0,eventSeed:Math.floor(Math.random()*EVENTS.length),voteEndsAt:0};rooms.set(c,r);try{await saveRoom(r);res.json({code:c,key});}catch(e){rooms.delete(c);res.status(503).json({error:'Could not save the new room. Please try again.'});}});
app.get('/api/room/:code',(req,res)=>{const r=rooms.get(String(req.params.code).toUpperCase());res.set('Cache-Control','no-store');res.status(r?200:404).json(r?{ok:true,code:r.code,status:r.status,players:r.players.length}:{ok:false,error:'Room not found on this server. Create a new room from the host page.'});});
app.get('/api/qr/:code',async(req,res)=>{const r=rooms.get(req.params.code.toUpperCase());if(!r)return res.sendStatus(404);res.type('png').send(await QRCode.toBuffer((process.env.RENDER_EXTERNAL_URL||('https://'+req.get('host')))+'/?room='+r.code));});

app.get('/api/media/:code/:id',async(req,res)=>{
 const code=String(req.params.code).toUpperCase(),id=String(req.params.id);
 const r=rooms.get(code);if(!r||!/^[A-Z0-9]+$/.test(id))return res.sendStatus(404);
 if(!PERSIST){const m=r.media.get(id);if(!m)return res.sendStatus(404);res.type(m.type).send(m.data);return;}
 try{const response=await sb('/storage/v1/object/authenticated/game-media/'+code+'/'+id);
  res.set({'Cache-Control':'private, max-age=86400, immutable','Content-Type':response.headers.get('content-type')||'application/octet-stream','X-Content-Type-Options':'nosniff'});
  res.send(Buffer.from(await response.arrayBuffer()));
 }catch(e){res.status(404).send('Media unavailable');}
});
app.post('/api/upload/:code',(req,res)=>{upload.single('media')(req,res,async err=>{
 if(err)return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'File too large. Maximum 8 MB.':err.message});
 const r=rooms.get(String(req.params.code).toUpperCase());if(!r)return res.status(404).json({error:'Game no longer active'});
 if(!req.file)return res.status(400).json({error:'Select a photo or video (8 MB max).'});
 if(r.mediaBytes+req.file.size>MAX_MEDIA_BYTES)return res.status(413).json({error:'Room media limit reached (48 MB).'});
 const id=generateCode()+generateCode();
 try{
  if(PERSIST)await sb('/storage/v1/object/game-media/'+r.code+'/'+id,{method:'POST',headers:{'Content-Type':req.file.mimetype},body:req.file.buffer});
  else r.media.set(id,{type:req.file.mimetype,data:req.file.buffer});
  r.mediaBytes+=req.file.size;
  res.json({url:'/api/media/'+r.code+'/'+id,type:req.file.mimetype.startsWith('video/')?'video':'image'});
 }catch(e){console.error('Upload failed',e.message);res.status(503).json({error:'Media storage unavailable. '+(e.message.startsWith('Supabase ')?e.message:'Connection error: '+e.message).slice(0,260)});}
 });});
io.on('connection',socket=>{
socket.on('join',({code,name,token,persona},reply)=>{const r=rooms.get(safe(code).toUpperCase());if(!r)return reply({error:'Game not found'});const n=safe(name).trim().slice(0,28);const chosen=PERSONAS.includes(persona)?persona:'Lifestyle Influencer';if(!n)return reply({error:'Enter a name'});if(r.players.length>=100&&!r.players.some(x=>x.token===token))return reply({error:'Room full'});socket.join(r.code);socket.data.room=r.code;socket.data.name=n;let p=token&&r.players.find(x=>x.token===token);if(p){p.name=n;p.persona=p.persona||chosen;p.bonus=p.bonus||{...PERSONA_BONUS[p.persona]};}else{token=generateCode()+generateCode()+generateCode();p={id:'player-'+randomUUID(),name:n,token,persona:chosen,bonus:{...PERSONA_BONUS[chosen]},eventRounds:[]};r.players.push(p);}socket.data.token=token;reply({ok:true,id:p.id,token});emit(r);});
socket.on('watch',({code},reply)=>{const r=rooms.get(safe(code).toUpperCase());if(!r)return reply?.({error:'Game not found'});socket.join(r.code);reply?.({ok:true});emit(r,false);});
socket.on('host',({code,key,action},reply)=>{const r=rooms.get(safe(code).toUpperCase());if(!r||r.key!==key)return reply?.({error:'Invalid host key'});if(action==='final'&&r.status!=='live')return reply?.({error:'Start the game before opening the final vote.'});if(action==='start'&&r.status==='lobby'){r.status='live';r.round=0;r.endsAt=Date.now()+(r.duration+5)*60*1000;r.roundEndsAt=Date.now()+5*60*1000;}if(action==='next'&&r.status==='live'){r.round=Math.min(r.round+1,r.challenges.length-1);r.roundEndsAt=Math.min(r.endsAt,Date.now()+5*60*1000);}if(action==='final'&&r.status==='live'){r.status='final';r.roundEndsAt=0;r.voteEndsAt=Date.now()+90*1000;}if(action==='reset'){r.status='lobby';r.round=0;r.roundEndsAt=0;r.endsAt=0;r.challenges=makeChallenges(r.duration);r.postPrompts=makePostPrompts(r.duration);r.posts=[{id:'WELCOME',author:'THE ALGORITHM',persona:'Official account',owner:'system',text:'Welcome to the feed. Build your following, post your most convincing influencer content, and see who survives the algorithm. Your fifteen minutes start now. ✨',media:null,likes:[],comments:[],created:Date.now(),pinned:true}];r.media=new Map();r.mediaBytes=0;r.finalVotes={};r.winner=null;r.voteEndsAt=0;r.eventSeed=Math.floor(Math.random()*EVENTS.length);for(const p of r.players){p.bonus={...PERSONA_BONUS[p.persona]};p.eventRounds=[];}}emit(r);reply?.({ok:true});});
socket.on('eventChoice',({choice},reply)=>{const r=rooms.get(socket.data.room);const p=r?.players.find(x=>x.token===socket.data.token);if(!r||r.status!=='live'||!p)return reply?.({error:'Game not active'});p.eventRounds=p.eventRounds||[];if(p.eventRounds.includes(r.round))return reply?.({error:'Already decided this round'});const opt=eventFor(r).options[Number(choice)];if(!opt)return reply?.({error:'Invalid choice'});p.eventRounds.push(r.round);addStats(p,opt.delta);emit(r);reply?.({ok:true});});
socket.on('post',({text,media},reply)=>{const r=rooms.get(socket.data.room);if(!r||r.status!=='live'||!r.players.some(p=>p.token===socket.data.token))return reply?.({error:'Game not live'});const t=safe(text).trim();if(!t&&!media)return reply?.({error:'Add text or media'});if(media&&(!String(media.url||'').startsWith('/api/media/'+r.code+'/')||!['image','video'].includes(media.type)))return reply?.({error:'Invalid media'});if(media&&!PERSIST&&!r.media.has(String(media.url).split('/').pop()))return reply?.({error:'Uploaded media expired. Please select it again.'});r.posts.unshift({id:generateCode()+generateCode(),author:socket.data.name,persona:r.players.find(p=>p.token===socket.data.token)?.persona||'Influencer',owner:r.players.find(p=>p.token===socket.data.token).id,text:t,media:media||null,likes:[],comments:[],challengeRound:r.round,created:Date.now()});emit(r);reply?.({ok:true});});
socket.on('like',({id})=>{const r=rooms.get(socket.data.room);if(!r||r.status!=='live'||!socket.data.token)return;const p=r.posts.find(x=>x.id===id);if(!p)return;const publicId=r.players.find(x=>x.token===socket.data.token)?.id;if(!publicId)return;p.likes.includes(publicId)?p.likes=p.likes.filter(x=>x!==publicId):p.likes.push(publicId);emit(r);});
socket.on('comment',({id,text},reply)=>{
 const r=rooms.get(socket.data.room);
 if(!r||r.status!=='live'||!socket.data.token)return reply?.({error:'Game not active'});
 const post=r.posts.find(p=>p.id===id);
 const message=String(text||'').trim().slice(0,240);
 if(!post||!message)return reply?.({error:'Write a comment first'});
 if((post.comments||[]).length>=100)return reply?.({error:'Comment limit reached'});
 post.comments=post.comments||[];
 const commenter=r.players.find(p=>p.token===socket.data.token);if(!commenter)return reply?.({error:'Player not found'});
 post.comments.push({id:generateCode()+generateCode(),author:commenter.name,playerId:commenter.id,text:message,created:Date.now()});
 emit(r);reply?.({ok:true});
});
socket.on('vote',({id},reply)=>{const r=rooms.get(socket.data.room);if(!r||r.status!=='final'||!r.players.some(x=>x.id===id)||!r.players.some(x=>x.token===socket.data.token))return reply?.({error:'Invalid vote'});const voter=r.players.find(p=>p.token===socket.data.token);if(id===voter.id)return reply?.({error:'You cannot vote for yourself'});r.finalVotes[voter.id]=id;r.winner=null;emit(r);reply?.({ok:true});});
socket.on('disconnect',()=>{const r=rooms.get(socket.data.room);if(!r)return;emit(r,false);});
});
setInterval(()=>{const now=Date.now();for(const r of rooms.values()){if(r.status==='final'&&now>=r.voteEndsAt){r.status='done';r.winner=resolveWinner(r);emit(r);continue;}if(r.status!=='live')continue;if(now>=r.endsAt){r.status='final';r.roundEndsAt=0;r.voteEndsAt=now+90*1000;emit(r);}else if(now>=r.roundEndsAt){if(r.round<r.challenges.length-1){r.round++;r.roundEndsAt=Math.min(r.endsAt,now+5*60*1000);emit(r);}else{r.status='final';r.roundEndsAt=0;r.voteEndsAt=now+90*1000;emit(r);}}}},1000).unref();
async function verifySupabase(){
 if(!PERSIST){console.error('Supabase check: missing or invalid configuration');return;}
 for(const [label,endpoint] of [['database','/rest/v1/influencer_games?select=code&limit=1'],['storage','/storage/v1/bucket/game-media']]){
  try{await sb(endpoint);console.log('Supabase '+label+' connection OK');}
  catch(e){console.error('Supabase '+label+' connection FAILED:',e.message);}
 }
}
app.get('/health',(req,res)=>res.json({ok:true}));
app.get('/health/supabase',async(req,res)=>{
 const checks={configured:PERSIST,urlValid:!!SB_URL,database:'not checked',storage:'not checked'};
 if(!PERSIST)return res.status(503).json({ok:false,checks});
 async function check(path){
  try{const r=await sb(path);return r.status===200?'ok':'ok';}
  catch(e){return e.message.startsWith('Supabase ')?e.message.slice(0,200):'Network connection failed: '+e.message;}
 }
 [checks.database,checks.storage]=await Promise.all([
  check('/rest/v1/influencer_games?select=code&limit=1'),
  check('/storage/v1/bucket/game-media')
 ]);
 const ok=checks.database==='ok'&&checks.storage==='ok';
 res.status(ok?200:503).json({ok,checks});
});restoreRooms().then(()=>purgeExpired()).finally(()=>server.listen(process.env.PORT||3000,()=>{console.log('Influencer beta listening');verifySupabase().catch(e=>console.error('Supabase diagnostic failed:',e.message));}));
