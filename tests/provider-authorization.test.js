'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {IdentityProviders,sha}=require('../server/identity-provider');

const attempt={state:'state-value',nonce:'nonce-value',verifier:'pkce-verifier-value'};

test('Google production authorization uses exact code flow, nonce, state and supported minimal OIDC scopes',()=>{
 const providers=new IdentityProviders({config:{google:{clientId:'google-client',clientSecret:'google-secret'}}});
 const url=new URL(providers.authorization('google',attempt,'https://play.antimatterinnovations.com/auth/callback/google'));
 assert.equal(url.origin,'https://accounts.google.com');
 assert.equal(url.pathname,'/o/oauth2/v2/auth');
 assert.equal(url.searchParams.get('client_id'),'google-client');
 assert.equal(url.searchParams.get('redirect_uri'),'https://play.antimatterinnovations.com/auth/callback/google');
 assert.equal(url.searchParams.get('response_type'),'code');
 assert.equal(url.searchParams.get('state'),attempt.state);
 assert.equal(url.searchParams.get('nonce'),attempt.nonce);
 assert.equal(url.searchParams.get('code_challenge'),sha(attempt.verifier));
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 const scopes=new Set(url.searchParams.get('scope').split(/\s+/));
 assert.deepEqual(scopes,new Set(['openid','profile']));
 assert.equal(scopes.has('email'),false);
});

test('Apple production authorization uses exact registered return URL and code-only query response',()=>{
 const providers=new IdentityProviders({config:{apple:{clientId:'com.antimatter.mega.web',teamId:'TEAM123',keyId:'KEY123',privateKey:'configured'}}});
 const url=new URL(providers.authorization('apple',attempt,'https://play.antimatterinnovations.com/auth/callback/apple'));
 assert.equal(url.origin,'https://appleid.apple.com');
 assert.equal(url.pathname,'/auth/authorize');
 assert.equal(url.searchParams.get('client_id'),'com.antimatter.mega.web');
 assert.equal(url.searchParams.get('redirect_uri'),'https://play.antimatterinnovations.com/auth/callback/apple');
 assert.equal(url.searchParams.get('response_type'),'code');
 assert.equal(url.searchParams.get('response_mode'),'query');
 assert.equal(url.searchParams.get('state'),attempt.state);
 assert.equal(url.searchParams.get('nonce'),attempt.nonce);
 assert.equal(url.searchParams.has('scope'),false);
});
