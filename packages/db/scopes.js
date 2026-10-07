/* Durable operation-outcome scopes.
 *
 * Each existing store keeps its own key/column layout - commands.id,
 * party_commands.id, social_operations.id, v35_commands(actor,key) - so no
 * invented shared convention replaces real legacy idempotency semantics. A scope
 * only carries the SQL the shared outcome repository runs on the unit of work.
 */
'use strict';
const COMMANDS = Object.freeze({
 find: 'SELECT actor,fingerprint,response FROM commands WHERE id=?',
 insert: 'INSERT INTO commands(id,actor,fingerprint,response) VALUES(?,?,?,?)',
 remove: 'DELETE FROM commands WHERE id=?',
});
const PARTY_COMMANDS = Object.freeze({
 find: 'SELECT fingerprint,response FROM party_commands WHERE id=?',
 insert: 'INSERT INTO party_commands(id,fingerprint,response) VALUES(?,?,?)',
 remove: 'DELETE FROM party_commands WHERE id=?',
});
const SOCIAL_OPERATIONS = Object.freeze({
 find: 'SELECT fingerprint,result FROM social_operations WHERE id=?',
 insert: 'INSERT INTO social_operations(id,fingerprint,result) VALUES(?,?,?)',
 remove: 'DELETE FROM social_operations WHERE id=?',
});
const V35_COMMANDS = Object.freeze({
 find: 'SELECT actor,key,fingerprint,response FROM v35_commands WHERE actor=? AND key=?',
 insert: 'INSERT INTO v35_commands(actor,key,fingerprint,response) VALUES(?,?,?,?)',
 remove: 'DELETE FROM v35_commands WHERE actor=? AND key=?',
});
module.exports = {COMMANDS, PARTY_COMMANDS, SOCIAL_OPERATIONS, V35_COMMANDS};
