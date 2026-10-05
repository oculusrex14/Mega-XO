/* Queue lifecycle adapter for the accepted V3.3.2 matching policy. Adds expiry,
 * cancellation, heartbeat cleanup and repeat-search recovery, not new rating rules. */
'use strict';
const {Matchmaker}=require('./matchmaking.js');
class QueueSession extends Matchmaker {
 constructor(options){super(options);this.seen=new Map();this.terminal=new Map();this.pendingTickets=new Map();}
 _clean(){const now=this.now();for(const [actor,ticket] of this.tickets){if(now-(this.seen.get(actor)||ticket.joinedAt)>45000){this.tickets.delete(actor);this.terminal.set(actor,{state:'disconnected'});}}
  for(const [actor,result] of [...this.results]){let m;try{m=this.store.read().view(result.matchId);}catch{this.results.delete(actor);continue;}if(m.status==='OFFERED'&&m.expires<=now){try{this.store.run({actor:'queue-clock',scope:'matchmaker'},'expire:'+m.id,{type:'expire',id:m.id});}catch{}m=this.store.read().view(m.id);}
   if(!['OFFERED','PLAYING'].includes(m.status)){this.results.delete(actor);this.terminal.set(actor,{state:m.status.toLowerCase(),matchId:m.id});}
  }
 }
 enqueue(actor,mode,key,context={}){this._clean();this.terminal.delete(actor);this.seen.set(actor,this.now());return super.enqueue(actor,mode,key,context);}
 status(actor){this._clean();this.seen.set(actor,this.now());const result=this.results.get(actor);if(result)return {state:'matched',mode:result.mode,matchId:result.matchId,termsHash:result.termsHash,expires:result.expires};return this.terminal.get(actor)||super.status(actor);}
 cancel(actor,key='cancel'){this._clean();const result=this.results.get(actor);if(result){const m=this.store.read().view(result.matchId);if(m.status==='PLAYING')return {state:'playing',matchId:m.id};if(m.status==='OFFERED')this.store.run({actor,scope:'player'},key,{type:'decline',id:m.id});this._clean();return {state:'cancelled'};}this.tickets.delete(actor);this.terminal.delete(actor);return {state:'cancelled'};}
 tick(){this._clean();this.sweep();return {queued:this.tickets.size};}
 busy(actor){this._clean();return this.tickets.has(actor)||this.results.has(actor);}
}
module.exports={QueueSession};
