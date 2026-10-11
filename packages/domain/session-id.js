'use strict';
const crypto = require('node:crypto');

/* Existing public session identity: sha256 of the stored base64url SHA256 digest,
 * hex, first24. Normalize its reversible PostgreSQL hex encoding before deriving it.
 * A storage digest is not accepted as a public session reference. */
function publicSessionId(storedDigest) {
 const b64 = typeof storedDigest === 'string' && /^[0-9a-f]{64}$/.test(storedDigest)
  ? Buffer.from(storedDigest, 'hex').toString('base64url')
  : storedDigest;
 return crypto.createHash('sha256').update(b64).digest('hex').slice(0, 24);
}

module.exports = { publicSessionId };
