/** @interface */
function SocialProviderInterface() {};

/**
 * @param {Object} loginOptions
 * @param {function(Object, Object=)} continuation First argument is an onStatus event, send is an optional error message.
 */
SocialProviderInterface.prototype.login = function(loginOptions, continuation) {};

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

/** @interface */
function Freedom() {};

/** @return {!SocialInterface} */
Freedom.prototype.social = function() {};

/** @type {Freedom} */
var freedom;

/** @interface */
function FreedomWebSocket() {}

/**
 * @param {string} msg
 * @param {function(...[?])} handler
 */
FreedomWebSocket.prototype.on = function(msg, handler) {};

/**
 * @param {Object} msg
 */
FreedomWebSocket.prototype.send = function(msg) {};

FreedomWebSocket.prototype.close = function() {};
