'use strict';
const fs=require('node:fs'),path=require('node:path');

const ROOT=path.resolve(__dirname,'..');
const REQUIRED=Object.freeze([
 'EXT-01','EXT-02','EXT-03','EXT-04','EXT-05',
 'EXT-07','EXT-08','EXT-09','EXT-10','EXT-11','EXT-12','EXT-13','EXT-14','EXT-15','EXT-16',
 'EXT-27','EXT-28','EXT-29','EXT-30'
]);

function parseLedger(text){
 const rows=new Map();
 for(const line of text.split(/\r?\n/)){
  if(!line.startsWith('| EXT-'))continue;
  const cells=line.split('|').slice(1,-1).map(x=>x.trim());
  if(cells.length<5)continue;
  rows.set(cells[0],{area:cells[1],status:cells[2],blocker:cells[3],evidence:cells[4]});
 }
 return rows;
}
function gate({tag=process.env.GITHUB_REF_NAME||'',sha=process.env.GITHUB_SHA||'',root=ROOT}={}){
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 const expected='v'+pkg.version;
 if(!/^v4\.\d+\.\d+$/.test(tag)||tag!==expected)throw Error('RELEASE_TAG_MUST_MATCH_PACKAGE_VERSION');
 if(!/^[a-f0-9]{40}$/.test(sha))throw Error('RELEASE_SHA_REQUIRED');
 const ledger=parseLedger(fs.readFileSync(path.join(root,'docs','V4-OPEN-BLOCKERS.md'),'utf8'));
 const missing=[],open=[];
 for(const id of REQUIRED){
  const row=ledger.get(id);
  if(!row)missing.push(id);
  else if(row.status!=='COMPLETE')open.push(id+':'+row.status);
 }
 if(missing.length)throw Error('RELEASE_GATE_ROWS_MISSING:'+missing.join(','));
 if(open.length)throw Error('RELEASE_BLOCKERS_OPEN:'+open.join(','));
 return {approved:true,tag,sha,version:pkg.version,mandatoryBlockers:[...REQUIRED]};
}
if(require.main===module){
 try{console.log(JSON.stringify(gate()));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
module.exports={gate,parseLedger,REQUIRED};
