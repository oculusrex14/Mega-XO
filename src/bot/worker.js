/* Classic worker: only local rules/search code. No auth, economy or network API client. */
'use strict';
importScripts('../game.js','contracts.js');
self.onmessage=event=>{const job=event.data;if(job?.op!=='choose')return;
 try{
  if(!['legacy','experimental','uct'].includes(job.engine)||!MegaGame.LEVELS.includes(job.difficulty)||typeof job.gameId!=='string'||job.revision!==job.state?.moves?.length)throw Error('INVALID_BOT_JOB');
  let result;const started=performance.now();
  if(job.engine==='legacy')result={move:MegaGame.choose(job.state,job.difficulty,MegaBotContract.seeded(job.seed)),diagnostics:{...MegaBotContract.diagnostics({difficulty:job.difficulty,seed:job.seed,budgetMs:({Beginner:0,Easy:0,Medium:55,Hard:140,Expert:320})[job.difficulty]}),engineVersion:'canonical-legacy',elapsedMs:performance.now()-started}};
  else {if(!self.MegaBotSearch)importScripts('board.js','search.js');result=MegaBotSearch[job.engine==='uct'?'mcts':'choose'](job.state,job);}
  MegaBotContract.assertMove(job.state,result.move);
  self.postMessage({...result,requestId:job.requestId,gameId:job.gameId,revision:job.revision});
 }catch{self.postMessage({requestId:job.requestId,gameId:job.gameId,revision:job.revision,error:'BOT_SEARCH_FAILED'});}
};
