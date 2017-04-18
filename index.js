var createConfig = require('ssb-config/inject')
var ssbKeys = require('ssb-keys')
var path = require('path')
var fs = require('fs')
var MultiServer = require('multiserver')
var msShs = require('multiserver/plugins/shs')
var msNet = require('multiserver/plugins/net')
var muxrpc = require('muxrpc')
var pull = require('pull-stream')

function toSodiumKeys(keys) {
  if(!keys || !keys.public) return null
  return {
    publicKey: new Buffer(keys.public.replace('.ed25519', ''), 'base64'),
    secretKey: new Buffer(keys.private.replace('.ed25519', ''), 'base64'),
  }
}

module.exports = function (opts, cb) {
  if (typeof opts === 'function') cb = opts, opts = null
  opts = opts || {}
  var config = createConfig(process.env.ssb_appname, opts)
  var appKey = config.appKey ||
    (config.caps && config.caps.shs && new Buffer(config.caps.shs, 'base64'))
  if (!appKey) return cb(new Error('missing secret-handshake capability key'))
  var keys = config.keys || (config.keys =
    ssbKeys.loadOrCreateSync(path.join(config.path, 'secret')))
  config.manifestFile = path.join(config.path, 'manifest.json')

  var shs = msShs({
    keys: toSodiumKeys(keys),
    appKey: appKey,
    auth: function (cb) { cb(null, false) },
    timeout: config.timers && config.timers.handshake || 5e3
  })

  var ms = MultiServer([
    [msNet({}), shs]
  ])

  var keyPublic = keys.public.replace('.ed25519', '')
  var host = config.host || 'localhost'
  var remote = 'net:' + host + ':' + config.port + '~shs:' + keyPublic

  ;(function tryConnect(remote) {
    ms.client(remote, function (err, stream) {
      if (err && err.code === 'ECONNREFUSED') {
        return spawnSbot(config, function (err, remote) {
          if (err) return cb(new Error(
            'unable to connect to or start sbot: ' + err.stack))
          tryConnect(remote)
        })
      }
      if (err) return cb(new Error('unable to connect to sbot: ' + err.stack))

      var manifest = config.manifest
        || JSON.parse(fs.readFileSync(config.manifestFile))
      var sbot = muxrpc(manifest, false)()
      sbot.id = '@'+stream.remote.toString('base64')+'.ed25519'
      pull(stream, sbot.createStream(), stream)
      delete config.keys
      cb(null, sbot, config)
    })
  }(remote))
}

function spawnSbot(config, cb) {
  console.error('Starting scuttlebot...')
  function cbOnce(err, addr) {
    if (!cb) return
    cb(err, addr)
    cb = null
  }
  var conf = config.party || {}
  var out = typeof conf.out === 'string'
    ? fs.openSync(path.resolve(config.path, conf.out), 'a')
    : conf.out === false ? 'ignore' : 'inherit'
  var err = typeof conf.err === 'string'
    ? fs.openSync(path.resolve(config.path, conf.err), 'a')
    : conf.err === false ? 'ignore' : conf.err === true ? 'inherit' : out
  var proc = require('child_process')
  var scriptPath = path.join(__dirname, 'server.js')
  var child = proc.spawn(process.execPath, [scriptPath], {
    detached: true,
    stdio: ['ignore', out, err, 'ipc'],
  })
  child.send(config)
  child.once('message', function (msg) {
    var manifestJSON = JSON.stringify(msg.manifest, null, 2)
    fs.writeFile(config.manifestFile, manifestJSON, function (err) {
      if (err) console.error('warning: unable to write manifest: ' + err.stack)
      child.unref()
      cbOnce(null, msg.address)
    })
  })
  child.once('error', function (err) {
    cbOnce(new Error('child sbot error: ' + err.stack))
  })
}
