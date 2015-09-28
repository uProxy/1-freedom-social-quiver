/*globals freedom:true, XMLHttpRequest:true, DEBUG */
/*jslint indent:2, white:true, node:true, sloppy:true, browser:true */

var xhr = require('./xhrshim');
/* jshint ignore:start */
XMLHttpRequest = xhr;
/* jshint ignore:end */
if (typeof window !== 'undefined') {
  window.XMLHttpRequest = xhr;
}


var io = require('socket.io-client');

var myDebug = require("debug");
myDebug.enable('*');

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
  this.clientSuffix_ = String(Math.random());

  /** @private {!Object.<string, !Object.<string, QuiverSocialProvider.clientTracker_>>} */
  this.clients_ = {};  // userId, clientSuffix => clientTracker

  /** @private {!Object.<string, QuiverSocialProvider.connection_>} */
  this.connections_ = {};  // server => connection

  // The connections in clientConnections_ and connections_ are referentially equal.
  /** @private {!Object.<string, QuiverSocialProvider.connection_[]>} */
  this.clientConnections_ = {};  // userId => connection[]

  /** @private {?QuiverSocialProvider.configuration_} */
  this.configuration_ = null;
}

// TODO: Replace this localhost server with a public host.  Using a
// localhost server prevents you from talking to anyone.
/** @const @private {!Array.<string>} */
QuiverSocialProvider.DEFAULT_SERVERS_ = ['https://quiver-test.appspot.com/'];

/** @const @private {number} */
QuiverSocialProvider.MAX_CONNECTIONS_ = 5;

/**
 * @private @typedef {{
 *   toCounter: number,
 *   fromCounter: number,
 *   gotIntro: boolean
 * }} 
 */
QuiverSocialProvider.clientTracker_ = undefined;

QuiverSocialProvider.makeClientTracker_ = function() {
  return {
    toCounter: 0,
    fromCounter: 0,
    gotIntro: false
  };
};

/**
 * @private @typedef {{
 *   id: ?string,
 *   nick: ?string,
 *   servers: !Array.<string>,
 *   knockCodes: !Array.<string>
 * }} 
 */
QuiverSocialProvider.userDesc_ = undefined;

/**
 * @private @typedef {{
 *   self: QuiverSocialProvider.userDesc_,
 *   friends: !Object.<string, QuiverSocialProvider.userDesc_>,
 *   unusedKnockCodes: !Array.<string>
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

/** @return {!QuiverSocialProvider.configuration_} */
QuiverSocialProvider.makeDefaultConfiguration_ = function() {
  return {
    self: {
      id: String(Math.random()),  // TODO(bemasc): Make this an EC pubkey.
      nick: null,
      servers: QuiverSocialProvider.DEFAULT_SERVERS_,
      knockCodes: []  // No knock code for talking to myself.
    },
    friends: {},
    unusedKnockCodes: []
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
      this.configuration_ = JSON.parse(result);
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

  this.syncConfiguration_(function() {
    this.clients_[this.configuration_.self.id] = {};
    this.clients_[this.configuration_.self.id][this.clientSuffix_] = QuiverSocialProvider.makeClientTracker_();

    // TODO: remove this terrible version JSON hack copied from the "email" provider
    console.log('login called with version ' + loginOpts.version);
    try {
      var versionObj = JSON.parse(loginOpts.version);
      this.setNick_(versionObj.userId);
    } catch(e) {
      console.log('failed to parse version object');  // TODO: remove
    }

    var finishLogin = function() {
      var clientState = this.makeClientState_(this.configuration_.self.id, this.clientSuffix_);
      continuation(clientState);
    }.bind(this);

    for (var i = 0; i < this.configuration_.self.servers.length; ++i) {
      var myServer = this.configuration_.self.servers[i];
      this.connectAsOwner(myServer, finishLogin);
    }
    
    var connectedCount = 0, connectedCountGoal = 0;
    var onClientConnection = function() {
      ++connectedCount;
      if (connectedCount === connectedCountGoal) {
        this.sendAllRosterChanged_();
      }
    }.bind(this);
    for (var userId in this.configuration_.friends) {
      var friend = this.configuration_.friends[userId];
      connectedCountGoal += friend.servers.length;
      for (var j = 0; j < friend.servers.length; ++j) {
        var friendServer = friend.servers[j];
        this.connectAsClient(friendServer, friend, onClientConnection);
      }
    }
  }.bind(this));
};

QuiverSocialProvider.prototype.sendAllRosterChanged_ = function() {
  this.changeRoster(/** @type {string} */ (this.configuration_.self.id), null);

  for (var userId in this.clients_) {
    this.changeRoster(userId, null);
  }
};

QuiverSocialProvider.prototype.countOwnerConnections_ = function() {
  var count = 0;
  for (var serverUrl in this.connections_) {
    if (this.connections_[serverUrl].owner) {
      ++count;
    }
  }
  return count;
};

QuiverSocialProvider.prototype.connect_ = function(serverUrl) {
  if (this.connections_[serverUrl]) {
    return;
  }

  var connectOptions = {
    'transports': ['polling']  // Force XHR so we can domain-front
  };
  var socket = io.connect(serverUrl, connectOptions);
  var resolve, reject;
  var everConnected = false;
  this.connections_[serverUrl] = {
    socket: socket,
    ready: new Promise(function(F, R) {
      resolve = F;
      reject = R;
    }),
    owner: false,
    friends: []
  };
  socket.on("connect", function() {
    everConnected = true;
    resolve();  // FIXME for breakpoint.
  });

  socket.on("error", function(err) {
    if (!everConnected) {
      console.log('Failed to connect to ' + serverUrl);
      this.disconnect_(serverUrl);
      reject(err);
    } else {
      console.log('Ignoring socket.io error: ' + err);
    }
  }.bind(this));

  socket.on("message", this.onMessage.bind(this, serverUrl));
  socket.on("reconnect_failed", function(msg) {
    this.disconnect_(serverUrl);
    reject(new Error('Never connected to ' + serverUrl));
  }.bind(this));
};

QuiverSocialProvider.prototype.connectAsOwner = function(serverUrl, continuation) {
  if (serverUrl[serverUrl.length - 1] != '/') {
    serverUrl = serverUrl + '/';
  }
  this.connect_(serverUrl);
  var connection = this.connections_[serverUrl];
  if (connection.owner) {
    // Already connected as owner.
    return;
  }
  connection.owner = true;

  connection.ready.then(function() {
    connection.socket.emit('join', this.configuration_.self.id);

    // Connect to self, in order to be able to send messages to my own other clients.
    this.connectAsClient(serverUrl, this.configuration_.self, continuation);
  }.bind(this)).catch(function(err) {
    continuation(undefined, err);
  });
};

QuiverSocialProvider.prototype.disconnect_ = function(serverUrl) {
    this.connections_[serverUrl].owner = false;
    if (this.connections_[serverUrl].friends.length === 0) {
      delete this.connections_[serverUrl];
    }
    if (this.countOwnerConnections_() === 0) {
      this.sendAllRosterChanged_();
    }
};

QuiverSocialProvider.prototype.connectAsClient = function(serverUrl, friend, continuation) {
  if (serverUrl[serverUrl.length - 1] != '/') {
    serverUrl = serverUrl + '/';
  }

  if (!this.clientConnections_[friend.id]) {
    this.clientConnections_[friend.id] = [];
  }

  this.connect_(serverUrl);
  var connection = this.connections_[serverUrl];

  if (connection.friends.indexOf(friend.id) !== -1) {
    // Already connected as client.
    connection.ready.then(continuation);
    return;
  }
  connection.friends.push(friend.id);
  this.clientConnections_[friend.id].push(connection);
  socket = connection.socket;

  connection.ready.then(function() {
    var introMsg = this.makeIntroMsg_(friend);
    socket.emit('emit', {
      'rooms': [friend.id],
      'msg': introMsg
    });
    socket.emit('addDisconnectMessage', {
      'rooms': [friend.id],
      'msg': {
        'cmd': 'disconnected',
        'userId': this.configuration_.self.id,
        'fromClient': this.clientSuffix_
      }
    });
    this.changeRoster(friend.id);
    continuation();
  }.bind(this)).catch(function(err) {
    continuation(undefined, err);
  });
};

/**
 * @param {QuiverSocialProvider.userDesc_} friend
 * @return {!Object} An intro msg.  This msg is idempotent.
 * @private
 */
QuiverSocialProvider.prototype.makeIntroMsg_ = function(friend) {
  var myServers = [];
  for (var server in this.connections_) {
    if (this.connections_[server].owner) {
      myServers.push(server);
    }
  }
  return {
    cmd: "intro",
    from: this.configuration_.self.id,
    servers: myServers,
    nick: this.configuration_.self.nick,
    knockCodes: friend.knockCodes,
    fromClient: this.clientSuffix_
  };
};

/**
 * @param {string} ignoredUserId
 * @param {function({networkData:string;})} cb
 */
QuiverSocialProvider.prototype.inviteUser = function(ignoredUserId, cb) {
  // TODO: Show my initially userId alongside the remote nick? Show pending
  // invitations and allow cancellation?
  var knockCode = String(Math.random());
  this.configuration_.unusedKnockCodes.push(knockCode);
  this.syncConfiguration_(function() {
    var serverUrl = this.configuration_.self.servers[0];
    if (serverUrl[serverUrl.length - 1] !== '/') {
      serverUrl += '/';
    }
    var url = serverUrl + this.configuration_.self.id + ':' + knockCode;
    cb({networkData: url});
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
    for (var serverUrl in this.clientConnections_[userId]) {
      var introMsg = this.makeIntroMsg_(this.configuration_.friends[userId]);
      this.clientConnections_[userId][serverUrl].socket.emit('emit', {
        'rooms': [userId],
        'msg': introMsg
      });
    }
  }
};

/**
 * @param {string} friendUrl
 * @param {Function} cb
 * @private
 */
QuiverSocialProvider.prototype.acceptUserInvitation = function(friendUrl, cb) {
  var splitIndex = friendUrl.lastIndexOf(':');
  if (splitIndex === -1) {
    // No friend, just a server URL?
    // TODO: Figure out whether we need a mechanism like this at all.
    this.addServer_(friendUrl);
    return;
  }

  var contact = friendUrl.slice(0, splitIndex);
  var knockCode = friendUrl.slice(splitIndex + 1);

  var splitPathIndex = contact.lastIndexOf('/');
  var serverUrl = contact.slice(0, splitPathIndex);
  var userId = contact.slice(splitPathIndex + 1);

  this.addFriend_([serverUrl], userId, [knockCode], null, cb);
};

/**
 * @param {!Array.<string>} servers
 * @param {string} userId
 * @param {!Array.<string>} knockCodes
 * @param {?string} nick
 * @private
 */
QuiverSocialProvider.prototype.addFriend_ = function(servers, userId, knockCodes, nick, continuation) {
  console.log('Adding Friend!', arguments);
  var friendDesc = this.configuration_.friends[userId];
  if (!friendDesc) {
    friendDesc = {
      id: userId,
      nick: null,
      servers: [],
      knockCodes: []
    };
    this.configuration_.friends[userId] = friendDesc;
  }
  var i;
  for (i = 0; i < servers.length; ++i) {
    if (friendDesc.servers.indexOf(servers[i]) == -1) {
      friendDesc.servers.push(servers[i]);
    }
  }
  for (i = 0; i < knockCodes.length; ++i) {
    if (friendDesc.knockCodes.indexOf(knockCodes[i]) == -1) {
      friendDesc.knockCodes.push(knockCodes[i]);
    }

    var p = this.configuration_.unusedKnockCodes.indexOf(knockCodes[i]);
    if (p != -1) {
      this.configuration_.unusedKnockCodes.splice(p, 1);
    }
  }
  if (nick) {
    friendDesc.nick = nick;
  }
  this.syncConfiguration_(function() {
    this.connectAsClient(servers[0], friendDesc, continuation);
  }.bind(this));
};

/**
 * @param {string} serverUrl
 * @private
 */
QuiverSocialProvider.prototype.addServer_ = function(serverUrl) {
  if (this.configuration_.self.servers.indexOf(serverUrl) != -1) {
    // No action needed, server is already known.
    return;
  }

  this.configuration_.self.servers.push(serverUrl);
  this.syncConfiguration_(function() {
    this.connectAsOwner(serverUrl);
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
 * @private
 */
QuiverSocialProvider.prototype.makeClientState_ = function(userId, clientSuffix) {
  var isOnline;
  if (userId == this.configuration_.self.id) {
    isOnline = this.countOwnerConnections_() > 0;
  } else {
    isOnline = !QuiverSocialProvider.isEmpty_(this.clientConnections_[userId]) &&
        !!this.clients_[userId] && !!this.clients_[userId][clientSuffix];
  }
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
      rooms: [userId],
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

  var onClose = function(server, continuation) {
    delete this.connections_[server];
    if (this.countOwnerConnections_() === 0) {  // FIXME: O(N^2)
      continuation();
    }
  };

  for (var server in this.connections_) {
    var conn = this.connections_[server];
    conn.socket.on("disconnect", onClose.bind(this, server, continuation));
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
 * Interpret messages from the server to this as owner.
 * There are 3 types of messages
 * - Directed messages from endpoints (message)
 * - State information from the server on initialization (state)
 * - Roster change events (users go online/offline) (roster)
 *
 * @method onMessage
 * @private
 * @param {string} serverUrl The server through which the message was delivered
 * @param {!Object} msg Message from the server (see server/bouncer.py for schema)
 * @return nothing
 **/
QuiverSocialProvider.prototype.onMessage = function(serverUrl, msg) {
  // TODO: Keep track of which message came through which server
  var fromUserId = msg.from;
  if (msg.cmd === 'msg') {
    if (!(fromUserId in this.configuration_.friends) && fromUserId != this.configuration_.self.id) {
      return;  // Don't accept messages from unknown parties.
      // TODO use message signing to make this secure.
    }
    if (!msg.toClient || msg.toClient == this.clientSuffix_) {
      if (this.clients_[fromUserId] && this.clients_[fromUserId][msg.fromClient] &&
          msg.index > this.clients_[fromUserId][msg.fromClient].fromCounter) {
        this.clients_[fromUserId][msg.fromClient].fromCounter = msg.index;
        this.dispatchEvent('onMessage', {
          from: this.makeClientState_(fromUserId, msg.fromClient),
          message: msg.msg
        });
      } else {
        console.warn('Ignoring message from unknown user');
      }
    }
  } else if (msg.cmd === 'intro') {
    if (this.shouldAllowIntro_(fromUserId, msg)) {
      if (!this.clients_[fromUserId]) {
        this.clients_[fromUserId] = {};
      }
      if (!this.clients_[fromUserId][msg.fromClient]) {
        this.clients_[fromUserId][msg.fromClient] = QuiverSocialProvider.makeClientTracker_();
      }
      this.addFriend_(msg.servers, fromUserId, msg.knockCodes, msg.nick, function() {
        if (!this.clients_[fromUserId][msg.fromClient].gotIntro) {
          this.clients_[fromUserId][msg.fromClient].gotIntro = true;
          // Reply to the first intro message we receive.  This will result in
          // a redundant triple-handshake for no reason ... except that we have
          // no way to be sure that an "intro" message was in response to ours,
          // rather than a result of a user signing on right after we sent the
          // initial intro message.
          var friend = this.configuration_.friends[fromUserId];
          var introMsg = this.makeIntroMsg_(friend);
          this.connections_[serverUrl].socket.emit('emit', {
            'rooms': [friend.id],
            'msg': introMsg
          });
        }
        this.changeRoster(fromUserId, msg.fromClient);
      }.bind(this));
    } else if (msg.cmd === 'disconnected') {
      // TODO: Ping to see if the user is still alive.
    }
  }
};

/**
 * @param {string} fromUserId
 * @param {!Object} introMsg
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
    if (this.configuration_.unusedKnockCodes.indexOf(introMsg.knockCodes[i]) != -1) {
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
