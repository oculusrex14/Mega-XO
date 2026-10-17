/* Canonical public document links for app surfaces (B2 / APP-002).
 * App UI must open the public megaxo.online documents, never a bundled or relative path.
 * Native bundles (meta[name="mega-account-transport"][content="native"]) render same-frame
 * anchors so the host's deliberate main-frame navigation delegate opens the system browser;
 * ordinary browsers open a new tab and keep the game running. No caller-supplied origins,
 * redirect destinations or account data flow through here. */
(function(root){
'use strict';
const LINKS=Object.freeze({
  privacy:'https://megaxo.online/privacy',
  'privacy-choices':'https://megaxo.online/privacy-choices',
  terms:'https://megaxo.online/terms',
  support:'https://megaxo.online/support',
  'delete-account':'https://megaxo.online/delete-account'
});
const ORIGIN=LINKS.privacy.replace(/\/\/privacy$/,'');
function isNative(){
  try{return root.document?.querySelector?.('meta[name="mega-account-transport"]')?.content==='native';}catch{return false;}
}
function attributes(key){
  const href=LINKS[key];
  if(!href)return '';
  return isNative()
    ?'href="'+href+'"'
    :'href="'+href+'" target="_blank" rel="noopener noreferrer"';
}
root.MegaPublicLinks=Object.freeze({ORIGIN,LINKS,attributes,isNative});
})(globalThis);
