/** @interface */
function SocialProviderInterface() {};

/**
 * @param {{userName: string, pgpKeyName: ?string, agent: string}} loginOptions
 * @param {function((!Object|undefined), Object=)} continuation First argument is an onStatus event, send is an optional error message.
 */
SocialProviderInterface.prototype.login = function(loginOptions, continuation) {};

/**
 * @param {string} userId
 * @param {function((Object|undefined), Object=)} continuation
 */
SocialProviderInterface.prototype.inviteUser = function(userId, continuation) {};

/**
 * @param {*} networkData
 * @param {function(undefined=, Object=)} continuation
 */
SocialProviderInterface.prototype.acceptUserInvitation = function(networkData,
    continuation) {};

SocialProviderInterface.prototype.clearCachedCredentials = function() {};

/**
 * @param {function((!Object|undefined), Object=)} continuation
 */
SocialProviderInterface.prototype.getClients = function(continuation) {};

/**
 * @param {function((!Object|undefined), Object=)} continuation
 */
SocialProviderInterface.prototype.getUsers = function(continuation) {};

/**
 * @param {string} destination_id The userId or clientId to send to
 * @param {string} message The message to send.
 * @param {function(undefined=, Object=)} continuation Function to call once the message is sent
 *     (not necessarily received).
 */
SocialProviderInterface.prototype.sendMessage = function(destination_id, message, continuation) {};

/** @param {function(undefined=, Object=)} continuation */
SocialProviderInterface.prototype.logout = function(continuation) {};

/** @constructor @struct */
function SocialInterface() {};

/** @const {!Object.<string, string>} */
SocialInterface.prototype.ERRCODE;

/** @param {!function(new:SocialProviderInterface, function())} x */
SocialInterface.prototype.provideAsynchronous = function(x) {};

/** @return {!SocialInterface} */
var freedom = function() {};

/** @type {?function():!SocialInterface} */
freedom.social;

/** @interface */
function FreedomWebSocket() {}

/**
 * @param {string} msg
 * @param {Function} handler
 */
FreedomWebSocket.prototype.on = function(msg, handler) {};

/**
 * @param {Object} msg
 */
FreedomWebSocket.prototype.send = function(msg) {};

FreedomWebSocket.prototype.close = function() {};

/** @interface */
function FreedomCrypto() {};

/**
 * @param {number} numBytes
 * @return {!Promise<!ArrayBuffer>}
 */
FreedomCrypto.prototype.getRandomBytes = function(numBytes) {}

/** @interface */
function FreedomPgp() {};

/**
 * @param {string} passphrase
 * @param {string} uid
 * @return {!Promise<void>}
 */
FreedomPgp.prototype.setup = function(passphrase, uid) {}

/**
 * @return {!Promise<{key: string, fingerprint: string, words: Array<string>}>}
 */
FreedomPgp.prototype.exportKey = function() {}

/**
 * @param {!ArrayBuffer} plainText
 * @param {?string=} pubKey
 * @return {!Promise<!ArrayBuffer>}
 */
FreedomPgp.prototype.signEncrypt = function(plainText, pubKey) {}

/**
 * @param {!ArrayBuffer} cipherText
 * @param {?string=} pubKey
 * @return {!Promise<{data: !ArrayBuffer, signedBy: Array<string>}>}
 */
FreedomPgp.prototype.verifyDecrypt = function(cipherText, pubKey) {}

/**
 * @param {string} pubKey
 * @return {!Promise<{fingerprint: string, words: Array<string>}>}
 */
FreedomPgp.prototype.getFingerprint = function(pubKey) {}
