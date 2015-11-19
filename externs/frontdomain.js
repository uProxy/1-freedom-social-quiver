/**
 * @constructor
 * @private
 */
var FrontDomain = function() {};

/**
 * @param {string} front
 * @param {string} host
 * @return {string}
 */
FrontDomain.prototype.munge = function(front, host) {};

/**
 * @param {string} domain
 * @return {boolean}
 */
FrontDomain.prototype.isFront = function(domain) {};

/**
 * @param {string} domain
 * @return {string|{front:string,host:string}}
 */
FrontDomain.prototype.demunge;
