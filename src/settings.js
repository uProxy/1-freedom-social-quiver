window.addEventListener('load', function() {
  var makeIntroUrl = document.getElementById('makeIntroUrl');
  makeIntroUrl.addEventListener('click', function(e) {
    parent.postMessage({cmd: 'makeIntroUrl'}, '*');
  }, true);
  
  var setNick = document.getElementById('setNick');
  setNick.addEventListener('submit', function(e) {
    e.preventDefault();
    parent.postMessage({cmd: 'setNick', message: setNick.nick.value}, '*');
    return false;
  }, true);
  
  var addContact = document.getElementById('addContact');
  addContact.addEventListener('submit', function(e) {
    e.preventDefault();
    parent.postMessage({cmd: 'addContact', message: addContact.contact.value}, '*');
    return false;
  }, true);

  var addServer = document.getElementById('addServer');
  addServer.addEventListener('submit', function(e) {
    e.preventDefault();
    parent.postMessage({cmd: 'addServer', message: addServer.server.value}, '*');
    return false;
  }, true);

  window.addEventListener('message', function(m) {
    if (m.data.event == 'newIntroUrl') {
      console.log('Got new intro URL: ', m);
      document.getElementById('newIntroUrl').innerText = m.data.url;
    } else if (m.data.event == 'nick') {
      setNick.nick.placeholder = m.data.nick;
    }
  }, true);

  parent.postMessage({cmd: 'ready'}, '*');
}, true);

