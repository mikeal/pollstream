var request = require('request')
  , pollstream = require('./index')
  , uuid = require('node-uuid')
  , stream = require('stream')
  , util = require('util')
  , path = require('path')
  , fs = require('fs')
  , qs = require('querystring')
  , assert = require('assert')
  , indexFile = path.join(__dirname, 'index.js')
  ;

function PollStreamChannel (id, client) {
  this.id = id
  this.client = client
}
util.inherits(PollStreamChannel, stream.Stream)
PollStreamChannel.prototype.write = function (chunk) {
  this.client.write(chunk, this.id)
}


function PollStreamClient (url) {
  if (url[url.length - 1] !== '/') url += '/'
  this.id = uuid()
  this.url = url + '_pollstream/poll?'
  this.request({})
  this.channels = {}
}
util.inherits(PollStreamClient, stream.Stream)

PollStreamClient.prototype.request = function () {
  var opts = {}
    , self = this
    ;
  opts.uuid = self.id
  if (self.etag) {
    opts.ack = self.etag
    opts.channel = self.channel
  }
  var r = request(this.url+qs.stringify(opts))

  r.on('response', function (resp) {
    if (self.etag) {
      if (self.etag === 'end') {
        self.getChannel(self.channel).emit('end')
      }
    }
    delete self.etag
    delete self.channel
    if (resp.headers['x-pollstream-noop']) {
      console.error('Concurrently trying to access a channel. bad!')
      return 
    }
    if (resp.headers['x-pollstream-pong']) {
      self.request()
      return
    }
    if (resp.headers['x-pollstream-channel']) {
      var channel = self.getChannel(resp.headers['x-pollstream-channel'])
        , chunks = []
        ;
      r.on('data', chunks.push.bind(chunks))
      r.on('data', function (c) {console.log(c)})
      r.on('end', function () {
        chunks.forEach(channel.emit.bind(channel, 'data'))
        self.ack(resp.headers['x-pollstream-etag'], resp.headers['x-pollstream-channel'])
        self.request()
      })
      return
    }
    
  })
}
PollStreamClient.prototype.getChannel = function (id) {
  if (!id) throw new Error('Must pass id to getChannel.')
  if (!this.channels[id]) {
    this.channels[id] = new PollStreamChannel(id)
    this.emit('channel', this.channels[id])
  }
  return this.channels[id]
}
PollStreamClient.prototype.chanel = function (id) {
  if (!id) id = this.id
  return this.getChannel(id)
}
PollStreamClient.prototype.ack = function (etag, channel) {
  if (this.etag) throw new Error('We have a pending acknowledgement.')
  this.etag = etag
  this.channel = channel
}

var p = pollstream.createServer(function (req, resp) {
  throw new Error('Not caught by pollstream. '+req.url)
})

p.on('client', function (client) {
  client.write('test')
  fs.createReadStream(indexFile).pipe(client.channel('index.js'))
})

var url = 'http://localhost:8080'
p.listen(8080, function () {
  var id = uuid()
    , passes = 0
    ;
  
  var frame = {expect:0, success:0}
  frame.getCheck = function (name) {
    frame.expect += 1
    function check () {
      console.log('Passed: '+name)
      frame.success += 1
      if (frame.success === frame.expect) {
        console.log('All Passed!')
        process.exit(0)
      }
    }
    return check
  }
  
  var s = new PollStreamClient(url)
  
  var basic = frame.getCheck('basic')
    , index = frame.getCheck('index')
    ;
  
  s.on('channel', function (channel) {
    console.log('got channel', channel.id)
    if (channel.id === s.id) {
      channel.on('data', function (chunk) {
        if (chunk === 'test') console.log('passed simple test')
        basic()
      })
    }
    if (channel.id === 'index.js') {
      var str = ''
      channel.on('data', function (c) {str += c})
      channel.on('end', function () {
        assert.equal(fs.readFileSync(indexFile).toString(), str)
        index()
      })
    }
    
    
  })
  
})