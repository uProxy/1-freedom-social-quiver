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
  front: 'a0.awsstatic.com'
}, {
  type: 'socketio',
  domain: 'd2oi2yhmhpjpt7.cloudfront.net',
  front: 'a0.awsstatic.com'
}, {
  type: 'socketio',
  domain: 'd2cqtpyb8m6x8r.cloudfront.net',
  front: 'a0.awsstatic.com'
}, {
  type: 'socketio',
  domain: 'd3h805atiromvi.cloudfront.net',
  front: 'a0.awsstatic.com'
}, {
  type: 'socketio',
  domain: 'd2yp1zilrgqkqt.cloudfront.net',
  front: 'a0.awsstatic.com'
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
 *   toCounter: number,
 *   fromCounter: number,
 *   gotIntro: !Object.<string, boolean>
 * }}
 * Note: the gotIntro object represents a set, so all values are true.
 */
QuiverSocialProvider.clientTracker_ = undefined;

QuiverSocialProvider.makeClientTracker_ = function() {
  return {
    toCounter: 0,
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
 *   knockCodes: !Array.<string>,
 *   inviteResponse: ?string
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
 *   friends: !Array.<string>
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
 * @param {function()} continuation
 * @private
 */
QuiverSocialProvider.prototype.syncConfiguration_ = function(continuation) {
  if (this.configuration_) {
    this.storage.set('config', JSON.stringify(this.configuration_)).then(continuation);
    return;
  }
  this.storage.get('config').then(function(result) {
    if (result) {
      this.configuration_ = /** @type {QuiverSocialProvider.configuration_} */ (JSON.parse(result));
      continuation();
    } else if (!this.configuration_) {
      this.makeDefaultConfiguration_().then(function(config) {
        if (!this.configuration_) {
          this.configuration_ = config;
        }
        this.syncConfiguration_(continuation);
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
QuiverSocialProvider.prototype.login = function(loginOpts, continuation) {
  if (this.isOnline_()) {
    continuation(undefined, this.err("LOGIN_ALREADYONLINE"));
    return;
  }

  this.clientSuffix_ = loginOpts.agent;

  if (!this.clientSuffix_) {
    continuation(undefined, this.err('No client suffix'));  // TODO: Pick an error code.
    return;
  }

  this.pgp_.setup('', loginOpts.pgpKeyName || '<quiver>').then(function() {
    return this.pgp_.exportKey();
  }.bind(this)).then(this.onPubKey_);

  this.syncConfiguration_(function() {
    this.clients_[this.configuration_.self.id] = {};
    this.clients_[this.configuration_.self.id][this.clientSuffix_] = QuiverSocialProvider.makeClientTracker_();

    this.setNick_(loginOpts.userName);

    this.finishLogin_ = function() {
      this.finishLogin_ = null;
      // Fulfill the method callback
      var clientState = this.makeClientState_(this.configuration_.self.id, this.clientSuffix_);
      continuation(clientState);
      this.sendAllRosterChanged_();
    }.bind(this);

    var connectToFriends = function() {
      var onConnectionFailure = function(friend) {
        console.warn('Failed to connect to friend: ' + JSON.stringify(friend));
      };

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
        console.warn('All server connection attempts failed!');
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
    console.warn('Unknown type: ' + server.type);
    this.connections_[serverKey] = {
      socket: null,
      ready: Promise.reject(),
      friends: []
    };
    return this.connections_[serverKey];
  }

  var connectOptions = {
    'transports': ['polling'],  // Force XHR so we can domain-front
    'forceNew': true  // Required for login-after-logout to work
  };
  var domain = server.front ?
      frontdomain.munge(server.front, server.domain) :
      server.domain;
  var serverUrl = (server.scheme || 'https') + '://' + domain;
  var socket = io.connect(serverUrl, connectOptions);
  var resolve, reject;
  this.connections_[serverKey] = {
    socket: socket,
    ready: new Promise(function(F, R) {
      resolve = F;
      reject = R;
    }),
    friends: []
  };
  socket.on("connect", resolve);

  socket.on("error", function(err) {
    console.log('Ignoring socket.io error: ' + err);
  }.bind(this));

  socket.on("connect_error", function(err) {
    console.log('Failed to connect to ' + serverUrl);
    socket.close();
    this.disconnect_(server);
    reject(err);
  }.bind(this));

  socket.on("message", this.onEncryptedMessage_.bind(this, server));
  socket.on("reconnect_failed", function(msg) {
    this.disconnect_(server);
    reject(new Error('Never connected to ' + serverUrl));
  }.bind(this));

  this.connections_[serverKey].ready.then(function() {
    socket.emit('join', this.configuration_.self.id);

    if (this.finishLogin_) {
      this.finishLogin_();
    }

    // Emit an unencrypted ping on the broadcast channel, so that everyone can
    // see that I have come online.  This ping is not encrypted because it is
    // being sent to all of my friends, including newly invited friends whose
    // user IDs I do not yet know.  This is safe because the ping contains no
    // sensitive information.
    // TODO: Prevent replays, e.g. by adding a timestamp.
    return this.signEncryptMessage_({
      cmd: 'ping',
      fromClient: this.clientSuffix_
    });
  }.bind(this)).then(function(signedPing) {
    socket.emit('emit', {
      room: 'broadcast:' + this.configuration_.self.id,
      msg: signedPing
    });

    // Connect to self, in order to be able to send messages to my own other clients.
    this.connectAsClient_(this.configuration_.self, server);
  }.bind(this));

  return this.connections_[serverKey];
};

/**
 * @param {!QuiverSocialProvider.server_} server
 * @private
 */
QuiverSocialProvider.prototype.disconnect_ = function(server) {
  var serverKey = QuiverSocialProvider.serverKey_(server);
  if (this.connections_[serverKey]) {
    if (this.connections_[serverKey].friends.length === 0) {
      delete this.connections_[serverKey];
    }
  } else {
    console.warn('Disconnect called for unknown server: ', server);
  }
  if (!this.isOnline_()) {
    this.sendAllRosterChanged_();
  }
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

  connection.ready.then(function() {
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

    if (friend.pubKey) {
      // Normally we want to add a disconnect message here, immediately after
      // connecting as a client.  However, this will not work when processing
      // an invite, because we do not yet know the recipient's pubKey.
      // TODO: Figure out how to set a disconnect message for the initial
      // connection.
      this.addDisconnectMessage_(connection.socket, friend);
    }

    this.changeRoster(friend.id);

    if (this.getLiveAdvertisedServers_().length <
        QuiverSocialProvider.MAX_CONNECTIONS_) {
      // We're low on connections to advertised servers.  Start advertising
      // this one, since it is evidently working.
      this.addServer_(server);
    }
  }.bind(this));

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
    fromClient: this.clientSuffix_,
    inviteResponse: friend.inviteResponse || undefined
  };
};

/**
 * @param {string} ignoredUserId
 * @param {function((Object|undefined), Object=)} cb
 * @override
 */
QuiverSocialProvider.prototype.inviteUser = function(ignoredUserId, cb) {
  // TODO: Show pending invitations and allow cancellation?

  // This implements Promise.race() except that rejections are ignored.
  /** @type {function(string)} */ var serverIsReady;
  /** @type {!Promise<string>} */
  var ownerRace = new Promise(function(F, R) { serverIsReady = F; });
  this.syncConfiguration_(function() {
    /** @type {!Array.<!QuiverSocialProvider.server_>} */
    var myServers = this.getLiveAdvertisedServers_();
    if (myServers.length === 0) {
      cb(undefined, this.err('Can\'t invite without a valid connection'));
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
      cb(undefined, this.err('Can\'t invite without a valid connection'));
    }

    // Get a knock code.  This code is used to ensure that we only ever send an
    // 'intro' message to people who have received an invite.  This is required
    // because the 'intro' message contains the nick (which might reveal the
    // user's real identity) and the server list (which must be kept secret to
    // prevent an attacker from learning all the servers on the network).
    // 16 bytes is the standard for collision avoidance in a UUID.
    this.crypto_.getRandomBytes(16).then(function(buffer) {
      // Convert to base64, but strip '=' because it adds no entropy.
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
      cb(invite);
    }.bind(this));
  }.bind(this));
};

/**
 * @param {string} nick
 * @private
 */
QuiverSocialProvider.prototype.setNick_ = function(nick) {
  this.configuration_.self.nick = nick;
  this.syncConfiguration_(function() {
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
    for (var i = 0; i < connections.length; ++i) {
      var connection = connections[i];
      var friend = this.configuration_.friends[userId];
      var introMsg = this.makeIntroMsg_(friend);
      this.emitEncrypted_(connection.socket, friend, introMsg);
    }
  }
};

/**
 * @param {Socket} socket
 * @param {QuiverSocialProvider.userDesc_} friend
 * @private
 */
QuiverSocialProvider.prototype.addDisconnectMessage_ =
    function(socket, friend) {
  var disconnectMessage = {
    'cmd': 'disconnected',
    'fromClient': this.clientSuffix_
  };
  this.emitEncrypted_(socket, friend, disconnectMessage, true);
};

/**
 * @param {*} networkData
 * @param {string} inviteResponse
 * @param {!Function} cb
 * @override
 */
QuiverSocialProvider.prototype.acceptUserInvitation = function(networkData, inviteResponse, cb) {
  var invite = /** @type {!QuiverSocialProvider.invite_} */ (networkData);
  this.addFriend_(invite.servers, invite.userId, null, [invite.knockCode],
      invite.nick, inviteResponse, cb);
};

/**
 * @param {!Array.<QuiverSocialProvider.server_>} servers
 * @param {string} userId
 * @param {!Array.<string>} knockCodes Only nonempty when processing an invite
 * @param {?string} pubKey
 * @param {?string} nick
 * @param {?string} inviteResponse
 * @param {function(undefined, *=)} continuation
 * @private
 */
QuiverSocialProvider.prototype.addFriend_ = function(servers, userId, pubKey,
    knockCodes, nick, inviteResponse, continuation) {
  if (userId === this.configuration_.self.id) {
    continuation(undefined);
    return;
  }

  console.log('Adding Friend!', arguments);
  var friendDesc = this.configuration_.friends[userId];
  if (!friendDesc) {
    friendDesc = {
      id: userId,
      pubKey: pubKey,
      nick: null,
      servers: {},
      knockCodes: [],
      inviteResponse: null
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
  friendDesc.inviteResponse = inviteResponse;
  this.syncConfiguration_(function() {
    // TODO: Connect to all servers.
    this.connectAsClient_(friendDesc, servers[0]).ready
        .then(continuation, function(err) {
      continuation(undefined, err);
    });
  }.bind(this));
};

/**
 * @param {QuiverSocialProvider.server_} server
 * @private
 */
QuiverSocialProvider.prototype.removeServer_ = function(server) {
  var serverKey = QuiverSocialProvider.serverKey_(server);

  delete this.configuration_.self.servers[serverKey];
  this.syncConfiguration_(function() {});
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
  this.syncConfiguration_(function() {
    this.connect_(server).ready.catch(function(err) {
      console.warn('Failed to connect to new server: ' + serverKey);
    });
  }.bind(this));
};

/**
 * Returns all the <user_profile>s that we've seen so far (from 'onUserProfile' events)
 *
 * @override
 */
QuiverSocialProvider.prototype.getUsers = function(continuation) {
  if (!this.configuration_) {
    continuation(undefined, this.err("OFFLINE"));
    return;
  }

  var profiles = {};
  for (var userId in this.configuration_.friends) {
    profiles[userId] = this.makeProfile_(userId);
  }
  var myUserId = this.configuration_.self.id;
  if (!myUserId) {
    continuation(undefined, this.err("OFFLINE"));
    return;
  }
  profiles[myUserId] = this.makeProfile_(myUserId);
  continuation(profiles);
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
QuiverSocialProvider.prototype.getClients = function(continuation) {
  if (!this.configuration_) {
    continuation(undefined, this.err("OFFLINE"));
    return;
  }

  var clientStates = {};
  for (var userId in this.clients_) {
    for (var clientSuffix in this.clients_[userId]) {
      var clientState = this.makeClientState_(userId, clientSuffix);
      clientStates[clientState.clientId] = clientState;
    }
  }
  continuation(clientStates);
};

/**
 * Send a message to user on your network
 * If the destination is not specified or invalid, the message is dropped
 * Note: userId and clientId are the same for this.websocket
 * e.g. sendMessage(String destination_id, String message)
 *
 * @override
 */
QuiverSocialProvider.prototype.sendMessage = function(to, msg, continuation) {
  if (!this.configuration_) {
    // This can happen if sendMessage is called right after login without waiting
    // for the continuation.
    this.syncConfiguration_(this.sendMessage.bind(this, to, msg, continuation));
    return;
  }

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
    continuation(undefined, this.err("OFFLINE"));
    return;
  } else if (!(userId in this.clientConnections_) || (clientSuffix && !(clientSuffix in this.clients_[userId]))) {
    continuation(undefined, this.err("SEND_INVALIDDESTINATION"));
    return;
  }

  var index = 0;
  if (clientSuffix) {
    index = ++this.clients_[userId][clientSuffix].toCounter;
  } else {
    // Choose a high enough index for the message that it will be accepted by all clients.
    // TODO: make the toCounter per-user instead of per-client?
    var userClients = this.clients_[userId];
    var suffix;
    for (suffix in userClients) {
      index = Math.max(index, ++userClients[suffix].toCounter);
    }
    // Ensure subsequent messages continue to increase monotonically.
    for (suffix in userClients) {
      userClients[suffix].toCounter = index;
    }
  }

  var friend = userId === this.configuration_.self.id ?
      this.configuration_.self : this.configuration_.friends[userId];
  if (!friend) {
    continuation(undefined, this.err("SEND_INVALIDDESTINATION"));
    return;
  }
  // TODO: Only encrypt once, even if there are multiple connections.
  this.clientConnections_[userId].forEach(function(connection) {
    this.emitEncrypted_(connection.socket, friend, {
      cmd: 'msg',
      msg: msg,
      index: index,  // For de-duplication across paths.
      fromClient: this.clientSuffix_,
      toClient: clientSuffix  // null for broadcast
    });
  }.bind(this));
  continuation();
};

/**
 * @param {?string=} opt_key The recipient's public key.  Omit to sign only.
 * @return {!Promise<!Object>} The returned object is JSON plus arraybuffers.
 * @private
 */
QuiverSocialProvider.prototype.signEncryptMessage_ = function(msg, opt_key) {
  if (!msg) {
    msg = null;
  }
  var msgString = JSON.stringify(msg);
  var msgBuffer = textEncoder.encode(msgString).buffer;
  return this.pgp_.signEncrypt(msgBuffer, opt_key).then(function(cipherData) {
    // cipherData is an ArrayBuffer.  socket.io supports sending ArrayBuffers.
    return {
      key: this.configuration_.self.pubKey,
      cipherText: cipherData
    };
  }.bind(this));
};

/**
 * @param {Socket} socket
 * @param {QuiverSocialProvider.userDesc_} friend
 * @param {*} msg JSON-ifiable message
 * @param {boolean=} opt_disconnect Delay the message until I disconnect
 * @private
 */
QuiverSocialProvider.prototype.emitEncrypted_ = function(socket, friend, msg,
    opt_disconnect) {
  if (!socket) {
    console.error('BUG: Tried to send on null socket');
    return;
  }

  if (!friend.pubKey) {
    console.error('BUG: Tried to encrypt a message but there is no key');
    return;
  }

  this.signEncryptMessage_(msg, friend.pubKey).then(function(cipherData) {
    // cipherData is an ArrayBuffer.  socket.io supports sending ArrayBuffers.
    var verb = opt_disconnect ? 'addDisconnectMessage' : 'emit';
    socket.emit(verb, {
      room: friend.id,
      msg: cipherData
    });
  }.bind(this)).catch(function(e) {
    console.warn('emit failed:', e);
  });
};

/**
 * Disconnects from the Web Socket server
 * e.g. logout(Object options)
 * No options needed
 *
 * @override
 */
QuiverSocialProvider.prototype.logout = function(continuation) {
  if (!this.isOnline_()) { // We may not have been logged in
    continuation(undefined, this.err("OFFLINE"));
    return;
  }

  var onClose = function(serverKey, continuation) {
    delete this.connections_[serverKey];
    if (!this.isOnline_()) {
      continuation();
    }
  };

  for (var serverKey in this.connections_) {
    var conn = this.connections_[serverKey];
    conn.socket.on("disconnect", onClose.bind(this, serverKey, continuation));
    conn.socket.close();
  }
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
 * @param {?string=} inviteResponse
 **/
QuiverSocialProvider.prototype.changeRoster = function(userId, clientSuffix, inviteResponse) {
  var userProfile = this.makeProfile_(userId);
  this.dispatchEvent('onUserProfile', userProfile);

  if (clientSuffix) {
    var clientState = this.makeClientState_(userId, clientSuffix);
    if (inviteResponse) {
      clientState.inviteResponse = inviteResponse;
    }
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

  this.pgp_.verifyDecrypt(msg.cipherText, msg.key).then(function(plain) {
    var text = textDecoder.decode(plain.data);
    var obj = JSON.parse(text);
    this.pgp_.getFingerprint(msg.key).then(function(fingerprintStruct) {
      var userId = QuiverSocialProvider.makeUserId_(fingerprintStruct);
      this.onMessage(server, obj, userId, msg.key);
    }.bind(this));
  }.bind(this)).catch(function(e) {
    console.warn('Decryption failed:', e);
  });
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

  // Update the sender's public key.  This should only happen if the key is
  // missing, which happens after accepting an invite.
  /** @type {QuiverSocialProvider.userDesc_} */
  var friendDesc = fromUserId === this.configuration_.self.id ?
      this.configuration_.self :
      this.configuration_.friends[fromUserId];
  if (friendDesc && friendDesc.pubKey !== fromPubKey) {
    friendDesc.pubKey = fromPubKey;
    this.syncConfiguration_(function() {});
  }

  // TODO: Keep track of which message came through which server
  var serverKey = QuiverSocialProvider.serverKey_(server);
  /** @type {!Object<string, boolean>} */ var gotIntro;
  var socket = this.connections_[serverKey].socket;
  if (msg.cmd === 'ping') {
    // Only pings are allowed to go unencrypted.
    // Reply to the ping with an encrypted intro msg.
    if (friendDesc) {
      this.addClient_(fromUserId, msg.fromClient);
      var introMsg = this.makeIntroMsg_(friendDesc);
      this.emitEncrypted_(socket, friendDesc, introMsg);
      gotIntro = this.clients_[fromUserId][msg.fromClient].gotIntro;
      if (!gotIntro[serverKey]) {
        this.emitEncrypted_(socket, friendDesc, {
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
        nick: null,
        inviteResponse: null
      };
      this.emitEncrypted_(socket, sender, {
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
          console.log('Ignoring duplicate message with index ' + msg.index);
        }
      } else {
        console.warn('Ignoring message from unknown user');
      }
    }
  } else if (msg.cmd === 'intro') {
    if (this.shouldAllowIntro_(fromUserId, msg)) {
      this.addFriend_(msg.servers, fromUserId, fromPubKey, [], msg.nick, null,
          function() {
        // TODO: Remove each code in msg.knockCodes from liveKnockCodes if it is
        // limited to a single user.
        this.addClient_(fromUserId, msg.fromClient);
        gotIntro = this.clients_[fromUserId][msg.fromClient].gotIntro;
        gotIntro[serverKey] = true;
        this.changeRoster(fromUserId, msg.fromClient, msg.inviteResponse);
      }.bind(this));
    }
  } else if (msg.cmd === 'disconnected') {
    if (this.clients_[fromUserId] &&
        this.clients_[fromUserId][msg.fromClient]) {
      gotIntro = this.clients_[fromUserId][msg.fromClient].gotIntro;
      delete gotIntro[serverKey];

      // Reset fromCounter and toCounter if the user has signed out.
      // This is needed in order to support non-ephemeral clientSuffixes.
      // TODO: Replace with a less racy mechanism.
      var key = null;
      for (key in gotIntro) {
        break;
      }
      if (!key) {
        this.clients_[fromUserId][msg.fromClient].toCounter = 0;
        this.clients_[fromUserId][msg.fromClient].fromCounter = 0;
      }
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

QuiverSocialProvider.prototype.err = function(code) {
  var err = {
    errcode: code,
    message: 'TODO: figure out how to populate message field'
  };
  return err;
};

// Register provider when in a module context.
if (typeof freedom !== 'undefined') {
  if (!freedom.social) {
    freedom().provideAsynchronous(QuiverSocialProvider);
  } else {
    // FIXME should this be social2?
    freedom.social().provideAsynchronous(QuiverSocialProvider);
  }
}
