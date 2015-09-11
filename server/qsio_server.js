/*jslint indent:2, white:true, node:true, sloppy:true*/
var server = require('http').createServer();
var io = require('socket.io')(server);

function doEmit(e) {
  var rooms = e['rooms'];
  if (!(rooms && typeof rooms.forEach === 'function' && rooms.length > 0)) {
    return;
  }
  var sender = io.sockets;
  rooms.forEach(function(room) { sender = sender.to(room); });
  sender.emit('message', e['msg']);
}

io.on('connection', function(socket) {
  socket.on('join', socket.join.bind(socket));
  socket.on('leave', socket.leave.bind(socket));
  socket.on('emit', doEmit);

  var disconnectMessages = [];
  socket.on('addDisconnectMessage', function(e) {
    disconnectMessages.push(e);
  });
  socket.on('disconnect', function() {
    disconnectMessages.forEach(doEmit);
  });
});

server.listen(8087);
