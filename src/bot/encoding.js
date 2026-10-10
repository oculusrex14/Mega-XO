/* Tensor encoding v1, side-to-move perspective, canonical action b*9+c. */
(function(root,factory){const api=factory(typeof module==='object'?require('../game.js'):root.MegaGame);if(typeof module==='object')module.exports=api;else root.MegaBotEncoding=api;})(globalThis,(G)=>{
'use strict';
const VERSION='planes8-v1',CHANNELS=8;
function spatial(b,c){return (Math.floor(b/3)*3+Math.floor(c/3))*9+(b%3)*3+c%3;}
function encode(state){const planes=new Float32Array(CHANNELS*81),mask=new Uint8Array(81),own=state.turn,other=own==='X'?'O':'X';
 for(let b=0;b<9;b++)for(let c=0;c<9;c++){const i=spatial(b,c),mark=state.board[b][c];planes[i]=Number(mark===own);planes[81+i]=Number(mark===other);planes[162+i]=Number(state.mini[b]===own);planes[243+i]=Number(state.mini[b]===other);planes[324+i]=Number(state.mini[b]==='DRAW');planes[405+i]=Number(state.required===b&&!state.mini[b]);planes[567+i]=Number(state.required===null||!!state.mini[state.required]);}
 for(const {b,c} of G.legal(state)){mask[b*9+c]=1;planes[486+spatial(b,c)]=1;}
 return {version:VERSION,shape:[1,CHANNELS,9,9],planes,mask,player:own};
}
function mapIndex(index,symmetry){if(!Number.isInteger(index)||index<0||index>8||!Number.isInteger(symmetry)||symmetry<0||symmetry>7)throw Error('INVALID_SYMMETRY_INDEX');let r=Math.floor(index/3),c=index%3;if(symmetry>=4)c=2-c;for(let i=0;i<symmetry%4;i++)[r,c]=[c,2-r];return r*3+c;}
function mapMove(m,s){return {b:mapIndex(m.b,s),c:mapIndex(m.c,s)};}
function transform(state,symmetry){const board=Array.from({length:9},()=>Array(9).fill(null)),mini=Array(9).fill(null);
 for(let b=0;b<9;b++){const nb=mapIndex(b,symmetry);mini[nb]=state.mini[b];for(let c=0;c<9;c++)board[nb][mapIndex(c,symmetry)]=state.board[b][c];}
 return {...state,board,mini,required:state.required===null?null:mapIndex(state.required,symmetry),line:G.winner(mini)?.line||null,moves:state.moves.map(m=>({...mapMove(m,symmetry),player:m.player}))};
}
function transformPolicy(values,symmetry){if(values.length!==81)throw Error('INVALID_POLICY_SHAPE');const out=new Float32Array(81);for(let b=0;b<9;b++)for(let c=0;c<9;c++){const m=mapMove({b,c},symmetry);out[m.b*9+m.c]=values[b*9+c];}return out;}
function maskedPolicy(logits,mask){if(logits.length!==81||mask.length!==81)throw Error('INVALID_POLICY_SHAPE');const out=new Float32Array(81),legal=[];for(let i=0;i<81;i++)if(mask[i]){if(!Number.isFinite(logits[i]))throw Error('NONFINITE_POLICY');legal.push(i);}if(!legal.length)return out;
 const max=Math.max(...legal.map(i=>logits[i]));let sum=0;for(const i of legal){out[i]=Math.exp(logits[i]-max);sum+=out[i];}for(const i of legal)out[i]/=sum;return out;
}
function value(winner,player){if(!['X','O','DRAW'].includes(winner)||!['X','O'].includes(player))throw Error('INVALID_TERMINAL_TARGET');return winner==='DRAW'?0:winner===player?1:-1;}
return {VERSION,CHANNELS,spatial,encode,mapIndex,mapMove,transform,transformPolicy,maskedPolicy,value};
});
