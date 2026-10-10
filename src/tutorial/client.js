/* Guided practice UI. No network, currency or alternative game state. */
(function(root){
'use strict';
const L=root.MegaLesson,G=root.MegaGame;
let host=null,lesson=null,gameId=null,panel=null,key='',confirmRestart=false,hiddenTips=false;
const $=s=>document.querySelector(s);
function current(match){return !!lesson&&match?.practice===true&&!match.online&&match.id===gameId;}
function blocked(match){return current(match)&&(lesson.phase!=='DONE'||confirmRestart);}
function stopSpeech(){try{root.speechSynthesis?.cancel();}catch{}}
function localVoice(){try{return root.speechSynthesis?.getVoices().find(v=>v.localService===true&&/^en(?:-|$)/i.test(v.lang));}catch{return null;}}
function speak(text){stopSpeech();if(!lesson?.narrationEnabled||document.hidden)return;const voice=localVoice();if(!voice||!root.SpeechSynthesisUtterance)return;const utterance=new root.SpeechSynthesisUtterance(text);utterance.voice=voice;utterance.lang=voice.lang;utterance.volume=lesson.volume;root.speechSynthesis.speak(utterance);}
function cleanHighlights(){document.querySelectorAll('.tutorial-cell,.tutorial-destination').forEach(n=>n.classList.remove('tutorial-cell','tutorial-destination'));document.querySelectorAll('[data-tutorial-described]').forEach(n=>{n.removeAttribute('aria-describedby');delete n.dataset.tutorialDescribed;});}
function stop(){stopSpeech();lesson=null;gameId=null;key='';confirmRestart=false;hiddenTips=false;if(panel)panel.hidden=true;$('#gameScreen')?.removeAttribute('data-guided');cleanHighlights();}
function start(match){stop();if(!match.practice||match.online)return;lesson=L.create(match.state);gameId=match.id;}
function restore(match,saved){stop();if(!match.practice||match.online)return;lesson=L.restore(saved,match.state);gameId=match.id;hiddenTips=lesson.phase==='DONE';if(lesson.reason==='incompatible-save'&&saved)host?.notify('Your board was restored. Guidance could not resume; continue unpaid practice or restart the tutorial.');}
function snapshot(match){return current(match)?{...lesson}:null;}
function allows(match,move){return !blocked(match)||(!confirmRestart&&L.allows(lesson,match.state,move));}
function permits(match,move,source){if(!blocked(match))return true;if(confirmRestart||document.hidden||!L.valid(lesson,match.state))return false;if(source==='human')return L.allows(lesson,match.state,move);const expected=L.advance(lesson,match.state,'continue').move;return !!expected&&move.b===expected.b&&move.c===expected.c;}
function after(match,before,move){if(!blocked(match))return;lesson=L.committed(lesson,before,move,match.state);}
function hint(){const match=host?.getMatch();if(!current(match))return;const v=L.view(lesson,match.state);host.notify(v.hint);if(v.move)requestAnimationFrame(()=>$('.tutorial-cell')?.focus());}
function button(label,action,quiet=false){const n=document.createElement('button');n.type='button';n.className='button'+(quiet?' quiet':'');n.dataset.tutor=action;n.textContent=label;return n;}
function ensurePanel(){if(panel)return;panel=document.createElement('section');panel.id='guidedPractice';panel.className='guided-practice';panel.setAttribute('role','region');panel.setAttribute('aria-labelledby','guidedTitle');$('#boardWrap').before(panel);panel.addEventListener('click',e=>{const b=e.target.closest('[data-tutor]');if(b&&!b.disabled)act(b.dataset.tutor);});panel.addEventListener('input',e=>{if(e.target.id==='guidedVolume'&&lesson){lesson.volume=Number(e.target.value);host.save();}});}
function focusNext(v){requestAnimationFrame(()=>{if(document.hidden||!$('#sheet')?.hidden)return;const target=v.move?$('.tutorial-cell'):$('#guidedTitle');target?.focus({preventScroll:true});});}
function render(match){cleanHighlights();const active=current(match)&&!match.state.winner&&!hiddenTips;$('#gameScreen')?.toggleAttribute('data-guided',active);if(!active){if(panel)panel.hidden=true;return;}ensurePanel();panel.hidden=false;
 if(!L.valid(lesson,match.state)){restore(match,null);if(panel)panel.hidden=true;return;}
 const v=L.view(lesson,match.state),newKey=[gameId,lesson.phase,lesson.gameRevision,lesson.narrationEnabled,!!localVoice(),confirmRestart].join(':');
 if(blocked(match)){
  document.querySelectorAll('#board .cell').forEach(n=>{const move={b:Number(n.dataset.b),c:Number(n.dataset.c)};n.disabled=confirmRestart||!L.allows(lesson,match.state,move);if(!n.disabled){n.classList.add('tutorial-cell');n.setAttribute('aria-describedby','guidedCaption');n.dataset.tutorialDescribed='true';}});
  for(let b=0;b<9;b++)if(!match.state.mini[b]&&(match.state.required===null||match.state.required===b))$('[data-board="'+b+'"]').classList.add('tutorial-destination');
 }
 if(newKey===key)return;key=newKey;panel.replaceChildren();
 const title=document.createElement('h2');title.id='guidedTitle';title.tabIndex=-1;title.textContent=confirmRestart?'Restart this practice match?':v.title;
 const caption=document.createElement('p');caption.id='guidedCaption';caption.tabIndex=-1;caption.setAttribute('role','status');caption.setAttribute('aria-live','polite');caption.setAttribute('aria-atomic','true');caption.textContent=confirmRestart?'This clears only this unpaid practice board. Your account and normal statistics are unchanged.':v.text;
 const progress=document.createElement('p');progress.className='guided-progress';progress.textContent=lesson.phase==='DONE'?'Unpaid Beginner practice':'Guided moves '+lesson.guidedMoves+' / 6';panel.append(progress,title,caption);
 if(lesson.phase==='PROMPT'&&!confirmRestart){const maps=document.createElement('div');maps.className='guided-maps';maps.setAttribute('role','img');maps.setAttribute('aria-label','Three X marks claim one Mini Board. Three claimed Mini Boards in a line win the Mega Board.');maps.innerHTML='<span>Mini Board<br><b>X X X</b></span><span aria-hidden="true">&#8594;</span><span>Mega Board<br><b>[X] [X] [X]</b></span>';panel.append(maps);}
 const controls=document.createElement('div');controls.className='guided-controls';
 if(confirmRestart){controls.append(button('Restart now','restart-confirm'),button('Keep playing','restart-cancel',true));}
 else if(lesson.phase==='DONE'){controls.append(button('Hide tips','hide',true),button('Restart tutorial','restart',true));}
 else {if(lesson.phase!=='AWAIT_MOVE')controls.append(button(lesson.phase==='PROMPT'?'Show my first move':lesson.gameRevision===6?'Play from here':'Continue','continue'));else controls.append(button('Hint','hint',true));controls.append(button('Skip guidance','skip',true));}
 panel.append(controls);
 if(!confirmRestart&&lesson.phase!=='DONE'){
  const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Explanation and audio';details.append(summary);const extra=document.createElement('div');extra.className='guided-controls';extra.append(button('Replay explanation','replay',true),button('Restart tutorial','restart',true));
  const voice=button(lesson.narrationEnabled?'Mute narration':'Enable narration','voice',true);voice.disabled=!localVoice();voice.setAttribute('aria-pressed',String(lesson.narrationEnabled));extra.append(voice);details.append(extra);
  const label=document.createElement('label');label.htmlFor='guidedVolume';label.textContent='Narration volume';const range=document.createElement('input');range.id='guidedVolume';range.type='range';range.min='0';range.max='1';range.step='.1';range.value=String(lesson.volume);range.disabled=!localVoice();label.append(range);details.append(label);
  const note=document.createElement('p');note.className='guided-progress';note.textContent=localVoice()?'Optional device voice; the captions are identical.':'No local English voice is available. All instructions remain on screen.';details.append(note);panel.append(details);
 }
 focusNext(v);speak(caption.textContent);
}
function act(action){const match=host?.getMatch();if(!current(match)||document.hidden||!$('#sheet')?.hidden)return;
 if(action==='restart'){confirmRestart=true;render(match);return;}
 if(action==='restart-cancel'){confirmRestart=false;host.paint();host.scheduleBot();return;}
 if(action==='restart-confirm'){stop();host.restart();return;}
 if(action==='hide'){hiddenTips=true;stopSpeech();host.paint();return;}
 if(action==='hint'){hint();return;}
 if(action==='replay'){const v=L.view(lesson,match.state);host.notify('Explanation repeated. The board is unchanged.');speak(v.text);$('#guidedCaption')?.focus();return;}
 if(action==='voice'){if(localVoice()){lesson.narrationEnabled=!lesson.narrationEnabled;host.save();render(match);}return;}
 const transition=L.advance(lesson,match.state,action);lesson=transition.lesson;
 if(transition.move){host.commitBot(transition.move);return;}
 host.paint();host.save();host.scheduleBot();
}
function bind(adapter){host=adapter;document.addEventListener('visibilitychange',()=>{if(document.hidden)stopSpeech();});root.speechSynthesis?.addEventListener?.('voiceschanged',()=>{if(host)render(host.getMatch());});}
root.MegaTutorial=Object.freeze({bind,start,stop,restore,snapshot,blocked,allows,permits,after,render,hint});
})(globalThis);
