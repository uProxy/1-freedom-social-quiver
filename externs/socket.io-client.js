/**
 * @constructor
 * @private
 */
var Socket = function() {};

/**
 * @param {string} name
 * @param {Function} listener
 */
Socket.prototype.on = function(name, listener) {};

/**
 * @param {string} name
 * @param {*} value
 */
Socket.prototype.emit = function(name, value) {};

Socket.prototype.close = function() {};

/**
 * @constructor
 * @private
 */
var SocketIO = function() {};

/**
 * @param {string} url
 * @param {Object=} options
 * @return {Socket}
 */
SocketIO.prototype.connect = function(url, options) {};
