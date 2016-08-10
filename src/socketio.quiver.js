/*globals freedom:true, XMLHttpRequest:true, DEBUG */
/*jslint indent:2, white:true, node:true, sloppy:true, browser:true */

/** @type {{coretcpsocket, corexhr}} */ var freedomXhr = require('freedom-xhr');

// Use coretcpsocket does not yet work in Firefox, however in Firefox
// corexhr supports domain fronting.
var xhr = navigator.userAgent.indexOf('Firefox') >= 0 ?
   freedomXhr.corexhr : freedomXhr.coretcpsocket;
/* jshint ignore:start */
XMLHttpRequest = xhr;
/* jshint ignore:end */
if (typeof window !== 'undefined') {
  window.XMLHttpRequest = xhr;
}

/** @type {SocketIO} */ var io = require('socket.io-client');
/** @type {FrontDomain} */ var frontdomain = require('frontdomain');
/** @type {LRUFactory} */ var lru = require('lru-cache');

var textEncoder = new TextEncoder('utf-8');
var textDecoder = new TextDecoder('utf-8');

/**
 * Implementation of a Social provider that depends on
 * the socket.io server code in server/qsio_server.js
 * By default, the code assumes that such a server is running on localhost,
 * which will only work if all clients are on the same machine.
 *
 * The provider has the following characteristics:
 * - buddy list stored in Freedom Storage (currently core.storage)
 * - you will only see messages from users to whom you have been introduced
 * - introductions are made by sending a one-time-use intro URL out of band.
 * - persistent userId's, user-controlled nicknames, and ephemerial clientId's
 * - users can be logged into multiple servers for invisible redundancy
 * - in-order delivery
 * - no reliability
 * @class QuiverSocialProvider
 * @constructor
 * @param {function(string, Object=)} dispatchEvent callback to signal events
 * @implements {SocialProviderInterface}
 * @struct
 */
function QuiverSocialProvider(dispatchEvent) {
  this.dispatchEvent = dispatchEvent;
  this.storage = freedom['core.storage']();

  /** @private @const {!FreedomCrypto} */
  this.crypto_ = freedom['core.crypto']();

  /** @private @const {!FreedomPgp} */
  this.pgp_ = freedom['pgp-e2e']();

  /** @private {function({key: string, fingerprint: string})} */
  this.onPubKey_;  // jshint ignore:line
  /** @private {!Promise<{key: string, fingerprint: string}>} */
  this.getPubKey_ = new Promise(function(F, R) {
    this.onPubKey_ = F;
  }.bind(this));

  /** @private {LRU<string, Promise<!FreedomPgpDecryptResult>>} */
  this.decryptCache_ = lru(25);  // Keep the last 25 messages.

  /** @private {LRU<string, Promise<!ArrayBuffer>>} */
  this.encryptCache_ = lru(25);  // Keep the last 25 messages.

  /** @private {!Console} */
  this.logger_ = console;
  this.initLogger_();

  /** @private {string} */
  this.clientSuffix_;  // jshint ignore:line

  /** @private {!Object.<string, !Object.<string, QuiverSocialProvider.clientTracker_>>} */
  this.clients_ = {};  // userId, clientSuffix => clientTracker

  /** @private {!Object.<string, QuiverSocialProvider.connection_>} */
  this.connections_ = {};  // serverKey => connection

  // The connections in clientConnections_ and connections_ are referentially equal.
  /** @private {!Object.<string, Array.<QuiverSocialProvider.connection_>>} */
  this.clientConnections_ = {};  // userId => connection[]

  /** @private {?QuiverSocialProvider.configuration_} */
  this.configuration_ = null;
}

/**
 * @private @typedef {{
 *   type: string,
 *   scheme: ?string,
 *   domain: string,
 *   front: ?string
 * }}
 * Notes:
 * |scheme| defaults to 'https'
 * If |front| is specified, we use domain-fronting.
 */
QuiverSocialProvider.server_ = undefined;

/**
 * @param {!QuiverSocialProvider.server_} server
 * @return {string} A unique key representing that server, suitable for use as
 *     an index.
 */
QuiverSocialProvider.serverKey_ = function(server) {
  return [server.type, server.scheme || 'https', server.domain, server.front || ''].join(';');
};

/** @const @private {!Array.<QuiverSocialProvider.server_>} */
QuiverSocialProvider.DEFAULT_SERVERS_ = [{
  type: 'socketio',
  domain: 'd1j0v91oi5t6ys.cloudfront.net',
  front: 'a0.awsstatic.com'
}, {
  type: 'socketio',
  domain: 'dzgea1sj9ik08.cloudfront.net',
  front: 'js.arcgis.com'
}, {
  type: 'socketio',
  domain: 'd2oi2yhmhpjpt7.cloudfront.net',
  front: 'api.mapbox.com'
}, {
  type: 'socketio',
  domain: 'd2cqtpyb8m6x8r.cloudfront.net',
  front: 'cdn.ckeditor.com'
}, {
  type: 'socketio',
  domain: 'd3h805atiromvi.cloudfront.net',
  front: 'assets.tumblr.com'
}, {
  type: 'socketio',
  domain: 'd2yp1zilrgqkqt.cloudfront.net',
  front: 'cdn.livefyre.com'
}];

/**
 * @private @typedef {{
 *   servers: !Array<!QuiverSocialProvider.server_>,
 *   userId: string,
 *   nick: ?string,
 *   knockCode: string
 * }}
 */
QuiverSocialProvider.invite_ = undefined;

/** @const @private {number} */
QuiverSocialProvider.MAX_CONNECTIONS_ = 2;

/**
 * @private @typedef {{
 *   fromCounter: number,
 *   gotIntro: !Object.<string, boolean>
 * }}
 * Note: the gotIntro object represents a set, so all values are true.
 */
QuiverSocialProvider.clientTracker_ = undefined;

QuiverSocialProvider.makeClientTracker_ = function() {
  return {
    fromCounter: 0,
    gotIntro: {}
  };
};

/**
 * @private @typedef {{
 *   id: string,
 *   pubKey: ?string,
 *   nick: ?string,
 *   servers: !Object.<string, QuiverSocialProvider.server_>,
 *   knockCodes: !Array.<string>
 * }}
 * id is the public key fingerprint
 * knockCodes are codes received from this user in out-of-band invites.
 */
QuiverSocialProvider.userDesc_ = undefined;

/**
 * @private @typedef {{
 *   self: QuiverSocialProvider.userDesc_,
 *   friends: !Object.<string, QuiverSocialProvider.userDesc_>,
 *   liveKnockCodes: !Array.<string>
 * }}
 */
QuiverSocialProvider.configuration_ = undefined;

/**
 * @private @typedef {{
 *   socket: Socket,
 *   ready: Promise.<void>,
 *   friends: !Array.<string>,
 *   listens: !Array.<{eventName: string, listener: !Function}>
 * }}
 */
QuiverSocialProvider.connection_ = undefined;

/**
 * @param {!{fingerprint:string}} fp
 * @return {string} A userId string generated from the fingerprint
 */
QuiverSocialProvider.makeUserId_ = function(fp) {
  // We choose the convention that a userId is a PGP key fingerprint in all caps
  // hex notation with no spaces.
  return fp.fingerprint.replace(/\s/g, '');
};

/**
 * @param {!Array<T>} list To shuffle.  Not modified.
 * @param {number=} opt_sampleSize
 * @return {!Array<T>} Shuffled copy of list, truncated to opt_sampleSize
 * @template T
 */
QuiverSocialProvider.shuffle_ = function(list, opt_sampleSize) {
  var size = opt_sampleSize || list.length;
  var tagged = list.map(function(x) { return [Math.random(), x]; });
  tagged.sort(function(a, b) { return a[0] - b[0]; });
  return tagged.slice(0, size).map(function(x) { return x[1]; });
};

/** @return {!Promise<!QuiverSocialProvider.configuration_>} */
QuiverSocialProvider.prototype.makeDefaultConfiguration_ = function() {
  var selectedServers = QuiverSocialProvider.shuffle_(
      QuiverSocialProvider.DEFAULT_SERVERS_,
      QuiverSocialProvider.MAX_CONNECTIONS_);
  /** @type {!Object.<string, QuiverSocialProvider.server_> } */
  var defaultServers = {};
  selectedServers.forEach(function(server) {
    var serverKey = QuiverSocialProvider.serverKey_(server);
    defaultServers[serverKey] = server;
  });
  return this.getPubKey_.then(function(keyStruct) {
    return {
      self: {
        id: QuiverSocialProvider.makeUserId_(keyStruct),
        pubKey: keyStruct.key,
        nick: null,
        servers: defaultServers,
        knockCodes: []  // No knock code for talking to myself.
      },
      friends: {},
      liveKnockCodes: []
    };
  });
};

/**
 * @return {!Promise} promise which fulfills once configuration is synced.
 * @private
 */
QuiverSocialProvider.prototype.syncConfiguration_ = function() {
  if (this.configuration_) {
    // Write configuration_ to storage, don't need to wait for this to complete.
    this.storage.set('config', JSON.stringify(this.configuration_))
    .catch(function(e) {
      this.logError_('Error writing to storage ' + e);
    }.bind(this));
    return Promise.resolve();
  }
  return this.storage.get('config').then(function(result) {
    if (result) {
      this.configuration_ = /** @type {QuiverSocialProvider.configuration_} */ (JSON.parse(result));
      return;  // Done with syncConfiguration_
    } else if (!this.configuration_) {
      return this.makeDefaultConfiguration_().then(function(config) {
        if (!this.configuration_) {
          this.configuration_ = config;
        }
        // Now that this.configuration_ is set, this just writes it to storage.
        return this.syncConfiguration_();
      }.bind(this));
    }
  }.bind(this));
};

/**
 * @param {!Object} obj
 * @return {boolean}
 * @private
 */
QuiverSocialProvider.isEmpty_ = function(obj) {
  for (var key in obj) {
    return false;
  }
  return true;
};

/**
 * @param {!Object} obj
 * @return {number}
 * @private
 */
QuiverSocialProvider.count_ = function(obj) {
  var i = 0;
  for (var key in obj) {
    ++i;
  }
  return i;
};

QuiverSocialProvider.prototype.getClientId_ = function() {
  return this.configuration_.self.id + '#' + this.clientSuffix_;
};

/** @override */
QuiverSocialProvider.prototype.clearCachedCredentials = function() {
  // TODO(bemasc): What does this even mean?
  return Promise.reject('clearCachedCredentials not implemented');
};


/**
 * @private {?Function}
 */
QuiverSocialProvider.prototype.finishLogin_ = null;

/**
 * Connect to the Web Socket rendezvous server
 * e.g. social.login(Object options)
 * The only login option needed is 'agent', used to determine which group to join in the server
 *
 * @override
 */
QuiverSocialProvider.prototype.login = function(loginOpts) {
  if (this.isOnline_()) {
    return Promise.reject('LOGIN_ALREADYONLINE');
  }

  this.clientSuffix_ = loginOpts.agent;
  if (!this.clientSuffix_) {
    return Promise.reject('No client suffix');  // TODO: Pick an error code.
  }

  this.pgp_.setup('', loginOpts.pgpKeyName || '<quiver>').then(function() {
    return this.pgp_.exportKey();
  }.bind(this)).then(this.onPubKey_);

  return new Promise(function(F, R) {
    this.syncConfiguration_().then(function() {
      this.clients_[this.configuration_.self.id] = {};
      this.clients_[this.configuration_.self.id][this.clientSuffix_] = QuiverSocialProvider.makeClientTracker_();

      this.setNick_(loginOpts.userName);

      this.finishLogin_ = function() {
        this.finishLogin_ = null;
        // Fulfill the method callback
        var clientState = this.makeClientState_(this.configuration_.self.id, this.clientSuffix_);
        F(clientState);
        this.sendAllRosterChanged_();
      }.bind(this);

      var connectToFriends = function() {
        var onConnectionFailure = function(friend) {
          this.warn_('Failed to connect to friend: ' + JSON.stringify(friend));
        }.bind(this);

        // Connect to friends
        /** @type {!Array.<!Promise>} */ var connectionPromises = [];
        for (var userId in this.configuration_.friends) {
          var friend = this.configuration_.friends[userId];

          connectionPromises.push(this.connectLoop_(friend.servers,
              this.connectAsClient_.bind(this, friend)).
                  catch(onConnectionFailure.bind(this, friend)));
        }
        return Promise.all(connectionPromises);
      }.bind(this);

      // The server connection heuristic is currently a three-step process.
      // Step 1: Once I know my own public key, connect to my own long-term
      // (i.e. advertised) servers.
      this.getPubKey_.then(function() {
        return this.connectLoop_(this.configuration_.self.servers,
            this.connect_.bind(this));
      }.bind(this)).then(function(results) {
        if (results.succeeded.length > 0) {
          // If at least one connection succeeded, then we do have a working
          // network, so any connection failures are because the server is in fact
          // failing or unreachable.  Remove it from the active list.
          // It will then be replaced by a friend's server.
          results.failed.forEach(this.removeServer_, this);
        }
        // Step 2: Connect to friends.  If I don't have MAX_CONNECTIONS long-term
        // servers of my own, I will adopt the first new server(s) to which I
        // connect during this process as long-term servers.
        return connectToFriends();
      }.bind(this)).then(function() {
        var deficit = QuiverSocialProvider.MAX_CONNECTIONS_ -
            this.getLiveAdvertisedServers_().length;
        // Step 3: If, after the above completes, I still have too few servers,
        // I will retry all the default servers, and add them to the long-term
        // set until I have MAX_CONNECTIONS servers or run out of default servers.
        if (deficit > 0) {
          /** @type {!Object<string, QuiverSocialProvider.server_>} */
          var unusedDefaultServers = {};
          QuiverSocialProvider.DEFAULT_SERVERS_.forEach(function(server) {
            var key = QuiverSocialProvider.serverKey_(server);
            if (!(key in this.connections_)) {
              unusedDefaultServers[key] = server;
            }
          }, this);
          return this.connectLoop_(unusedDefaultServers,
              this.connect_.bind(this), deficit);
        }
      }.bind(this)).then(function() {
        if (this.finishLogin_) {
          this.warn_('All server connection attempts failed!');
          // Arguably, we should report failure, not success at this point.
          // However, the only way for the user to get back to a working state is
          // to accept an invitation that includes a new (working) server, and
          // they can't do that unless login has succeeded.
          // TODO: Report failure once Quiver and application code allow us to
          // process invitations without being logged in.
          this.finishLogin_();
        }
      }.bind(this));
    }.bind(this));
  }.bind(this));  // end of return new Promise
};

/**
 * @private @typedef {{
 *   succeeded: !Array<!QuiverSocialProvider.server_>,
 *   failed: !Array<!QuiverSocialProvider.server_>
 * }}
 */
QuiverSocialProvider.connectLoopResults_ = undefined;

/**
 * Async for-loop.  Try to connect to each server, and stop once we hit the
 * limit or run out of servers.
 * @param {!Object.<string, !QuiverSocialProvider.server_>} servers
 * @param {function(!QuiverSocialProvider.server_):
 *     QuiverSocialProvider.connection_} connector
 * @param {number=} opt_limit Optional limit, defaults to MAX_CONNECTIONS
 * @return {!Promise<!QuiverSocialProvider.connectLoopResults_>} Always fulfills.
 * @private
 */
QuiverSocialProvider.prototype.connectLoop_ = function(servers, connector,
    opt_limit) {
  var limit = opt_limit || QuiverSocialProvider.MAX_CONNECTIONS_;

  /** @type {function(!QuiverSocialProvider.connectLoopResults_)} */
  var fulfill;
  var promise = new Promise(function(F, R) {
    fulfill = F;
  });

  /** @type {!Array<!QuiverSocialProvider.server_>} */
  var succeeded = [];
  /** @type {!Array<!QuiverSocialProvider.server_>} */
  var failed = [];

  // Bail out early if there's no work to do.
  var serverKeys = QuiverSocialProvider.shuffle_(Object.keys(servers));
  if (limit === 0 || serverKeys.length === 0) {
    fulfill({succeeded: succeeded, failed: failed});
    return promise;
  }

  var serverIndex = 0;
  var onSuccess, onFailure;
  /** @param {boolean} success */
  var helper = function(success) {
    // Due to connector's calling convention, retval is always undefined.
    var lastServer = servers[serverKeys[serverIndex]];
    if (success) {
      succeeded.push(lastServer);
    } else {
      failed.push(lastServer);
    }
    ++serverIndex;
    if (succeeded.length === limit || serverIndex === serverKeys.length) {
      fulfill({succeeded: succeeded, failed: failed});
      return;
    }
    var nextServer = servers[serverKeys[serverIndex]];
    connector(nextServer).ready.then(onSuccess, onFailure);
  }.bind(this);
  onSuccess = helper.bind(this, true);
  onFailure = helper.bind(this, false);
  connector(servers[serverKeys[0]]).ready.then(onSuccess, onFailure);

  return promise;
};

QuiverSocialProvider.prototype.sendAllRosterChanged_ = function() {
  this.changeRoster(/** @type {string} */ (this.configuration_.self.id), null);

  for (var userId in this.clients_) {
    this.changeRoster(userId, null);
  }
};

/**
 * @return {!Array.<!QuiverSocialProvider.server_>} The intersection of servers
 *     that I am connected to and servers that I am advertising in my intro
 *     message.  Includes connections that have not yet succeeded.
 * @private
 */
QuiverSocialProvider.prototype.getLiveAdvertisedServers_ = function() {
  if (!this.configuration_) {
    return [];
  }
  /** @type {!Array.<!QuiverSocialProvider.server_>} */ var myServers = [];
  for (var serverKey in this.configuration_.self.servers) {
    if (this.connections_[serverKey]) {
      myServers.push(this.configuration_.self.servers[serverKey]);
    }
  }
  return myServers;
};

/**
 * @return {boolean} True if we are connected to at least one of our advertised
 *     servers, or still attempting a connection.
 */
QuiverSocialProvider.prototype.isOnline_ = function() {
  return this.getLiveAdvertisedServers_().length > 0;
};

/**
 * @param {!QuiverSocialProvider.connection_} connection
 * @param {string} eventName
 * @param {!Function} listener
 * @private
 */
QuiverSocialProvider.prototype.listen_ = function(connection, eventName,
    listener) {
  connection.socket.on(eventName, listener);
  connection.listens.push({
    eventName: eventName,
    listener: listener
  });
};

/**
 * @param {!QuiverSocialProvider.connection_} connection
 * @private
 */
QuiverSocialProvider.prototype.unlisten_ = function(connection) {
  connection.listens.forEach(function(listen) {
    connection.socket.removeListener(listen.eventName, listen.listener);
  }, this);
};

/**
 * @param {!QuiverSocialProvider.server_} server
 * @return {!QuiverSocialProvider.connection_}
 * @private
 */
QuiverSocialProvider.prototype.connect_ = function(server) {
  var serverKey = QuiverSocialProvider.serverKey_(server);
  if (this.connections_[serverKey]) {
    return this.connections_[serverKey];
  }

  if (server.type !== 'socketio') {
    this.warn_('Unknown type: ' + server.type);
    this.connections_[serverKey] = {
      socket: null,
      ready: Promise.reject(),
      friends: [],
      listens: []
    };
    return this.connections_[serverKey];
  }

  var connectOptions = {
    'transports': ['polling']  // Force XHR so we can domain-front
  };
  var domain = server.front ?
      frontdomain.munge(server.front, server.domain) :
      server.domain;
  var serverUrl = (server.scheme || 'https') + '://' + domain;
  // The first call to io.connect() to a given server will create a new socket
  // and connect to the server.  Subsequent io.connect() calls to the same
  // server will return the same socket, in its current state, even if the
  // socket has been disconnected.  We therefore call connect() to ensure that
  // the socket connects in these cases, which occur on login after logout.
  var socket = io.connect(serverUrl, connectOptions).connect();
  var resolve, reject;
  var connection = {
    socket: socket,
    ready: new Promise(function(F, R) {
      resolve = F;
      reject = R;
    }),
    friends: [],
    listens: []
  };
  this.connections_[serverKey] = connection;
  this.log_('Adding core listeners for: ' + serverKey);

  this.listen_(connection, "error", function(err) {
    this.warn_('socketio: error for ' + serverUrl + ', ' + err);
  }.bind(this));

  var onClose = function() {
    this.cleanupServer_(serverKey);
    if (!this.isOnline_() && !this.finishLogin_) {
      // Only logout if we are not in the middle of login (i.e.
      // if finishLogin_ does not still exist).
      this.warn_('Got final disconnect, logging out');
      this.logout();
    }
  }.bind(this);

  var connectErrorCount = 0;
  this.listen_(connection, "connect_error", function(err) {
    ++connectErrorCount;
    this.warn_('socketio: connect_error for ' + serverUrl + ', ' + err +
        ', connectErrorCount: ' + connectErrorCount);
    // If there is an error connecting to the server (e.g. it is unreachable
    // or has just been restarted), socketio will attempt to reconnect to that
    // server every ~5 seconds, indefinitely.  We should stop after the max
    // retries, e.g. so that uProxy can know we are OFFLINE.
    var maxRetries = this.finishLogin_ ? 2 : 6;
    if (connectErrorCount > maxRetries) {
      this.warn_('disconnecting from ' + serverUrl + ' after max retries');
      socket.close();
      onClose();
      reject(err);
    }
  }.bind(this));

  this.listen_(connection, "message", this.onEncryptedMessage_.bind(this, server));
  this.listen_(connection, "reconnect_failed", function(msg) {
    this.warn_('socketio: reconnect_failed for ' + serverUrl + ', ' + msg);
    onClose();
    reject(new Error('Never connected to ' + serverUrl));
  }.bind(this));

  var onConnect = function() {
    this.log_('socketio: connect for ' + serverUrl);
    connectErrorCount = 0;
    socket.emit('join', this.configuration_.self.id);
    resolve();

    if (this.finishLogin_) {
      this.finishLogin_();
    }

    // Cue up a broadcast disconnect message so everyone can see if I go offline
    // and am no longer reachable on this server.
    this.addDisconnectMessage_(socket);

    // Emit an unencrypted ping on the broadcast channel, so that everyone can
    // see that I have come online.  This ping is not encrypted because it is
    // being sent to all of my friends, including newly invited friends whose
    // user IDs I do not yet know.  This is safe because the ping contains no
    // sensitive information.
    // TODO: Prevent replays, e.g. by adding a timestamp.
    // TODO: Is it safe to include the client suffix here?  This is plaintext.
    return this.signEncryptMessage_({
      cmd: 'ping',
      fromClient: this.clientSuffix_
    }).then(function(signedPing) {
      socket.emit('emit', {
        room: 'broadcast:' + this.configuration_.self.id,
        msg: signedPing
      });
    }.bind(this));
  }.bind(this);
  this.listen_(connection, "connect", onConnect);

  if (this.configuration_.self.servers[serverKey]) {
    // Connect to self, in order to be able to send messages to my own other
    // clients.
    this.connections_[serverKey].ready.then(function() {
      this.connectAsClient_(this.configuration_.self, server);
    }.bind(this));
  }

  // We were briefly offline, so we have been disconnected from our room, and
  // may have missed any inbound pings.  Re-join, and re-ping to indicate that
  // we are now online.
  // TODO: Figure out how to deal with friends whose disconnect messages were
  // dropped during the disconnection interval.  Currently they will be zombies.
  this.listen_(connection, "reconnect", function() {
    this.warn_('socketio: reconnect for ' + serverUrl);
    onConnect();
  }.bind(this));

  this.listen_(connection, "disconnect", function() {
    // This may be emitted when the user logs out of Quiver, in that case
    // it is not an error.  We should not call onClose here as we will
    // be attempting to reconnect.
    this.warn_('socketio: disconnect for ' + serverUrl);
  }.bind(this));

  return this.connections_[serverKey];
};

/**
 * @param {!string} serverKey
 * @private
 */
QuiverSocialProvider.prototype.cleanupServer_ = function(serverKey) {
  var connection = this.connections_[serverKey];
  if (!connection) {
    this.warn_('cleanupServer_ called for unknown server ' + serverKey);
    return;
  }
  this.log_('cleanupServer_ for ' + serverKey);
  // Remove server from friend in this.clientConnections_
  connection.friends.forEach(function(userId) {
    var connections = this.clientConnections_[userId];
    if (!connections) {
      this.warn_('Can\'t find user ' + userId);
      return;
    }
    var index = connections.indexOf(connection);
    if (index === -1) {
      this.warn_('Can\'t find server for user ' + userId);
      return;
    }
    connections.splice(index);
  }, this);
  this.unlisten_(connection);
  delete this.connections_[serverKey];
};

/**
 * @param {!QuiverSocialProvider.userDesc_} friend
 * @param {!QuiverSocialProvider.server_} server
 * @return {!QuiverSocialProvider.connection_}
 * @private
 */
QuiverSocialProvider.prototype.connectAsClient_ = function(friend, server) {
  if (!this.clientConnections_[friend.id]) {
    this.clientConnections_[friend.id] = [];
  }

  var connection = this.connect_(server);

  if (connection.friends.indexOf(friend.id) !== -1) {
    // Already connected as client.
    return connection;
  }
  connection.friends.push(friend.id);
  this.clientConnections_[friend.id].push(connection);

  var onConnect = function() {
    // Join my friend's broadcast room so I can see when they come online.
    connection.socket.emit('join', 'broadcast:' + friend.id);

    // Send my friend a ping to let them know that I am online.
    this.signEncryptMessage_({
      cmd: 'ping',
      fromClient: this.clientSuffix_
    }).then(function(signedPing) {
      connection.socket.emit('emit', {
        room: friend.id,
        msg: signedPing
      });
    }.bind(this));

    this.addDisconnectMessage_(connection.socket, friend);

    if (this.getLiveAdvertisedServers_().length <
        QuiverSocialProvider.MAX_CONNECTIONS_) {
      // We're low on connections to advertised servers.  Start advertising
      // this one, since it is evidently working.
      this.addServer_(server);
    }
  }.bind(this);

  connection.ready.then(onConnect);

  // When we were disconnected, the server sent our disconnect message and
  // removed us from any rooms. Our friends received the disconnect message and
  // marked us as disconnected from this server.  Now that we are back, we need
  // to set a new disconnect message and notify friends that we are back online.
  if (connection.socket) {
    this.listen_(connection, 'reconnect', onConnect);
  }

  return connection;
};

/**
 * @param {!QuiverSocialProvider.userDesc_} friend
 * @return {!Object} An intro msg.  This msg is idempotent.
 * @private
 */
QuiverSocialProvider.prototype.makeIntroMsg_ = function(friend) {
  return {
    cmd: "intro",
    servers: this.getLiveAdvertisedServers_(),
    nick: this.configuration_.self.nick,
    knockCodes: friend.knockCodes || undefined,
    fromClient: this.clientSuffix_
  };
};

/**
 * @param {string} ignoredUserId
 * @override
 */
QuiverSocialProvider.prototype.inviteUser = function(ignoredUserId) {
  // TODO: Show pending invitations and allow cancellation?

  return new Promise(function(F, R) {
    // This implements Promise.race() except that rejections are ignored.
    /** @type {function(string)} */ var serverIsReady;
    /** @type {!Promise<string>} */
    var ownerRace = new Promise(function(F, R) { serverIsReady = F; });
    this.syncConfiguration_().then(function() {
      /** @type {!Array.<!QuiverSocialProvider.server_>} */
      var myServers = this.getLiveAdvertisedServers_();
      if (myServers.length === 0) {
        R('Can\'t invite without a valid connection');
      }
      myServers.forEach(function(server) {
        var serverKey = QuiverSocialProvider.serverKey_(server);
        var connection = this.connections_[serverKey];
        if (connection) {
          connection.ready.then(serverIsReady.bind(this, serverKey));
        }
      }, this);
    }.bind(this));
    ownerRace.then(function(serverKey) {
      var server = this.configuration_.self.servers[serverKey];
      if (!server) {
        R('Can\'t invite without a valid connection');
      }

      // Get a knock code.  This code is used to ensure that we only ever send an
      // 'intro' message to people who have received an invite.  This is required
      // because the 'intro' message contains the nick (which might reveal the
      // user's real identity) and the server list (which must be kept secret to
      // prevent an attacker from learning all the servers on the network).
      // 16 bytes is the standard for collision avoidance in a UUID.
      this.crypto_.getRandomBytes(16).then(function(buffer) {
        // Convert to base64, but strip '=' because it adds no entropy.
        // TODO: Fix handling of 0 bytes.  They shouldn't make knockCode shorter.
        var knockCode = btoa(String.fromCharCode.apply(null,
            new Uint8Array(buffer))).replace(/=/g, '');
        this.configuration_.liveKnockCodes.push(knockCode);
        /** @type QuiverSocialProvider.invite_ */
        var invite = {
          servers: [server],
          userId: this.configuration_.self.id,
          nick: this.configuration_.self.nick,
          knockCode: knockCode
        };
        F(invite);
      }.bind(this));
    }.bind(this));
  }.bind(this));  // end of return new Promise
};

/**
 * @param {string} nick
 * @private
 */
QuiverSocialProvider.prototype.setNick_ = function(nick) {
  this.configuration_.self.nick = nick;
  this.syncConfiguration_().then(function() {
    if (this.isOnline_()) {
      this.selfDescriptionChanged_();
    }
  }.bind(this));
};

/** @private */
QuiverSocialProvider.prototype.selfDescriptionChanged_ = function() {
  this.changeRoster(/** @type {string} */ (this.configuration_.self.id));
  for (var userId in this.clientConnections_) {
    var connections = this.clientConnections_[userId];
    var friend = this.configuration_.friends[userId];
    var introMsg = this.makeIntroMsg_(friend);
    if (connections.length > 0) {
      this.emitEncrypted_(connections, friend, introMsg);
    }
  }
};

/**
 * @param {Socket} socket
 * @param {QuiverSocialProvider.userDesc_=} friend
 * @private
 */
QuiverSocialProvider.prototype.addDisconnectMessage_ =
    function(socket, friend) {
  // Disconnect messages contain no sensitive information, so they don't have to
  // be encrypted.  This is important when setting a disconnect message for a
  // new friend whose public key is not yet known.
  this.signEncryptMessage_({
    'cmd': 'disconnected',
    'fromClient': this.clientSuffix_
  }).then(function(disconnectMessage) {
    socket.emit('addDisconnectMessage', {
      room: friend ? friend.id : 'broadcast:' + this.configuration_.self.id,
      msg: disconnectMessage
    });
  }.bind(this));
};

/**
 * @param {*} networkData
 * @override
 */
QuiverSocialProvider.prototype.acceptUserInvitation = function(networkData) {
  var invite = /** @type {!QuiverSocialProvider.invite_} */ (networkData);
  return this.addFriend_(invite.servers, invite.userId, null,
      [invite.knockCode], invite.nick);
};

/**
 * @param {!Array.<QuiverSocialProvider.server_>} servers
 * @param {string} userId
 * @param {!Array.<string>} knockCodes Only nonempty when processing an invite
 * @param {?string} pubKey
 * @param {?string} nick
 * @return {!Promise} promise which fulfills once friend is added.
 * @private
 */
QuiverSocialProvider.prototype.addFriend_ = function(servers, userId, pubKey,
    knockCodes, nick) {
  if (userId === this.configuration_.self.id) {
    return Promise.resolve();
  }

  this.log_('Adding Friend! userId: ' + userId +
      ', servers: ' + JSON.stringify(servers));
  var friendDesc = this.configuration_.friends[userId];
  if (!friendDesc) {
    friendDesc = {
      id: userId,
      pubKey: pubKey,
      nick: null,
      servers: {},
      knockCodes: []
    };
    this.configuration_.friends[userId] = friendDesc;
  }
  var i;
  for (i = 0; i < servers.length; ++i) {
    var serverKey = QuiverSocialProvider.serverKey_(servers[i]);
    if (!(serverKey in friendDesc.servers)) {
      friendDesc.servers[serverKey] = servers[i];
    }
  }
  for (i = 0; i < knockCodes.length; ++i) {
    if (friendDesc.knockCodes.indexOf(knockCodes[i]) === -1) {
      friendDesc.knockCodes.push(knockCodes[i]);
    }
  }
  if (nick) {
    // Update nick, which is mutable.
    friendDesc.nick = nick;
  }
  if (pubKey) {
    // Friends' pubKeys are mutable, and callers to |addFriend_| are required to
    // check that the key has the correct fingerprint.  This allows us to accept
    // changes to the OpenPGP-formatted keystring, such as adding new subkeys.
    friendDesc.pubKey = pubKey;
  }

  // Emit a UserProfile event
  this.dispatchEvent('onUserProfile', this.makeProfile_(userId));

  return this.syncConfiguration_().then(function() {
    // TODO: Connect to all servers.
    return this.connectAsClient_(friendDesc, servers[0]).ready;
  }.bind(this)).catch(function(err) {
    // The connection to the invitation server has failed.  This could be
    // because the front domain is malfunctioning.  Try again with one of the
    // default front domains.  This last-ditch effort is worthwhile because
    // (1) invitations only contain a single server, so the front domain is a
    // single point of failure, and (2) there is a known related bug, #2619.
    // In the future, we may want to generalize this approach to include all
    // connection retries, not only when processing invitations.
    var server = servers[0];
    if (!server.front) {
      // This isn't a fronted server, so there's nothing to retry.
      throw err;
    }
    var domainComponents = server.domain.split('.');
    if (domainComponents.length < 3) {
      // For very short domains, we don't know how to identify which CDN they
      // use.
      throw err;
    }
    var cloudDomain = domainComponents.slice(1).join('.');
    var alternateFront = null;
    // Find the first front domain for this cloud in the default set.
    // For this algorithm to work well, the first default server listed for each
    // cloud domain should include the front domain that we think will be most
    // reliable.
    for (var i = 0; i < QuiverSocialProvider.DEFAULT_SERVERS_.length; ++i) {
      var defaultServer = QuiverSocialProvider.DEFAULT_SERVERS_[i];
      if (defaultServer.domain.endsWith(cloudDomain) &&
          defaultServer.type === server.type &&
          defaultServer.front) {
        alternateFront = defaultServer.front;
        break;
      }
    }
    if (!alternateFront) {
      // We didn't find any default server on the same cloud, so we don't know
      // of any alternate front domain.
      throw err;
    }
    if (alternateFront === server.front) {
      // To get to this point, something like the following must happen:
      // 1. The user received an invite which failed.
      // 2. This function retried the server with an alternate front domain
      // (e.g. a0.awsstatic.com).
      // 3. The retry also failed.  The loop selected a0.awsstatic.com as the
      // alternateFront again, so this alternateFront === server.front check
      // was hit. Given that we expect a0.awsstatic.com should always work,
      // this indicates that the connection failed for some other reason
      // (e.g. network disconnection, actual server failure).
      //
      // At this point we rethrow the error to admit defeat and prevent an
      // infinite retry loop.
      throw err;
      // CONSIDER: Retrying with each of the possible front domains, keeping
      // track of the ones tried already to avoid infinite recursion.
    }
    /* QuiverSocialProvider.Server_ */ var serverWithNewFront = {
      type: server.type,
      domain: server.domain,
      front: alternateFront
    };
    // This will append the modified server to the friend's configuration, sync
    // it to disk, and try to connect to it.
    return this.addFriend_([serverWithNewFront], userId, pubKey, knockCodes,
        nick);
  }.bind(this));
};

/**
 * @param {QuiverSocialProvider.server_} server
 * @private
 */
QuiverSocialProvider.prototype.removeServer_ = function(server) {
  var serverKey = QuiverSocialProvider.serverKey_(server);

  delete this.configuration_.self.servers[serverKey];
  this.syncConfiguration_().then(function() {});
};

/**
 * @param {QuiverSocialProvider.server_} server
 * @private
 */
QuiverSocialProvider.prototype.addServer_ = function(server) {
  var serverKey = QuiverSocialProvider.serverKey_(server);
  if (serverKey in this.configuration_.self.servers) {
    // No action needed, server is already known.
    return;
  }

  this.configuration_.self.servers[serverKey] = server;
  this.syncConfiguration_().then(function() {
    this.connect_(server).ready.catch(function(err) {
      this.warn_('Failed to connect to new server: ' + serverKey);
    });
  }.bind(this));
};

/**
 * Returns all the <user_profile>s that we've seen so far (from 'onUserProfile' events)
 *
 * @override
 */
QuiverSocialProvider.prototype.getUsers = function() {
  if (!this.configuration_) {
    return Promise.reject('OFFLINE');
  }

  var profiles = {};
  for (var userId in this.configuration_.friends) {
    profiles[userId] = this.makeProfile_(userId);
  }
  var myUserId = this.configuration_.self.id;
  if (!myUserId) {
    return Promise.reject('OFFLINE');
  }
  profiles[myUserId] = this.makeProfile_(myUserId);
  return Promise.resolve(profiles);
};

/**
 * @param {string} userId
 * @returns {!Object}
 * @private
 */
QuiverSocialProvider.prototype.makeProfile_ = function(userId) {
  var nick;
  if (userId == this.configuration_.self.id) {
    nick = this.configuration_.self.nick;
  } else {
    nick = this.configuration_.friends[userId].nick;
  }
  return {
    userId: userId,
    lastUpdated: Date.now(),  // FIXME what does this mean?
    name: nick
  };
};

/**
 * @param {string} userId
 * @param {string} clientSuffix
 * @param {boolean=} opt_forceOnline
 * @private
 */
QuiverSocialProvider.prototype.makeClientState_ = function(userId, clientSuffix, opt_forceOnline) {
  var isOnline;
  if (userId == this.configuration_.self.id) {
    isOnline = this.isOnline_();
  } else {
    isOnline = this.clientConnections_[userId].length > 0 &&
        !!this.clients_[userId] && !!this.clients_[userId][clientSuffix] &&
        !QuiverSocialProvider.isEmpty_(this.clients_[userId][clientSuffix].gotIntro);
    if (!isOnline) {
      this.log_('makeClientState_ OFFLINE for ' + userId +
          ', opt_forceOnline: ' + opt_forceOnline +
          ', this.clientConnections_[userId].length: ' + this.clientConnections_[userId].length +
          ', !!this.clients_[userId]: ' + !!this.clients_[userId] +
          ', !!this.clients_[userId][clientSuffix]: ' + !!this.clients_[userId][clientSuffix] +
          ', !QuiverSocialProvider.isEmpty_(this.clients_[userId][clientSuffix].gotIntro: ' + !QuiverSocialProvider.isEmpty_(this.clients_[userId][clientSuffix].gotIntro));
    }
  }
  isOnline = opt_forceOnline || isOnline;
  return {
    userId: userId,
    clientId: userId + '#' + clientSuffix,
    status: isOnline ? 'ONLINE' : 'OFFLINE',
    lastUpdated: Date.now(),  // TODO
    lastSeen: Date.now()  // TODO
  };
};

/**
 * Returns all the <client_state>s that we've seen so far (from any 'onClientState' event)
 * Use the clientId returned from social.login() to extract your element
 * NOTE: This does not guarantee to be entire roster, just clients we're currently aware of at the moment
 * e.g. social.getClients()
 *
 * @override
 *   On failure, rejects with an error code (see above)
 */
QuiverSocialProvider.prototype.getClients = function() {
  if (!this.configuration_) {
    return Promise.reject('OFFLINE');
  }

  var clientStates = {};
  for (var userId in this.clients_) {
    for (var clientSuffix in this.clients_[userId]) {
      var clientState = this.makeClientState_(userId, clientSuffix);
      clientStates[clientState.clientId] = clientState;
    }
  }
  return Promise.resolve(clientStates);
};

/**
 * Send a message to user on your network
 * If the destination is not specified or invalid, the message is dropped
 * Note: userId and clientId are the same for this.websocket
 * e.g. sendMessage(String destination_id, String message)
 *
 * @override
 */
QuiverSocialProvider.prototype.sendMessage = function(to, msg) {
  return new Promise(function(F, R) {
    // this.configuration may not be set if sendMessage is called right after
    // login without waiting for the continuation.
    this.syncConfiguration_().then(function () {
      var userId, clientSuffix;
      var breakPoint = to.indexOf('#');
      if (breakPoint === -1) {
        userId = to;
        clientSuffix = null;
      } else {
        userId = to.slice(0, breakPoint);
        clientSuffix = to.slice(breakPoint + 1);
      }

      if (!this.isOnline_()) {
        R('OFFLINE');
        return;
      } else if (!(userId in this.clientConnections_) || (clientSuffix && !(clientSuffix in this.clients_[userId]))) {
        R('SEND_INVALIDDESTINATION');
        return;
      }

      var friend = userId === this.configuration_.self.id ?
          this.configuration_.self : this.configuration_.friends[userId];
      if (!friend) {
        R('SEND_INVALIDDESTINATION');
        return;
      }
      // TODO: Handle more than one message per millisecond.  Currently, if two
      // messages are sent in one millisecond, one will be dropped.
      var index = Date.now();
      var connections = this.clientConnections_[userId];
      if (connections.length > 0) {
        this.emitEncrypted_(connections, friend, {
          cmd: 'msg',
          msg: msg,
          index: index,  // For de-duplication across paths.
          fromClient: this.clientSuffix_,
          toClient: clientSuffix  // null for broadcast
        });
        F();
      } else {
        R('OFFLINE');
      }
    }.bind(this));  // end of syncConfiguration
  }.bind(this));  // end of return new Promise
};

/**
 * @param {Object} msg The object to send.
 * @param {?string=} opt_key The recipient's public key.  Omit to sign only.
 * @return {!Promise<!Object>} The returned object is JSON plus arraybuffers.
 * @private
 */
QuiverSocialProvider.prototype.signEncryptMessage_ = function(msg, opt_key) {
  if (!msg) {
    msg = null;
  }
  var msgString = JSON.stringify(msg);

  // Memoize encryption.  This removes the unpredictability of PGP encryption,
  // and potentially leaks metadata about the number of friends (if the cache
  // fills) but we are not relying on these features.
  var msgKey = msgString + ';' + (opt_key || '');

  /** @type {Promise<!ArrayBuffer>} */ var cipherDataPromise;
  if (this.encryptCache_.has(msgKey)) {
    cipherDataPromise = this.encryptCache_.get(msgKey);
  } else {
    var msgBuffer = textEncoder.encode(msgString).buffer;
    cipherDataPromise = this.pgp_.signEncrypt(msgBuffer, opt_key);
    this.encryptCache_.set(msgKey, cipherDataPromise);
  }

  return cipherDataPromise.then(function(cipherData) {
    // cipherData is an ArrayBuffer.  socket.io supports sending ArrayBuffers.
    return {
      key: this.configuration_.self.pubKey,
      cipherText: cipherData
    };
  }.bind(this));
};

/**
 * @param {!Array<!QuiverSocialProvider.connection_>} connections
 * @param {QuiverSocialProvider.userDesc_} friend
 * @param {Object} msg JSON-ifiable message
 * @private
 */
QuiverSocialProvider.prototype.emitEncrypted_ = function(connections, friend,
    msg) {
  if (!connections || connections.length === 0) {
    this.logError_('BUG: Tried to send on null socket');
    return;
  }

  if (!friend.pubKey) {
    this.logError_('BUG: Tried to encrypt a message but there is no key');
    return;
  }

  this.signEncryptMessage_(msg, friend.pubKey).then(function(cipherData) {
    // cipherData is an ArrayBuffer.  socket.io supports sending ArrayBuffers.
    connections.forEach(function(connection) {
      connection.socket.emit('emit', {
        room: friend.id,
        msg: cipherData
      });
    }, this);
  }.bind(this)).catch(function(e) {
    this.warn_('emit failed: ' + e);
  }.bind(this));
};

/**
 * Disconnects from the Web Socket server
 * e.g. logout(Object options)
 * No options needed
 *
 * @override
 */
QuiverSocialProvider.prototype.logout = function() {
  for (var serverKey in this.connections_) {
    var conn = this.connections_[serverKey];
    if (conn.socket.connected) {
      conn.socket.close();
    }
    this.cleanupServer_(serverKey);
  }
  this.dispatchEvent('onClientState',
      this.makeClientState_(this.configuration_.self.id, this.clientSuffix_));
  return Promise.resolve();
};

/**
 * INTERNAL METHODS
 **/

/**
 * Dispatch an 'onClientState' event with the following status and return the <client_card>
 * Note, because clients are ephemeral, we simply ignore offline clients unless clientSuffix
 * is specified.
 *
 * @method changeRoster
 * @private
 * @param {string} userId
 * @param {?string=} clientSuffix Optional.
 **/
QuiverSocialProvider.prototype.changeRoster = function(userId, clientSuffix) {
  var userProfile = this.makeProfile_(userId);
  this.dispatchEvent('onUserProfile', userProfile);

  if (clientSuffix) {
    var clientState = this.makeClientState_(userId, clientSuffix);
    this.dispatchEvent('onClientState', clientState);
  } else {
    for (var eachClientSuffix in this.clients_[userId]) {
      var eachClientState = this.makeClientState_(userId, eachClientSuffix);
      this.dispatchEvent('onClientState', eachClientState);
    }
  }
};

/**
 * @param {!QuiverSocialProvider.server_} server The server through which the
 *     message was delivered.
 * @param {Object} msg Encrypted message from the server
 * @private
 **/
QuiverSocialProvider.prototype.onEncryptedMessage_ = function(server, msg) {
  if (!msg) {
    return;
  }

  if (!this.connections_[QuiverSocialProvider.serverKey_(server)]) {
    this.logError_('No such server!');
    return;
  }

  // Memoize decryption.  For security, it's important that msgKey be
  // non-collidable even if the sender is hostile.
  var bytes = new Uint8Array(msg.cipherText);
  var msgKey = msg.key + ';' + Array.prototype.join.call(bytes, ':');

  /** @type {Promise<!FreedomPgpDecryptResult>} */ var plainTextPromise;
  if (this.decryptCache_.has(msgKey)) {
    plainTextPromise = this.decryptCache_.get(msgKey);
  } else {
    plainTextPromise = this.pgp_.verifyDecrypt(msg.cipherText, msg.key);
    this.decryptCache_.set(msgKey, plainTextPromise);
  }

  plainTextPromise.then(function(plain) {
    var text = textDecoder.decode(plain.data);
    var obj = JSON.parse(text);
    this.pgp_.getFingerprint(msg.key).then(function(fingerprintStruct) {
      var userId = QuiverSocialProvider.makeUserId_(fingerprintStruct);
      this.onMessage(server, obj, userId, msg.key);
    }.bind(this));
  }.bind(this)).catch(function(e) {
    this.warn_('Decryption failed: ' + e);
  }.bind(this));
};

/**
 * Interpret decrypted messages from another user.
 * There are 3 types of commands in these messages
 * - Application message comands (msg)
 * - Introduction/state update commands (intro)
 * - Disconnection commands (disconnected)
 *
 * @method onMessage
 * @private
 * @param {!QuiverSocialProvider.server_} server The server through which the message was delivered
 * @param {*} msg Message from the server
 * @param {string} fromUserId
 * @param {string} fromPubKey
 **/
QuiverSocialProvider.prototype.onMessage = function(server, msg, fromUserId,
    fromPubKey) {
  if (!msg) {
    return;
  }

  if (!msg.fromClient) {
    return; // All messages must indicate the sending client.
  }

  if (msg.toClient && msg.toClient !== this.clientSuffix_) {
    return;  // Ignore message to another client.
  }

  this.log_('received message from ' + fromUserId + ', cmd: ' + msg.cmd);

  // Update the sender's public key.  This should only happen if the key is
  // missing, which happens after accepting an invite.
  /** @type {QuiverSocialProvider.userDesc_} */
  var friendDesc = fromUserId === this.configuration_.self.id ?
      this.configuration_.self :
      this.configuration_.friends[fromUserId];
  if (friendDesc && friendDesc.pubKey !== fromPubKey) {
    friendDesc.pubKey = fromPubKey;
    this.syncConfiguration_().then(function() {});
  }

  // TODO: Keep track of which message came through which server
  var serverKey = QuiverSocialProvider.serverKey_(server);
  /** @type {!Object<string, boolean>} */ var gotIntro;
  if (msg.cmd === 'ping') {
    var connection = this.connections_[serverKey];
    // Only pings are allowed to go unencrypted.
    // Reply to the ping with an encrypted intro msg.
    if (friendDesc) {
      this.addClient_(fromUserId, msg.fromClient);
      var introMsg = this.makeIntroMsg_(friendDesc);
      this.emitEncrypted_([connection], friendDesc, introMsg);
      gotIntro = this.clients_[fromUserId][msg.fromClient].gotIntro;
      if (!gotIntro[serverKey]) {
        this.emitEncrypted_([connection], friendDesc, {
          cmd: 'ping',
          fromClient: this.clientSuffix_,
          toClient: msg.fromClient
        });
      }
    } else {
      // A ping from an unknown party might be someone trying to use an invite.
      // They know our userId (key fingerprint), but they need to know our
      // public key and client ID.  This reply ping provides that information,
      // which we regard as public.
      /** @type {QuiverSocialProvider.userDesc_} */
      var sender = {
        id: fromUserId,
        pubKey: fromPubKey,
        knockCodes: [],
        servers: {},
        nick: null
      };
      this.emitEncrypted_([connection], sender, {
        cmd: 'ping',
          toClient: msg.fromClient,
          fromClient: this.clientSuffix_,
      });
    }
  } else if (msg.cmd === 'msg') {
    if (!(fromUserId in this.configuration_.friends) && fromUserId != this.configuration_.self.id) {
      return;  // Don't accept messages from unknown parties.
      // TODO use message signing to make this secure.
    }
    if (!msg.toClient || msg.toClient == this.clientSuffix_) {
      if (this.clients_[fromUserId] && this.clients_[fromUserId][msg.fromClient]) {
        if (msg.index > this.clients_[fromUserId][msg.fromClient].fromCounter) {
          this.clients_[fromUserId][msg.fromClient].fromCounter = msg.index;
          // |true| means force ClientState to be ONLINE.  This is needed because
          // we cannot be sending messages from clients who are ostensibly offline!
          this.dispatchEvent('onMessage', {
            from: this.makeClientState_(fromUserId, msg.fromClient, true),
            message: msg.msg
          });
        } else {
          this.log_('Ignoring duplicate message with index ' + msg.index);
        }
      } else {
        this.warn_('Ignoring message from unknown user');
      }
    }
  } else if (msg.cmd === 'intro') {
    if (this.shouldAllowIntro_(fromUserId, msg)) {
      this.addFriend_(msg.servers, fromUserId, fromPubKey, [], msg.nick)
      .then(function() {
        // TODO: Remove each code in msg.knockCodes from liveKnockCodes if it is
        // limited to a single user.
        this.addClient_(fromUserId, msg.fromClient);
        gotIntro = this.clients_[fromUserId][msg.fromClient].gotIntro;
        gotIntro[serverKey] = true;
        this.changeRoster(fromUserId, msg.fromClient);
      }.bind(this));
    }
  } else if (msg.cmd === 'disconnected') {
    if (this.clients_[fromUserId] &&
        this.clients_[fromUserId][msg.fromClient]) {
      gotIntro = this.clients_[fromUserId][msg.fromClient].gotIntro;
      delete gotIntro[serverKey];
    }
    // TODO: Ping to see if the user is still alive.
    this.changeRoster(fromUserId, msg.fromClient);
  }
};

/**
 * Idempotent.  Only to be called on trusted (friendly) clients.
 * @param {string} userId
 * @param {string} clientSuffix
 * @private
 */
QuiverSocialProvider.prototype.addClient_ = function(userId, clientSuffix) {
  if (!this.clients_[userId]) {
    this.clients_[userId] = {};
  }
  if (!this.clients_[userId][clientSuffix]) {
    this.clients_[userId][clientSuffix] = QuiverSocialProvider.makeClientTracker_();
  }
};

/**
 * @param {string} fromUserId
 * @param {*} introMsg
 * @return {boolean} Whether |introMsg| is from a trusted source.  If not, it
 *     should be discarded.
 * @private
 */
QuiverSocialProvider.prototype.shouldAllowIntro_ = function(fromUserId, introMsg) {
  if (fromUserId === this.configuration_.self.id ||
      this.configuration_.friends[fromUserId]) {
    return true;
  }

  for (var i = 0; i < introMsg.knockCodes.length; ++i) {
    if (this.configuration_.liveKnockCodes.indexOf(introMsg.knockCodes[i]) != -1) {
      return true;
    }
  }

  return false;
};

/**
 * Initialize this.logger_.
 * @private
 */
QuiverSocialProvider.prototype.initLogger_ = function() {
  if (typeof freedom !== 'undefined' &&
      typeof freedom.core === 'function') {
    freedom.core().getLogger('[QuiverSocialProvider]').then(function(log) {
      this.logger_ = log;
    }.bind(this));
  }
};

/**
 * @param {string} str
 * @private
 */
QuiverSocialProvider.prototype.log_ = function(str) {
  this.logger_.log(str);
};

/**
 * @param {string} str
 * @private
 */
QuiverSocialProvider.prototype.warn_ = function(str) {
  this.logger_.warn(str);
};

/**
 * @param {string} str
 * @private
 */
QuiverSocialProvider.prototype.logError_ = function(str) {
  this.logger_.error(str);
};

// Register provider when in a module context.
if (typeof freedom !== 'undefined') {
  if (!freedom.social) {
    freedom().providePromises(QuiverSocialProvider);
  } else {
    // FIXME should this be social2?
    freedom.social().providePromises(QuiverSocialProvider);
  }
}
