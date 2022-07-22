'use strict'

const { AbstractLevel } = require('abstract-level')
const ModuleError = require('module-error')
const fs = require('fs')
const binding = require('./binding')
const { ChainedBatch } = require('./chained-batch')
const { Iterator } = require('./iterator')
const assert = require('assert')

const kContext = Symbol('context')
const kColumns = Symbol('columns')
const kLocation = Symbol('location')
const kOptions = Symbol('options')

class RocksLevel extends AbstractLevel {
  constructor (location, options, _) {
    // To help migrating to abstract-level
    if (typeof options === 'function' || typeof _ === 'function') {
      throw new ModuleError('The levelup-style callback argument has been removed', {
        code: 'LEVEL_LEGACY'
      })
    }

    if (typeof location !== 'string' || location === '') {
      throw new TypeError("The first argument 'location' must be a non-empty string")
    }

    super({
      encodings: {
        buffer: true,
        utf8: true
      },
      seek: true,
      createIfMissing: true,
      errorIfExists: true,
      additionalMethods: {
        updates: true,
        query: true
      }
    }, options)

    this[kLocation] = location
    this[kContext] = binding.db_init()
    this[kColumns] = {}
  }

  get options () {
    return this[kOptions]
  }

  get sequence () {
    return Number(binding.db_get_latest_sequence(this[kContext]))
  }

  get location () {
    return this[kLocation]
  }

  get columns () {
    return this[kColumns]
  }

  _open (options, callback) {
    const onOpen = (err, columns) => {
      if (err) {
        callback(err)
      } else {
        this[kColumns] = columns
        callback(null)
      }
    }
    if (options.createIfMissing) {
      fs.mkdir(this[kLocation], { recursive: true }, (err) => {
        if (err) return callback(err)
        this[kOptions] = binding.db_open(this[kContext], this[kLocation], options, onOpen)
      })
    } else {
      this[kOptions] = binding.db_open(this[kContext], this[kLocation], options, onOpen)
    }
  }

  _close (callback) {
    binding.db_close(this[kContext], callback)
  }

  _put (key, value, options, callback) {
    try {
      binding.db_put(this[kContext], key, value, options)
      process.nextTick(callback, null)
    } catch (err) {
      process.nextTick(callback, err)
    }
  }

  _get (key, options, callback) {
    binding.db_get(this[kContext], key, options, callback)
  }

  _getMany (keys, options, callback) {
    binding.db_get_many(this[kContext], keys, options, callback)
  }

  _del (key, options, callback) {
    try {
      binding.db_del(this[kContext], key, options)
      process.nextTick(callback, null)
    } catch (err) {
      process.nextTick(callback, err)
    }
  }

  _clear (options, callback) {
    try {
      binding.db_clear(this[kContext], options)
      process.nextTick(callback, null)
    } catch (err) {
      process.nextTick(callback, err)
    }
  }

  _chainedBatch () {
    return new ChainedBatch(this, this[kContext])
  }

  _batch (operations, options, callback) {
    try {
      binding.batch_do(this[kContext], operations, options)
      process.nextTick(callback, null)
    } catch (err) {
      process.nextTick(callback, err)
    }
  }

  _iterator (options) {
    return new Iterator(this, this[kContext], options)
  }

  getProperty (property) {
    if (typeof property !== 'string') {
      throw new TypeError("The first argument 'property' must be a string")
    }

    // Is synchronous, so can't be deferred
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN'
      })
    }

    return binding.db_get_property(this[kContext], property)
  }

  async getCurrentWALFile () {
    return binding.db_get_current_wal_file(this[kContext])
  }

  async getSortedWALFiles () {
    return binding.db_get_sorted_wal_files(this[kContext])
  }

  async flushWAL (options) {
    binding.db_flush_wal(this[kContext], options)
  }

  async query (options) {
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN'
      })
    }

    const context = binding.iterator_init(this[kContext], options)
    const resource = {
      callback: null,
      close (callback) {
        this.callback = callback
      }
    }

    try {
      this.attachResource(resource)

      const limit = options.limit ?? 1000
      return await new Promise((resolve, reject) => binding.iterator_nextv(context, limit, (err, rows, finished) => {
        if (err) {
          reject(err)
        } else {
          resolve({
            rows,
            sequence: Number(binding.iterator_get_sequence(context)),
            finished
          })
        }
      }))
    } finally {
      this.detachResource(resource)
      binding.iterator_close(context)
      if (resource.callback) {
        resource.callback()
      }
    }
  }

  async * updates (options) {
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN'
      })
    }

    class Updates {
      constructor (db, options) {
        const { since, context, keys, values, data } = binding.updates_init(db[kContext], options)

        assert(context)
        assert.equal(since, options.since || 0)
        assert.equal(keys, keys ?? true)
        assert.equal(values, values ?? true)
        assert.equal(data, data ?? true)

        this.context = context
        this.closed = false
        this.promise = null
        this.db = db
        this.db.attachResource(this)
      }

      async next () {
        if (this.closed) {
          return {}
        }

        this.promise = new Promise(resolve => binding.updates_next(this.context, (err, rows, sequence, count) => {
          this.promise = null
          if (err) {
            resolve(Promise.reject(err))
          } else {
            resolve({ rows, sequence, count })
          }
        }))

        return this.promise
      }

      async close (callback) {
        try {
          await this.promise
        } catch {
          // Do nothing...
        }

        try {
          if (!this.closed) {
            this.closed = true
            binding.updates_close(this.context)
          }

          if (callback) {
            process.nextTick(callback)
          }
        } catch (err) {
          if (callback) {
            process.nextTick(callback, err)
          } else {
            throw err
          }
        } finally {
          this.db.detachResource(this)
        }
      }
    }

    const updates = new Updates(this, options)
    try {
      while (true) {
        const entry = await updates.next()
        if (!entry.rows) {
          return
        }
        yield entry
      }
    } finally {
      await updates.close()
    }
  }
}

exports.RocksLevel = RocksLevel
