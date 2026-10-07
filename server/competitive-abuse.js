/* Review-only competitive abuse signals.
 * The approved policy and signal logic now live once in packages/domain/abuse.js; this module is the
 * retained server path so that existing server/tests callers and the checked entry point keep working.
 */
'use strict';
module.exports=require('../packages/domain/abuse.js');
