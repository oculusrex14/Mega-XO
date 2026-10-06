'use strict';
class StorePurchaseProvider{
 constructor({google=null,apple=null}={}){this.google=google;this.apple=apple;if(!google&&!apple)throw Error('STORE_PROVIDER_CONFIG');}
 stores(){return [['google',this.google],['apple',this.apple]].filter(([,v])=>!!v).map(([k])=>k);}
 async verify(evidence,actor,binding){
  const provider=evidence?.store==='google'?this.google:evidence?.store==='apple'?this.apple:null;if(!provider)throw Error('STORE_UNAVAILABLE');
  return provider.verify(evidence,actor,binding);
 }
 async finalize(receipt){const provider=receipt?.store==='google'?this.google:receipt?.store==='apple'?this.apple:null;if(!provider)return false;return provider.finalize?provider.finalize(receipt):true;}
 async processDue(hasReceipt){return this.google?.processDue?this.google.processDue(hasReceipt):{processed:0,completed:0};}
}
module.exports={StorePurchaseProvider};
