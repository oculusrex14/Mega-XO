'use strict';
// Explicit journal -> task ledger/checkmarks. Never infers device or release passes.
const fs=require('node:fs'),path=require('node:path');
const base='docs/v5.1/bot-ai',ledgerPath=base+'/progress.json',checklistPath=base+'/IMPLEMENTATION.md';
const journalPath=process.argv[2];if(!journalPath||!path.resolve(journalPath).startsWith(path.resolve(base+'/evidence')+path.sep))throw Error('EXPECTED_EVIDENCE_JOURNAL');
const ledger=JSON.parse(fs.readFileSync(ledgerPath,'utf8')),journal=JSON.parse(fs.readFileSync(journalPath,'utf8'));
for(const [id,entry] of Object.entries(journal.checkpoints||{})){if(!/^[0-9a-f]{40}$/.test(entry.commit||''))throw Error('CHECKPOINT_REQUIRES_COMMIT');ledger.checkpoints[id]=entry;}
for(const [id,entry] of Object.entries(journal.tasks||{})){if(!Object.hasOwn(ledger.tasks,id))throw Error('UNKNOWN_TASK '+id);if(!['DONE','PARTIAL','IN_PROGRESS','PLANNED','BLOCKED','DEFERRED'].includes(entry.status))throw Error('INVALID_STATUS');if(entry.checkpoint&&!ledger.checkpoints[entry.checkpoint])throw Error('UNKNOWN_CHECKPOINT');if(entry.status==='DONE'&&!entry.commit&&!entry.checkpoint)throw Error('DONE_REQUIRES_COMMIT_EVIDENCE');ledger.tasks[id]={...ledger.tasks[id],...entry};}
Object.assign(ledger.phases,journal.phases||{});
const text=fs.readFileSync(checklistPath,'utf8'),ids=[...text.matchAll(/^- \[[ x]\] \*\*(B\d\d\.\d\d)\*\*/gm)].map(m=>m[1]);
if(ids.length!==82||new Set(ids).size!==82||Object.keys(ledger.tasks).length!==82||ids.some(id=>!Object.hasOwn(ledger.tasks,id)))throw Error('CHECKLIST_ID_MISMATCH');
const updated=text.replace(/^- \[[ x]\] (\*\*(B\d\d\.\d\d)\*\*)/gm,(_,label,id)=>'- ['+(ledger.tasks[id].status==='DONE'?'x':' ')+'] '+label);
fs.writeFileSync(ledgerPath,JSON.stringify(ledger,null,2)+'\n');fs.writeFileSync(checklistPath,updated);
console.log(JSON.stringify(ids.reduce((counts,id)=>{const status=ledger.tasks[id].status||ledger.defaults.status;counts[status]=(counts[status]||0)+1;return counts;},{})));
