/* Reusable local Impossible lifecycle controller; never an official economy or Elo authority. */
(function(root,factory){
  const api=factory(
    typeof module==='object'?require('../game.js'):root.MegaGame,
    typeof module==='object'?require('./contracts.js'):root.MegaBotContract,
    typeof module==='object'?require('./pack.js'):root.MegaBotPack,
    typeof module==='object'?require('./local-ai.js'):root.MegaLocalAI,
    typeof module==='object'?require('./neural-runtime.js'):root.MegaBotNeuralRuntime,
    typeof module==='object'?require('./runtime.js'):root.MegaBotRuntime
  );
  if(typeof module==='object')module.exports=api;
  else root.MegaLocalSession=api;
})(globalThis,(G,C,P,L,NR,BR)=>{
'use strict';
const VERSION='local-session-v1';
let globalTrustedCatalog=null;

function getActiveCatalog(catalog){
  if(Array.isArray(catalog))return catalog;
  if(Array.isArray(globalTrustedCatalog))return globalTrustedCatalog;
  return P.APPROVED_CATALOG;
}

class Session {
  constructor({
    baseURL,
    catalog=null,
    store=null,
    runtime=null,
    legacyClient=null,
    workerFactory=null,
    onState=()=>{}
  }={}){
    this.baseURL=baseURL||(typeof location!=='undefined'?location.href:'https://game.example/');
    this.catalog=getActiveCatalog(catalog);
    this.onState=onState;
    this.generation=0;
    this.store=store||new P.Store({
      baseURL:this.baseURL,
      catalog:this.catalog,
      onState:s=>this.emit('store',s)
    });
    this.runtime=runtime||new NR.Client({
      baseURL:this.baseURL,
      workerFactory,
      onState:s=>this.emit('runtime',s)
    });
    this.legacyClient=legacyClient||(BR?new BR.Client():null);
    this.match=null;
    this.state={status:'idle',match:null,error:null};
  }

  setCatalog(catalog){
    this.catalog=getActiveCatalog(catalog);
    if(this.store)this.store.catalog=this.catalog;
  }

  getCatalog(){
    return this.catalog;
  }

  getStore(){
    return this.store;
  }

  getRuntime(){
    return this.runtime;
  }

  getMatch(){
    return this.match;
  }

  emit(type,detail={}){
    this.state={...this.state,type,detail};
    try{this.onState({...this.state});}catch{}
    return this.state;
  }

  getLatestManifest(){
    const latest=this.catalog.filter(x=>x.deploymentStatus==='APPROVED').at(-1);
    if(!latest)return null;
    return P.manifest(latest,this.baseURL);
  }

  isAvailable(){
    const info=this.getLatestManifest();
    if(!info)return false;
    return this.store.state?.status==='ready'&&this.store.state?.modelHash===info.sha256;
  }

  async prepareModel({consent=false,signal}={}){
    const gen=++this.generation;
    const info=this.getLatestManifest();
    if(!info){
      const err=Error('NO_APPROVED_MODEL');
      err.code='NO_APPROVED_MODEL';
      throw err;
    }
    let bytes=null;
    try{
      bytes=await this.store.read(info);
    }catch(e){
      if(e?.name==='AbortError')throw e;
    }
    if(gen!==this.generation){
      const err=Error('SESSION_CANCELLED');
      err.name='AbortError';
      throw err;
    }
    if(!bytes){
      if(!consent){
        const err=Error('PACK_CONSENT_REQUIRED');
        err.code='PACK_CONSENT_REQUIRED';
        throw err;
      }
      bytes=await this.store.download(info,{consent:true,signal});
    }
    if(gen!==this.generation){
      const err=Error('SESSION_CANCELLED');
      err.name='AbortError';
      throw err;
    }
    await this.runtime.configure(info,bytes,{signal});
    if(gen!==this.generation){
      const err=Error('SESSION_CANCELLED');
      err.name='AbortError';
      throw err;
    }
    const pin=this.store.pin(info);
    return {manifest:info,pin,bytes};
  }

  startMatch({id,first='X',seed=0,pin=null}={}){
    if(!id){
      id=typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random();
    }
    let resolvedPin=pin;
    if(!resolvedPin){
      const info=this.getLatestManifest();
      if(!info)throw Error('LOCAL_AI_MATCH_NOT_APPROVED');
      resolvedPin=this.store.pin(info);
    }
    const match=L.create({id,first,pin:resolvedPin,seed},this.catalog);
    this.match=match;
    this.emit('match-started',{match:this.match});
    return this.match;
  }

  async restoreMatch(saved){
    const restored=L.restore(saved,this.catalog);
    this.match=restored;
    if(restored.engine==='neural'&&restored.status==='ready'){
      const info=this.catalog.find(m=>m.sha256===restored.pin.modelHash&&m.version===restored.pin.packVersion);
      if(!info){
        this.match.status='pack-unavailable';
      }else{
        try{
          const manifest=P.manifest(info,this.baseURL);
          const bytes=await this.store.read(manifest);
          if(!bytes||bytes.length!==manifest.bytes){
            this.match.status='pack-unavailable';
          }else{
            await this.runtime.configure(manifest,bytes);
          }
        }catch{
          this.match.status='pack-unavailable';
        }
      }
    }
    this.emit('match-restored',{match:this.match});
    return this.match;
  }

  applyHumanMove(move){
    if(!this.match||this.match.state.winner)throw Error('MATCH_NOT_ACTIVE');
    if(this.match.state.turn!=='X')throw Error('NOT_HUMAN_TURN');
    const legal=G.legal(this.match.state);
    if(!legal.some(m=>m.b===move.b&&m.c===move.c))throw Error('ILLEGAL_MOVE');
    const nextState=G.apply(this.match.state,move);
    this.match={
      ...this.match,
      state:nextState,
      status:nextState.winner?'finished':'ready'
    };
    this.emit('human-move',{match:this.match,move});
    return this.match;
  }

  async chooseMove({signal,budgetMs=2600,allowMainThreadFallback=false}={}){
    if(!this.match||this.match.state.winner)throw Error('MATCH_NOT_ACTIVE');
    if(this.match.state.turn!=='O')throw Error('NOT_BOT_TURN');
    if(this.match.status!=='ready')throw Error('LOCAL_AI_NOT_READY');

    if(this.match.engine==='neural'){
      const revision=this.match.state.moves.length;
      const job={
        state:this.match.state,
        gameId:this.match.id,
        revision,
        seed:this.match.seed,
        modelHash:this.match.pin.modelHash,
        budgetMs
      };
      const result=await this.runtime.choose(job,{signal});
      this.match=L.accept(this.match,result);
      this.emit('bot-move',{match:this.match,move:result.move,diagnostics:result.diagnostics});
      return {move:result.move,diagnostics:result.diagnostics,match:this.match};
    }

    if(this.match.engine==='legacy'){
      const revision=this.match.state.moves.length;
      const seed=((this.match.seed||0)^Math.imul(revision+1,0x9e3779b9))>>>0;
      let move=null,diagnostics=null;
      if(this.legacyClient){
        try{
          const result=await this.legacyClient.choose({
            state:this.match.state,
            gameId:this.match.id,
            revision,
            difficulty:'Expert',
            engine:'legacy',
            seed
          },{signal});
          move=result.move;
          diagnostics={engine:'legacy',fallback:true,modelHash:this.match.pin.modelHash,...result.diagnostics};
        }catch(e){
          if(e?.name==='AbortError'||!allowMainThreadFallback)throw e;
          const started=(typeof performance!=='undefined'?performance.now():Date.now());
          move=G.choose(this.match.state,'Expert',C.seeded(seed));
          diagnostics={engine:'legacy',fallback:true,modelHash:this.match.pin.modelHash,recoveryCode:e?.code||'LEGACY_WORKER_FAILED',elapsedMs:(typeof performance!=='undefined'?performance.now():Date.now())-started};
        }
      }else if(allowMainThreadFallback){
        const started=(typeof performance!=='undefined'?performance.now():Date.now());
        move=G.choose(this.match.state,'Expert',C.seeded(seed));
        diagnostics={engine:'legacy',fallback:true,modelHash:this.match.pin.modelHash,recoveryCode:'NO_LEGACY_CLIENT',elapsedMs:(typeof performance!=='undefined'?performance.now():Date.now())-started};
      }else{
        const err=Error('LEGACY_WORKER_UNAVAILABLE');
        err.code='LEGACY_WORKER_UNAVAILABLE';
        throw err;
      }
      const result={gameId:this.match.id,revision,move,diagnostics};
      this.match=L.accept(this.match,result);
      this.emit('bot-move',{match:this.match,move,diagnostics});
      return {move,diagnostics,match:this.match};
    }
    throw Error('UNKNOWN_ENGINE');
  }

  expertFallback({confirmed=false}={}){
    if(!this.match)throw Error('MATCH_NOT_ACTIVE');
    this.runtime.cancel('EXPERT_FALLBACK',true);
    this.match=L.expertFallback(this.match,{confirmed});
    this.emit('expert-fallback',{match:this.match});
    return this.match;
  }

  async retryModelLoad({consent=false,signal}={}){
    if(!this.match)throw Error('MATCH_NOT_ACTIVE');
    if(this.match.engine!=='neural')return this.match;
    const gen=++this.generation;
    const info=this.catalog.find(m=>m.sha256===this.match.pin.modelHash&&m.version===this.match.pin.packVersion);
    if(!info){
      this.match.status='pack-unavailable';
      return this.match;
    }
    const manifest=P.manifest(info,this.baseURL);
    let bytes=null;
    try{bytes=await this.store.read(manifest);}catch(e){if(e?.name==='AbortError')throw e;}
    if(gen!==this.generation)return this.match;
    if(!bytes){
      if(!consent){
        this.match.status='pack-unavailable';
        return this.match;
      }
      bytes=await this.store.download(manifest,{consent:true,signal});
    }
    if(gen!==this.generation)return this.match;
    await this.runtime.configure(manifest,bytes,{signal});
    if(gen!==this.generation)return this.match;
    this.match.status='ready';
    this.emit('model-reloaded',{match:this.match});
    return this.match;
  }

  cancel(code='LOCAL_SESSION_CANCELLED'){
    this.generation++;
    this.runtime.cancel(code,true);
    this.legacyClient?.cancel(code,true);
  }
  snapshot(){
    if(!this.match)return null;
    return L.snapshot(this.match);
  }

  recordMatch(data,{at=Date.now()}={}){
    if(!this.match)return false;
    return L.record(data,this.match,{at});
  }

  stats(data){
    return L.stats(data);
  }

  getRuntimeStatus(){
    return {
      sessionStatus:this.state?.status||'idle',
      storeStatus:this.store?.state?.status||'unavailable',
      runtimeStatus:this.runtime?.state?.status||'unavailable',
      modelHash:this.runtime?.state?.modelHash||this.store?.state?.modelHash||null,
      match:this.match?{
        id:this.match.id,
        difficulty:this.match.difficulty,
        engine:this.match.engine,
        resultClass:this.match.resultClass,
        status:this.match.status,
        revision:this.match.state.moves.length,
        modelHash:this.match.pin?.modelHash||null,
        fallbackFrom:this.match.fallbackFrom||null
      }:null
    };
  }

  destroy(){
    this.cancel('SESSION_DESTROYED');
    this.runtime.unload();
    this.match=null;
    this.emit('destroyed');
  }
}

function createSession(options={}){
  return new Session(options);
}

function setTrustedCatalog(catalog){
  globalTrustedCatalog=Array.isArray(catalog)?catalog:null;
}

function getTrustedCatalog(){
  return globalTrustedCatalog;
}

return {
  VERSION,
  Session,
  createSession,
  setTrustedCatalog,
  getTrustedCatalog
};
});
