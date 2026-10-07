/* Pure Mega XO product domain, independent of HTTP, SQLite and process globals.
 *
 * These are the canonical approved rules and economy implementations, not copies: the browser
 * UMD sources under src/ (game, domain, monetization, tournament, authority) remain the single
 * definition and are still loaded directly by index.html, so no shipped client or policy constant
 * is duplicated here. This entry point only publishes that one implementation to CommonJS
 * consumers (server/, scripts/, tests/).
 *
 * `matchmaking` and `abuse` are the pure policy halves extracted from server/matchmaking.js and
 * server/competitive-abuse.js; their stateful storage/ticket layers stay in server/.
 */
'use strict';
const game=require('../../src/game.js');
const domain=require('../../src/domain.js');
const tournament=require('../../src/tournament.js');
const monetization=require('../../src/monetization.js');
const {Authority,chooseSymbols}=require('../../src/authority.js');
const matchmaking=require('./matchmaking.js');
const abuse=require('./abuse.js');
const commands=require('./commands.js');

module.exports={
 game,
 policy:domain.POLICY,
 domain,
 tournament,
 monetization,
 abuse,
 matchmaking,
 Authority,
 chooseSymbols,
 executeCommand:commands.executeCommand,
 COMMAND_ROLES:commands.COMMAND_ROLES,
 PRINCIPAL_SCOPES:commands.PRINCIPAL_SCOPES,
 matchmakerPrincipal:commands.matchmakerPrincipal
};
