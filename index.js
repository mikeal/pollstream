var events = require('events')
  , stream = require('stream')
  , util = require('util')
  , http = require('http')
  , path = require('path')
  , zlib = require('zlib')
  , url = require('url')
  , qs = require('querystring')
  , clientBuffer = require('fs').readFileSync(path.join(__dirname, 'client.js'))
  
  , crypto = require('crypto')
  , md5 = function (chunk) { return crypto.createHash('md5').update(chunk).digest('hex') }
  ;

// TODO create a gzipped buffer

// TODO ack and etags for client POST data like we have for GET data

function ClientChannel (id, client) {
  this.id = id
  this.client = client
  this.chunks = []
  this.writable = true
  this.readable = true
  
  this.on('pending', client.emit.bind(client, 'pending'))
}
util.inherits(ClientChannel, stream.Stream)
ClientChannel.prototype.onRequest = function (req, resp) {
  if (this.chunks.length) {
    if (this.chunks.length > 1) {
      // compact chunks in to one write and hash
      var buffer = new Buffer(this.chunksLength)
      var i = 0
      this.chunks.forEach(function (chunk) {
        chunk.copy(buffer, i, 0, chunk.length)
        i += chunk.length
      })
      this.chunks = [md5(buffer), buffer]
    }
    resp.setHeader('x-pollstream-channel', this.id)
    resp.setHeader('x-pollstream-etag', this.chunks[0][0])
    // resp.setHeader('x-pollstream-pending', this.client.pending())
    resp.setHeader('date', new Date())
    resp.write(this.chunks[0][1])
    resp.end()
    return true
  }
  if (this.ended) {
    resp.setHeader('x-pollstream-end', true)
    resp.setHeader('x-pollstream-etag', 'end')
    resp.setHeader('x-pollstream-channel', this.id)
    resp.setHeader('content-length', 0)
    // resp.setHeader('x-pollstream-pending', this.client.pending())
    resp.setHeader('date', new Date())
    resp.end()
    return true
  }
  return false
} 
ClientChannel.prototype.ack = function (hash) {
  if (hash === 'end') {
    this.emit('release')
    this.pending = false
    this.ended = false
    return
  }
  
  if (this.chunks[0][0] === hash) {
    this.chunks.shift()
    if (this.chunks.length === 0 && this.ended === false) this.pending = false
  } else {
    console.error('Chunk acknowledged that no longer exists!')
  }
}
ClientChannel.prototype.write = function (chunk) {
  this.chunks.push([md5(chunk), chunk])
  this.chunksLength += chunk.length
  this.emit('pending', this)
  this.pending = true
}
ClientChannel.prototype.end = function () {
  this.ended = true
  this.pending = true
}

function ClientStream (id, poll) {
  this.poll = poll
  this.id = id
  this.chunks = []
  this.writable = true
  this.readable = true
  this.channels = {id: new ClientChannel(id, this)}
  this.on('release', poll.release.bind(poll, id))
}
util.inherits(ClientStream, stream.Stream)
ClientStream.prototype.onRequest = function (req, resp, page) {
  var self = this
  
  if (page.ack) {
    self.channel(page.channel).ack(page.ack)
  }
  
  if (req.method === 'POST') {
    req.on('data', self.channel(page.channel).emit.bind(self.channel(page.channel), 'data'))
    req.on('end', onEnd)
  } else {
    onEnd()
  }
  
  function onEnd () {
    for (var i in self.channels) {
      if (self.channels[i].onRequest(req, resp)) {
        return
      }
    }
    if (page.ack) {
      return self.pong(req, resp)
    }
    self.idle(req, resp)
  }
  
}
ClientStream.prototype.write = function (chunk, channel) {
  if (!channel) channel = this.id
  this.getChannel(channel).write(chunk)
}
ClientStream.prototype.idle = function (req, resp) {
  var self = this
  if (self.idler) {
    resp.setHeader('x-pollstream-noop', 'true')
    resp.end()
    return
  }
  self.idler = [req, resp]
  
  // Safe cleanup and remove of the idler
  function remove (release) { 
    self.idler = null 
    clearTimeout(self.timeout)
    
    self.removeListener('pending', pending)
    
    resp.removeListener('error', remove)
    resp.removeListener('close', remove)
    resp.removeListener('timeout', remove)
    
    resp.socket.removeListener('close', remove)
    resp.socket.removeListener('timeout', remove)
    
    if (release) self.emit('release')
    resp.end = resp.___end
  }
  resp.___end = resp.end
  resp.end = function (chunk) {remove(); resp.__end(chunk)}
  resp.on('error', remove)
  resp.on('close', remove)
  resp.on('timeout', remove)
  resp.socket.on('close', remove)
  resp.socket.on('timeout', remove)
  
  self.timeout = setTimeout(function () {
    remove(false)
    self.pong(req, resp)
  }, 30 * 1000)
  
  // wait for pending data from any channel
  function pending (channel) {
    remove(false)
    channel.onRequest(req, resp)
  }
  self.on('pending', pending)
}
ClientStream.prototype.pong = function (req, resp) {
  resp.setHeader('x-pollstream-pong', 'true')
  resp.end()
}
ClientStream.prototype.getChannel = function (channel) {
  if (!channel) throw new Error('Must pass channel name')
  if (!this.channels[channel]) this.channels[channel] = new ClientChannel(channel, this)
  return this.channels[channel]
}
ClientStream.prototype.channel = function (id) {
  if (!id) id = this.id
  return this.getChannel(id)
}

function PollServer () {
  var self = this
  self.clients = {}
  self.on('request', function (req, resp) {
    // iOS security bullshit, this should be configurable in the future
    resp.setHeader('access-control-allow-origin', "*")
    resp.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
    resp.setHeader('access-control-allow-headers', 'Content-Type') 
    resp.setHeader('access-control-max-age', 86400)
    // iOS POST caching bullshit
    resp.setHeader('Cache-Control', 'no-cache')
    
    if (req.method === 'GET' && req.url === '/_pollstream/client.js') {
      resp.statusCode = 200
      resp.setHeader('content-type', 'application/javascript')
      resp.setHeader('content-length', clientBuffer.length)
      resp.write(clientBuffer)
      resp.end()
      return
    }
    
    if (req.url.slice(0, '/_pollstream/poll'.length) === '/_pollstream/poll') {
      var page = qs.parse(url.parse(req.url).query)
        , client = self.getClient(page.uuid)
        ;
      client.onRequest(req, resp, page)
      return
    }
    
    resp.statusCode = 404
    resp.end()
  })
}
util.inherits(PollServer, events.EventEmitter)
PollServer.prototype.onRequest = function (req, resp) {
  if (req.url.slice(0, '/_pollstream/'.length) === '/_pollstream/') {
    this.emit('request', req, resp)
    return true
  }
  return false
}
PollServer.prototype.getClient = function (uuid) {
  if (!this.clients[uuid]) {
    this.clients[uuid] = new ClientStream(uuid, this)
    this.emit('client', this.clients[uuid])
  }
  return this.clients[uuid]
}
PollServer.prototype.release = function (id) {
  delete this.clients[id]
}

module.exports = function () {
  return new PollServer()
}
module.exports.createServer = function (handler) {
  var pollsocket = new PollServer()
    , server = http.createServer()
    ;
  server.on('request', function (req, resp) {
    if (!pollsocket.onRequest(req, resp)) {
      handler(req, resp)
    }
  })
  pollsocket.on('client', function (client) {server.emit('client', client)})
  return server
}