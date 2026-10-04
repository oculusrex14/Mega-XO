/* Server-only reference authority. In-memory: NOT a deployable financial backend.
   Production adapter must authenticate actor IDs, use a transactional database,
   persist the ledger/idempotency keys and enforce jurisdiction/age/attestation. */
'use strict';
const G=require('./game.js'),D=require('./domain.js');
class Authority {
 constructor({allowEarnedStakes=false,now=()=>Date.now()}={}){this.allowEarnedStakes=allowEarnedStakes;this.now=now;this.accounts=new Map();this.matches=new Map();this.burned=0;this.dailyBonus=new Map();}
 addAccount(id,coins=0){if(!id||this.accounts.has(id)||!Number.isSafeInteger(coins)||coins<0)throw Error('INVALID_ACCOUNT');this.accounts.set(id,{coins,tier:'wood',verified:true,blocked:[],region:'IN',suspended:false});}
 offer(id,a,b,terms){
  if(this.matches.has(id))throw Error('DUPLICATE_MATCH');if(a===b)throw Error('SELF_CHALLENGE');
  const A=this.accounts.get(a),B=this.accounts.get(b);if(!A||!B||!A.verified||!B.verified||A.suspended||B.suspended||A.blocked.includes(b)||B.blocked.includes(a))throw Error('INELIGIBLE');
  if(terms.currency&&terms.currency!=='earned')throw Error('PURCHASED_STAKES_FORBIDDEN');
  terms={...terms,from:A.tier,to:B.tier};const q=D.quote(terms);if(q.fee&&!this.allowEarnedStakes)throw Error('STAKES_DISABLED');
  const recent=[...this.matches.values()].filter(m=>m.players.includes(a)&&m.players.includes(b)&&this.now()-m.created<86400000).length;
  if(q.fee&&recent>=3)throw Error('PAIR_RATE_LIMIT');
  const m={id,players:[a,b],terms:{...terms},quote:q,accepted:[],created:this.now(),expires:this.now()+120000,status:'OFFERED',state:G.create(),revision:0,commands:new Map(),escrow:0,settled:false};this.matches.set(id,m);return m;
 }
 accept(id,actor){
  const m=this.matches.get(id);if(!m||!m.players.includes(actor))throw Error('NOT_PARTICIPANT');if(m.status!=='OFFERED')throw Error('NOT_OPEN');if(this.now()>m.expires){m.status='EXPIRED';throw Error('OFFER_EXPIRED');}
  if(!m.accepted.includes(actor))m.accepted.push(actor);if(m.accepted.length<2)return;
  const [a,b]=m.players.map(p=>this.accounts.get(p)),fee=m.quote.fee;
  // Validate both before either debit. Replace with row locks + atomic DB transaction.
  if(a.coins<fee||b.coins<fee){m.accepted=[];throw Error('INSUFFICIENT_COINS');}
  a.coins-=fee;b.coins-=fee;m.escrow=2*fee;m.status='PLAYING';m.started=this.now();m.deadline=this.now()+30000;
 }
 move(id,actor,revision,key,move){
  const m=this.matches.get(id);if(!m||!m.players.includes(actor))throw Error('NOT_PARTICIPANT');
  const fingerprint=JSON.stringify({actor,revision,move});
  if(m.commands.has(key)){const old=m.commands.get(key);if(old.fingerprint!==fingerprint)throw Error('IDEMPOTENCY_CONFLICT');return old.state;}
  if(m.status!=='PLAYING'||m.settled)throw Error('MATCH_CLOSED');if(m.revision!==revision)throw Error('STALE_REVISION');
  if(this.now()>=m.deadline){this.timeout(id);throw Error('TIMER_EXPIRED');}
  if(actor!==m.players[m.state.turn==='X'?0:1])throw Error('NOT_YOUR_TURN');
  const next=G.apply(m.state,move);m.state=next;m.revision++;m.deadline=this.now()+30000;
  if(next.winner)this._settle(m,next.winner,next.winner==='DRAW'?'draw':'line');
  const state=structuredClone(next);m.commands.set(key,{fingerprint,state});return state;
 }
 timeout(id){const m=this.matches.get(id);if(!m||m.status!=='PLAYING'||this.now()<m.deadline)throw Error('NOT_TIMED_OUT');this._settle(m,m.state.turn==='X'?'O':'X','timeout');}
 cancel(id,actor){const m=this.matches.get(id);if(!m||!m.players.includes(actor)||m.status!=='OFFERED')throw Error('CANNOT_CANCEL');m.status='CANCELLED';}
 voidByOperator(id){const m=this.matches.get(id);if(!m||m.settled)return;for(const id of m.players)this.accounts.get(id).coins+=m.escrow/2;m.escrow=0;m.status='VOID';m.settled=true;}
 _settle(m,winner,reason){
  if(m.settled)return;let payout=0,bonus=0,burn=0;
  if(winner==='DRAW'){for(const id of m.players)this.accounts.get(id).coins+=m.escrow/2;}
  else{const id=m.players[winner==='X'?0:1],a=this.accounts.get(id);burn=m.escrow/2;payout=m.escrow-burn;
   // Mint only eligible ranked game bonuses. Challenge/friend payouts NEVER change Elo.
   if(m.terms.mode==='ranked'&&reason==='line'&&m.state.moves.length>=12&&this.now()-m.started>=30000){const key=D.day(this.now())+':'+id,used=this.dailyBonus.get(key)||0;bonus=Math.min(Math.floor(12*D.tier(winner==='X'?m.terms.from:m.terms.to).multiplier),Math.max(0,120-used));this.dailyBonus.set(key,used+bonus);}
   a.coins+=payout+bonus;this.burned+=burn;
  }
  m.receipt={winner,reason,payout,bonus,burn,refunded:winner==='DRAW'?m.escrow:0};m.escrow=0;m.settled=true;m.status='FINISHED';
 }
}
module.exports={Authority};
