'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const game = require('../src/game.js');
const source = fs.readFileSync(require.resolve('../apps/web/board.js'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
function harness() {
  const listeners = new Map();
  const host = {dataset:{}, addEventListener:(type,fn)=>listeners.set(type,fn), removeEventListener:()=>{}, contains:()=>true, querySelector:()=>null, querySelectorAll:()=>[], innerHTML:''};
  return {host, action: action=>listeners.get('click')({target:{closest:()=>({dataset:{gbAction:action}})}})};
}
test('game workspace keeps scores and move totals authoritative; home preview retains its HUD', async()=>{
  const ui=await modulePromise;
  globalThis.MegaGame=game;
  try {
    const state=ui.generatePreviewState(game);
    const snapshot={id:'match-ui',status:'PLAYING',state,revision:state.moves.length,symbols:{X:'me',O:'them'},playerNames:{them:'<img onerror=alert(1)>'}};
    const html=ui.renderGame({match:snapshot,actorId:'me'});
    for(const player of ['X','O']) assert.ok(html.includes(`${state.mini.filter(v=>v===player).length} small boards won`));
    assert.ok(html.includes(`<strong>${state.moves.length}</strong>`));
    assert.ok(html.includes('&lt;img onerror=alert(1)&gt;'));
    assert.doesNotMatch(html,/data-gb-action="fresh"|data-gb-powers|data-gb-action="rematch"/);
    const preview=ui.renderPreview();
    assert.match(preview,/gb-hud/);assert.doesNotMatch(preview,/gb-dashboard|Game Setup|gb-power-cards/);
  }finally{delete globalThis.MegaGame;}
});
test('sharing an online game includes no private match or actor identifiers',async()=>{
  const ui=await modulePromise;globalThis.MegaGame=game;
  const originalWindow=globalThis.window,originalNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  const shared=[];
  globalThis.window={location:{href:'https://megaxo.online/game?private=secret'}};
  Object.defineProperty(globalThis,'navigator',{value:{share:async value=>shared.push(value)},configurable:true});
  try{const h=harness(),snapshot={id:'private-match-id',status:'PLAYING',state:game.create(),symbols:{X:'private-actor',O:'other'}};
    const mounted=ui.mountBoard(h.host,{online:{match:snapshot,actorId:'private-actor',onMove:()=>{throw Error('sharing is not a move');}}});
    h.action('share');assert.equal(shared.length,1);assert.equal(shared[0].url,'https://megaxo.online/game');assert.equal(mounted.getState().moves.length,0);mounted.destroy();
  }finally{globalThis.window=originalWindow;if(originalNavigator)Object.defineProperty(globalThis,'navigator',originalNavigator);else delete globalThis.navigator;delete globalThis.MegaGame;}
});
