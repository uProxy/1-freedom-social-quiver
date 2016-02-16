/**
 * @interface
 * @template Key, Val
 */
function LRU() {};

/**
 * @param {Key} key
 * @param {Val} val
 * @param {number=} maxAge
 */
LRU.prototype.set = function(key, val, maxAge) {};

/**
 * @param {Key} key
 * @return {Val}
 */
LRU.prototype.get = function(key) {};

/**
 * @param {Key} key
 * @return {Val}
 */
LRU.prototype.peek = function(key) {};

/**
 * @param {Key} key
 */
LRU.prototype.del = function(key) {};

LRU.prototype.reset = function() {};

/**
 * @param {Key} key
 * @return {boolean}
 */
LRU.prototype.has = function(key) {};

/**
 * @typedef {function(number):!LRU}
 */
var LRUFactory;
