'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {AppleStoreKit}=require('../server/apple-storekit');
const fixture=name=>fs.readFileSync(path.join(__dirname,'fixtures',name),'utf8');
const b64=pem=>new crypto.X509Certificate(pem).raw.toString('base64');
const at=Date.UTC(2026,9,7),db={prepare:()=>({get:()=>null})};
function store(){return new AppleStoreKit(db,{bundleId:'com.antimatter.mega.test',environment:'Sandbox',products:{test_sku:'crowns_100'},trustedRoots:[fixture('apple-root.pem')],now:()=>at});}
function header(leaf='apple-leaf.pem'){return {alg:'ES256',x5c:[b64(fixture(leaf)),b64(fixture('apple-intermediate.pem')),b64(fixture('apple-root.pem'))]};}
test('StoreKit accepts only the Apple App Store certificate profile',()=>{assert.doesNotThrow(()=>store().chain(header(),at));assert.throws(()=>store().chain(header('apple-leaf-no-store-oid.pem'),at),/INVALID_RECEIPT/);});
test('StoreKit requires the exact three-certificate x5c chain',()=>{const h=header();assert.throws(()=>store().chain({...h,x5c:h.x5c.slice(0,2)},at),/INVALID_RECEIPT/);assert.throws(()=>store().chain({...h,x5c:[...h.x5c,h.x5c[2]]},at),/INVALID_RECEIPT/);});
