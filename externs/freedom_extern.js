/** @interface */
function SocialProviderInterface() {};

/**
 * @param {{userName: string, pgpKeyName: ?string, agent: string}} loginOptions
 * @return {!Promise<!Object>} client state for logged in user
 */
SocialProviderInterface.prototype.login = function(loginOptions) {};

/**
 * @param {string} userId
 * @return {!Promise} Promise<void>
 */
SocialProviderInterface.prototype.inviteUser = function(userId) {};

/**
 * @param {*} networkData
 * @return {!Promise} Promise<void>
 */
SocialProviderInterface.prototype.acceptUserInvitation = function(networkData) {};

/**
 * @return {!Promise} Promise<void>
 */
SocialProviderInterface.prototype.clearCachedCredentials = function() {};

/**
 * @return {!Promise} Mapping from clientId to client states
 */
SocialProviderInterface.prototype.getClients = function() {};

/**
 * @return {!Promise} Mapping from userId to user profiles
 */
SocialProviderInterface.prototype.getUsers = function() {};

/**
 * @param {string} destination_id The userId or clientId to send to
 * @param {string} message The message to send.
 * @return {!Promise} Promise<void>
 */
SocialProviderInterface.prototype.sendMessage = function(destination_id, message) {};

/** @return {!Promise} Promise<void> */
SocialProviderInterface.prototype.logout = function() {};

/** @constructor @struct */
function SocialInterface() {};

/** @const {!Object.<string, string>} */
SocialInterface.prototype.ERRCODE;

/** @param {!function(new:SocialProviderInterface, function())} x */
SocialInterface.prototype.providePromises = function(x) {};


/** @constructor @struct */
function CoreInterface() {};

/**
 * @param {string} x
 * @return {!Promise<!Console>}
 */
CoreInterface.prototype.getLogger = function(x) {};

/** @return {!SocialInterface} */
var freedom = function() {};

/** @type {?function():!SocialInterface} */
freedom.social;

/** @type {?function():!CoreInterface} */
freedom.core;

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

/**
 * @typedef {{
 *   data: !ArrayBuffer,
 *   signedBy: Array<string>
 * }}
 */
var FreedomPgpDecryptResult;

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
 * @return {!Promise<!FreedomPgpDecryptResult>}
 */
FreedomPgp.prototype.verifyDecrypt = function(cipherText, pubKey) {}

/**
 * @param {string} pubKey
 * @return {!Promise<{fingerprint: string, words: Array<string>}>}
 */
FreedomPgp.prototype.getFingerprint = function(pubKey) {}
