/*globals freedom:true, DEBUG */

var frontdomain = require('./frontdomain');
var parseuri = require('parseuri');

function bufferToString(buffer) {
  var byteArray = new Uint8Array(buffer);
  var chars = [];
  for (var i = 0; i < byteArray.length; ++i) {
    chars.push(String.fromCharCode(byteArray[i]));
  }
  return chars.join('');
}

function MyEventTarget() {
  this.listeners_ = {};
}

MyEventTarget.prototype.addEventListener = function(type, listener) {
  if (!this.listeners_[type]) {
    this.listeners_[type] = [];
  }

  this.listeners_[type].push(listener);
};

MyEventTarget.prototype.removeEventListener = function(type, listener) {
  var list = this.listeners_[event.type];
  if (!list) {
    return;
  }

  var index = list.indexOf(listener);
  if (index > -1) {
    list.splice(index, 1);
  }
};

MyEventTarget.prototype.dispatchEvent = function(event) {
  var list = this.listeners_[event.type];
  if (list) {
    list.forEach(function(listener) {
      if (listener.handleEvent) {
        listener.handleEvent(event);
      } else {
        listener(event);
      }
    });
  }

  var onType = 'on' + event.type;
  if (this[onType]) {
    this[onType](event);
  }
};

var shimCounter = 0;
function XhrShim() {
  this.id_ = ++shimCounter;
  this.log_('Constructing');
  MyEventTarget.call(this);
  this.xhr_ = freedom['core.xhr']();
  this.listeners_ = {};

  this.UNSENT = 0;
  this.OPENED = 1;
  this.HEADERS_RECEIVED = 2;
  this.LOADING = 3;
  this.DONE = 4;
  this.readyState = this.UNSENT;

  this.status = 0;
  this.statusText = '';

  // Sync-cached writable properties
  this.timeout_ = 0;
  this.withCredentials_ = false;
  this.responseHeaders_ = {};
  this.responseType_ = '';

  this.upload = new MyEventTarget();

  this.bindReadyStateEvent_();
  var progressEvents = [
    'loadstart',
    'progress',
    'abort',
    'error',
    'load',
    'timeout',
    'loadend'
  ];
  progressEvents.forEach(this.bindProgressEvent_.bind(this));
}

XhrShim.prototype = Object.create(MyEventTarget.prototype);

XhrShim.prototype.log_ = function(msg) {
  console.log('XhrShim ' + this.id_ + ': ' + msg);
};

XhrShim.prototype.bindProgressEvent_ = function(name) {
  this.xhr_.on('on' + name, function(event) {
    this.refresh_().then(function() {
      if (name === 'loadend') {
        freedom['core.xhr'].close(this.xhr_);
      }
      // Freedom seems to lose the event type attribute
      event.type = name;
      this.dispatchEvent(event);
    }.bind(this));
  }.bind(this));

  this.xhr_.on('onupload' + name, function(event) {
    this.upload.dispatchEvent(event);
  }.bind(this));
};

XhrShim.prototype.bindReadyStateEvent_ = function() {
  this.xhr_.on('onreadystatechange', function() {
    this.refresh_().then(this.dispatchEvent.bind(this, {
      type: 'readystatechange'
    }));
  }.bind(this));
};

XhrShim.prototype.refresh_ = function() {
  var promises = [
    this.xhr_.getReadyState().then(function(readyState) {
      this.readyState = readyState;
    }.bind(this)),
    this.xhr_.getAllResponseHeaders().then(this.parseResponseHeaders_.bind(this)),
    this.xhr_.getResponse().then(function(response) {
      if (!response) {
        this.response = response;
      } else if (response.buffer) {
        this.log_('XhrShim got response buffer: ' + bufferToString(response.buffer));
        this.response = response.buffer;
      } else if (response.object) {
        this.response = response.object;
      } else if (response.string) {
        this.response = response.string;
      } else {
        throw new Error('XhrShim: unrecognized response ' + JSON.stringify(response));
      }
    }.bind(this)),
    this.xhr_.getStatus().then(function(status) {
      this.status = status;
    }.bind(this)),
    this.xhr_.getStatusText(function(statusText) {
      this.statusText = statusText;
    }.bind(this))
  ];

  return Promise.all(promises);
};

XhrShim.prototype.addResponseHeader_ = function(header, value) {
  if (!this.responseHeaders_[header]) {
    this.responseHeaders_[header] = [];
  }
  this.responseHeaders_[header].push(value);
};

XhrShim.UNSENT = 0;
XhrShim.OPENED = 1;
XhrShim.HEADERS_RECEIVED = 2;
XhrShim.LOADING = 3;
XhrShim.DONE = 4;

XhrShim.prototype.open = function(method, url, async, username, password) {
  this.log_('XhrShim::open(' + method + ', ' + url + ')');
  if (async === false) {
    throw new Error('XhrShim only supports async operation');
  }

  this.readyState = this.OPENED;

  // Domain fronting
  var parsed = parseuri(url);
  var isFront = frontdomain.isFront(parsed.host);
  if (isFront) {
    var parts = frontdomain.demunge(parsed.host);
    var frontedUrl = url.replace(parsed.host, parts.front);  // TODO: Only replace first instance
    this.xhr_.open(method, frontedUrl, async, username, password);
    this.setRequestHeader('Host', parts.host);
  } else {
    this.xhr_.open(method, url, async, username, password);
  }
};

XhrShim.prototype.setRequestHeader = function(header, value) {
  if (this.readyState !== this.OPENED) {
    // TODO: Should be InvalidStateError
    throw new Error('XhrShim: cannot set request header in state ' + this.readyState);
  }

  this.xhr_.setRequestHeader(header, value);
};

Object.defineProperty(XhrShim.prototype, 'timeout', {
  set: function(t) {
    this.timeout_ = t;
    this.xhr_.setTimeout(t);
  },
  get: function() {
    return this.timeout_;
  }
});

Object.defineProperty(XhrShim.prototype, 'withCredentials', {
  set: function(w) {
    if (this.readyState !== this.UNSENT && this.readyState !== this.OPENED) {
      // TODO: Should be InvalidStateError
      throw new Error('XhrShim: cannot set withCredentials in state ' + this.readyState);
    }

    this.withCredentials_ = w;
    this.xhr_.setWithCredentials(w);
  },
  get: function() {
    return this.withCredentials_;
  }
});

XhrShim.prototype.send = function(data) {
  this.log_('XhrShim::send(' + data + ')');
  if (this.readyState !== this.OPENED) {
    // TODO: Should be InvalidStateError
    throw new Error('XhrShim: cannot send in state ' + this.readyState);
  }

  if (!data) {
    this.xhr_.send();
  } else if (typeof data === 'string') {
    this.xhr_.send({string: data});
  } else if (data instanceof ArrayBuffer) {
    this.xhr_.send({buffer: data});
  } else if (data instanceof Blob) {
    var reader = new FileReader();
    reader.onload = function() {
      this.xhr_.send({buffer: reader.result});
    }.bind(this);
    reader.readAsArrayBuffer(data);
  } else {
    throw new Error('XhrShim: cannot send unknown type ' + typeof data);
  }
};

XhrShim.prototype.abort = function(data) {
  if (this.readyState === this.DONE) {
    // Abort would have no effect, and the core provider may already
    // have been disposed.
    return;
  }
  this.xhr_.abort();
};

XhrShim.prototype.parseResponseHeaders_ = function(headers) {
  var lines = headers.split('\r\n');
  lines.forEach(function(line) {
    if (line.length === 0) {
      return;
    }
    var groups = line.match(/(^[^:]+): (.+)$/);
    if (!groups || groups.length < 3) {
      this.log_('Failed to parse ' + line + ' from ' + headers);
      return;
    }
    var header = groups[1];
    var valueString = groups[2];
    var values = valueString.split(', ');
    this.responseHeaders_[header] = values;
  }.bind(this));
};

XhrShim.prototype.getCaseSensitiveResponseHeader_ = function(header) {
  return this.responseHeaders_[header].join(', ');
};

XhrShim.prototype.getResponseHeader = function(header) {
  header = header.toLowerCase();
  // Case-insensitive match!
  // TODO: Replace with O(1) algorithm
  for (var key in this.responseHeaders_) {
    if (key.toLowerCase() === header) {
      return this.getCaseSensitiveResponseHeader_(key);
    }
  }
  return '';
};

XhrShim.prototype.getAllResponseHeaders = function() {
  var lines = [];
  for (var header in this.responseHeaders_) {
    var line = header + ': ' + this.getCaseSensitiveResponseHeader_(header);
    lines.push(line);
  }

  return lines.join('\r\n');
};

XhrShim.prototype.overrideMimeType = function(mime) {
  if (this.readyState !== this.LOADING && this.readyState !== this.DONE) {
    // TODO: Should be InvalidStateError
    throw new Error('XhrShim: cannot overrideMimeType in state ' + this.readyState);
  }

  this.xhr_.overrideMimeType(mime);
};

Object.defineProperty(XhrShim.prototype, 'responseType', {
  set: function(t) {
    if (this.readyState === this.LOADING || this.readyState === this.DONE) {
      // TODO: Should be InvalidStateError
      throw new Error('XhrShim: cannot set responseType in state ' + this.readyState);
    }
    this.responseType_ = t;
    this.xhr_.setResponseType(t);
  },
  get: function() {
    return this.responseType_;
  }
});

Object.defineProperty(XhrShim.prototype, 'responseText', {
  get: function() {
    if (this.responseType_ !== '' && this.responseType_ !== 'text') {
      // TODO: Should be InvalidStateError
      throw new Error('XhrShim: no responseText for type ' + this.responseType_);
    }
    this.log_('XhrShim returning responseText ' + this.response);
    return this.response;
  }
});

Object.defineProperty(XhrShim.prototype, 'responseXML', {
  get: function() {
    if (this.responseType_ !== '' && this.responseType_ !== 'document') {
      // TODO: Should be InvalidStateError
      throw new Error('XhrShim: no responseText for type ' + this.responseType_);
    }
    var mimeType = this.getResponseHeader('Content-Type');
    return (new DOMParser()).parseFromString(this.response, mimeType);
  }
});

module.exports = XhrShim;
