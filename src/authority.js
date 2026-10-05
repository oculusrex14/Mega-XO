/* Server-only economy/game authority. Never load this file into the client.
 * Use DurableStore for transactional persistence; bind actor IDs to server-authenticated sessions.
 * No payments or paid-entry online mode are enabled by default. */
'use strict';
const crypto=require('node:crypto'),G=require('./game.js'),D=require('./domain.js');
const clone=x=>structuredClone(x),hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(id);
class Authority {
 constructor({paidEntryEnabled=false,eligibility=()=>false,verifyPurchase=null,now=()=>Date.now(),random=()=>crypto.randomInt(2),state=null}={}){
  this.paidEntryEnabled=paidEntryEnabled;this.eligibility=eligibility;this.verifyPurchase=verifyPurchase;this.now=now;this.random=random;
  this.accounts=new Map();this.matches=new Map();this.receipts=new Map();this.snapshots=new Map();this.weeklyPaid=new Map();this.burned={coins:0,crowns:0};this.journal=[];this.leagueWeek=null;
  if(state)this.restore(state);
 }
 export(){return clone({accounts:[...this.accounts],matches:[...this.matches].map(([id,m])=>[id,{...m,commands:[...m.commands]}]),receipts:[...this.receipts],snapshots:[...this.snapshots],weeklyPaid:[...this.weeklyPaid],burned:this.burned,journal:this.journal,leagueWeek:this.leagueWeek});}
 restore(s){this.accounts=new Map(s.accounts);for(const a of this.accounts.values()){if(!Number.isFinite(a.casualRating))a.casualRating=a.games>=D.POLICY.placements?a.rating:1000;if(!Number.isSafeInteger(a.casualGames))a.casualGames=0;}this.matches=new Map(s.matches.map(([id,m])=>[id,{...m,commands:new Map(m.commands)}]));this.receipts=new Map(s.receipts);this.snapshots=new Map(s.snapshots);this.weeklyPaid=new Map(s.weeklyPaid);this.burned=s.burned;this.journal=s.journal;this.leagueWeek=s.leagueWeek;}
 account(id){const a=this.accounts.get(id);if(!a)throw Error('UNKNOWN_ACCOUNT');return a;}
 _entry(id,actor,currency,amount,reason,source='game'){this.journal.push({id,actor,currency,amount,reason,source,at:this.now()});}
 /* Provisioning is a trusted server operation, never a user-supplied balance import. */
 addAccount(id,{coins=100,crowns=0,rating=600,games=0,verified=false,createdAt=this.now(),region='',wealthPublic=false}={}){
  if(!validId(id)||this.accounts.has(id))throw Error('INVALID_ACCOUNT');D.integer(coins);D.integer(crowns);D.integer(games);if(!Number.isFinite(rating)||rating<0)throw Error('INVALID_RATING');
  let friendCode;do{friendCode='MEGA-'+crypto.randomBytes(4).toString('hex').toUpperCase();}while([...this.accounts.values()].some(p=>p.friendCode===friendCode));
  const a={id,friendCode,coins,crowns,reservedCoins:0,reservedCrowns:0,rating:Math.round(rating*100)/100,peak:rating,games,tier:D.basicTier(rating).id,casualRating:games>=D.POLICY.placements?Math.round(rating*100)/100:1000,casualGames:0,verified,createdAt,region,wealthPublic,suspended:false,hold:false,blocked:[],friends:[],friendRequests:[],activeMatch:null,history:[],daily:{},operations:{},ledger:[],owned:[],purchaseInfluenced:false};
  D.wealth(a);this.accounts.set(id,a);this._entry('opening:'+id,id,'coins',coins,'Opening balance','provisioning');if(crowns)this._entry('opening-crowns:'+id,id,'crowns',crowns,'Opening balance','provisioning');return clone(a);
 }
 preferences(actor,changes){const a=this.account(actor);if(typeof changes.wealthPublic==='boolean')a.wealthPublic=changes.wealthPublic;if(typeof changes.region==='string'&&changes.region.length<=64)a.region=changes.region;return {wealthPublic:a.wealthPublic,region:a.region};}
 cosmetic(actor,name){const prices={'Copper edge':30,'Orbit frame':60,'Crown frame':120},a=this.account(actor);if(a.hold||a.suspended)throw Error('ACCOUNT_HELD');if(!Object.hasOwn(prices,name))throw Error('UNKNOWN_COSMETIC');if(a.owned.includes(name))return {owned:true};if(a.coins<prices[name])throw Error('INSUFFICIENT_COINS');a.coins-=prices[name];a.owned.push(name);this._entry('cosmetic:'+actor+':'+name,actor,'coins',-prices[name],name,'spend');return {owned:true};}
 requestFriend(actor,target){const found=this.accounts.get(target)||[...this.accounts.values()].find(p=>p.friendCode===target);if(!found)throw Error('UNKNOWN_ACCOUNT');target=found.id;const a=this.account(actor),b=this.account(target);this._players(actor,target);if(a.friends.includes(target))return {alreadyFriends:true};if(!b.friendRequests.includes(actor))b.friendRequests.push(actor);return {requested:true};}
 acceptFriend(actor,from){const a=this.account(actor),b=this.account(from);this._players(actor,from);if(!a.friendRequests.includes(from))throw Error('NO_FRIEND_REQUEST');if(!a.friends.includes(from))a.friends.push(from);if(!b.friends.includes(actor))b.friends.push(actor);a.friendRequests=a.friendRequests.filter(x=>x!==from);return {friends:true};}
 currentTier(a){if(this.leagueWeek===D.week(this.now())&&D.tier(a.tier).index>=8)return a.tier;return D.basicTier(a.rating).id;}
 _players(a,b){const A=this.account(a),B=this.account(b);if(a===b)throw Error('SELF_CHALLENGE');if(!A.verified||!B.verified||A.suspended||B.suspended||A.hold||B.hold||A.blocked.includes(b)||B.blocked.includes(a))throw Error('INELIGIBLE');return [A,B];}
 _paidAllowed(players,q){if(!q.pool)return;if(!this.paidEntryEnabled||!players.every(p=>this.eligibility(clone(p),clone(q))))throw Error('PAID_ENTRY_UNAVAILABLE');}
 _pairLimit(a,b,q){if(!q.rated)return;const now=this.now(),start=D.weekStart(D.week(now));const completed=[...this.matches.values()].filter(m=>m.quote.rated&&m.status!=='VOID'&&m.started!==undefined&&m.players.includes(a)&&m.players.includes(b));
  if(q.mode==='direct'){
   const direct=completed.filter(m=>m.quote.mode==='direct');if(direct.filter(m=>now-m.started< D.DAY).length>=D.POLICY.directPairDaily||direct.filter(m=>m.started>=start).length>=D.POLICY.directPairWeekly)throw Error('RATED_PAIR_LIMIT');
  }else if(completed.filter(m=>m.quote.mode==='queue'&&now-m.started<D.DAY).length>=D.POLICY.queuePairDaily)throw Error('RATED_PAIR_LIMIT');
 }
 /* queue offers are created by the trusted matchmaker, never by a client choosing an opponent. */
 offerQueue(id,a,b,mode='ranked',turnSeconds){if(typeof mode==='number'){turnSeconds=mode;mode='ranked';}if(!['ranked','casual'].includes(mode))throw Error('INVALID_MODE');return this._offer(id,a,b,{mode,kind:mode==='casual'?'casual':undefined,source:'queue',turnSeconds:turnSeconds??(mode==='ranked'?30:60)});}
 offer(id,a,b,terms={}){if(terms.mode==='ranked'||terms.mode==='queue')throw Error('MATCHMAKER_REQUIRED');return this._offer(id,a,b,{...terms,mode:'direct'});}
 _offer(id,a,b,terms){
  if(!validId(id)||this.matches.has(id))throw Error('DUPLICATE_OR_INVALID_MATCH');const players=this._players(a,b),now=this.now();
  if(players.some(p=>p.activeMatch))throw Error('ALREADY_IN_MATCH');
  if([...this.matches.values()].filter(m=>m.players[0]===a&&now-m.created<D.DAY).length>=D.POLICY.offerDaily)throw Error('INVITE_RATE_LIMIT');
  if([...this.matches.values()].some(m=>m.status==='OFFERED'&&m.expires>now&&m.players.includes(a)&&m.players.includes(b)))throw Error('PENDING_INVITATION');
  const queueSource=terms.source==='queue',q=D.quote({...terms,from:this.currentTier(players[0]),to:this.currentTier(players[1])});
  if(q.rated&&q.kind==='friend'&&(!players[0].friends.includes(b)||!players[1].friends.includes(a)))throw Error('FRIENDSHIP_REQUIRED');
  if(q.mode==='direct'&&players.some(p=>p.games<D.POLICY.placements))throw Error('COMPLETE_PLACEMENTS');
  this._paidAllowed(players,q);this._pairLimit(a,b,q);
  const turnSeconds=terms.turnSeconds??(q.rated?30:60);if(q.rated?turnSeconds!==30:![0,30,60].includes(turnSeconds))throw Error('INVALID_CLOCK');
  const clean={source:queueSource?'queue':'direct',mode:q.mode,kind:q.kind||terms.kind||(queueSource?(q.rated?'ranked':'casual'):'friend'),rated:q.rated,amount:q.pool,currency:q.currency,turnSeconds,from:this.currentTier(players[0]),to:this.currentTier(players[1]),ratings:players.map(p=>p.rating)};
  const fingerprint=hash({players:[a,b],terms:clean,quote:q});
  const m={id,players:[a,b],terms:clean,quote:q,termsHash:fingerprint,accepted:queueSource?[]:[a],created:now,expires:now+(queueSource?15000:D.POLICY.offerMinutes*60000),status:'OFFERED',state:G.create(),symbols:null,revision:0,commands:new Map(),escrow:0,settled:false,riskFlags:q.mode==='direct'&&q.pool>=5000?['HIGH_VALUE_DIRECT_POT']:[]};
  this.matches.set(id,m);return this.view(id);
 }
 view(id){const m=this.matches.get(id);if(!m)throw Error('UNKNOWN_MATCH');const {commands,...rest}=m;return clone(rest);}
 accept(id,actor,termsHash){
  const m=this.matches.get(id);if(!m||!m.players.includes(actor))throw Error('NOT_PARTICIPANT');if(m.termsHash!==termsHash)throw Error('TERMS_CHANGED');
  if(m.status==='PLAYING'&&m.accepted.includes(actor))return this.view(id);if(m.status!=='OFFERED')throw Error('NOT_OPEN');
  if(this.now()>=m.expires)throw Error('OFFER_EXPIRED');const players=this._players(...m.players);this._paidAllowed(players,m.quote);this._pairLimit(...m.players,m.quote);
  if(players.some(p=>p.activeMatch))throw Error('ALREADY_IN_MATCH');
  if(players.some((p,i)=>p.rating!==m.terms.ratings[i]||this.currentTier(p)!==[m.terms.from,m.terms.to][i]))throw Error('REQUOTE_REQUIRED');
  const accepted=new Set([...m.accepted,actor]);if(accepted.size<2){m.accepted=[...accepted];return this.view(id);}
  const currency=m.quote.currency,held=currency==='coins'?'reservedCoins':'reservedCrowns';
  if(currency)players.forEach((p,i)=>{if(p[currency]<m.quote.contributions[i])throw Error('INSUFFICIENT_'+currency.toUpperCase());D.add(p[held],m.quote.contributions[i]);});
  // Preflight every write before modifying either account. DurableStore wraps the operation in one transaction.
  if(currency)players.forEach((p,i)=>{const amount=m.quote.contributions[i];p[currency]-=amount;p[held]+=amount;this._entry(id+':reserve:'+p.id,p.id,currency,-amount,'Reserved for match');});
  m.accepted=[...accepted];m.escrow=m.quote.pool;m.status='PLAYING';m.started=this.now();m.preRatings=players.map(p=>p.rating);m.preTiers=players.map(p=>this.currentTier(p));
  let swap;if(m.terms.source==='queue'){const bias=p=>(p.history||[]).filter(h=>h.queue&&h.symbol).slice(-8).reduce((n,h)=>n+(h.symbol==='X'?1:-1),0),aBias=bias(players[0]),bBias=bias(players[1]),normal=Math.abs(aBias+1)+Math.abs(bBias-1),flipped=Math.abs(aBias-1)+Math.abs(bBias+1);swap=flipped<normal?true:normal<flipped?false:this.random()===1;}else swap=this.random()===1;m.symbols={X:m.players[swap?1:0],O:m.players[swap?0:1]};m.deadline=m.terms.turnSeconds?this.now()+m.terms.turnSeconds*1000:null;
  for(const p of players)p.activeMatch=id;return this.view(id);
 }
 decline(id,actor){const m=this.matches.get(id);if(!m||!m.players.includes(actor)||m.status!=='OFFERED')throw Error('CANNOT_DECLINE');m.status='DECLINED';return this.view(id);}
 cancel(id,actor){const m=this.matches.get(id);if(!m||m.players[0]!==actor||m.status!=='OFFERED')throw Error('CANNOT_CANCEL');m.status='CANCELLED';return this.view(id);}
 expire(id){const m=this.matches.get(id);if(!m||m.status!=='OFFERED'||this.now()<m.expires)throw Error('NOT_EXPIRED');m.status='EXPIRED';return this.view(id);}
 move(id,actor,revision,key,move){
  const m=this.matches.get(id);if(!m||!m.players.includes(actor))throw Error('NOT_PARTICIPANT');if(!validId(key))throw Error('INVALID_OPERATION');
  const fingerprint=hash({actor,revision,move});if(m.commands.has(key)){const old=m.commands.get(key);if(old.fingerprint!==fingerprint)throw Error('IDEMPOTENCY_CONFLICT');return clone(old.result);}
  if(m.status!=='PLAYING'||m.settled)throw Error('MATCH_CLOSED');if(m.revision!==revision)throw Error('STALE_REVISION');
  if(m.deadline!==null&&this.now()>=m.deadline)throw Error('TIMER_EXPIRED');if(actor!==m.symbols[m.state.turn])throw Error('NOT_YOUR_TURN');
  this._players(...m.players);const next=G.apply(m.state,move);m.state=next;m.revision++;m.deadline=m.terms.turnSeconds?this.now()+m.terms.turnSeconds*1000:null;
  if(next.winner)this._settle(m,next.winner,next.winner==='DRAW'?'draw':'line');
  const result={state:clone(m.state),revision:m.revision,receipt:clone(m.receipt||null)};m.commands.set(key,{fingerprint,result});return clone(result);
 }
 timeout(id){const m=this.matches.get(id);if(!m||m.status!=='PLAYING'||m.deadline===null||this.now()<m.deadline)throw Error('NOT_TIMED_OUT');return this._settle(m,m.state.turn==='X'?'O':'X','timeout');}
 resign(id,actor){const m=this.matches.get(id);if(!m||!m.players.includes(actor)||m.status!=='PLAYING')throw Error('NOT_PARTICIPANT');return this._settle(m,m.symbols.X===actor?'O':'X','resign');}
 _release(m,refund=false){const c=m.quote.currency;if(!c)return;const held=c==='coins'?'reservedCoins':'reservedCrowns';m.players.forEach((id,i)=>{const a=this.account(id),n=m.quote.contributions[i];a[held]-=n;if(refund){a[c]=D.add(a[c],n);this._entry(m.id+':refund:'+id,id,c,n,'Match refund');}});}
 /* This operation is only exposed to an authenticated operator, never an app client. */
 voidByOperator(id,reason='Server cancellation'){
  const m=this.matches.get(id);if(!m)throw Error('UNKNOWN_MATCH');if(m.settled)return clone(m.receipt);
  if(m.escrow)this._release(m,true);const refunded=m.escrow;m.escrow=0;m.settled=true;m.status='VOID';m.receipt={reason,refunded,burn:0,payout:0,rating:null};
  m.players.forEach(p=>{const a=this.account(p);if(a.activeMatch===id)a.activeMatch=null;});return clone(m.receipt);
 }
 _settle(m,winner,reason){
  if(m.settled)return clone(m.receipt);if(!['X','O','DRAW'].includes(winner))throw Error('INVALID_RESULT');
  const now=this.now(),isDraw=winner==='DRAW',winnerId=isDraw?null:m.symbols[winner],players=m.players.map(id=>this.account(id));
  const qualified=['line','draw'].includes(reason)&&m.state.moves.length>=D.POLICY.minRewardMoves&&now-m.started>=D.POLICY.minRewardSeconds*1000;
  if(m.quote.mode==='direct'&&!qualified)m.riskFlags.push('SHORT_DIRECT_RESULT_REVIEW');
  const c=m.quote.currency,burn=isDraw?0:m.escrow/2,payout=isDraw?0:m.escrow-burn;
  let bonus=0,rating=null;
  if(m.quote.rated){const score=isDraw?.5:winnerId===m.players[0]?1:0;rating=D.elo(m.preRatings[0],m.preRatings[1],score);}
  let casual=null;if(!m.quote.rated&&m.terms.source==='queue'&&m.terms.kind==='casual'){const score=isDraw?.5:winnerId===m.players[0]?1:0,k=Math.min(players[0].casualGames,players[1].casualGames)<10?32:Math.min(players[0].casualGames,players[1].casualGames)<40?24:16;casual=D.elo(players[0].casualRating,players[1].casualRating,score,k);players[0].casualRating=casual.a;players[1].casualRating=casual.b;players[0].casualGames++;players[1].casualGames++;}
  const winAccount=winnerId?this.account(winnerId):null;
  if(winAccount&&m.quote.mode==='queue'&&qualified&&reason==='line'){
   const d=this._daily(winAccount,now),idx=m.players.indexOf(winnerId);bonus=Math.min(Math.floor(12*D.tier(m.preTiers[idx]).multiplier),Math.max(0,D.POLICY.rankedBonusDailyCap-d.rankedBonus));
  }
  // Check the resulting balances before releasing escrow, including additive Coin bonus.
  if(winAccount&&c)D.add(winAccount[c],payout+(c==='coins'?bonus:0));if(winAccount&&c!=='coins')D.add(winAccount.coins,bonus);
  if(c)D.add(this.burned[c],burn);if(isDraw)players.forEach((p,i)=>{if(c)D.add(p[c],m.quote.contributions[i]);});
  this._release(m,isDraw);
  if(!isDraw&&c){winAccount[c]+=payout;this.burned[c]+=burn;this._entry(m.id+':payout',winnerId,c,payout,'Match winnings');this._entry(m.id+':burn','system',c,-burn,'Currency retired');if(players.some(p=>p.purchaseInfluenced))winAccount.purchaseInfluenced=true;}
  if(bonus){winAccount.coins+=bonus;this._daily(winAccount,now).rankedBonus+=bonus;this._entry(m.id+':bonus',winnerId,'coins',bonus,'Ranked win bonus','mint');}
  if(rating)players.forEach((a,i)=>{a.rating=i?rating.b:rating.a;a.games++;a.peak=Math.max(a.peak,a.rating);a.reachedAt=now;a.tier=this.currentTier(a);});
  players.forEach((a,i)=>{
   const result=isDraw?'draw':a.id===winnerId?'win':'loss',mode=m.quote.rated?'ranked':m.terms.kind==='friend'?'friend':'casual';
   a.history.push({id:m.id,at:now,opponent:m.players[1-i],mode,queue:m.terms.source==='queue',symbol:m.symbols.X===a.id?'X':'O',rated:m.quote.rated,qualified,result,reason,activeSeconds:Math.floor((now-m.started)/1000),ratingDelta:rating?(i?-rating.delta:rating.delta):0,casualDelta:casual?(i?-casual.delta:casual.delta):0});
   if(qualified){const d=this._daily(a,now);d.finished++;d.seconds+=Math.min(900,(now-m.started)/1000);d.boards+=m.state.mini.filter(v=>v===(m.symbols.X===a.id?'X':'O')).length;d[mode]++;}
   a.activeMatch=null;
  });
  m.state={...m.state,winner};m.receipt={winner:winnerId,reason,currency:c,payout,burn,bonus,refunded:isDraw?m.escrow:0,rating,at:now};m.escrow=0;m.settled=true;m.status='FINISHED';return clone(m.receipt);
 }
 _daily(a,now){const key=D.day(now);if(!a.daily[key])a.daily[key]={finished:0,seconds:0,boards:0,casual:0,friend:0,ranked:0,rankedBonus:0,claimed:[]};return a.daily[key];}
 convert(actor,from,amount,key){const a=this.account(actor);if(a.suspended||a.hold)throw Error('ACCOUNT_HELD');const result=D.convert({version:3.2,wallet:a},from,amount,key,this.now());if(!result.duplicate){this._entry(key+':out',actor,from,-result.debit,'Currency conversion','conversion');this._entry(key+':in',actor,result.to,result.credit,'Currency conversion','conversion');}return result;}
 claimQuest(actor,id){const a=this.account(actor),d=this._daily(a,this.now()),q=D.QUESTS.find(q=>q.id===id);if(a.hold||a.suspended)throw Error('ACCOUNT_HELD');if(!q||d.claimed.includes(id)||(d[q.metric]||0)<q.target)return 0;const n=D.add(a.coins,q.reward);a.coins=n;d.claimed.push(id);this._entry('quest:'+D.day(this.now())+':'+actor+':'+id,actor,'coins',q.reward,q.title,'mint');return q.reward;}
 /* Callback must validate the native store transaction and bind it to actor/accountToken.
    No client-supplied amount or product quantity is accepted. */
 purchase(actor,evidence){
  if(!this.verifyPurchase)throw Error('STORE_UNAVAILABLE');const a=this.account(actor);if(a.hold||a.suspended)throw Error('ACCOUNT_HELD');const receipt=this.verifyPurchase(evidence,actor);
  if(!receipt||receipt.valid!==true||receipt.accountId!==actor||receipt.refunded||!['apple','google'].includes(receipt.store)||!validId(receipt.transactionId))throw Error('INVALID_RECEIPT');
  const pack=D.CROWN_PACKS.find(p=>p.id===receipt.productId);if(!pack)throw Error('INVALID_PRODUCT');const id=receipt.store+':'+receipt.transactionId,old=this.receipts.get(id);
  if(old){if(old.actor!==actor||old.productId!==pack.id)throw Error('RECEIPT_REPLAY');if(old.refunded)throw Error('RECEIPT_REFUNDED');return {crowns:pack.crowns,duplicate:true};}
  a.crowns=D.add(a.crowns,pack.crowns);a.purchaseInfluenced=true;this.receipts.set(id,{actor,productId:pack.id,crowns:pack.crowns,refunded:false,at:this.now()});this._entry('purchase:'+id,actor,'crowns',pack.crowns,'Crown purchase','verified-store');return {crowns:pack.crowns,duplicate:false};
 }
 refundPurchase(store,transactionId){
  const r=this.receipts.get(store+':'+transactionId);if(!r)throw Error('UNKNOWN_RECEIPT');if(r.refunded)return {duplicate:true};const a=this.account(r.actor);
  // Freeze rather than silently clawing funds from an innocent match opponent.
  r.refunded=true;a.hold=true;this._entry('refund-hold:'+store+':'+transactionId,a.id,'crowns',0,'Purchase refund: review required','verified-store');return {held:true,duplicate:false};
 }
 publishLeagues(){
  const now=this.now(),key=D.week(now);if(this.leagueWeek===key)return;
  const players=[...this.accounts.values()].map(a=>({...a,uniqueOpponents:new Set(a.history.filter(h=>h.rated).map(h=>h.opponent)).size,recentGames:a.history.filter(h=>h.rated&&now-h.at<7*D.DAY).length}));
  const assignments=D.assignTiers(players,now);this.leagueWeek=key;for(const a of this.accounts.values())a.tier=assignments.get(a.id)?.tier||D.basicTier(a.rating).id;
 }
 snapshotDay(){
  this.publishLeagues();const date=D.day(this.now());if(this.snapshots.has(date))return clone(this.snapshots.get(date));
  const snapshot={};for(const a of this.accounts.values())if(a.verified&&!a.suspended&&!a.hold&&a.games>=D.POLICY.placements)snapshot[a.id]=this.currentTier(a);
  this.snapshots.set(date,snapshot);return clone(snapshot);
 }
 payoutWeek(key){
  const start=D.weekStart(key),end=start+7*D.DAY;if(this.now()<end)throw Error('WEEK_NOT_FINISHED');const payments=[];
  for(const a of this.accounts.values()){
   const id=key+':'+a.id;if(this.weeklyPaid.has(id)){payments.push(clone(this.weeklyPaid.get(id)));continue;}
   if(!a.verified||a.suspended||a.hold)continue;
   const days=Array.from({length:7},(_,i)=>this.snapshots.get(D.day(start+i*D.DAY))?.[a.id]||null),dailyTiers=days.filter(Boolean);
   // Never backfill missing observations or pay the previous week using today's rank.
   if(!days[6])continue;const games=a.history.filter(h=>h.rated&&h.qualified&&h.at>=start&&h.at<end);
   const reward=D.weeklyReward({dailyTiers,endTier:days[6],games:games.length,queueGames:games.filter(h=>h.queue).length,uniqueOpponents:new Set(games.map(h=>h.opponent)).size,activeDays:new Set(games.map(h=>D.day(h.at))).size});
   if(!reward.eligible)continue;a.coins=D.add(a.coins,reward.amount);const payment={id,account:a.id,week:key,...reward};this.weeklyPaid.set(id,payment);payments.push(payment);this._entry('weekly:'+id,a.id,'coins',reward.amount,'Weekly '+D.tier(reward.tier).name+' reward','mint');
  }return clone(payments);
 }
 leaderboard(options={}){return clone(D.leaderboard([...this.accounts.values()].map(a=>({...a,tier:this.currentTier(a)})),options));}
}
module.exports={Authority};
