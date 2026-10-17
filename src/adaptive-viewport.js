/* Adaptive viewport (2026-10-17): the shell must fit the ACTUAL visible area of any phone,
 * not a hardcoded desktop frame. The measured visualViewport drives --vvh/--vvw custom
 * properties, and html[data-phone] marks phone-shaped surfaces (measured dimensions OR a
 * mobile UA) so the full-bleed rules apply regardless of which signal is available.
 * Desktop keeps the framed presentation. No identity, credential or transport data.
 */
(function(){
"use strict";
function apply(){
  var vv=window.visualViewport;
  var w=Math.round(vv?vv.width:(window.innerWidth||0));
  var h=Math.round(vv?vv.height:(window.innerHeight||0));
  var de=document.documentElement;
  if(!de||!w||!h)return;
  de.style.setProperty("--vvh",h+"px");
  de.style.setProperty("--vvw",w+"px");
  var ua=(typeof navigator!=="undefined"&&navigator.userAgent)||"";
  var uaPhone=/iPhone|Android.*Mobile|Mobile.*Android/i.test(ua);
  var phone=uaPhone||w<=520||h<=560;
  if(phone)de.setAttribute("data-phone","");else de.removeAttribute("data-phone");
}
apply();
window.addEventListener("resize",apply);
window.addEventListener("orientationchange",apply);
if(window.visualViewport)window.visualViewport.addEventListener("resize",apply);
})();
