/* Queue lifecycle and bounded ephemeral state. Policy remains in matchmaking.js. */
'use strict';
const {Matchmaker}=require('./matchmaking.js');
class QueueSession extends Matchmaker {
 constructor(options){super(options);this.seen=new Map();this.terminal=new Map();this.terminalAt=new Map();this.pendingTickets=new Map();}
 _terminal(actor,result){this.terminal.set(actor,result);this.terminalAt.set(actor,this.now());}
 _clean(){
  const now=this.now();
  for(const [actor,ticket]of this.tickets)if(now-(this.seen.get(actor)||ticket.joinedAt)>45000){this.tickets.delete(actor);this._terminal(actor,{state:'disconnected'});}
  // One aggregate read for all unchanged results, rather than one full database
  // deserialization per player on every heartbeat. Refresh only after a write.
  let authority=this.results.size?this.store.read():null;
  for(const [actor,result]of this.results){
   let match;try{match=authority.view(result.matchId);}catch{this.results.delete(actor);continue;}
   if(match.status==='OFFERED'&&match.expires<=now){
    try{this.store.run({actor:'queue-clock',scope:'matchmaker'},'expire:'+match.id,{type:'expire',id:match.id});}catch{}
    authority=this.store.read();match=authority.view(match.id);
   }
   if(!['OFFERED','PLAYING'].includes(match.status)){this.results.delete(actor);this._terminal(actor,{state:match.status.toLowerCase(),matchId:match.id});}
  }
  for(const [actor,at]of this.terminalAt)if(now-at>300000){this.terminalAt.delete(actor);this.terminal.delete(actor);}
  while(this.terminalAt.size>Math.max(1000,this.maxTickets*4)){const actor=this.terminalAt.keys().next().value;this.terminalAt.delete(actor);this.terminal.delete(actor);}
  for(const [actor,at]of this.seen)if(now-at>300000&&!this.tickets.has(actor)&&!this.results.has(actor)){this.seen.delete(actor);this.pendingTickets.delete(actor);}
 }
 enqueue(actor,mode,key,context={}){this._clean();this.terminal.delete(actor);this.terminalAt.delete(actor);this.seen.set(actor,this.now());return super.enqueue(actor,mode,key,context);}
 status(actor){this._clean();this.seen.set(actor,this.now());const result=this.results.get(actor);if(result)return {state:'matched',mode:result.mode,matchId:result.matchId,termsHash:result.termsHash,expires:result.expires};return this.terminal.get(actor)||super.status(actor);}
 cancel(actor,key='cancel'){this._clean();const result=this.results.get(actor);if(result){const match=this.store.read().view(result.matchId);if(match.status==='PLAYING')return {state:'playing',matchId:match.id};if(match.status==='OFFERED')this.store.run({actor,scope:'player'},key,{type:'decline',id:match.id});this._clean();return {state:'cancelled'};}this.tickets.delete(actor);this.terminal.delete(actor);this.terminalAt.delete(actor);this.seen.delete(actor);return {state:'cancelled'};}
 tick(){this._clean();this.sweep();return {queued:this.tickets.size};}
 busy(actor){this._clean();return this.tickets.has(actor)||this.results.has(actor);}
}
module.exports={QueueSession};
