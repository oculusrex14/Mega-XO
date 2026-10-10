/* Local-only bot contract. No network, account, wallet or ranking authority. */
(function(root,factory){const api=factory(typeof module==='object'?require('../game.js'):root.MegaGame);if(typeof module==='object')module.exports=api;else root.MegaBotContract=api;})(globalThis,(G)=>{
'use strict';
const VERSION='bot-contract-v1',RULESET='mega-xoxo-canonical-v1';
function seeded(seed){let n=Number(seed)>>>0;return ()=>{n=(n+0x6d2b79f5)>>>0;let t=Math.imul(n^(n>>>15),n|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};}
function sameMove(a,b){return !!a&&!!b&&a.b===b.b&&a.c===b.c;}
function assertMove(state,move){if(!G.legal(state).some(m=>sameMove(m,move)))throw Error('ILLEGAL_BOT_MOVE');return {b:move.b,c:move.c};}
function diagnostics({difficulty,seed,budgetMs,modelHash=null}={}){return {version:VERSION,ruleset:RULESET,difficulty,modelHash,rngSeed:Number(seed)>>>0,thinkingBudget:{budgetMs}};}
function accept({state,gameId,revision},result){if(!result||result.gameId!==gameId||result.revision!==revision||state.moves.length!==revision)throw Error('STALE_BOT_RESULT');return assertMove(state,result.move);}
return {VERSION,RULESET,seeded,sameMove,assertMove,diagnostics,accept};
});
