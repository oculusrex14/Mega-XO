/* V3.3 party authority. Use the SAME SQLite path as DurableStore for competitive events.
   Authentication and account eligibility are server-authoritative, never player JSON.
   P01: every room command, tick and recovery runs inside the shared unit of work
   (packages/db). Room JSON, party_command outcome and the economic graph share one
   transaction scope on this connection; nested economic calls borrow that scope. */
'use strict';
const MM=require('../packages/domain/matchmaking.js'),ABUSE=require('../packages/domain/abuse.js');
const {DatabaseSync}=require('node:sqlite'),crypto=require('node:crypto'),T=require('../src/tournament.js');
const {createSqliteUnitOfWork}=require('../packages/db');
const {currentScope,getRepositories}=require('../packages/db/context');
const clone=x=>structuredClone(x),hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const err=s=>{throw Error(s);}, safe=n=>{if(!Number.isSafeInteger(n)||n<0)err('INVALID_BALANCE');return n;};
const {PARTY_COMMANDS}=require('../packages/db/scopes');
class RoomStore{
 constructor(path,{lanOnly=false,now=()=>Date.now()}={}){
  this.lanOnly=lanOnly;this.now=now;
  this.db=new DatabaseSync(path);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS party_rooms(id TEXT PRIMARY KEY,code TEXT UNIQUE NOT NULL,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS party_commands(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response TEXT NOT NULL); CREATE TABLE IF NOT EXISTS party_guests(token TEXT PRIMARY KEY,actor TEXT UNIQUE NOT NULL,name TEXT NOT NULL,expires INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS party_status ON party_rooms(json_extract(json,\'$.status\'));');
  this.uow=createSqliteUnitOfWork(this.db,{now,begin:'BEGIN IMMEDIATE'});
 }
 /* Existing room/economy transaction seam: the shared unit of work. */
 tx(fn){return this.uow.run(fn);}
 repositories(){return getRepositories(this.db,{now:this.now,begin:'BEGIN IMMEDIATE'});}
 guest(name){if(!this.lanOnly)err('GUESTS_NOT_ALLOWED');if(typeof name!=='string'||!name.trim()||name.length>32)err('INVALID_NAME');const token=crypto.randomBytes(32).toString('base64url'),actor=crypto.randomUUID();this.db.prepare('DELETE FROM party_guests WHERE expires<?').run(this.now());if(this.db.prepare('SELECT COUNT(*) n FROM party_guests').get().n>=200)err('SESSION_LIMIT');this.db.prepare('INSERT INTO party_guests VALUES(?,?,?,?)').run(hash(token),actor,name.trim(),this.now()+86400000);return {token,actor,name:name.trim()};}
 authenticate(token){if(!this.lanOnly||typeof token!=='string')return null;return this.db.prepare('SELECT actor,name FROM party_guests WHERE token=? AND expires>?').get(hash(token),this.now())||null;}
 all(){return this.repositories().tournaments.rooms();}
 active(){return this.repositories().tournaments.activeRooms();}
 get(id){const room=this.repositories().tournaments.room(id);if(!room)err('ROOM_NOT_FOUND');return room;}
 /* Legacy room-row seam. Inside a unit of work it is the scoped repository write
  * (one transaction with the economy graph and the outcome); the source's plain
  * outside-transaction callers keep their existing autocommit behavior instead of
  * a new failure. Product mutations always run inside run/tick/recover. */
 save(r){
  if(currentScope(this.db))return this.repositories().tournaments.save(r);
  this.db.prepare('INSERT INTO party_rooms VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(r.id,r.code,JSON.stringify(r));
  return r.id;
 }
 /* Economic graph of the current unit of work (or a fresh hydrate outside one). */
 economy(){return this.repositories().state.read();}
 account(e,id){return e.accounts.find(([key])=>key===id)?.[1]||err('ACCOUNT_REQUIRED');}
 /* Persist the raw economic record through the shared unit of work. The cached
  * domain graph of the open scope is invalidated so a later participant of the
  * same transaction re-reads the row it just wrote. */
 writeEconomy(e){return this.repositories().state.write(e);}
 eligible(e,id,q){const a=this.account(e,id);if(a.verified!==true||a.suspended||a.hold||a.games<10)err('INELIGIBLE');return a;}
 code(){let c;do{c=crypto.randomBytes(5).toString('hex').toUpperCase();}while(this.repositories().tournaments.codeExists(c));return c;}
 shuffle(ids){const a=ids.slice();for(let i=a.length-1;i>0;i--){const j=crypto.randomInt(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;}
 journal(e,id,actor,currency,amount,reason){e.journal.push({id,actor,currency,amount,reason,source:'tournament',at:this.now()});}
 recordTournament(a,place,table){const t=a.tournamentRecord||(a.tournamentRecord={entered:0,wins:0,runnerUp:0,top3:0,top5:0,bestFinish:null,finishSum:0,premiumWins:0});t.entered=safe(t.entered+1);t.finishSum=safe(t.finishSum+place);if(place===1){t.wins=safe(t.wins+1);if(table==='premium')t.premiumWins=safe(t.premiumWins+1);}if(place===2)t.runnerUp=safe(t.runnerUp+1);if(place<=3)t.top3=safe(t.top3+1);if(place<=5)t.top5=safe(t.top5+1);t.bestFinish=t.bestFinish===null||t.bestFinish===undefined?place:Math.min(t.bestFinish,place);}
 reserve(r,e){const q=clone(r.quote),held=q.currency==='coins'?'reservedCoins':'reservedCrowns',players=r.players.map(p=>this.eligible(e,p.id,q));
  if(players.some(p=>p.activeMatch))err('ALREADY_IN_MATCH');if(Math.max(...players.map(p=>p.rating))-Math.min(...players.map(p=>p.rating))>MM.CONFIG.tournament.hardMax)err('SKILL_WINDOW_CHANGED');
  for(const p of players){if(p[q.currency]<q.entry)err('INSUFFICIENT_'+q.currency.toUpperCase());safe(p[held]+q.entry);}
  r.escrow=q.pool;r.quote=q;r.settled=false;r.contributions=players.map(p=>({id:p.id,amount:q.entry}));
  for(const p of players){p[q.currency]-=q.entry;p[held]+=q.entry;p.activeMatch='tournament:'+r.id;this.journal(e,r.id+':reserve:'+p.id,p.id,q.currency,-q.entry,'Tournament entry reserved');}
 }
 settle(r,e){if(!r.table||r.settled||!['COMPLETE','VOID','CANCELLED'].includes(r.status)||!r.escrow)return;
  const q=r.quote,c=q.currency,held=c==='coins'?'reservedCoins':'reservedCrowns',refund=r.status!=='COMPLETE';
  if(!refund&&r.ranking.some(id=>this.account(e,id).hold||this.account(e,id).suspended)){r.status='REVIEW';r.reason='ACCOUNT_REVIEW';return;}
  if(!refund&&(r.ranking.length!==10||new Set(r.ranking).size!==10))err('INVALID_FINAL_RANKING');
  const payouts=refund?r.contributions.map(p=>({id:p.id,amount:p.amount})):r.ranking.map((id,i)=>({id,amount:q.payouts[i]}));
  for(const p of payouts)safe(this.account(e,p.id)[c]+p.amount);if(!refund)safe(e.burned[c]+q.burn);
  for(const p of r.contributions){const a=this.account(e,p.id);if(a[held]<p.amount)err('ESCROW_MISMATCH');a[held]-=p.amount;if(a.activeMatch==='tournament:'+r.id)a.activeMatch=null;}
  for(const p of payouts){const a=this.account(e,p.id);a[c]+=p.amount;this.journal(e,r.id+(refund?':refund:':':payout:')+p.id,p.id,c,p.amount,refund?'Tournament entry refunded':'Tournament placement payout');}
  if(!refund){e.burned[c]+=q.burn;r.ranking.forEach((id,i)=>this.recordTournament(this.account(e,id),i+1,r.table));}r.receipt={currency:c,pool:r.escrow,burn:refund?0:q.burn,payouts,refunded:refund};r.escrow=0;r.settled=true;
  if(refund){r.riskFlags=[];delete r._riskActors;}else{const abuse=ABUSE.tournamentSignals(r);r.riskFlags=abuse.flags;r._riskActors=abuse.actors;}
 }
 view(id,actor){const r=this.get(id);if(!r.players.some(p=>p.id===actor))err('NOT_IN_ROOM');return T.view(r,this.now());}
 run(principal,key,command){
  if(!principal||typeof principal.actor!=='string'||!principal.actor)err('AUTH_REQUIRED');if(typeof key!=='string'||!key||key.length>160||!command)err('INVALID_COMMAND');
  const actor=principal.actor,cmd=clone(command),op=JSON.stringify([actor,key]),fp=hash(cmd);
  return this.uow.run(tx=>{const repositories=tx.repositories;
   const previous=repositories.outcomes.find(PARTY_COMMANDS,op);
   if(previous){if(previous.fingerprint!==fp)err('IDEMPOTENCY_CONFLICT');const prior=JSON.parse(previous.response),current=repositories.tournaments.room(prior.id);return current.players.some(p=>p.id===actor)?T.view(current,this.now()):{id:current.id,status:'LEFT'};}
   let r,e=null;const now=this.now(),active=repositories.tournaments.activeRooms();
   if(cmd.type==='create'){
    if(active.filter(r=>r.owner===actor).length>=3)err('ROOM_LIMIT');r=T.create({id:crypto.randomUUID(),code:this.code(),owner:actor,name:cmd.name,format:cmd.format,clock:cmd.clock??180,increment:cmd.increment??2,now});T.join(r,actor,principal.name||actor,now);
   }else if(cmd.type==='publicJoin'){
    if(this.lanOnly)err('FREE_PRIVATE_ONLY');const q=T.prize(cmd.table);e=repositories.state.read();const a=this.eligible(e,actor,q);if(a.activeMatch)err('ALREADY_IN_MATCH');
    if(active.some(r=>r.table&&r.players.some(p=>p.id===actor)))err('ALREADY_QUEUED');if(a[q.currency]<q.entry)err('INSUFFICIENT_'+q.currency.toUpperCase());
    r=MM.selectTournamentRoom(active,e,actor,cmd.table,now);
    if(!r)r=T.create({id:crypto.randomUUID(),code:this.code(),owner:'service',name:q.name+' table',table:cmd.table,now});T.join(r,actor,principal.name||a.id,now);
   }else{
    r=repositories.tournaments.room(cmd.id);if(!r)err('ROOM_NOT_FOUND');if(cmd.type==='join'){if(r.table)err('USE_PUBLIC_QUEUE');if(!this.lanOnly){const accounts=repositories.state.read(),joining=this.account(accounts,actor);if(r.players.some(p=>joining.blocked.includes(p.id)||this.account(accounts,p.id).blocked.includes(actor)))err('INELIGIBLE');}T.join(r,actor,principal.name||actor,now);}
    else{if(!r.players.some(p=>p.id===actor)&&principal.scope!=='operator')err('NOT_IN_ROOM');
     switch(cmd.type){
      case 'ready':T.ready(r,actor,cmd.value,cmd.rulesVersion);break;
      case 'configure':T.configure(r,actor,{format:cmd.format,clock:cmd.clock,increment:cmd.increment});break;
      case 'leave':T.leave(r,actor);break;
      case 'kick':if(r.table||r.status!=='LOBBY'||r.owner!==actor||cmd.target===actor)err('HOST_ONLY');T.leave(r,cmd.target);break;
      case 'transfer':if(r.table||r.status!=='LOBBY'||r.owner!==actor||!r.players.some(p=>p.id===cmd.target))err('HOST_ONLY');r.owner=cmd.target;r.revision++;break;
      case 'start':if(r.table)err('AUTOMATIC_START_ONLY');T.start(r,actor,this.shuffle(r.players.map(p=>p.id)),now);break;
      case 'matchReady':T.readyGame(r,cmd.fixture,actor,now);break;
      case 'move':T.move(r,cmd.fixture,actor,cmd.revision,cmd.move,now);break;
      case 'resign':T.resign(r,cmd.fixture,actor,now);break;
      case 'pause':T.pause(r,actor,now);break;
      case 'resume':T.resume(r,actor,now);break;
      case 'cancel':if((r.table&&principal.scope!=='operator')||(!r.table&&r.owner!==actor))err('HOST_ONLY');if(r.settled||r.status==='COMPLETE')err('EVENT_FINISHED');r.status='VOID';r.reason='CANCELLED';r.revision++;break;
      default:err('UNKNOWN_COMMAND');
     }
    }
   }
   if(r.table){e=e||repositories.state.read();if(r.status==='LOBBY'&&r.players.length===10&&r.players.every(p=>p.ready)){this.reserve(r,e);T.start(r,'service',MM.tournamentSeed(r.players.map(p=>p.id),e),now);}this.settle(r,e);this.writeEconomy(e);}
   repositories.tournaments.save(r);const response=T.view(r,now);repositories.outcomes.save(PARTY_COMMANDS,op,fp,JSON.stringify({id:r.id}));return response;
  });
 }
 tick(){
  return this.uow.run(tx=>{const repositories=tx.repositories;let e=null;
   for(const r of repositories.tournaments.activeRooms()){const rev=r.revision;T.tick(r,this.now());if(r.revision!==rev){if(r.table){e=e||repositories.state.read();this.settle(r,e);}repositories.tournaments.save(r);}}
   if(e)this.writeEconomy(e);
  });
 }
 /* Call once on service boot, not on every database connection. Fail financially closed after an outage. */
 recover(){
  return this.uow.run(tx=>{const repositories=tx.repositories;let e=null;
   for(const r of repositories.tournaments.activeRooms())if(r.status==='RUNNING'){if(r.table){r.status='VOID';r.reason='SERVER_RESTART';e=e||repositories.state.read();this.settle(r,e);}else{r.status='PAUSED';r.reason='SERVER_RESTART';r.pausedAt=this.now();for(const f of r.fixtures)if(f.status==='PLAYING')f.turnAt=this.now();}r.revision++;repositories.tournaments.save(r);}
   if(e)this.writeEconomy(e);
  });
 }
 close(){this.uow.close();this.db.close();}
}
module.exports={RoomStore};
