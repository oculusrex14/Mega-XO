/* Shared V3.3 tournament rules. No balances, sockets, or trusted client results. */
(function(root,factory){const api=factory(typeof module==='object'?require('./game.js'):root.MegaGame);if(typeof module==='object')module.exports=api;else root.MegaTournament=api;})(globalThis,G=>{
'use strict';
const VERSION='tournament-1', TABLES=Object.freeze({low:{name:'Low',currency:'coins',entry:100},medium:{name:'Medium',currency:'coins',entry:500},high:{name:'High',currency:'coins',entry:2000},premium:{name:'Premium',currency:'crowns',entry:500}});
const SHARES=Object.freeze([36,20,13,11,10,0,0,0,0,0]);
const copy=x=>structuredClone(x), fail=s=>{throw Error(s);};
const integer=(n,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
function prize(table){const t=TABLES[table];if(!t)fail('INVALID_TABLE');const pool=t.entry*10,payouts=SHARES.map(p=>pool*p/100);return {...t,table,seats:10,pool,burn:pool/10,payouts,net:payouts.map(p=>p-t.entry)};}
function create({id,code='',owner,name='Party',format='mixed',table=null,clock=180,increment=2,sequential=false,now=Date.now()}={}){
 if(!owner||!id||!['duel','league','knockout','mixed'].includes(format))fail('INVALID_ROOM');
 if(![0,120,180,300].includes(clock)||!integer(increment,0,3))fail('INVALID_CLOCK');
 if(table){prize(table);format='mixed';clock=120;increment=1;}
 return {version:VERSION,id,code,owner,name:String(name).trim().slice(0,48)||'Party',format,table,sequential:table?false:sequential===true,quote:table?prize(table):null,clock,increment:clock?increment:0,capacity:format==='duel'?2:10,rulesVersion:1,players:[],status:'LOBBY',created:now,expires:now+(table?300000:1800000),fixtures:[],groups:[],ranking:null,finalRefs:null,started:null,revision:0,roundDelay:table?15000:5000};
}
function member(r,id){return r.players.find(p=>p.id===id)||fail('NOT_IN_ROOM');}
function join(r,id,name,now=Date.now()){
 if(r.status!=='LOBBY'||now>=r.expires)fail('ROOM_CLOSED');if(r.players.some(p=>p.id===id))return;
 if(r.players.length>=r.capacity)fail('ROOM_FULL');if(!id||typeof name!=='string'||!name.trim()||name.length>32)fail('INVALID_NAME');
 r.players.push({id,name:name.trim(),ready:false,withdrawn:false});r.revision++;
}
function ready(r,id,value,version){if(r.status!=='LOBBY'||version!==r.rulesVersion||typeof value!=='boolean')fail('RULES_CHANGED');member(r,id).ready=value;r.revision++;}
function leave(r,id){member(r,id);if(r.status!=='LOBBY')fail('TOURNAMENT_STARTED');r.players=r.players.filter(p=>p.id!==id);if(r.owner===id)r.owner=r.players[0]?.id||null;if(!r.players.length)r.status='CANCELLED';r.revision++;}
function configure(r,id,changes){if(r.owner!==id||r.status!=='LOBBY'||r.table)fail('HOST_ONLY');const next=create({id:r.id,owner:id,...{format:r.format,clock:r.clock,increment:r.increment},...changes});if(r.players.length>next.capacity)fail('TOO_MANY_PLAYERS');for(const k of ['format','clock','increment','capacity'])r[k]=next[k];r.rulesVersion++;r.players.forEach(p=>p.ready=false);r.revision++;}
function slot(r,s){if(typeof s==='string')return s;const f=r.fixtures.find(f=>f.id===s.match);return f?.status==='DONE'?(s.result==='win'?f.winner:f.players.find(p=>p!==f.winner)):null;}
function ref(f,result){return {match:f.id,result};}
function fixture(r,a,b,label,{round=0,group=null,decisive=true}={}){const f={id:'g'+(r.fixtures.length+1),slots:[a,b],label,round,group,decisive,status:'BLOCKED',players:null,ready:[],state:null,winner:null,attempt:0,mini:{},history:[]};r.fixtures.push(f);return f;}
/* Circle schedule, with near-regular orientation: each player starts 4/5 games at ten seats. */
function roundRobin(ids){const ring=ids.slice();if(ring.length%2)ring.push(null);const out=[],mod=ids.length%2?ids.length:ids.length+1;for(let round=0;round<ring.length-1;round++){const games=[];for(let i=0;i<ring.length/2;i++){let a=ring[i],b=ring[ring.length-1-i];if(a!==null&&b!==null){if((ids.indexOf(b)-ids.indexOf(a)+mod)%mod>Math.floor(mod/2))[a,b]=[b,a];games.push([a,b]);}}out.push(games);ring.splice(1,0,ring.pop());}return out;}
/* Full placement bracket, not just a champion: all payout positions are actually decided. */
function bracket(r,slots,label){if(slots.length<=1)return slots;let power=1;while(power*2<=slots.length)power*=2;if(power!==slots.length){const n=slots.length-power,top=slots.slice(0,slots.length-2*n),tail=slots.slice(top.length),pre=[];for(let i=0;i<n;i++)pre.push(fixture(r,tail[i],tail[tail.length-1-i],label+' play-in'));return bracket(r,top.concat(pre.map(f=>ref(f,'win'))),label).concat(bracket(r,pre.map(f=>ref(f,'lose')),label+' placement'));}
 const first=[];for(let i=0;i<slots.length/2;i++)first.push(fixture(r,slots[i],slots[slots.length-1-i],label));return bracket(r,first.map(f=>ref(f,'win')),label+' winners').concat(bracket(r,first.map(f=>ref(f,'lose')),label+' placement'));
}
function start(r,actor,seed,now=Date.now()){
 if(r.status!=='LOBBY'||now>=r.expires)fail('ROOM_CLOSED');if(!r.table&&actor!==r.owner)fail('HOST_ONLY');
 const min=r.format==='mixed'?4:2;if(r.players.length<min||(r.table&&r.players.length!==10))fail('NOT_ENOUGH_PLAYERS');if(!r.players.every(p=>p.ready))fail('PLAYERS_NOT_READY');
 const ids=r.players.map(p=>p.id);if(!Array.isArray(seed)||seed.length!==ids.length||new Set(seed).size!==ids.length||seed.some(p=>!ids.includes(p)))fail('INVALID_SEED');
 r.seed=seed.slice();r.started=now;r.status='RUNNING';r.deadline=r.clock?now+(r.table?7200000:21600000):now+86400000;
 if(r.format==='duel')r.finalRefs=bracket(r,seed,'Private match');
 else if(r.format==='knockout')r.finalRefs=bracket(r,seed,'Knockout');
 else{const groups=r.format==='league'?[seed]:[seed.filter((_,i)=>i%4===0||i%4===3),seed.filter((_,i)=>i%4===1||i%4===2)];r.groups=groups.map((players,i)=>({id:'group'+i,name:r.format==='league'?'League':'Group '+(i?'B':'A'),players,refs:null}));for(const g of r.groups)roundRobin(g.players).forEach((round,i)=>round.forEach(([a,b])=>fixture(r,a,b,g.name+' - round '+(i+1),{group:g.id,round:i+1,decisive:false})));}
 r.revision++;advance(r,now);
}
function standings(r,g){const rows=g.players.map(id=>({id,points:0,wins:0,draws:0,losses:0,mini:0,forfeits:0,sb:0,head:0,played:0})),map=Object.fromEntries(rows.map(x=>[x.id,x]));const games=r.fixtures.filter(f=>f.group===g.id&&f.status==='DONE');for(const f of games){for(const id of f.players){const row=map[id],other=f.players.find(x=>x!==id);row.played++;row.mini+=(f.mini[id]||0)-(f.mini[other]||0);if(f.winner===id){row.points+=2;row.wins++;}else if(f.winner===null){row.points++;row.draws++;}else row.losses++;if(f.reason==='timeout'||f.reason==='resign'||f.reason==='no-show')if(f.winner!==id)row.forfeits++;}}
 for(const f of games)for(const id of f.players){const other=f.players.find(x=>x!==id),score=f.winner===null?1:f.winner===id?2:0;map[id].sb+=score*map[other].points;if(map[id].points===map[other].points)map[id].head+=score;}
 return rows.sort((a,b)=>b.points-a.points||b.head-a.head||b.sb-a.sb||b.mini-a.mini||a.forfeits-b.forfeits);
}
const tied=(a,b)=>['points','head','sb','mini','forfeits'].every(k=>a[k]===b[k]);
function groupRanks(r,g){if(!g.refs){const rows=standings(r,g),refs=[];for(let i=0;i<rows.length;){let j=i+1;while(j<rows.length&&tied(rows[i],rows[j]))j++;const ids=rows.slice(i,j).map(x=>x.id);refs.push(...(ids.length===1?ids:bracket(r,ids,g.name+' tie-break')));i=j;}g.refs=refs;}return g.refs.map(s=>slot(r,s));}
function advance(r,now){if(r.status!=='RUNNING')return;
 if(r.groups.length&&!r.finalRefs){const done=r.fixtures.filter(f=>f.group).every(f=>f.status==='DONE');if(done){const orders=r.groups.map(g=>groupRanks(r,g));if(orders.every(a=>a.every(Boolean))){if(r.format==='league')r.finalRefs=orders[0];else{const [a,b]=orders,one=fixture(r,a[0],b[1],'Semi-final 1'),two=fixture(r,b[0],a[1],'Semi-final 2');const final=fixture(r,ref(one,'win'),ref(two,'win'),'Final'),bronze=fixture(r,ref(one,'lose'),ref(two,'lose'),'Third-place game');r.finalRefs=[ref(final,'win'),ref(final,'lose'),ref(bronze,'win'),ref(bronze,'lose')];for(let i=2;i<Math.max(a.length,b.length);i++){if(a[i]&&b[i]){const f=fixture(r,a[i],b[i],'Places '+(2*i+1)+' / '+(2*i+2));r.finalRefs.push(ref(f,'win'),ref(f,'lose'));}else r.finalRefs.push(a[i]||b[i]);}}}}}
 for(const f of r.fixtures)if(f.status==='BLOCKED'){if(r.sequential&&r.fixtures.some(g=>g.status==='READY'||g.status==='PLAYING'))break;const players=f.slots.map(s=>slot(r,s));const prior=f.group&&r.fixtures.some(p=>p.group&&p.round<f.round&&p.status!=='DONE');if(players.every(Boolean)&&!prior){f.players=players;f.status='READY';f.opens=now+r.roundDelay;f.expires=f.opens+120000;}}
 if(r.finalRefs){const rank=r.finalRefs.map(s=>slot(r,s));if(rank.every(Boolean)){if(new Set(rank).size!==r.players.length)fail('INVALID_FINAL_RANKING');r.ranking=rank;r.status='COMPLETE';r.ended=now;}}
}
function findGame(r,id,actor){const f=r.fixtures.find(f=>f.id===id);if(!f||!f.players?.includes(actor))fail('NOT_MATCH_PLAYER');return f;}
function readyGame(r,id,actor,now){const f=findGame(r,id,actor);if(r.status!=='RUNNING'||f.status!=='READY'||now<f.opens||(!f.ready.length&&now>=f.expires)||(f.ready.length===1&&now>=f.readyDeadline))fail('MATCH_NOT_READY');if(!f.ready.includes(actor))f.ready.push(actor);if(f.ready.length===1)f.readyDeadline=now+45000;if(f.ready.length===2){f.status='PLAYING';f.state=G.create();f.banks={[f.players[0]]:r.clock,[f.players[1]]:r.clock};f.turnAt=now;f.attempt++;}r.revision++;}
function current(f){return f.players[f.state.turn==='X'?0:1];}
function remaining(r,f,now){if(!r.clock||!f.state)return null;return Math.max(0,f.banks[current(f)]-Math.max(0,((r.status==='PAUSED'?r.pausedAt:now)-f.turnAt)/1000));}
function finishGame(r,f,winner,reason,now){f.history.push({players:f.players.slice(),moves:copy(f.state?.moves||[]),winner,reason});if(f.state)for(const [i,p] of f.players.entries())f.mini[p]=(f.mini[p]||0)+f.state.mini.filter(x=>x===(i?'O':'X')).length;
 if(winner===null&&f.decisive){if(f.attempt>=3){r.status=r.table?'VOID':'PAUSED';r.reason='THREE_DRAWN_DECIDERS';r.pausedAt=now;r.drawGame=f.id;return;}f.players.reverse();f.state=null;f.status='READY';f.ready=[];f.opens=now+r.roundDelay;f.expires=f.opens+120000;delete f.readyDeadline;return;}
 f.winner=winner;f.reason=reason;f.status='DONE';f.finished=now;advance(r,now);
}
function move(r,id,actor,revision,m,now=Date.now()){const f=findGame(r,id,actor);if(r.status!=='RUNNING'||f.status!=='PLAYING')fail('MATCH_CLOSED');if(f.state.moves.length!==revision)fail('STALE_REVISION');if(current(f)!==actor)fail('NOT_YOUR_TURN');if(r.clock&&remaining(r,f,now)<=0)fail('TIME_EXPIRED');const next=G.apply(f.state,m);if(r.clock)f.banks[actor]=remaining(r,f,now)+r.increment;f.turnAt=now;f.state=next;r.revision++;if(next.winner)finishGame(r,f,next.winner==='DRAW'?null:f.players[next.winner==='X'?0:1],next.winner==='DRAW'?'draw':'line',now);}
function resign(r,id,actor,now=Date.now()){const f=findGame(r,id,actor);if(r.status!=='RUNNING'||!['PLAYING','READY'].includes(f.status))fail('MATCH_CLOSED');finishGame(r,f,f.players.find(p=>p!==actor),'resign',now);r.revision++;}
function tick(r,now=Date.now()){if(r.status==='LOBBY'&&now>=r.expires){r.status='CANCELLED';r.reason='LOBBY_EXPIRED';r.revision++;return;}if(r.status!=='RUNNING')return;if(now>=r.deadline){r.status='VOID';r.reason='EVENT_TIME_LIMIT';r.revision++;return;}for(const f of r.fixtures){if(r.status!=='RUNNING')break;if(f.status==='PLAYING'&&r.clock&&remaining(r,f,now)<=0){finishGame(r,f,f.players.find(p=>p!==current(f)),'timeout',now);r.revision++;}else if(f.status==='READY'&&f.ready.length===1&&now>=f.readyDeadline){finishGame(r,f,f.ready[0],'no-show',now);r.revision++;}else if(f.status==='READY'&&!f.ready.length&&now>=f.expires){r.status=r.table?'VOID':'PAUSED';r.reason='BOTH_PLAYERS_ABSENT';r.pausedAt=now;r.revision++;}}}
function pause(r,actor,now=Date.now()){if(r.table||actor!==r.owner||r.status!=='RUNNING')fail('HOST_ONLY');r.status='PAUSED';r.reason='HOST_PAUSED';r.pausedAt=now;r.revision++;}
function resume(r,actor,now=Date.now()){if(r.table||actor!==r.owner||r.status!=='PAUSED')fail('CANNOT_RESUME');const paused=now-r.pausedAt;r.deadline+=paused;for(const f of r.fixtures){if(f.status==='PLAYING')f.turnAt+=paused;if(f.status==='READY'){f.opens=now;f.expires=now+120000;if(f.ready.length)f.readyDeadline=now+45000;else delete f.readyDeadline;}}if(r.drawGame){const f=r.fixtures.find(f=>f.id===r.drawGame);f.players.reverse();f.status='READY';f.state=null;f.ready=[];f.attempt=0;f.opens=now;f.expires=now+120000;delete r.drawGame;}r.status='RUNNING';r.revision++;}
function view(r,now=Date.now()){const v=copy(r);v.serverNow=now;v.standings=r.groups.map(g=>({name:g.name,rows:standings(r,g)}));for(const f of v.fixtures)if(f.status==='PLAYING'){f.clock=remaining(r,f,now);f.deadline=r.clock?f.turnAt+f.banks[current(f)]*1000:null;}return v;}
return {VERSION,TABLES,SHARES,prize,create,join,ready,leave,configure,start,roundRobin,bracket,standings,readyGame,move,resign,tick,pause,resume,view,remaining,slot};
});
