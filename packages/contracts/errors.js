/* Contract failures carry only a stable public code, exactly like the legacy guards
 * they replace (`Error('AUTH_REQUIRED')`). Every router maps `e.message`, so the
 * message must stay a bare code matching /^[A-Z][A-Z0-9_]*$/.
 */
'use strict';
class ContractError extends Error {
 constructor(code, detail) {
  super(code);
  this.name = 'ContractError';
  this.code = code;
  if (detail !== undefined) this.detail = detail;
 }
}
const fail = (code, detail) => { throw new ContractError(code, detail); };
const isContractError = value => value instanceof ContractError;
module.exports = { ContractError, fail, isContractError };
