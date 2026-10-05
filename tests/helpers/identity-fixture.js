'use strict';
// Cryptographically signed fixture identities. Loaded only by tests, not the app/server.
const crypto=require('node:crypto');
const pair=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...pair.publicKey.export({format:'jwk'}),kid:'fixture-key',alg:'RS256',use:'sig'};
function sign(provider,subject,nonce,now=Date.now(),patch={}){const header=Buffer.from(JSON.stringify({alg:'RS256',kid:jwk.kid})).toString('base64url'),payload=Buffer.from(JSON.stringify({iss:provider==='apple'?'https://appleid.apple.com':'https://accounts.google.com',aud:'test-native',sub:subject,nonce,iat:Math.floor(now/1000),exp:Math.floor(now/1000)+300,...patch})).toString('base64url'),p=header+'.'+payload;return p+'.'+crypto.sign('RSA-SHA256',Buffer.from(p),pair.privateKey).toString('base64url');}
module.exports={jwk,sign};
