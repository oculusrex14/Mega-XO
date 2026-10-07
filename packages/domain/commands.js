/* Economic command dispatch, extracted from the transaction switch in server/economy-store.js.
   Performs no persistence, network, SQL, clock or process-global mutation: the caller owns the
   unit of work, validates the invocation (AUTH_REQUIRED / INVALID_COMMAND stay with
   packages/contracts validateInvocation) and supplies a live Authority. */
'use strict';
const {Authority}=require('../../src/authority.js');

/* Exact principal scope set accepted by the durable transaction boundary. */
const PRINCIPAL_SCOPES=Object.freeze(['player','operator','matchmaker','store']);

/* Exact role table of the legacy switch. Commands absent here are available to any valid
   principal, so that one table (not a duplicated switch) owns the privilege rules. */
const COMMAND_ROLES=Object.freeze({
 provision:Object.freeze(['operator']),
 queue:Object.freeze(['matchmaker']),
 timeout:Object.freeze(['operator','matchmaker']),
 expire:Object.freeze(['operator','matchmaker']),
 void:Object.freeze(['operator']),
 snapshot:Object.freeze(['operator']),
 weekly:Object.freeze(['operator']),
 refund:Object.freeze(['store'])
});

/* The trusted service principal used by maintenance/queue workers. */
function matchmakerPrincipal(){return {actor:'matchmaker',scope:'matchmaker'};}

function executeCommand(authority,principal,key,command){
 const role=(...roles)=>{if(!roles.includes(principal.scope))throw Error('FORBIDDEN');};
 const actor=principal.actor;let result;
 switch(command.type){
  case 'preferences': result=authority.preferences(actor,command.changes||{});break;
  case 'cosmetic': result=authority.cosmetic(actor,command.name);break;
  case 'friend': result=authority.requestFriend(actor,command.target);break;
  case 'acceptFriend': result=authority.acceptFriend(actor,command.from);break;
  case 'convert': result=authority.convert(actor,command.from,command.amount,key);break;
  case 'quest': result=authority.claimQuest(actor,command.quest);break;
  case 'offer': result=authority.offer(command.id,actor,command.opponent,command.terms);break;
  case 'accept': result=authority.accept(command.id,actor,command.termsHash);break;
  case 'decline': result=authority.decline(command.id,actor);break;
  case 'cancel': result=authority.cancel(command.id,actor);break;
  case 'move': result=authority.move(command.id,actor,command.revision,key,command.move);break;
  case 'resign': result=authority.resign(command.id,actor);break;
  case 'purchase': result=authority.purchase(actor,command.evidence);break;
  case 'provision': role('operator');result=authority.addAccount(command.account,command.options);break;
  case 'queue': role('matchmaker');result=authority.offerQueue(command.id,command.a,command.b,command.mode||'ranked',command.turnSeconds);break;
  case 'timeout': role('operator','matchmaker');result=authority.timeout(command.id);break;
  case 'expire': role('operator','matchmaker');result=authority.expire(command.id);break;
  case 'void': role('operator');result=authority.voidByOperator(command.id,command.reason);break;
  case 'snapshot': role('operator');result=authority.snapshotDay();break;
  case 'weekly': role('operator');result=authority.payoutWeek(command.week);break;
  case 'refund': role('store');result=authority.refundPurchase(command.store,command.transactionId);break;
  default: throw Error('UNKNOWN_COMMAND');
 }
 /* Legacy nullish semantics: an unmet quest claim stays 0, any undefined result becomes {ok:true}. */
 return result??{ok:true};
}

module.exports={executeCommand,COMMAND_ROLES,PRINCIPAL_SCOPES,matchmakerPrincipal,Authority};
