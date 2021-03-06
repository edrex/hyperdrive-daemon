const p = require('path')
const { EventEmitter } = require('events')
const crypto = require('crypto')

const datEncoding = require('dat-encoding')
const hyperfuse = require('hyperdrive-fuse')
const fuse = require('fuse-native')
const { HyperdriveFuse } = hyperfuse

const { Stat }  = require('hyperdrive-schemas')
const { rpc } = require('hyperdrive-daemon-client')
const { fromHyperdriveOptions, toHyperdriveOptions } = require('hyperdrive-daemon-client/lib/common')
const constants = require('hyperdrive-daemon-client/lib/constants')

const { VirtualFiles } = require('./virtual-files')
const log = require('../log').child({ component: 'fuse-manager' })

class FuseManager extends EventEmitter {
  constructor (driveManager, db, opts) {
    super()

    this.driveManager = driveManager
    this.db = db
    this.opts = opts

    // TODO: Replace with an LRU cache.
    this._handlers = new Map()
    this._virtualFiles = new VirtualFiles()

    // Set in ready.
    this.fuseConfigured = false
    this._rootDrive = null
    this._rootMnt = null
    this._rootHandler = null
  }

  async ready () {
    try {
      await ensureFuse()
      this.fuseConfigured = true
    } catch (err) {
      this.fuseConfigured = false
    }
    if (this.fuseConfigured) return this._refreshMount()
    return null
  }

  async _refreshMount () {
    log.debug('attempting to refresh the root drive if it exists.')
    const rootDriveMeta = await this._getRootDriveInfo()
    if (rootDriveMeta) {
      const { opts, mnt } = rootDriveMeta
      log.debug({ opts, mnt }, 'refreshing mount on restart')
      await this.mount(mnt, opts)
      return true
    } else {
      log.debug('no root mount found')
      return false
    }
  }

  async _getRootDriveInfo () {
    log.debug('getting root drive metadata')
    try {
      const rootDriveMeta = await this.db.get('root-drive')
      log.debug({ rootDriveMeta }, 'got root drive metadata')
      return rootDriveMeta
    } catch (err) {
      if (!err.notFound) throw err
      log.debug('no root drive metadata found')
      return null
    }
  }

  _wrapHandlers (handlers) {
    const interceptorIndex = new Map()

    const RootListHandler = {
      id: 'root',
      test: '^\/$',
      search: /^\/$/,
      ops: ['readdir'],
      handler: (op, match, args, cb) => {
        return this._rootHandler['readdir'].apply(null, [...args, (err, list) => {
          if (err) return cb(err)
          return cb(0, [...list, 'by-key', 'stats', 'active'])
        }])
      }
    }

    const NonWritableRootHandler = {
      id: 'nowriteroot',
      test: '^\/\\w+\/?$',
      search: /./,
      ops: ['write', 'truncate', 'setxattr', 'chown', 'chmod', 'mkdir', 'create', 'utimens', 'rmdir', 'unlink'],
      handler: (op, match, args, cb) => {
        // The top-level directory is not writable
        return process.nextTick(cb, -1)
      }
    }

    const ByKeyHandler = {
      id: 'bykey',
      test: '^\/by-key',
      ops: '*',
      search: /^\/(by\-key)(\/(?<key>\w+)(\+(?<version>\d+))?(\+(?<hash>\w+))?\/?)?/,
      handler: (op, match, args, cb) => {
        // If this is a stat on '/by-key', return a directory stat.
        if (!match.groups['key']) {
          if (op === 'readdir') return cb(0, [])
          if (op === 'releasedir') return cb(0)
          if (op === 'getattr') return cb(0, Stat.directory({ uid: process.getuid(), gid: process.getgid() }))
          return handlers[op].apply(null, [...args, cb])
        }

        // Otherwise this is operating on a subdir of by-key, in which case perform the op on the specified drive.
        try {
          var key = datEncoding.decode(match.groups['key'])
        } catch (err) {
          log.error({ err }, 'key encoding error')
          return cb(-1)
        }

        if (op === 'symlink') {
          // Symlinks into the 'by-key' directory should be treated as mounts in the root drive.
          var version = match.groups['version']
          if (version && +version) version = +version
          const hash = match.groups['hash']
          return this.mountDrive(args[0], { version, hash })
            .then(() => cb(0))
            .catch(err => {
              log.error({ err }, 'mount error')
              cb(-1)
            })
        }

        return this.driveManager.get(key, { ...this.opts })
          .then(drive => {
            var driveFuse = this._handlers.get(drive)
            if (!driveFuse) {
              const fuse = new HyperdriveFuse(drive, `/by-key/${key}`, this.opts)
              handlers = fuse.getBaseHandlers()
              driveFuse = { fuse, handlers }
              this._handlers.set(drive, driveFuse)
            }
            handlers = driveFuse.handlers
            args[0] = args[0].slice(match[0].length) || '/'
            return handlers[op].apply(null, [...args, (err, result) => {
              if (err) {
                log.trace({ err }, 'error in sub-fuse handler')
                return cb(err)
              }
              log.trace({ result }, 'sub-fuse handler result')
              return cb(null, result)
            }])
          })
          .catch(err => {
            log.error({ err: err.stack }, 'by-key handler error')
            return cb(-1)
          })
      }
    }

    const StatsHandler = {
      id: 'stats',
      test: '^\/stats',
      ops: ['readdir', 'getattr', 'open', 'read', 'close', 'symlink', 'release', 'releasedir', 'opendir'],
      search: /^\/(stats)(\/(?<key>\w+)(\/(?<filename>.+))?)?/,
      handler: async (op, match, args, cb) => {
        if (op === 'getattr') {
          // If this is a stat on '/stats', return a directory stat.
          if (!match.groups['key']) return cb(0, Stat.directory({ uid: process.getuid(), gid: process.getgid() }))

          // If this is a stat on '/stats/(key)', return a directory stat.
          if (match.groups['key'] && !match.groups['filename']) return cb(0, Stat.directory({ uid: process.getuid(), gid: process.getgid() }))

          const filename = match.groups['filename']
          if (filename !== 'networking.json' && filename !== 'storage.json') return cb(fuse.ENOENT)

          // Otherwise, this is a stat on a specific virtual file, so return a file stat.
          return cb(0, Stat.file({ uid: process.getuid(), gid: process.getgid(), size: 4096 }))
        }

        if (op === 'readdir') {
          // If this is a readdir on '/stats', do not return anything (this should not enumerate all drives).
          if (!match.groups['key']) {
            try {
              const drives = await this.driveManager.listDrives()
              return cb(0, drives.map(d => d.key))
            } catch (err) {
              return cb(fuse.EIO)
            }
          }
          // If this is a readdir on '/stats/(key)', return the two JSON filenames.
          if (match.groups['key'] && !match.groups['filename']) return cb(0, ['networking.json', 'storage.json'])
          // Otherwise return an empty list
          return cb(0, [])
        }

        if (op === 'open') {
          if (!match.groups['key'] || !match.groups['filename']) return cb(fuse.ENOENT)
          const filename = match.groups['filename']
          if (filename !== 'networking.json' && filename !== 'storage.json') return cb(fuse.ENOENT)

          try {
            const key = datEncoding.decode(match.groups['key'])
            log.debug({ key: match.groups['key'], filename }, 'opening stats file for drive')
            const drive = await this.driveManager.get(key, { ...this.opts })
            var stats = null

            if (filename === 'networking.json') {
              stats = await this.driveManager.getDriveStats(drive)
              stats.forEach(stat => {
                if (stat.metadata) stat.metadata.key = datEncoding.encode(stat.metadata.key)
                if (stat.content) stat.content.key = datEncoding.encode(stat.content.key)
              })
            } else {
              stats = await new Promise((resolve, reject) => {
                drive.stats('/', (err, sts) => {
                  if (err) return reject(err)
                  const stObj = {}
                  for (const [dir, st] of sts) {
                    stObj[dir] = st
                  }
                  return resolve(stObj)
                })
              })
            }

            const fd = this._virtualFiles.open(JSON.stringify(stats, null, 2))
            return cb(0, fd)
          } catch (err) {
            return cb(fuse.ENOENT)
          }
        }

        if (op === 'read') {
          if (!match.groups['key'] || !match.groups['filename']) return cb(fuse.ENOENT)
          const filename = match.groups['filename']
          if (filename !== 'networking.json' && filename !== 'storage.json') return cb(fuse.ENOENT)
          return this._virtualFiles.read.apply(this._virtualFiles, [...args, cb])
        }

        if (op === 'release') {
          if (!match.groups['key'] || !match.groups['filename']) return cb(fuse.ENOENT)
          const filename = match.groups['filename']
          if (filename !== 'networking.json' && filename !== 'storage.json') return cb(fuse.ENOENT)
          log.debug({ key: match.groups['key'], filename }, 'closing stats file')
          return this._virtualFiles.close.apply(this._virtualFiles, [...args, cb])
        }

        return handlers[op].apply(null, [...args, cb])
      }
    }

    const ActiveHandler = {
      id: 'active',
      test: '^\/active',
      ops: ['readdir', 'getattr', 'symlink', 'readlink'],
      search: /^\/(active)(\/(?<key>\w+)\.json\/?)?/,
      handler: async (op, match, args, cb) => {
        if (op === 'getattr') {
          // If this is a stat on '/active', return a directory stat.
          if (!match.groups['key']) return cb(0, Stat.directory({ uid: process.getuid(), gid: process.getgid() }))
          // Othersise, it is a stat on a particular key, so return a symlink to the /stats dir for that key
          const linkname = `${constants.mountpoint}/stats/${match.groups['key']}/networking.json`
          return cb(0, Stat.symlink({ uid: process.getuid(), gid: process.getgid() }))
        }

        if (op === 'readdir') {
          const seedingDrives = await this.driveManager.listSeedingDrives()
          console.error('SEEDING DRIVES:', seedingDrives)
          return cb(0, seedingDrives.map(d => d.value.key + '.json'))
        }

        if (op === 'readlink') {
          if (!match.groups['key']) return cb(fuse.ENOENT)
          return cb(0, `${constants.mountpoint}/stats/${match.groups['key']}/networking.json`)
        }

        return handlers[op].apply(null, [...args, cb])
      }
    }

    const interceptors = [
      RootListHandler,
      NonWritableRootHandler,
      ByKeyHandler,
      StatsHandler,
      ActiveHandler
    ]
    for (let interceptor of interceptors) {
      interceptorIndex.set(interceptor.id, interceptor)
    }

    const wrappedHandlers = {}
    for (let handlerName of Object.getOwnPropertyNames(handlers)) {
      const baseHandler = handlers[handlerName]
      if (typeof baseHandler !== 'function') {
        wrappedHandlers[handlerName] = baseHandler
      } else {
        wrappedHandlers[handlerName] = wrapHandler(handlerName, baseHandler)
      }
    }

    return wrappedHandlers

    function wrapHandler (handlerName, handler) {
      log.debug({ handlerName }, 'wrapping handler')
      const activeInterceptors = interceptors.filter(({ ops }) => ops === '*' || (ops.indexOf(handlerName) !== -1))
      if (!activeInterceptors.length) return handler

      const matcher = new RegExp(activeInterceptors.map(({ test, id }) => `(?<${id}>${test})`).join('|'))

      return function () {
        const arg = handlerName === 'symlink' ? arguments[1] : arguments[0]
        const match = matcher.exec(arg)

        if (!match) return handler(...arguments)

        // TODO: Don't slice here.
        const args = [...arguments].slice(0, -1)

        if (log.isLevelEnabled('trace')) {
          log.trace({ id: match[1], path: args[0] }, 'syscall interception')
        }

        // TODO: Don't iterate here.
        for (let key in match.groups) {
          if (!match.groups[key]) continue
          var id = key
          break
        }

        const { handler: wrappedHandler, search } = interceptorIndex.get(id)
        return wrappedHandler(handlerName, search.exec(arg), args, arguments[arguments.length - 1])
      }
    }
  }

  _getMountPath (path) {
    if (!this._rootDrive && path !== constants.mountpoint) {
      throw new Error(`You can only mount the root drive at ${constants.mountpoint}`)
    }
    if (!this._rootDrive) return { path: constants.mountpoint, root: true }
    if (path.startsWith(this._rootMnt) && path !== this._rootMnt) {
      const relativePath = path.slice(this._rootMnt.length)
      if (!relativePath.startsWith('/home')) throw new Error('You can only mount sub-hyperdrives within the home directory.')
      return { path: relativePath, root: false }
    }
  }

  async _keyForPath (path) {
    if (!this._rootDrive) throw new Error('Cannot get mountpoint keys when a root drive is not mounted.')
    if (!path.startsWith(this._rootMnt)) throw new Error(`The mountpoint must be a beneath ${constants.mountpoint}.`)
    const self = this

    if (path !== this._rootMnt) {
      const relativePath = path.slice(this._rootMnt.length)
      if (!relativePath.startsWith('/home')) throw new Error('You get keys of mounted sub-hyperdrives within the home directory.')
      return {
        key: await getSubdriveKey(relativePath),
        root: false,
        relativePath
      }
    }

    return { key: this._rootDrive.key, root: true }

    function getSubdriveKey(relativePath) {
      return new Promise((resolve, reject) => {
        self._rootDrive.stat(p.join(relativePath, 'does_not_exist'), { trie: true }, (err, stat, trie) => {
          if (err && err.errno !== 2) return reject(err)
          else if (err && !trie) return resolve(null)
          return resolve(trie.key)
        })
      })
    }
  }

  async _driveForPath (path, opts = {}) {
    const self = this
    const { key: driveKey, root, relativePath } = await this._keyForPath(path)
    return { drive: await this.driveManager.get(driveKey, { ...opts }), root, relativePath }
  }

  async mount (mnt, mountOpts = {}) {
    const self = this
    if (!this._rootDrive && mnt !== constants.mountpoint) throw new Error('Must mount a root drive before mounting subdrives.')
    mnt = mnt || constants.mountpoint

    await ensureFuse()
    log.debug({ mnt, mountOpts }, 'mounting a drive')

    // TODO: Stop using the hash field to pass this flag once hashes are supported.
    console.error('mountOpts here:', mountOpts, 'hash string?', mountOpts.hash && mountOpts.hash.toString())
    if (mnt === constants.mountpoint && (!mountOpts.hash || (mountOpts.hash.toString() !== 'force'))) {
      const rootDriveInfo = await this._getRootDriveInfo()
      if (rootDriveInfo) mountOpts = rootDriveInfo.opts
    }

    const drive = await this.driveManager.get(mountOpts.key, { ...mountOpts, configure: { rootDrive: !this._rootDrive }})

    if (!this._rootDrive) {
      await this.unmount(mnt)
      return mountRoot(drive)
    }

    const { path: relativePath } = this._getMountPath(mnt)
    return mountSubdrive(relativePath, drive)

    async function mountSubdrive (relativePath, drive) {
      log.debug({ key: drive.key.toString('hex') }, 'mounting a sub-hyperdrive')
      mountOpts.uid = process.getuid()
      mountOpts.gid = process.getgid()
      return new Promise((resolve, reject) => {
        self._rootDrive.mount(relativePath, drive.key, mountOpts, err => {
          if (err) return reject(err)
          return resolve({ ...mountOpts, key: drive.key })
        })
      })
    }

    async function mountRoot (drive) {
      log.debug({ key: drive.key.toString('hex') }, 'mounting the root drive')
      const fuseLogger = log.child({ component: 'fuse' })

      const fuse = new HyperdriveFuse(drive, constants.hiddenMountpoint, {
        force: true,
        displayFolder: true,
        log: fuseLogger.trace.bind(fuseLogger),
        debug: log.isLevelEnabled('trace'),
        safe: false
      })

      const handlers = fuse.getBaseHandlers()
      const wrappedHandlers = self._wrapHandlers(handlers)
      await fuse.mount(wrappedHandlers)

      log.debug({ mnt, wrappedHandlers }, 'mounted the root drive')
      mountOpts.key = drive.key

      await self.db.put('root-drive', { mnt, opts: { ...mountOpts, key: datEncoding.encode(drive.key) } })

      self._rootDrive = drive
      self._rootMnt = mnt
      self._rootFuse = fuse
      self._rootHandler = handlers

      return mountOpts
    }
  }

  async unmount (mnt) {
    log.debug({ mnt }, 'unmounting drive at mountpoint')
    await ensureFuse()
    const self = this

    if (!this._rootMnt) return

    // If a mountpoint is not specified, then it is assumed to be the root mount.
    if (!mnt || mnt === constants.mountpoint) return unmountRoot()

    // Otherwise, unmount the subdrive
    const { path, root } = this._getMountPath(mnt)
    if (root) return unmountRoot()
    return unmountSubdrive(path)

    async function unmountRoot () {
      log.debug({ mnt: self._rootMnt }, 'unmounting the root drive')

      await self._rootFuse.unmount()

      self._rootDrive = null
      self._rootMnt = null
      self._rootFuse = null
      self._rootHandler = null
    }

    function unmountSubdrive (path) {
      return new Promise((resolve, reject) => {
        self._rootDrive.unmount(path, err => {
          if (err) return reject(err)
          return resolve()
        })
      })
    }
  }

  async mountDrive (path, opts) {
    if (!this._rootDrive) throw new Error('The root hyperdrive must first be created before mounting additional drives.')
    if (!this._rootMnt || !path.startsWith(this._rootMnt)) throw new Error('Drives can only be mounted within the mountpoint.')

    // The corestore name is not very important here, since the initial drive will be discarded after mount.
    const drive = await this._createDrive(null, { ...this.opts, name: crypto.randomBytes(64).toString('hex') })

    log.debug({ path, key: drive.key }, 'mounting a drive at a path')
    return new Promise((resolve, reject) => {
      const innerPath = path.slice(this._rootMnt.length)
      this._rootDrive.mount(innerPath, opts, err => {
        if (err) return reject(err)
        log.debug({ path, key: drive.key }, 'drive mounted')
        return resolve()
      })
    })
  }

  async publish (mnt) {
    await ensureFuse()
    const { drive } = await this._driveForPath(mnt)
    return this.driveManager.publish(drive)
  }

  async unpublish (mnt) {
    await ensureFuse()
    const { drive } = await this._driveForPath(mnt)
    return this.driveManager.unpublish(drive)
  }

  async key (mnt) {
    await ensureFuse()
    const { key: driveKey, relativePath } = await this._keyForPath(mnt)
    if (!driveKey) throw new Error(`A drive is not mounted at path: ${mnt}`)
    return { key: datEncoding.encode(driveKey), relativePath }
  }

  list () {
    return new Map([...this._drives])
  }

  getHandlers () {
    return {
      mount: async (call) => {
        var mountOpts = call.request.getOpts()
        const mnt = call.request.getPath()
        if (mountOpts) mountOpts = fromHyperdriveOptions(mountOpts)

        if (!mnt) throw new Error('A mount request must specify a mountpoint.')
        const mountInfo = await this.mount(mnt, mountOpts)

        const rsp = new rpc.fuse.messages.MountResponse()
        rsp.setMountinfo(toHyperdriveOptions(mountInfo))
        rsp.setPath(mnt)

        return rsp
      },

      publish: async (call) => {
        const mnt = call.request.getPath()

        if (!mnt) throw new Error('A publish request must specify a mountpoint.')
        await this.publish(mnt)

        return new rpc.fuse.messages.PublishResponse()
      },

      unpublish: async (call) => {
        const mnt = call.request.getPath()

        if (!mnt) throw new Error('An unpublish request must specify a mountpoint.')
        await this.unpublish(mnt)

        return new rpc.fuse.messages.UnpublishResponse()
      },

      unmount: async (call) => {
        const mnt = call.request.getPath()

        await this.unmount(mnt)

        return new rpc.fuse.messages.UnmountResponse()
      },

      status: (call) => {
        const rsp = new rpc.fuse.messages.FuseStatusResponse()
        rsp.setAvailable(true)
        return new Promise((resolve, reject) => {
          hyperfuse.isConfigured((err, configured) => {
            if (err) return reject(err)
            rsp.setConfigured(configured)
            return resolve(rsp)
          })
        })
      },

      key: async (call) => {
        const rsp = new rpc.fuse.messages.KeyResponse()
        const mnt = call.request.getPath()

        const { key, relativePath } = await this.key(mnt)
        rsp.setKey(key)
        rsp.setPath(relativePath)

        return rsp
      },

      download: async (call) => {
        const rsp = new rpc.fuse.messages.DownloadResponse()
        const path = call.request.getPath()

        const { downloadId, sessionId } = await this.download(path)
        rsp.setDownloadid(downloadId)
        rsp.setSessionid(sessionId)

        return rsp
      }
    }
  }
}

function ensureFuse () {
  return new Promise((resolve, reject) => {
    hyperfuse.isConfigured((err, configured) => {
      if (err) return reject(err)
      if (!configured) return reject(new Error('FUSE is not configured. Please run `hyperdrive setup` first.'))
      return resolve()
    })
  })
}

module.exports = FuseManager
