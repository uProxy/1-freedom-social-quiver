#!/usr/bin/env python
"""
Websocket message bouncer.
Listens on http://localhost:8083/bounce
  Depends on python-tornado

The owner connects to ws://.../bounce/[id1], to open the port.
The clients can then connect to ws://.../bounce/[id1]/[id2].

If an owner is not already connected, client connections will be closed
immediately by the server.

Owners and clients normally have unique id's, but the code must tolerate
having multiple endpoints connected with the same id to prevent a trivial
denial-of-service attack.  A group of indistinguishable endpoints is called
a cluster.

The clients send and receive bare messages.  Their connection is closed if
the owner leaves (i.e. the port is closed).

The owner speaks the following protocol
  On initial connection: {cmd: "state", msg: [string] (client id's)}
  On message: {cmd: "message", from: string, to: string, msg: string}
  On roster change: {cmd: "roster", id: string, online: boolean}
"""
import os, sys, inspect
here = os.path.abspath(os.path.split(inspect.getfile(inspect.currentframe()))[0])
if os.path.join(here, "tornado") not in sys.path:
  sys.path.insert(0, os.path.join(here, "tornado"))

import tornado.escape
import tornado.ioloop
import tornado.websocket
import tornado.web
import re

class Port:
  def __init__(self, name, owner, close_cb):
    print("New port: " + name)
    self.name = name
    self.owner_cluster = set()
    self.client_clusters = {}  # client_id => [ClientHandlers with that id]
    self.close_cb = close_cb
    self.add_owner(owner)

  def add_owner(self, owner):
    print("Adding owner")
    self.owner_cluster.add(owner)
    owner.write_message({"cmd": "state", "msg": self.client_clusters.keys()})

  def remove_owner(self, owner):
    print("Removing owner")
    self.owner_cluster.remove(owner)
    if not self.owner_cluster:
      print("No more owners; closing port")
      for client_cluster in self.client_clusters.values():
        for client in client_cluster:
          client.close()
      self.client_clusters.clear()  # Break the reference cycle (GC optimization)
      self.close_cb(self)

  def add_client(self, client):
    print("Adding client: " + client.id)
    if client.id not in self.client_clusters:
      self.client_clusters[client.id] = set()
      self.send_message_to_owner({"cmd": "roster", "id": client.id, "online": True})
    self.client_clusters[client.id].add(client)

  def remove_client(self, client):
    print("Removing client: " + client.id)
    self.client_clusters[client.id].remove(client)
    if not self.client_clusters[client.id]:
      del self.client_clusters[client.id]
      self.send_message_to_owner({"cmd": "roster", "id": client.id, "online": False})

  def send_message_to_owner(self, msg):
    print("Sending message to owner " + self.name + ": " + repr(msg))
    for owner in self.owner_cluster:
      owner.write_message(msg)

  def send_message_to_client(self, client_id, msg):
    if client_id in self.client_clusters:
      for client in self.client_clusters[client_id]:
        client.write_message(msg)

class Application(tornado.web.Application):
  def __init__(self):
    handlers = [
      (ClientHandler.PATH_PATTERN, ClientHandler),
      (OwnerHandler.PATH_PATTERN, OwnerHandler)
    ]
    settings = dict( autoescape=None )
    tornado.web.Application.__init__(self, handlers, **settings)

class OwnerHandler(tornado.websocket.WebSocketHandler):
  PATH_PATTERN = r"/bounce/([a-zA-Z0-9_.]+)"
  PATH_RE = re.compile(PATH_PATTERN)

  ports = dict()  # port_name => Port

  def release_port(self, port):
    del self.ports[port.name]

  def open(self, *args, **kwargs):
    path_match = self.PATH_RE.match(self.request.path)
    port_name = path_match.groups()[0]
    if port_name not in self.ports:
      self.ports[port_name] = Port(port_name, self, self.release_port)
    else:
      self.ports[port_name].add_owner(self)
    self.port = self.ports[port_name]

  def on_close(self):
    self.port.remove_owner(self)
    self.port = None

  def on_finish(self):
    self.on_close()

  def on_message(self, msg):
    val = tornado.escape.json_decode(msg)
    if "to" in val:
      self.port.send_message_to_client(val["to"], val["msg"])

class ClientHandler(tornado.websocket.WebSocketHandler):
  PATH_PATTERN =  r"/bounce/([a-zA-Z0-9_.]+)/([a-zA-Z0-9_.]+)"
  PATH_RE = re.compile(PATH_PATTERN)

  def open(self, *args, **kwargs):
    path_match = self.PATH_RE.match(self.request.path)
    port_name, self.id = path_match.groups()
    if port_name not in OwnerHandler.ports:
      self.close()
    else:
      self.port = OwnerHandler.ports[port_name]
      self.port.add_client(self)

  def on_close(self):
    self.port.remove_client(self)

  def on_finish(self):
    self.on_close()

  def on_message(self, msg):
    self.port.send_message_to_owner({"cmd": "message", "from": self.id, "msg": msg})

def main():
  port = 8083
  print "Listening on " + str(port) 
  app = Application()
  app.listen(port)
  tornado.ioloop.IOLoop.instance().start()

if __name__ == "__main__":
  main()
