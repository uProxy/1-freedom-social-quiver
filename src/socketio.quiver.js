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
}];

/**
 * @private @typedef {{
 *   servers: !Object.<string, !QuiverSocialProvider.server_>,
 *   userId: string,
 *   nick: ?string
 * }}
 * Note: the keys in |servers| are serverKeys.
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
 *   nick: ?string,
 *   servers: !Object.<string, QuiverSocialProvider.server_>
 * }}
 */
QuiverSocialProvider.userDesc_ = undefined;

/**
 * @private @typedef {{
 *   self: QuiverSocialProvider.userDesc_,
 *   friends: !Object.<string, QuiverSocialProvider.userDesc_>
 * }}
 */
QuiverSocialProvider.configuration_ = undefined;

/**
 * @private @typedef {{
 *   socket: Socket,
 *   ready: Promise.<void>,
 *   owner: boolean,
 *   friends: !Array.<string>
 * }}
 */
QuiverSocialProvider.connection_ = undefined;

/**
 * @param {!Array<T>} list To sample from
 * @param {number} k Target number of samples
 * @return {!Array<T>} Subset of |list|
 * @template T
 */
QuiverSocialProvider.randomSample_ = function(list, k) {
  if (k >= list.length) {
    return list;
  }

  // Algorithm R: https://en.wikipedia.org/wiki/Reservoir_sampling#Algorithm_R
  var sample = list.slice(0, k);
  for (var i = k; i < list.length; ++i) {
    var j = Math.floor(Math.random() * i);
    if (j < k) {
      sample[j] = list[i];
    }
  }

  return sample;
};

/**
 * @param {!Array<T>} list To shuffle
 * @return {!Array<T>} Shuffled copy of list
 * @template T
 */
QuiverSocialProvider.shuffle_ = function(list) {
  var tagged = list.map(function(x) { return [Math.random(), x]; });
  tagged.sort(function(a, b) { return a[0] - b[0]; });
  return tagged.map(function(x) { return x[1]; });
};

/** @return {!QuiverSocialProvider.configuration_} */
QuiverSocialProvider.makeDefaultConfiguration_ = function() {
  var selectedServers = QuiverSocialProvider.randomSample_(
      QuiverSocialProvider.DEFAULT_SERVERS_,
      QuiverSocialProvider.MAX_CONNECTIONS_);
  /** @type {!Object.<string, QuiverSocialProvider.server_> } */
  var defaultServers = {};
  selectedServers.forEach(function(server) {
    var serverKey = QuiverSocialProvider.serverKey_(server);
    defaultServers[serverKey] = server;
  });
  return {
    self: {
      id: String(Math.random()),  // TODO(bemasc): Make this an EC pubkey.
      nick: null,
      servers: defaultServers
    },
    friends: {}
  };
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
      this.configuration_ = QuiverSocialProvider.makeDefaultConfiguration_();
      this.syncConfiguration_(continuation);
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
  return this.configuration_.self.id + ':' + this.clientSuffix_;
};

/** @override */
QuiverSocialProvider.prototype.clearCachedCredentials = function() {
  // TODO(bemasc): What does this even mean?
};

/**
 * Connect to the Web Socket rendezvous server
 * e.g. social.login(Object options)
 * The only login option needed is 'agent', used to determine which group to join in the server
 *
 * @override
 */
QuiverSocialProvider.prototype.login = function(loginOpts, continuation) {
  if (this.countOwnerConnections_() > 0) {
    continuation(undefined, this.err("LOGIN_ALREADYONLINE"));
    return;
  }

  this.clientSuffix_ = loginOpts.agent;

  if (!this.clientSuffix_) {
    continuation(undefined, this.err('No client suffix'));  // TODO: Pick an error code.
    return;
  }

  this.syncConfiguration_(function() {
    this.clients_[this.configuration_.self.id] = {};
    this.clients_[this.configuration_.self.id][this.clientSuffix_] = QuiverSocialProvider.makeClientTracker_();

    this.setNick_(loginOpts.userName);

    var finishLogin = function() {
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
            this.connectAsClient_.bind(this, friend, null)).
                catch(onConnectionFailure.bind(this, friend)));
      }
      return Promise.all(connectionPromises);
    }.bind(this);

    // The server connection heuristic is currently a three-step process.
    // Step 1: Connect to my own long-term servers as an owner (i.e. listening
    // for messages from friends).
    this.connectLoop_(this.configuration_.self.servers,
        this.connectAsOwner_.bind(this)).then(function(results) {
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
      var deficit = QuiverSocialProvider.MAX_CONNECTIONS_ - this.countOwnerConnections_();
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
            this.connectAsOwner_.bind(this), deficit);
      }
    }.bind(this)).then(finishLogin);
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
 * @param {function(!QuiverSocialProvider.server_, Function)} connector
 * @param {number=} opt_limit Optional limit, defaults to MAX_CONNECTIONS
 * @return {!Promise<!QuiverSocialProvider.connectLoopResults_>} Always fulfills.
 *     
 * @private
 */
QuiverSocialProvider.prototype.connectLoop_ = function(servers, connector,
    opt_limit) {
  var limit = opt_limit || QuiverSocialProvider.MAX_CONNECTIONS_;

  /** @type {Function} */ var fulfill;
  /** @type {Function} */ var reject;
  var promise = new Promise(function(F, R) {
    fulfill = F;
    reject = R;
  });

  var serverKeys = QuiverSocialProvider.shuffle_(Object.keys(servers));
  var tried = 0;
  /** @type {!Array<!QuiverSocialProvider.server_>} */
  var succeeded = [];
  /** @type {!Array<!QuiverSocialProvider.server_>} */
  var failed = [];
  var helper = function(retval, failure) {
    var lastServer = servers[serverKeys[tried - 1]];
    if (failure) {
      failed.push(lastServer);
    } else {
      succeeded.push(lastServer);
    }
    if (succeeded.length === limit || tried === serverKeys.length) {
      fulfill({succeeded: succeeded, failed: failed});
      return;
    }
    var nextServer = servers[serverKeys[tried]];
    ++tried;
    connector(nextServer, helper);
  }.bind(this);

  helper(undefined, undefined);
  return promise;
};

QuiverSocialProvider.prototype.sendAllRosterChanged_ = function() {
  this.changeRoster(/** @type {string} */ (this.configuration_.self.id), null);

  for (var userId in this.clients_) {
    this.changeRoster(userId, null);
  }
};

QuiverSocialProvider.prototype.countOwnerConnections_ = function() {
  var count = 0;
  for (var serverKey in this.connections_) {
    if (this.connections_[serverKey].owner) {
      ++count;
    }
  }
  return count;
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
      owner: false,
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
    owner: false,
    friends: []
  };
  socket.on("connect", resolve);

  socket.on("error", function(err) {
    console.log('Ignoring socket.io error: ' + err);
  }.bind(this));

  socket.on("connect_error", function(err) {
    console.log('Failed to connect to ' + serverUrl);
    this.disconnect_(server);
    reject(err);
  }.bind(this));

  socket.on("message", this.onMessage.bind(this, server));
  socket.on("reconnect_failed", function(msg) {
    this.disconnect_(server);
    reject(new Error('Never connected to ' + serverUrl));
  }.bind(this));

  return this.connections_[serverKey];
};

/**
 * @param {!QuiverSocialProvider.server_} server
 * @param {Function} continuation
 * @private
 */
QuiverSocialProvider.prototype.connectAsOwner_ = function(server, continuation) {
  var connection = this.connect_(server);
  if (connection.owner) {
    // Already connected as owner.
    return;
  }
  connection.owner = true;

  connection.ready.then(function() {
    connection.socket.emit('join', this.configuration_.self.id);
    connection.socket.emit('emit', {
      room: 'broadcast:' + this.configuration_.self.id,
      msg: this.makeIntroMsg_()
    });

    // Connect to self, in order to be able to send messages to my own other clients.
    this.connectAsClient_(this.configuration_.self, null, server, continuation);

    // Add the server to our public list of contact points.
    this.addServer_(server);
  }.bind(this)).catch(function(err) {
    continuation(undefined, err);
  });
};

/**
 * @param {!QuiverSocialProvider.server_} server
 * @private
 */
QuiverSocialProvider.prototype.disconnect_ = function(server) {
  var serverKey = QuiverSocialProvider.serverKey_(server);
  this.connections_[serverKey].owner = false;
  if (this.connections_[serverKey].friends.length === 0) {
    delete this.connections_[serverKey];
  }
  if (this.countOwnerConnections_() === 0) {
    this.sendAllRosterChanged_();
  }
};

/**
 * @param {!QuiverSocialProvider.userDesc_} friend
 * @param {?string} inviteResponse
 * @param {!QuiverSocialProvider.server_} server
 * @param {Function} continuation
 * @private
 */
QuiverSocialProvider.prototype.connectAsClient_ = function(friend, inviteResponse, server, continuation) {
  if (!this.clientConnections_[friend.id]) {
    this.clientConnections_[friend.id] = [];
  }

  var connection = this.connect_(server);

  if (connection.friends.indexOf(friend.id) !== -1) {
    // Already connected as client.
    connection.ready.then(continuation);
    return;
  }
  connection.friends.push(friend.id);
  this.clientConnections_[friend.id].push(connection);

  connection.ready.then(function() {
    connection.socket.emit('join', 'broadcast:' + friend.id);
    var introMsg = this.makeIntroMsg_();
    if (inviteResponse) {
      introMsg.inviteResponse = inviteResponse;
    }
    connection.socket.emit('emit', {
      'room': friend.id,
      'msg': introMsg
    });
    connection.socket.emit('addDisconnectMessage', {
      'room': friend.id,
      'msg': {
        'cmd': 'disconnected',
        'from': this.configuration_.self.id,
        'fromClient': this.clientSuffix_
      }
    });
    this.changeRoster(friend.id);
    continuation();

    if (this.countOwnerConnections_() < QuiverSocialProvider.MAX_CONNECTIONS_) {
      // We're low on owner servers.  Add this one to the set, since it is
      // evidently working.
      this.addServer_(server);
    }

  }.bind(this)).catch(function(err) {
    continuation(undefined, err);
  });
};

/**
 * @return {!Object} An intro msg.  This msg is idempotent.
 * @private
 */
QuiverSocialProvider.prototype.makeIntroMsg_ = function() {
  /** @type {!Array.<!QuiverSocialProvider.server_>} */ var myServers = [];
  for (var serverKey in this.connections_) {
    if (this.connections_[serverKey].owner) {
      myServers.push(this.configuration_.self.servers[serverKey]);
    }
  }
  return {
    cmd: "intro",
    from: this.configuration_.self.id,
    servers: myServers,
    nick: this.configuration_.self.nick,
    fromClient: this.clientSuffix_
  };
};

/**
 * @param {string} ignoredUserId
 * @param {function(({networkData:string}|undefined), Object=)} cb
 * @override
 */
QuiverSocialProvider.prototype.inviteUser = function(ignoredUserId, cb) {
  // TODO: Show pending invitations and allow cancellation?
  this.syncConfiguration_(function() {
    /** @type {!QuiverSocialProvider.server_} */ var server;
    for (var serverKey in this.connections_) {
      if (this.connections_[serverKey].owner) {
        server = this.configuration_.self.servers[serverKey];
        break;
      }
    }
    if (!server) {
      cb(undefined, this.err('Can\'t invite without a valid connection'));
    }
    /** @type QuiverSocialProvider.invite_ */
    var invite = {
      servers: [server],
      userId: this.configuration_.self.id,
      nick: this.configuration_.self.nick
    };
    cb({networkData: JSON.stringify(invite)});
  }.bind(this));
};



/**
 * @param {string} nick
 * @private
 */
QuiverSocialProvider.prototype.setNick_ = function(nick) {
  this.configuration_.self.nick = nick;
  this.syncConfiguration_(function() {
    this.selfDescriptionChanged_();
  }.bind(this));
};

/** @private */
QuiverSocialProvider.prototype.selfDescriptionChanged_ = function() {
  this.changeRoster(/** @type {string} */ (this.configuration_.self.id));
  for (var userId in this.clientConnections_) {
    var connections = this.clientConnections_[userId];
    for (var i = 0; i < connections.length; ++i) {
      var connection = connections[i];
      var introMsg = this.makeIntroMsg_();
      connection.socket.emit('emit', {
        'room': userId,
        'msg': introMsg
      });
    }
  }
};

/**
 * @param {string} networkData
 * @param {string} inviteResponse
 * @param {Function} cb
 * @override
 */
QuiverSocialProvider.prototype.acceptUserInvitation = function(networkData, inviteResponse, cb) {
  var invite = /** QuiverSocialProvider.invite_ */ JSON.parse(networkData);
  this.addFriend_(invite.servers, invite.userId, invite.nick, inviteResponse, cb);
};

/**
 * @param {!Array.<QuiverSocialProvider.server_>} servers
 * @param {string} userId
 * @param {?string} nick
 * @param {?string} inviteResponse
 * @private
 */
QuiverSocialProvider.prototype.addFriend_ = function(servers, userId, nick, inviteResponse, continuation) {
  console.log('Adding Friend!', arguments);
  var friendDesc = this.configuration_.friends[userId];
  if (!friendDesc) {
    friendDesc = {
      id: userId,
      nick: null,
      servers: []
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
  if (nick) {
    friendDesc.nick = nick;
  }
  this.syncConfiguration_(function() {
    // TODO: Connect to all servers.
    this.connectAsClient_(friendDesc, inviteResponse, servers[0], continuation);
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
    this.connectAsOwner_(server, function(success, err) {
      if (err) {
        console.warn('Failed to connect to new server: ' + serverKey);
      }
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
    isOnline = this.countOwnerConnections_() > 0;
  } else {
    isOnline = this.clientConnections_[userId].length > 0 &&
        !!this.clients_[userId] && !!this.clients_[userId][clientSuffix] &&
        !QuiverSocialProvider.isEmpty_(this.clients_[userId][clientSuffix].gotIntro);
  }
  isOnline = opt_forceOnline || isOnline;
  return {
    userId: userId,
    clientId: userId + ':' + clientSuffix,
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
  var colonPoint = to.indexOf(':');
  if (colonPoint == -1) {
    userId = to;
    clientSuffix = null;
  } else {
    userId = to.slice(0, colonPoint);
    clientSuffix = to.slice(colonPoint + 1);
  }

  if (this.countOwnerConnections_() === 0) {
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

  this.clientConnections_[userId].forEach(function(connection) {
    connection.socket.emit('emit', {
      room: userId,
      msg: {
        cmd: 'msg',
        msg: msg,
        from: this.configuration_.self.id,
        index: index,  // For de-duplication across paths.
        fromClient: this.clientSuffix_,
        toClient: clientSuffix  // null for broadcast
      }
    });
  }.bind(this));
  continuation();
};

/**
 * Disconnects from the Web Socket server
 * e.g. logout(Object options)
 * No options needed
 *
 * @override
 */
QuiverSocialProvider.prototype.logout = function(continuation) {
  if (this.countOwnerConnections_() === 0) { // We may not have been logged in
    continuation(undefined, this.err("OFFLINE"));
    return;
  }

  var onClose = function(serverKey, continuation) {
    delete this.connections_[serverKey];
    if (this.countOwnerConnections_() === 0) {  // FIXME: O(N^2)
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
 * Interpret messages from the server to this as owner.
 * There are 3 types of messages
 * - Directed messages from endpoints (message)
 * - State information from the server on initialization (state)
 * - Roster change events (users go online/offline) (roster)
 *
 * @method onMessage
 * @private
 * @param {!QuiverSocialProvider.server_} server The server through which the message was delivered
 * @param {!Object} msg Message from the server (see server/qsio_server.js for schema)
 * @return nothing
 **/
QuiverSocialProvider.prototype.onMessage = function(server, msg) {
  // TODO: Keep track of which message came through which server
  var serverKey = QuiverSocialProvider.serverKey_(server);
  var fromUserId = msg.from;
  if (msg.cmd === 'msg') {
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
    if (!this.clients_[fromUserId]) {
      this.clients_[fromUserId] = {};
    }
    if (!this.clients_[fromUserId][msg.fromClient]) {
      this.clients_[fromUserId][msg.fromClient] = QuiverSocialProvider.makeClientTracker_();
    }
    this.addFriend_(msg.servers, fromUserId, msg.nick, null, function() {
      var gotIntro = this.clients_[fromUserId][msg.fromClient].gotIntro;
      if (!gotIntro[serverKey]) {
        gotIntro[serverKey] = true;
        // Reply to the first intro message we receive.  This will result in
        // a redundant triple-handshake for no reason ... except that we have
        // no way to be sure that an "intro" message was in response to ours,
        // rather than a result of a user signing on right after we sent the
        // initial intro message.
        // TODO: Can this be removed now that we have a "broadcast:" room?
        var friend = this.configuration_.friends[fromUserId];
        var introMsg = this.makeIntroMsg_();
        this.connections_[serverKey].socket.emit('emit', {
          'room': friend.id,
          'msg': introMsg
        });
      }
      this.changeRoster(fromUserId, msg.fromClient, msg.inviteResponse);
    }.bind(this));
  } else if (msg.cmd === 'disconnected') {
    if (this.clients_[fromUserId] &&
        this.clients_[fromUserId][msg.fromClient]) {
      var gotIntro = this.clients_[fromUserId][msg.fromClient].gotIntro;
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
