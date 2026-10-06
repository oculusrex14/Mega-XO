'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {DurableStore}=require('../server/economy-store');
const {config}=require('../server/production/config');
const {createRuntime}=require('../server/production/main');
const ROOT=path.resolve(__dirname,'..');
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
test('production restart refunds unresolved escrow exactly once and preserves identity data',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v4-recovery-')),file=path.join(dir,'db');
 const old=new DurableStore(file,{paidEntryEnabled:true,eligibility:()=>true});let a=old.read();
 a.addAccount('alice',{verified:true,games:50,rating:1500,coins:500});a.addAccount('bob',{verified:true,games:50,rating:1500,coins:500});
 const offer=a.offerQueue('interrupted','alice','bob','ranked');a.accept('interrupted','alice',offer.termsHash);a.accept('interrupted','bob',offer.termsHash);
 old.db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(a.export()));assert(a.account('alice').reservedCoins>0);old.close();
 const cfg={...config({MEGA_ORIGIN:'https://game.test',MEGA_OTP_SECRET:'a'.repeat(64),MEGA_PROXY_SECRET:'b'.repeat(64)}),file,host:'127.0.0.1',port:0,adminPort:0};
 let runtime=await createRuntime(cfg);a=runtime.service.store.read();assert.equal(a.account('alice').coins,500);assert.equal(a.account('alice').reservedCoins,0);assert.equal(a.account('alice').rating,1500);assert.equal(a.view('interrupted').status,'VOID');
 const refunded=a.journal.filter(x=>x.reason==='Match refund').length;assert.equal(refunded,2);await runtime.close();
 runtime=await createRuntime(cfg);assert.equal(runtime.service.store.read().journal.filter(x=>x.reason==='Match refund').length,refunded);await runtime.close();
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
});
test('Linux production launcher rejects a second coordinator and releases lock after shutdown',{skip:process.platform!=='linux',timeout:20000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v4-lock-')),children=[];
 t.after(()=>{for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');fs.rmSync(dir,{recursive:true,force:true});});
 const env={...process.env,MEGA_ENV:'staging',MEGA_ORIGIN:'https://game.test',MEGA_DB:path.join(dir,'db'),MEGA_OTP_SECRET:'a'.repeat(64),MEGA_PROXY_SECRET:'b'.repeat(64),MEGA_BIND:'127.0.0.1',PORT:String(await port()),MEGA_METRICS_PORT:String(await port()),RESEND_API_KEY:''};
 async function start(){const child=spawn('sh',['deploy/run.sh'],{cwd:ROOT,env});children.push(child);let output='';await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('STARTUP_TIMEOUT')),8000);child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('service_ready')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);if(!output.includes('service_ready'))reject(Error('STARTUP_EXIT_'+code));});});return child;}
 const first=await start(),second=spawn('sh',['deploy/run.sh'],{cwd:ROOT,env});children.push(second);const [code]=await once(second,'exit');assert.equal(code,73);
 const exit=once(first,'exit');first.kill('SIGTERM');assert.equal((await exit)[0],0);
 const restarted=await start(),done=once(restarted,'exit');restarted.kill('SIGTERM');assert.equal((await done)[0],0);
});

test('production runtime dependencies are pinned by immutable multi-arch digest',()=>{
 const dockerfile=fs.readFileSync(path.join(ROOT,'Dockerfile'),'utf8');
 const compose=fs.readFileSync(path.join(ROOT,'deploy','compose.yaml'),'utf8');
 const smoke=fs.readFileSync(path.join(ROOT,'scripts','image-smoke.sh'),'utf8');
 assert.match(dockerfile,/ARG NODE_IMAGE=node@sha256:[a-f0-9]{64}/);
 assert.match(compose,/CADDY_IMAGE:-caddy@sha256:[a-f0-9]{64}/);
 assert.match(smoke,/caddy_image='caddy@sha256:[a-f0-9]{64}'/);
 assert.equal(dockerfile.includes('ARG NODE_IMAGE=node:24-bookworm-slim'),false);
 assert.equal(compose.includes('CADDY_IMAGE:-caddy:2-alpine'),false);
});

test('VPS initialization and Compose keep provider credentials in secret files',()=>{
 const init=fs.readFileSync(path.join(ROOT,'scripts','init-vps.js'),'utf8');
 const compose=fs.readFileSync(path.join(ROOT,'deploy','compose.yaml'),'utf8');
 const installer=fs.readFileSync(path.join(ROOT,'deploy','install-secrets.sh'),'utf8');
 for(const name of ['resend_api_key','google_client_secret','apple_private_key'])assert.ok(init.includes(name));
 assert.ok(compose.includes('GOOGLE_CLIENT_SECRET_FILE: /run/secrets/google_client_secret'));
 assert.ok(compose.includes('APPLE_PRIVATE_KEY_FILE: /run/secrets/apple_private_key'));
 assert.ok(compose.includes("google_client_secret: {file: '\${MEGA_ROOT}/secrets/google_client_secret'}"));
 assert.ok(compose.includes("apple_private_key: {file: '\${MEGA_ROOT}/secrets/apple_private_key'}"));
 assert.ok(installer.includes('No secret values were printed.'));
 assert.equal(installer.includes('printf \'%s\\n\' "$resend"'),false);
});

test('staging initialization uses real HTTPS and isolated access credentials',t=>{
 const {init}=require('../scripts/init-vps');
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'v4-init-')),stage=path.join(base,'staging'),prod=path.join(base,'production');
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const staged=init('staging.play.antimatterinnovations.com',stage,'staging');
 assert.equal(staged.origin,'https://staging.play.antimatterinnovations.com');
 const stageEnv=fs.readFileSync(path.join(stage,'compose.env'),'utf8');
 assert.match(stageEnv,/MEGA_HTTP_PORT=80/);assert.match(stageEnv,/MEGA_HTTPS_PORT=443/);assert.match(stageEnv,/MEGA_CADDY_FILE=Caddyfile\.staging/);
 assert.ok(fs.statSync(path.join(stage,'secrets','staging_access_password')).size>10);
 assert.equal(fs.readFileSync(path.join(stage,'secrets','staging_password_hash'),'utf8'),'');
 const produced=init('play.antimatterinnovations.com',prod,'production');
 assert.equal(produced.origin,'https://play.antimatterinnovations.com');
 assert.equal(fs.existsSync(path.join(prod,'secrets','staging_access_password')),false);
 assert.equal(fs.existsSync(path.join(prod,'secrets','staging_password_hash')),true);
});
test('backup and monitoring assets preserve environment isolation and private diagnostics',()=>{
 const r2=fs.readFileSync(path.join(ROOT,'deploy','configure-r2-backup.sh'),'utf8');
 const monitor=fs.readFileSync(path.join(ROOT,'deploy','host-health-monitor.sh'),'utf8');
 const staging=fs.readFileSync(path.join(ROOT,'deploy','Caddyfile.staging'),'utf8');
 assert.ok(r2.includes('mega-xo-v4-$stage'));
 assert.ok(r2.includes('MEGA_BACKUP_BUDGET_BYTES=2147483648'));
 assert.ok(monitor.includes('RestartCount'));
 assert.ok(monitor.includes('contact@antimatterinnovations.com'));
 assert.ok(staging.includes('basic_auth'));
 assert.ok(staging.includes('X-Robots-Tag'));
});

test('production perimeter assets keep only edge web ports public',()=>{
 const compose=fs.readFileSync(path.join(ROOT,'deploy','compose.yaml'),'utf8');
 const caddy=fs.readFileSync(path.join(ROOT,'deploy','Caddyfile'),'utf8');
 const audit=fs.readFileSync(path.join(ROOT,'deploy','audit-perimeter.sh'),'utf8');
 const outside=fs.readFileSync(path.join(ROOT,'scripts','external-perimeter-probe.js'),'utf8');
 assert.ok(compose.includes("'127.0.0.1:\${MEGA_LOCAL_METRICS_PORT:-9091}:9091'"));
 assert.equal(compose.includes(':8080:8080'),false);
 assert.ok(caddy.includes('header -Server'));
 assert.ok(caddy.includes('Strict-Transport-Security'));
 for(const port of ['22','2375','2376','8080','9091'])assert.ok(outside.includes(port));
 assert.ok(audit.includes('ReadonlyRootfs'));
 assert.ok(audit.includes('no-new-privileges:true'));
 assert.ok(audit.includes('Tailscale'));
});
test('release workflow is gated and emits an immutable release manifest',()=>{
 const workflow=fs.readFileSync(path.join(ROOT,'.github','workflows','v35-validation.yml'),'utf8');
 const verify=fs.readFileSync(path.join(ROOT,'deploy','verify-release.sh'),'utf8');
 assert.ok(workflow.includes('node scripts/release-gate.js'));
 assert.ok(workflow.includes('immutable-release.json'));
 assert.ok(workflow.includes('gh release create'));
 assert.ok(workflow.includes('provenance: true'));assert.ok(workflow.includes('sbom: true'));
 assert.ok(verify.includes('org.opencontainers.image.revision'));
 assert.ok(verify.includes('ghcr.io/oculusrex14/mega-xo@sha256:'));
});
