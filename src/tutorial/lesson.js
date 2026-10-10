/* Declarative, versioned guidance over canonical MegaGame states. */
(function(root,factory){const api=factory(typeof module==='object'?require('../game.js'):root.MegaGame);if(typeof module==='object')module.exports=api;else root.MegaLesson=api;})(globalThis,(G)=>{
'use strict';
const VERSION='guided-practice-v1';
const SCRIPT=Object.freeze([{b:0,c:4},{b:4,c:0},{b:0,c:3},{b:3,c:0},{b:0,c:5},{b:5,c:0}].map(Object.freeze));
const TEXT=Object.freeze([
 {title:'Your first move',text:'Play the centre cell of the top-left Mini Board. Your cell sends the bot to the centre Mini Board.',hint:'Choose the outlined centre cell in the top-left board.'},
 {title:'Your cell chose the next board',text:'You played the centre cell, so the bot must play in the centre Mini Board. Continue to see its move send you back to the top-left.',hint:'A cell position names the next Mini Board.'},
 {title:'Build a row',text:'The bot played a top-left cell, sending you back to the top-left Mini Board. Play middle-left to put two X marks in a row.',hint:'Choose the outlined middle-left cell beside your X.'},
 {title:'Follow the route',text:'Your middle-left cell sent the bot to the middle-left Mini Board. Continue to see the bot send you back again.',hint:'Watch the highlighted destination, not just the board where the last mark was placed.'},
 {title:'Claim your first Mini Board',text:'Play middle-right to complete three X marks across the middle row. This claims one Mini Board, not the whole match.',hint:'Complete the row with the outlined middle-right cell.'},
 {title:'One Mini Board is yours!',text:'Three X marks claimed the top-left Mini Board. You need three claimed Mini Boards in a line to win the Mega Board. Continue for the bot to send you to that closed board.',hint:'Your large X is one of the three Mini Boards needed for a Mega Board line.'},
 {title:'Closed destination means free choice',text:'The bot chose a top-left cell, but you already own that Mini Board. You may now choose any open Mini Board. The script is over: keep this position and play a real Beginner match.',hint:'Any empty cell in any open Mini Board is legal now. Try building another Mini Board while watching where you send the bot.'}
]);
function done(reason='skipped'){return {lessonVersion:VERSION,stepId:'done',phase:'DONE',gameRevision:0,practice:true,guidedMoves:0,narrationEnabled:false,volume:.8,paused:false,reason};}
function create(state){if(state.moves.length||state.turn!=='X'||state.winner)throw Error('TUTORIAL_REQUIRES_NEW_X_PRACTICE');return {...done(),stepId:'objective',phase:'PROMPT',paused:true,reason:null};}
function valid(l,state){if(!l||l.lessonVersion!==VERSION||l.practice!==true)return false;if(l.phase==='DONE')return true;
 if(!['PROMPT','AWAIT_MOVE','AWAIT_CONTINUE'].includes(l.phase)||l.gameRevision!==state.moves.length||state.moves.length>6)return false;
 if(l.phase==='PROMPT'&&state.moves.length!==0)return false;
 if(l.phase==='AWAIT_MOVE'&&![0,2,4].includes(state.moves.length))return false;
 if(l.phase==='AWAIT_CONTINUE'&&![1,3,5,6].includes(state.moves.length))return false;
 let expected=G.create();try{for(let i=0;i<state.moves.length;i++){const m=state.moves[i];if(m.b!==SCRIPT[i].b||m.c!==SCRIPT[i].c||m.player!==expected.turn)return false;expected=G.apply(expected,m);}}catch{return false;}
 return ['board','mini','turn','required','winner','line'].every(k=>JSON.stringify(expected[k])===JSON.stringify(state[k]));
}
function restore(saved,state){if(!valid(saved,state))return {...done('incompatible-save'),gameRevision:state.moves.length};return {...saved,paused:saved.phase!=='DONE',narrationEnabled:saved.narrationEnabled===true,volume:Number.isFinite(saved.volume)?Math.max(0,Math.min(1,saved.volume)):.8};}
function view(l,state){if(!valid(l,state))throw Error('TUTORIAL_STATE_MISMATCH');if(l.phase==='DONE')return {title:'Keep playing',text:'Guidance is off. This is still unpaid Beginner practice. Claim three Mini Boards in a line to win.',hint:'Watch where your cell sends the bot.',move:null};
 if(l.phase==='PROMPT')return {title:'Small boards. One big goal.',text:'Make three marks in a row to claim a Mini Board. Claim three Mini Boards in a row, column or diagonal to win the Mega Board. We will guide your first six moves; then you take over.',hint:'Start with one Mini Board, then build a line of three.',move:null};
 return {...TEXT[state.moves.length],move:l.phase==='AWAIT_MOVE'?SCRIPT[state.moves.length]:null};
}
function allows(l,state,move){if(!l||l.phase==='DONE')return true;return valid(l,state)&&l.phase==='AWAIT_MOVE'&&move.b===SCRIPT[state.moves.length].b&&move.c===SCRIPT[state.moves.length].c;}
function advance(l,state,action,{hidden=false}={}){if(!valid(l,state))throw Error('TUTORIAL_STATE_MISMATCH');if(hidden)return {lesson:l,move:null};
 if(action==='skip')return {lesson:{...l,phase:'DONE',stepId:'done',paused:false,reason:'skipped'},move:null};
 if(action!=='continue'||l.phase==='DONE')return {lesson:l,move:null};
 if(l.phase==='PROMPT')return {lesson:{...l,phase:'AWAIT_MOVE',stepId:'move-1'},move:null};
 if(l.phase==='AWAIT_CONTINUE'&&state.moves.length===6)return {lesson:{...l,phase:'DONE',stepId:'done',paused:false,reason:'completed'},move:null};
 return {lesson:l,move:l.phase==='AWAIT_CONTINUE'?SCRIPT[state.moves.length]:null};
}
function committed(l,before,move,after){if(l.phase==='DONE')return l;if(!valid(l,before))throw Error('TUTORIAL_STATE_MISMATCH');const expected=SCRIPT[before.moves.length];
 if(!expected||expected.b!==move.b||expected.c!==move.c||!(l.phase==='AWAIT_MOVE'||l.phase==='AWAIT_CONTINUE'))throw Error('UNEXPECTED_GUIDED_MOVE');
 const n=after.moves.length,next={...l,gameRevision:n,guidedMoves:n,stepId:n===6?'free-route':'move-'+(n+1),phase:n===6||n%2?'AWAIT_CONTINUE':'AWAIT_MOVE'};
 if(n!==before.moves.length+1||!valid(next,after))throw Error('TUTORIAL_COMMIT_MISMATCH');return next;
}
return {VERSION,SCRIPT,TEXT,create,done,valid,restore,view,allows,advance,committed};
});
