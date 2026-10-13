'use strict';
/* Separate exact-role connection lane; reuses platform TLS/target guards rather than adding
 * capture identities to Core's credentials, grant lists or connection pool registry. */
const fs=require('node:fs');
const guards=require('../db/pg/guards.js');
const ROLES=Object.freeze(['capture_runtime','capture_exporter','capture_privacy']);
const fail=code=>{throw new Error(code);};
function configFromEnvironment(env,role){
 if(!ROLES.includes(role))fail('CAPTURE_ROLE_INVALID');
 let u;try{u=new URL(env.CAPTURE_PG_URL);}catch{fail('CAPTURE_PG_URL_REQUIRED');}
 if(!['postgres:','postgresql:'].includes(u.protocol)||!u.hostname||u.hash)fail('CAPTURE_PG_URL_INVALID');
 for(const k of u.searchParams.keys())if(k!=='sslmode')fail('CAPTURE_PG_PARAMETER_REFUSED');
 const user=decodeURIComponent(u.username),database=decodeURIComponent(u.pathname.slice(1)),label=env.CAPTURE_ENV;
 if(user!==role||!database||database.includes('/'))fail('CAPTURE_EXACT_ROLE_REQUIRED');
 guards.assertEnvironmentCoherence({label,host:u.hostname,database,user});
 if(!['production','staging','test'].includes(label))fail('CAPTURE_ENVIRONMENT');
 let target=null;if(env.CAPTURE_TARGET_FILE){try{target=JSON.parse(fs.readFileSync(env.CAPTURE_TARGET_FILE,'utf8'));}catch{fail('CAPTURE_TARGET_FILE');}}
 guards.assertTargetBinding({label,host:u.hostname,database},target);
 const allowLocalNoTls=env.CAPTURE_DISPOSABLE_LOOPBACK==='1';
 if(allowLocalNoTls&&label!=='test')fail('CAPTURE_LOOPBACK_TEST_ONLY');
 const ssl=guards.assertTlsConfig({label,host:u.hostname,sslmode:u.searchParams.get('sslmode')||undefined,
  sslRootCertPath:env.CAPTURE_PG_ROOTCERT,allowLocalNoTls});
 if(!allowLocalNoTls&&!u.password)fail('CAPTURE_PASSWORD_REQUIRED');
 const max=Number(env.CAPTURE_POOL_MAX||2);if(!Number.isSafeInteger(max)||max<1||max>4)fail('CAPTURE_POOL_BOUND');
 if(guards.isPoolerHost(u.hostname))fail('CAPTURE_DIRECT_ENDPOINT_REQUIRED');
 return {role,label,expectedDatabase:database,target,pg:{host:u.hostname.replace(/^\[|\]$/g,''),port:Number(u.port||5432),user,password:decodeURIComponent(u.password),database,ssl,max,
  application_name:role+'/capture/v1',statement_timeout:30000,lock_timeout:5000,idle_in_transaction_session_timeout:60000,
  connectionTimeoutMillis:5000,idleTimeoutMillis:5000}};
}
async function createConnection(env,role,{Pool}={}){
 const conf=configFromEnvironment(env,role);if(!Pool)({Pool}=require('pg'));
 const pool=new Pool(conf.pg);let closed=false;
 pool.on?.('error',()=>{}); // idle errors are not unhandled events; the next checkout fails closed.
 async function connect(){
  if(closed)fail('CAPTURE_POOL_CLOSED');const c=await pool.connect();
  try{
   const r=(await c.query(`SELECT current_user AS actor,session_user AS login,current_database() AS db,
    r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolbypassrls,r.rolinherit,
    has_schema_privilege(current_user,'learning','USAGE') AS learning_access,
    EXISTS(SELECT FROM pg_roles x WHERE x.rolname<>$1 AND x.rolname IN
     ('api_runtime','core_runtime','worker_runtime','backup_reader','audit_runtime','migration_owner','v5_owner','capture_runtime','capture_exporter','capture_privacy','pg_read_all_data','pg_write_all_data')
      AND pg_has_role(session_user,x.oid,'MEMBER')) AS mixed_role
    FROM pg_roles r WHERE r.rolname=session_user`,[role])).rows[0];
   if(!r||r.actor!==role||r.login!==role||r.db!==conf.expectedDatabase||r.rolsuper||r.rolcreaterole||r.rolcreatedb||r.rolbypassrls||r.rolinherit||!r.learning_access||r.mixed_role)fail('CAPTURE_DATABASE_ROLE_DENIED');
   return c;
  }catch(e){c.release(true);throw e;}
 }
 return Object.freeze({connect,query:async(sql,args)=>{const c=await connect();try{return await c.query(sql,args);}finally{c.release();}},end:async()=>{closed=true;await pool.end();},environment:conf.label,target:conf.target});
}
function readKey(filename){
 if(!filename)fail('CAPTURE_PRIVATE_KEY_FILE_REQUIRED');
 const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const st=fs.fstatSync(fd);if(!st.isFile()||(st.mode&0o077)||st.size>65)fail('CAPTURE_PRIVATE_KEY_FILE_REQUIRED');
  const raw=fs.readFileSync(fd);const key=raw.length===32?Buffer.from(raw):/^[a-fA-F0-9]{64}\n?$/.test(raw.toString())?Buffer.from(raw.toString().trim(),'hex'):null;
  raw.fill(0);if(!key)fail('CAPTURE_KEY_REQUIRED');return key;
 }finally{fs.closeSync(fd);}
}
module.exports={ROLES,configFromEnvironment,createConnection,readKey};
