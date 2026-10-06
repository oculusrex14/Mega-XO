'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function init(host,root,stage='production') {
 if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host||'')||host.endsWith('.example'))throw Error('VALID_HOSTNAME_REQUIRED');
 if(!path.isAbsolute(root||'')||!/^\/[A-Za-z0-9/_.-]+$/.test(root)||path.resolve(root)!==root||root==='/'||!['production','staging'].includes(stage))throw Error('INVALID_DEPLOYMENT_DIRECTORY');
 if(fs.existsSync(path.join(root,'app.env')))throw Error('DEPLOYMENT_ALREADY_INITIALIZED');
 process.umask(0o077);fs.mkdirSync(root,{recursive:true,mode:0o700});
 const files=[],staging=stage==='staging',origin='https://'+host+(staging?':8448':'');
 const write=(name,value)=>{const file=path.join(root,name);fs.writeFileSync(file,value,{flag:'wx',mode:0o600});files.push(file);};
 for(const dir of ['secrets','data','backup-work','backup-status','releases'])fs.mkdirSync(path.join(root,dir),{mode:0o700});
 for(const key of ['otp_secret','proxy_secret','restic_password'])write('secrets/'+key,crypto.randomBytes(32).toString('hex')+'\n');
 for(const key of ['resend_api_key','backup_access_key','backup_secret_key'])write('secrets/'+key,'');
 write('app.env',`MEGA_ENV=${stage}\nMEGA_ORIGIN=${origin}\nMEGA_EMAIL_FROM=Mega XO by Antimatter Innovations <contact@antimatterinnovations.com>\nMEGA_MAIL_DAILY_LIMIT=${staging?10:80}\nMEGA_MAIL_MONTHLY_LIMIT=${staging?100:2400}\nMEGA_AUTH_WORKERS=2\nMEGA_MAX_QUEUED=200\nMEGA_AD_MODE=off\nMEGA_PURCHASES_ENABLED=false\nMEGA_PAID_ENTRY_ENABLED=false\n`);
 write('compose.env',`MEGA_PROJECT=mega-xo-${stage}\nMEGA_ROOT=${root}\nMEGA_HOSTNAME=${host}\nMEGA_LOCAL_METRICS_PORT=${staging?9092:9091}\nMEGA_HTTP_BIND=${staging?'127.0.0.1':'0.0.0.0'}\nMEGA_HTTPS_BIND=${staging?'127.0.0.1':'0.0.0.0'}\nMEGA_HTTP_PORT=${staging?8088:80}\nMEGA_HTTPS_PORT=${staging?8448:443}\nMEGA_CADDY_FILE=${staging?'Caddyfile.staging':'Caddyfile'}\n`);
 write('backup.env',`# Fill the dedicated free-tier S3-compatible backup prefix before enabling backups.\nRESTIC_REPOSITORY=\nMEGA_BACKUP_BUDGET_BYTES=2147483648\nMEGA_BACKUP_HOST=mega-xo-${stage}\nAWS_DEFAULT_REGION=\n`);
 if(process.getuid?.()===0){for(const dir of ['', 'secrets','data','backup-work','backup-status','releases'])fs.chownSync(path.join(root,dir),1000,1000);for(const file of files)fs.chownSync(file,1000,1000);}
 return {initialized:true,root,stage,origin,secretsPrinted:false};
}
if(require.main===module){try{console.log(JSON.stringify(init(...process.argv.slice(2))));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={init};
