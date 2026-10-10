/* Distinct unverified local result class; never a server or currency authority. */
(function(root,factory){const api=factory(typeof module==='object'?require('../game.js'):root.MegaGame,typeof module==='object'?require('./contracts.js'):root.MegaBotContract,typeof module==='object'?require('./pack.js'):root.MegaBotPack);if(typeof module==='object')module.exports=api;else root.MegaLocalAI=api;})(globalThis,(G,C,P)=>{
'use strict';
const VERSION='local-ai-match-v1',RESULT_CLASS='unverified-local-ai';
function validPin(pin){return !!pin&&pin.ruleset===C.RULESET&&pin.encodingVersion===P.ENCODING&&/^[a-f0-9]{64}$/.test(pin.modelHash||'')&&/^[a-zA-Z0-9._-]{1,64}$/.test(pin.packVersion||'');}
function create({id,first='X',pin,seed=0}={},catalog=P.APPROVED_CATALOG){if(typeof id!=='string'||!id||id.length>160||!['X','O'].includes(first)||!validPin(pin)||!P.resolvePinned(pin,catalog)||!Number.isInteger(seed)||seed<0||seed>4294967295)throw Error('LOCAL_AI_MATCH_NOT_APPROVED');return {version:VERSION,id,first,state:G.create(first),difficulty:'Impossible',engine:'neural',resultClass:RESULT_CLASS,pin:{...pin},seed,status:'ready'};}
function snapshot(match){if(match.version!==VERSION||match.resultClass!==RESULT_CLASS||!validPin(match.pin))throw Error('INVALID_LOCAL_AI_MATCH');return {version:VERSION,id:match.id,first:match.first,resultClass:RESULT_CLASS,difficulty:match.difficulty,engine:match.engine,pin:{...match.pin},seed:match.seed,revision:match.state.moves.length,moves:match.state.moves.map(m=>({...m}))};}
function restore(saved,catalog=P.APPROVED_CATALOG){
 if(!saved||saved.version!==VERSION||saved.resultClass!==RESULT_CLASS||typeof saved.id!=='string'||!saved.id||saved.id.length>160||!['X','O'].includes(saved.first)||!validPin(saved.pin)||!Number.isInteger(saved.seed)||saved.seed<0||saved.seed>4294967295||!Array.isArray(saved.moves)||saved.moves.length>81||saved.revision!==saved.moves.length)throw Error('INVALID_LOCAL_AI_SAVE');
 if(!((saved.engine==='neural'&&saved.difficulty==='Impossible')||(saved.engine==='legacy'&&saved.difficulty==='Expert')))throw Error('INVALID_LOCAL_AI_LABEL');
 let state=G.create(saved.first);for(const move of saved.moves){if(move.player!==state.turn)throw Error('INVALID_LOCAL_AI_PLAYER');state=G.apply(state,move);}
 return {...saved,pin:{...saved.pin},state,status:state.winner?'finished':saved.engine==='legacy'||P.resolvePinned(saved.pin,catalog)?'ready':'pack-unavailable'};
}
function accept(match,result){if(match.status!=='ready'||match.state.winner)throw Error('LOCAL_AI_NOT_READY');if(match.engine==='neural'&&result.diagnostics?.modelHash!==match.pin.modelHash)throw Error('LOCAL_AI_MODEL_CHANGED');const move=C.accept({state:match.state,gameId:match.id,revision:match.state.moves.length},result),state=G.apply(match.state,move);return {...match,state,status:state.winner?'finished':'ready'};}
function expertFallback(match,{confirmed=false}={}){if(!confirmed)throw Error('LOCAL_AI_FALLBACK_CONFIRMATION');if(match.state.winner)throw Error('MATCH_FINISHED');return {...match,difficulty:'Expert',engine:'legacy',status:'ready',resultClass:RESULT_CLASS,fallbackFrom:match.pin.modelHash};}
function record(data,match,{at=Date.now()}={}){if(match.resultClass!==RESULT_CLASS||!match.state.winner||!Number.isFinite(at))throw Error('LOCAL_AI_RESULT_NOT_FINISHED');const rows=Array.isArray(data.localAiRecords)?data.localAiRecords:[];if(rows.some(r=>r.id===match.id))return false;
 const result=match.state.winner==='DRAW'?'draw':match.state.winner==='X'?'win':'loss';
 data.localAiRecords=[...rows.slice(-1999),{id:match.id,resultClass:RESULT_CLASS,difficulty:match.difficulty,modelHash:match.pin.modelHash,packVersion:match.pin.packVersion,result,moves:match.state.moves.length,at}];return true;
}
function stats(data){const rows=(Array.isArray(data.localAiRecords)?data.localAiRecords:[]).filter(r=>r.resultClass===RESULT_CLASS&&['win','loss','draw'].includes(r.result));return {games:rows.length,wins:rows.filter(r=>r.result==='win').length,draws:rows.filter(r=>r.result==='draw').length,losses:rows.filter(r=>r.result==='loss').length};}
return {VERSION,RESULT_CLASS,create,snapshot,restore,accept,expertFallback,record,stats};
});
