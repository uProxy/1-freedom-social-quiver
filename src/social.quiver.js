/*globals freedom:true, WebSocket, DEBUG */
/*jslint indent:2, white:true, node:true, sloppy:true, browser:true */


/**
 * Implementation of a Social provider that depends on
 * the WebSockets server code in server/bouncer.py
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
 * @param {Function} dispatchEvent callback to signal events
 * @param {WebSocket} webSocket Alternative webSocket implementation for tests
 */
function QuiverSocialProvider(dispatchEvent, webSocket) {
  this.dispatchEvent = dispatchEvent;
  this.storage = freedom['core.storage']();
  this.view = freedom['core.view']();
  this.websocket = freedom["core.websocket"] || webSocket;
  this.social = freedom.social();

  /** @private {string} */
  this.clientSuffix_ = String(Math.random());

  /** @private {!Object.<string, QuiverSocialProvider.clientTracker_>} */
  this.clients_ = {};  // userId, clientSuffix => clientTracker

  /** @private {!Object.<string, !WebSocket>} */
  this.ownerConnections_ = {};  // server => WebSocket

  /** @private {!Object.<string, !Object.<string, !WebSocket>>} */
  this.clientConnections_ = {};  // userId, server => WebSocket

  /** @private {QuiverSocialProvider.configuration_} */
  this.configuration_ = null;
}

// TODO: Replace this localhost server with a public host.  Using a
// localhost server prevents you from talking to anyone.
/** @const @private {!Array.<string>} */
QuiverSocialProvider.DEFAULT_SERVERS_ = ['ws://localhost:8083/bounce/'];

/** @const @private {number} */
QuiverSocialProvider.MAX_CONNECTIONS_ = 5;

/**
 * @private @typedef {{
 *   toCounter: number,
 *   fromCounter: number
 * }} 
 */
QuiverSocialProvider.clientTracker_ = undefined;

QuiverSocialProvider.makeClientTracker_ = function() {
  return {
    toCounter: 0,
    fromCounter: 0
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

/**
 * Connect to the Web Socket rendezvous server
 * e.g. social.login(Object options)
 * The only login option needed is 'agent', used to determine which group to join in the server
 *
 * @method login
 * @param {Object} loginOptions
 * @param {function(Object, Object=)} continuation First argument is an onStatus event, send is an optional error message.
 * @return {Object} status - Same schema as 'onStatus' events
 **/
QuiverSocialProvider.prototype.login = function(loginOpts, continuation) {
  // Wrap the continuation so that it will only be called once by
  // onmessage in the case of success.
  var finishLogin = {
    continuation: continuation,
    finish: function(msg, err) {
      if (this.continuation) {
        this.continuation(msg, err);
        delete this.continuation;
      }
    }
  };

  if (!QuiverSocialProvider.isEmpty_(this.ownerConnections_)) {
    finishLogin.finish(undefined, this.err("LOGIN_ALREADYONLINE"));
    return;
  }

  this.view.on('message', this.onSettingsMessage_.bind(this));
  this.view.open('settings', {file: 'settings.html'}).
      then(this.view.show.bind(this.view));

  var onFirstMessage = function() {
    var clientState = this.makeClientState_(this.configuration_.self.id, this.clientSuffix_);
    finishLogin.finish(clientState);
  }.bind(this);

  this.syncConfiguration_(function() {
    this.clients_[this.configuration_.self.id] = {};
    this.clients_[this.configuration_.self.id][this.clientSuffix_] = QuiverSocialProvider.makeClientTracker_();

    for (var i = 0; i < this.configuration_.self.servers.length; ++i) {
      var myServer = this.configuration_.self.servers[i];
      this.connectAsOwner(myServer, onFirstMessage);
    }
    for (var userId in this.configuration_.friends) {
      var friend = this.configuration_.friends[userId];
      for (var j = 0; j < friend.servers.length; ++j) {
        var friendServer = friend.servers[j];
        this.connectAsClient(friendServer, friend);
      }
    }
    this.sendAllRosterChanged_();
    this.updateView_();
  }.bind(this));
};

QuiverSocialProvider.prototype.sendAllRosterChanged_ = function() {
  this.changeRoster(this.configuration_.self.id, null);

  for (var userId in this.clients_) {
    this.changeRoster(userId, null);
  }
};

QuiverSocialProvider.prototype.connectAsOwner = function(serverUrl, continuation) {
  if (serverUrl[serverUrl.length - 1] != '/') {
    serverUrl = serverUrl + '/';
  }
  if (this.ownerConnections_[serverUrl]) {
    // Already connected.
    return;
  }
  if (QuiverSocialProvider.count_(this.ownerConnections_) >= QuiverSocialProvider.MAX_CONNECTIONS_) {
    return;  // Too many connections.
    // TODO introduce connection recycling by last working date, clear out dead connections, etc.
  }

  var conn = this.websocket(serverUrl + this.configuration_.self.id);
  this.ownerConnections_[serverUrl] = conn;
  // Save the continuation until we get a status message for
  // successful login.
  conn.on("onOpen", function() {
    // Connect to self, in order to be able to send messages to my own other clients.
    this.connectAsClient(serverUrl, this.configuration_.self);
  }.bind(this));
  conn.on("onMessage", this.onMessage.bind(this, continuation));
  conn.on("onError", function (cont, error) {
    delete this.ownerConnections_[serverUrl];
    continuation(undefined, this.err('ERR_CONNECTION'));
  }.bind(this, continuation));
  conn.on("onClose", function (cont, msg) {
    delete this.ownerConnections_[serverUrl];
    if (QuiverSocialProvider.isEmpty_(this.ownerConnections_)) {
      this.sendAllRosterChanged_();
    }
  }.bind(this, continuation));
};

QuiverSocialProvider.prototype.disconnectAsOwner = function(serverUrl) {

};

QuiverSocialProvider.prototype.connectAsClient = function(serverUrl, friend) {
  if (serverUrl[serverUrl.length - 1] != '/') {
    serverUrl = serverUrl + '/';
  }
  var continuation = function() {};
  if (!this.clientConnections_[friend.id]) {
    this.clientConnections_[friend.id] = {};
  }
  var connections = this.clientConnections_[friend.id];
  if (connections[serverUrl]) {
    // Already connected.
    return;
  }
  if (QuiverSocialProvider.count_(connections) >= QuiverSocialProvider.MAX_CONNECTIONS_) {
    return;  // Too many connections.
    // TODO introduce connection recycling by last working date, clear out dead connections, etc.
  }
  var fullPath = serverUrl + friend.id + '/' + this.configuration_.self.id;
  var conn = this.websocket(fullPath);
  connections[serverUrl] = conn;
  // Save the continuation until we get a status message for
  // successful login.
  conn.on("onOpen", function() {
    this.changeRoster(friend.id);
    var introMsg = this.makeIntroMsg_(friend);
    conn.send({'text': JSON.stringify(introMsg)});
  }.bind(this));
  // Uncomment below to allow owner->client messages (not currently used).
  // conn.on("onMessage", this.onMessage.bind(this, continuation));
  conn.on("onError", function (cont, error) {
    delete connections[serverUrl];
    conn.finish(undefined, this.err('ERR_CONNECTION'));
  }.bind(this, continuation));
  conn.on("onClose", function (cont, msg) {
    delete connections[serverUrl];
    if (QuiverSocialProvider.isEmpty_(connections)) {
      delete this.clientConnections_[friend.id];
    }
    this.changeRoster(friend.id);
  }.bind(this, continuation));
};

/**
 * @param {QuiverSocialProvider.userDesc_} friend
 * @return {!Object} An intro msg.  This msg is idempotent.
 * @private
 */
QuiverSocialProvider.prototype.makeIntroMsg_ = function(friend) {
  var myServers = [];
  for (var server in this.ownerConnections_) {
    myServers.push(server);
  }
  return {
    cmd: "intro",
    servers: myServers,
    nick: this.configuration_.self.nick,
    knockCodes: friend.knockCodes,
    fromClientSuffix: this.clientSuffix_
  };
};

/**
 * Process a settings message
 * @method onSettingsMessage_
 * @private
 * @param {Object} msg The message sent from the authentication view.
 */
QuiverSocialProvider.prototype.onSettingsMessage_ = function(msg) {
  if (!this.configuration_) {
    this.syncConfiguration_(function() {
      this.onSettingsMessage_(msg);
    }.bind(this));
    return;
  }

  switch (msg.cmd) {
    case 'ready':
      this.updateView_();
      break;
    case 'makeIntroUrl':
      this.showNewIntroUrl_(msg.message);
      break;
    case 'setNick':
      this.setNick_(msg.message);
      break;
    case 'addContact':
      this.addFriendByUrl_(msg.message);
      break;
    case 'addServer':
      this.addServer_(msg.message);
      break;
  }
};

QuiverSocialProvider.prototype.showNewIntroUrl_ = function(msg) {
  var knockCode = String(Math.random());
  this.configuration_.unusedKnockCodes.push(knockCode);
  this.syncConfiguration_(function() {
    var url = this.configuration_.self.servers[0] + this.configuration_.self.id + ':' + knockCode;
    this.view.postMessage({event: 'newIntroUrl', url: url});
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
  this.changeRoster(this.configuration_.self.id);
  for (var userId in this.clientConnections_) {
    for (var serverUrl in this.clientConnections_[userId]) {
      var introMsg = this.makeIntroMsg_(this.configuration_.friends[userId]);
      this.clientConnections_[userId][serverUrl].send({text: JSON.stringify(introMsg)});
    }
  }
};

QuiverSocialProvider.prototype.updateView_ = function() {
  if (!this.view || !this.configuration_) {
    return;
  }
  if (this.configuration_.self.nick) {
    this.view.postMessage({event: 'nick', nick: this.configuration_.self.nick});
  }
};

/**
 * @param {string} friendUrl
 * @private
 */
QuiverSocialProvider.prototype.addFriendByUrl_ = function(friendUrl) {
  var splitIndex = friendUrl.lastIndexOf(':');
  var contact = friendUrl.slice(0, splitIndex);
  var knockCode = friendUrl.slice(splitIndex + 1);

  var splitPathIndex = contact.lastIndexOf('/');
  var serverUrl = contact.slice(0, splitPathIndex);
  var userId = contact.slice(splitPathIndex + 1);

  this.addFriend_([serverUrl], userId, [knockCode], null);
};

/**
 * @param {!Array.<string>} servers
 * @param {string} userId
 * @param {!Array.<string>} knockCodes
 * @param {?string} nick
 * @private
 */
QuiverSocialProvider.prototype.addFriend_ = function(servers, userId, knockCodes, nick) {
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
    this.connectAsClient(servers[0], friendDesc);
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
 * @method getUsers
 * @return {Object} { 
 *    'userId1': <user_profile>,
 *    'userId2': <user_profile>,
 *     ...
 * } List of <user_profile>s indexed by userId
 *   On failure, rejects with an error code (see above)
 **/
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
    isOnline = !QuiverSocialProvider.isEmpty_(this.ownerConnections_);
  } else {
    isOnline = !!this.clients_[userId] && !!this.clients_[userId][clientSuffix];
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
 * @method getClients
 * @return {Object} { 
 *    'clientId1': <client_state>,
 *    'clientId2': <client_state>,
 *     ...
 * } List of <client_state>s indexed by clientId
 *   On failure, rejects with an error code (see above)
 **/
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
 * @method sendMessage
 * @param {String} to Either the target clientId, or a userId to reach all of
 *     that user's clients.
 * @param {String} msg The message to send
 * @param {function} continuation Function to call once the message is sent
 *     (not necessarily received).
 **/
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

  if (QuiverSocialProvider.isEmpty_(this.ownerConnections_)) {
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

  for (var server in this.clientConnections_[userId]) {
    this.clientConnections_[userId][server].send({text: JSON.stringify({
      cmd: 'msg',
      msg: msg,
      index: index,  // For de-duplication across paths.
      fromClientSuffix: this.clientSuffix_,
      toClientSuffix: clientSuffix  // null for broadcast
    })});
  }
  continuation();
};

/**
   * Disconnects from the Web Socket server
   * e.g. logout(Object options)
   * No options needed
   * 
   * @method logout
   * @return {Object} status - same schema as 'onStatus' events
   **/
QuiverSocialProvider.prototype.logout = function(continuation) {
  if (QuiverSocialProvider.isEmpty_(this.ownerConnections_)) { // We may not have been logged in
    continuation(undefined, this.err("OFFLINE"));
    return;
  }

  var onClose = function(server, continuation) {
    delete this.ownerConnections_[server];
    if (QuiverSocialProvider.isEmpty_(this.ownerConnections_)) {
      continuation();
    }
  };

  for (var server in this.ownerConnections_) {
    var conn = this.ownerConnections_[server];
    conn.on("onClose", onClose.bind(this, server, continuation));
    conn.close();
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
 * @param {String} userId
 * @param {?String=} clientSuffix Optional.
 * @return {Object} - same schema as 'onStatus' event
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
 * @param {function} gotMsg Function to call upon receipt of a message
 * @param {String} msg Message from the server (see server/bouncer.py for schema)
 * @return nothing
 **/
QuiverSocialProvider.prototype.onMessage = function(gotMsg, msg) {
  gotMsg();
  msg = JSON.parse(msg.text);

  // If state information from the server
  // Store my own ID and all known users at the time
  if (msg.cmd === 'state') {
    // Ignore for now.  This message might be useful later if we want
    // to support recovering from asymmetric contact loss.
  // If directed message, emit event
  } else if (msg.cmd === 'message') {
    this.onEndpointMessage(msg.from, JSON.parse(msg.msg));
  // Roster change event
  } else if (msg.cmd === 'roster') {
    // Ignore for now.  We can handle roster changes using websocket.onClose.
  }
};

/**
 * Interpret messages from a client
 * There are 2 types of messages
 *  - Providing or updating contact info (intro)
 *  - Actual message contents from a higher layer (msg)
 *
 * @method onEndpointMessage
 * @private
 * @param {function} gotMsg Function to call upon receipt of a message
 * @param {String} msg Message from the client (see .sendMessage and .makeIntroMsg_)
 * @return nothing
 **/
QuiverSocialProvider.prototype.onEndpointMessage = function(fromUserId, msg) {
  if (msg.cmd === 'msg') {
    if (!(fromUserId in this.configuration_.friends) && fromUserId != this.configuration_.self.id) {
      return;  // Don't accept messages from unknown parties.
      // TODO use message signing to make this secure.
    }
    if ((!msg.toClientSuffix || msg.toClientSuffix == this.clientSuffix_) &&
        msg.index > this.clients_[fromUserId][msg.fromClientSuffix].fromCounter) {
      this.clients_[fromUserId][msg.fromClientSuffix].fromCounter = msg.index;
      this.dispatchEvent('onMessage', {
        from: this.makeClientState_(fromUserId, msg.fromClientSuffix),
        message: msg.msg
      });
    }
  } else if (msg.cmd === 'intro') {
    var known = false;
    if (this.shouldAllowIntro_(fromUserId, msg)) {
      if (!this.clients_[fromUserId]) {
        this.clients_[fromUserId] = {};
      }
      if (!this.clients_[fromUserId][msg.fromClientSuffix]) {
        this.clients_[fromUserId][msg.fromClientSuffix] = QuiverSocialProvider.makeClientTracker_();
      }
      this.addFriend_(msg.servers, fromUserId, msg.knockCodes, msg.nick);
      this.changeRoster(fromUserId, msg.fromClientSuffix);
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
  if (this.configuration_.friends[fromUserId]) {
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
    message: this.social.ERRCODE[code]
  };
  return err;
};

/** REGISTER PROVIDER **/
if (typeof freedom !== 'undefined') {
  freedom.social().provideAsynchronous(QuiverSocialProvider);
}
