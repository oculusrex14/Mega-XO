'use strict';

// The website can operate its own seat and game only. Room administration,
// identity, names, prices and clocks never come from a public HTTP command.
const FIELDS = Object.freeze({
 publicJoin: ['type', 'table'],
 ready: ['type', 'id', 'value', 'rulesVersion'],
 leave: ['type', 'id'],
 matchReady: ['type', 'id', 'fixture'],
 move: ['type', 'id', 'fixture', 'revision', 'move'],
 resign: ['type', 'id', 'fixture'],
});
const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;
const invalid = () => { const error = Error('INVALID_TOURNAMENT_COMMAND'); error.status = 400; throw error; };
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function tournamentRoomId(value) {
 if (typeof value !== 'string' || !ROOM_ID.test(value)) invalid();
 return value;
}

function tournamentCommand(value) {
 if (!object(value) || !Object.hasOwn(FIELDS, value.type)) invalid();
 const fields = FIELDS[value.type];
 if (Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) invalid();
 const command = Object.fromEntries(fields.map(key => [key, value[key]]));
 if (command.type === 'publicJoin') {
  if (!['low', 'medium', 'high', 'premium'].includes(command.table)) invalid();
  return command;
 }
 tournamentRoomId(command.id);
 if (fields.includes('fixture') && (typeof command.fixture !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(command.fixture))) invalid();
 if (command.type === 'ready' && (typeof command.value !== 'boolean' || !Number.isSafeInteger(command.rulesVersion) || command.rulesVersion < 1)) invalid();
 if (command.type === 'move') {
  if (!Number.isSafeInteger(command.revision) || command.revision < 0 || !object(command.move) ||
      Object.keys(command.move).length !== 2 || !Object.hasOwn(command.move, 'b') || !Object.hasOwn(command.move, 'c') ||
      !Number.isSafeInteger(command.move.b) || command.move.b < 0 || command.move.b > 8 ||
      !Number.isSafeInteger(command.move.c) || command.move.c < 0 || command.move.c > 8) invalid();
  command.move = { b: command.move.b, c: command.move.c };
 }
 return command;
}

module.exports = { tournamentCommand, tournamentRoomId };
