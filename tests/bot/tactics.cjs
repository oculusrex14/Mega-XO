'use strict';
const G=require('../../src/game.js');
const C=require('../../src/bot/contracts.js');
// Goals allow multiple correct actions. Positions retain canonical move histories.
function goals(state){
 const player=state.turn,other=player==='X'?'O':'X';
 return G.legal(state).map(move=>{const next=G.apply(state,move),replies=G.legal(next);
 return {move,megaWin:next.winner===player,miniWin:next.mini[move.b]===player&&state.mini[move.b]!==player,freeRoute:next.required===null,drawnDestination:next.mini[move.c]==='DRAW',closedDestination:!!next.mini[move.c],losesNext:replies.some(reply=>G.apply(next,reply).winner===other),givesMini:replies.some(reply=>G.apply(next,reply).mini[reply.b]===other&&next.mini[reply.b]!==other)};});
}
function verifyCritical(state,move){const options=goals(state),chosen=options.find(x=>C.sameMove(x.move,move));if(!chosen)return false;
 if(options.some(x=>x.megaWin))return chosen.megaWin;
 if(options.some(x=>!x.losesNext))return !chosen.losesNext;
 return true;
}
function corpus({games=12,seed=54}={}){const rng=C.seeded(seed),cases={opening:G.create()};
 for(let n=0;n<games;n++){let s=G.create(n%2?'O':'X');while(!s.winner){const legal=G.legal(s);if(s.moves.length>20){const opts=goals(s),retain=(name,p)=>{if(!cases[name]&&p)cases[name]=s;};retain('mega-win',opts.some(x=>x.megaWin));retain('mandatory-global-defense',!opts.some(x=>x.megaWin)&&opts.some(x=>x.losesNext)&&opts.some(x=>!x.losesNext));retain('mini-win',opts.some(x=>x.miniWin));retain('closed-route',opts.some(x=>x.closedDestination));retain('drawn-route',opts.some(x=>x.drawnDestination));retain('send-danger',opts.some(x=>x.givesMini)&&opts.some(x=>!x.givesMini));retain('late-forced',legal.length===1);retain('free-choice',s.required===null&&s.mini.some(Boolean));}
 s=G.apply(s,legal[Math.floor(rng()*legal.length)]);}}
 return Object.entries(cases).map(([id,state])=>({id,first:state.moves[0]?.player||state.turn,moves:state.moves,expected:{required:state.required,mini:state.mini,winner:state.winner},goals:goals(state)}));
}
module.exports={goals,verifyCritical,corpus};
