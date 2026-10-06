'use strict';
const fs=require('node:fs');
const {operatorKey}=require('../server/production/operator-service');

function fail(message){console.error(message);process.exit(64);}
function secret(){
 const direct=process.env.MEGA_PROXY_SECRET||'',file=process.env.MEGA_PROXY_SECRET_FILE||'';
 if(direct&&file)throw Error('AMBIGUOUS_OPERATOR_SECRET');
 if(direct)return direct;
 if(file){if(!file.startsWith('/')||!fs.statSync(file).isFile())throw Error('INVALID_OPERATOR_SECRET_FILE');return fs.readFileSync(file,'utf8').trim();}
 throw Error('MISSING_OPERATOR_SECRET');
}
function args(argv){
 const values=[...argv],command=values.shift();if(!command)fail('Usage: node scripts/operator.js COMMAND ...');
 const out={command,operator:'',reason:'',limit:50,query:'',state:'open',outcome:''};
 while(values.length){
  const v=values.shift();
  if(v==='--operator')out.operator=values.shift()||'';
  else if(v==='--reason')out.reason=values.shift()||'';
  else if(v==='--limit')out.limit=Number(values.shift());
  else if(v==='--state')out.state=values.shift()||'';
  else if(v==='--outcome')out.outcome=values.shift()||'';
  else if(!out.query)out.query=v;
  else fail('Unexpected argument: '+v);
 }
 return out;
}
async function request(body){
 const key=operatorKey(secret()),port=process.env.MEGA_METRICS_PORT||9091;
 const r=await fetch('http://127.0.0.1:'+port+'/operator',{method:'POST',headers:{'Content-Type':'application/json','X-Mega-Operator-Key':key},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
 const text=await r.text();let data;try{data=JSON.parse(text);}catch{throw Error('OPERATOR_NON_JSON');}
 if(!r.ok)throw Error(data.error||'OPERATOR_FAILED');return data;
}
async function main(argv=process.argv.slice(2)){
 const a=args(argv),map={support:'support',lookup:'lookup',audit:'audit','audit-verify':'audit-verify','sessions-revoke':'sessions-revoke',suspend:'suspend',unsuspend:'unsuspend','hold-on':'hold-on','hold-off':'hold-off','incident-status':'incident-status','incident-lockdown':'incident-lockdown','incident-clear':'incident-clear','report-list':'report-list','report-resolve':'report-resolve'},action=map[a.command];
 if(!action)fail('Unknown operator command.');
 if(!['audit-verify','incident-status','incident-lockdown','incident-clear','report-list'].includes(action)&&!a.query&&action!=='audit')fail('Player/report lookup value required.');
 if(['sessions-revoke','suspend','unsuspend','hold-on','hold-off','incident-lockdown','incident-clear','report-resolve'].includes(action)&&(!a.operator||!a.reason))fail('Mutations require --operator and --reason.');
 if(action==='report-resolve'&&!a.outcome)fail('report-resolve requires --outcome no_action|action_taken|duplicate.');
 const result=await request({action,query:a.query||undefined,operator:a.operator||undefined,reason:a.reason||undefined,limit:a.limit,state:a.state,outcome:a.outcome||undefined});
 console.log(JSON.stringify(result,null,2));
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={main,args,request};
