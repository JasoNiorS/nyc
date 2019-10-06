'use strict'

/* global __coverage__ */

const cachingTransform = require('caching-transform')
const cpFile = require('cp-file')
const findCacheDir = require('find-cache-dir')
const fs = require('fs')
const glob = require('glob')
const Hash = require('./lib/hash')
const libCoverage = require('istanbul-lib-coverage')
const libHook = require('istanbul-lib-hook')
const { ProcessInfo, ProcessDB } = require('istanbul-lib-processinfo')
const libReport = require('istanbul-lib-report')
const mkdirp = require('make-dir')
const Module = require('module')
const onExit = require('signal-exit')
const path = require('path')
const reports = require('istanbul-reports')
const resolveFrom = require('resolve-from')
const rimraf = require('rimraf')
const SourceMaps = require('./lib/source-maps')
const testExclude = require('test-exclude')
const util = require('util')

const debugLog = util.debuglog('nyc')

let selfCoverageHelper

/* istanbul ignore next */
if (/self-coverage/.test(__dirname)) {
  selfCoverageHelper = require('../self-coverage-helper')
} else {
  // Avoid additional conditional code
  selfCoverageHelper = {
    onExit () {}
  }
}

function coverageFinder () {
  var coverage = global.__coverage__
  if (typeof __coverage__ === 'object') coverage = __coverage__
  if (!coverage) coverage = global['__coverage__'] = {}
  return coverage
}

class NYC {
  constructor (config) {
    config = config || {}
    this.config = config

    this.subprocessBin = config.subprocessBin || path.resolve(__dirname, './bin/nyc.js')
    this._tempDirectory = config.tempDirectory || config.tempDir || './.nyc_output'
    this._instrumenterLib = require(config.instrumenter || './lib/instrumenters/istanbul')
    this._reportDir = config.reportDir || 'coverage'
    this._sourceMap = typeof config.sourceMap === 'boolean' ? config.sourceMap : true
    this._showProcessTree = config.showProcessTree || false
    this._eagerInstantiation = config.eager || false
    this.cwd = config.cwd || process.cwd()
    this.reporter = [].concat(config.reporter || 'text')

    this.cacheDirectory = (config.cacheDir && path.resolve(config.cacheDir)) || findCacheDir({ name: 'nyc', cwd: this.cwd })
    this.cache = Boolean(this.cacheDirectory && config.cache)

    this.extensions = [].concat(config.extension || [])
      .concat('.js')
      .map(ext => ext.toLowerCase())
      .filter((item, pos, arr) => arr.indexOf(item) === pos)

    this.exclude = testExclude({
      cwd: this.cwd,
      include: config.include,
      exclude: config.exclude,
      excludeNodeModules: config.excludeNodeModules !== false,
      extension: this.extensions
    })

    this.sourceMaps = new SourceMaps({
      cache: this.cache,
      cacheDirectory: this.cacheDirectory
    })

    // require extensions can be provided as config in package.json.
    this.require = [].concat(config.require || [])

    this.transforms = this.extensions.reduce((transforms, ext) => {
      transforms[ext] = this._createTransform(ext)
      return transforms
    }, {})

    this.hookRequire = config.hookRequire
    this.hookRunInContext = config.hookRunInContext
    this.hookRunInThisContext = config.hookRunInThisContext
    this.fakeRequire = null

    this.processInfo = new ProcessInfo(Object.assign({}, config._processInfo, {
      directory: path.resolve(this.tempDirectory(), 'processinfo')
    }))

    this.hashCache = {}
  }

  _createTransform (ext) {
    const opts = {
      salt: Hash.salt(this.config),
      hashData: (input, metadata) => [metadata.filename],
      filenamePrefix: metadata => path.parse(metadata.filename).name + '-',
      onHash: (input, metadata, hash) => {
        this.hashCache[metadata.filename] = hash
      },
      cacheDir: this.cacheDirectory,
      // when running --all we should not load source-file from
      // cache, we want to instead return the fake source.
      disableCache: this._disableCachingTransform(),
      ext: ext
    }
    if (this._eagerInstantiation) {
      opts.transform = this._transformFactory(this.cacheDirectory)
    } else {
      opts.factory = this._transformFactory.bind(this)
    }
    return cachingTransform(opts)
  }

  _disableCachingTransform () {
    return !(this.cache && this.config.isChildProcess)
  }

  _loadAdditionalModules () {
    this.require.forEach(requireModule => {
      // Attempt to require the module relative to the directory being instrumented.
      // Then try other locations, e.g. the nyc node_modules folder.
      require(resolveFrom.silent(this.cwd, requireModule) || requireModule)
    })
  }

  instrumenter () {
    return this._instrumenter || (this._instrumenter = this._createInstrumenter())
  }

  _createInstrumenter () {
    return this._instrumenterLib({
      ignoreClassMethods: [].concat(this.config.ignoreClassMethod).filter(a => a),
      produceSourceMap: this.config.produceSourceMap,
      compact: this.config.compact,
      preserveComments: this.config.preserveComments,
      esModules: this.config.esModules,
      plugins: this.config.parserPlugins
    })
  }

  addFile (filename) {
    const source = this._readTranspiledSource(filename)
    this._maybeInstrumentSource(source, filename)
  }

  _readTranspiledSource (filePath) {
    var source = null
    var ext = path.extname(filePath)
    if (typeof Module._extensions[ext] === 'undefined') {
      ext = '.js'
    }
    Module._extensions[ext]({
      _compile: function (content, filename) {
        source = content
      }
    }, filePath)
    return source
  }

  addAllFiles () {
    this._loadAdditionalModules()

    this.fakeRequire = true
    this.exclude.globSync(this.cwd).forEach(relFile => {
      const filename = path.resolve(this.cwd, relFile)
      this.addFile(filename)
      const coverage = coverageFinder()
      const lastCoverage = this.instrumenter().lastFileCoverage()
      if (lastCoverage) {
        coverage[lastCoverage.path] = {
          ...lastCoverage,
          // Only use this data if we don't have it without `all: true`
          all: true
        }
      }
    })
    this.fakeRequire = false

    this.writeCoverageFile()
  }

  instrumentAllFiles (input, output, cb) {
    let inputDir = '.' + path.sep
    const visitor = relFile => {
      const inFile = path.resolve(inputDir, relFile)
      const inCode = fs.readFileSync(inFile, 'utf-8')
      const outCode = this._transform(inCode, inFile) || inCode

      if (output) {
        const mode = fs.statSync(inFile).mode
        const outFile = path.resolve(output, relFile)
        mkdirp.sync(path.dirname(outFile))
        fs.writeFileSync(outFile, outCode)
        fs.chmodSync(outFile, mode)
      } else {
        console.log(outCode)
      }
    }

    this._loadAdditionalModules()

    try {
      const stats = fs.lstatSync(input)
      if (stats.isDirectory()) {
        inputDir = input

        const filesToInstrument = this.exclude.globSync(input)

        if (this.config.completeCopy && output) {
          const globOptions = { dot: true, nodir: true, ignore: ['**/.git', '**/.git/**', path.join(output, '**')] }
          glob.sync(path.resolve(input, '**'), globOptions)
            .forEach(src => cpFile.sync(src, path.join(output, path.relative(input, src))))
        }
        filesToInstrument.forEach(visitor)
      } else {
        visitor(input)
      }
    } catch (err) {
      return cb(err)
    }
    cb()
  }

  _transform (code, filename) {
    const extname = path.extname(filename).toLowerCase()
    const transform = this.transforms[extname] || (() => null)

    return transform(code, { filename })
  }

  _maybeInstrumentSource (code, filename) {
    if (!this.exclude.shouldInstrument(filename)) {
      return null
    }

    return this._transform(code, filename)
  }

  maybePurgeSourceMapCache () {
    if (!this.cache) {
      this.sourceMaps.purgeCache()
    }
  }

  _transformFactory (cacheDir) {
    const instrumenter = this.instrumenter()
    let instrumented

    return (code, metadata, hash) => {
      const filename = metadata.filename
      let sourceMap = null

      if (this._sourceMap) sourceMap = this.sourceMaps.extractAndRegister(code, filename, hash)

      try {
        instrumented = instrumenter.instrumentSync(code, filename, sourceMap)
      } catch (e) {
        debugLog('failed to instrument ' + filename + ' with error: ' + e.stack)
        if (this.config.exitOnError) {
          console.error('Failed to instrument ' + filename)
          process.exit(1)
        } else {
          instrumented = code
        }
      }

      if (this.fakeRequire) {
        return 'function x () {}'
      } else {
        return instrumented
      }
    }
  }

  _handleJs (code, options) {
    // ensure the path has correct casing (see istanbuljs/nyc#269 and nodejs/node#6624)
    const filename = path.resolve(this.cwd, options.filename)
    return this._maybeInstrumentSource(code, filename) || code
  }

  _addHook (type) {
    const handleJs = this._handleJs.bind(this)
    const dummyMatcher = () => true // we do all processing in transformer
    libHook['hook' + type](dummyMatcher, handleJs, { extensions: this.extensions })
  }

  _addRequireHooks () {
    if (this.hookRequire) {
      this._addHook('Require')
    }
    if (this.hookRunInContext) {
      this._addHook('RunInContext')
    }
    if (this.hookRunInThisContext) {
      this._addHook('RunInThisContext')
    }
  }

  cleanup () {
    if (!process.env.NYC_CWD) rimraf.sync(this.tempDirectory())
  }

  clearCache () {
    if (this.cache) {
      rimraf.sync(this.cacheDirectory)
    }
  }

  createTempDirectory () {
    mkdirp.sync(this.tempDirectory())
    if (this.cache) mkdirp.sync(this.cacheDirectory)

    mkdirp.sync(this.processInfo.directory)
  }

  reset () {
    this.cleanup()
    this.createTempDirectory()
  }

  _wrapExit () {
    selfCoverageHelper.registered = true

    // we always want to write coverage
    // regardless of how the process exits.
    onExit(
      () => {
        this.writeCoverageFile()
        selfCoverageHelper.onExit()
      },
      { alwaysLast: true }
    )
  }

  wrap (bin) {
    process.env.NYC_PROCESS_ID = this.processInfo.uuid
    this._addRequireHooks()
    this._wrapExit()
    this._loadAdditionalModules()
    return this
  }

  writeCoverageFile () {
    var coverage = coverageFinder()
    if (!coverage) return

    // Remove any files that should be excluded but snuck into the coverage
    Object.keys(coverage).forEach(function (absFile) {
      if (!this.exclude.shouldInstrument(absFile)) {
        delete coverage[absFile]
      }
    }, this)

    if (this.cache) {
      Object.keys(coverage).forEach(function (absFile) {
        if (this.hashCache[absFile] && coverage[absFile]) {
          coverage[absFile].contentHash = this.hashCache[absFile]
        }
      }, this)
    } else {
      coverage = this.sourceMaps.remapCoverage(coverage)
    }

    var id = this.processInfo.uuid
    var coverageFilename = path.resolve(this.tempDirectory(), id + '.json')

    fs.writeFileSync(
      coverageFilename,
      JSON.stringify(coverage),
      'utf-8'
    )

    this.processInfo.coverageFilename = coverageFilename
    this.processInfo.files = Object.keys(coverage)
    this.processInfo.save()
  }

  getCoverageMapFromAllCoverageFiles (baseDirectory) {
    const map = libCoverage.createCoverageMap({})

    this.eachReport(undefined, (report) => {
      map.merge(report)
    }, baseDirectory)

    map.data = this.sourceMaps.remapCoverage(map.data)

    // depending on whether source-code is pre-instrumented
    // or instrumented using a JIT plugin like @babel/require
    // you may opt to exclude files after applying
    // source-map remapping logic.
    if (this.config.excludeAfterRemap) {
      map.filter(filename => this.exclude.shouldInstrument(filename))
    }

    return map
  }

  report () {
    const context = libReport.createContext({
      dir: this.reportDirectory(),
      watermarks: this.config.watermarks,
      coverageMap: this.getCoverageMapFromAllCoverageFiles()
    })

    this.reporter.forEach((_reporter) => {
      reports.create(_reporter, {
        skipEmpty: this.config.skipEmpty,
        skipFull: this.config.skipFull,
        maxCols: process.stdout.columns || 100
      }).execute(context)
    })

    if (this._showProcessTree) {
      this.showProcessTree()
    }
  }

  writeProcessIndex () {
    const db = new ProcessDB(this.processInfo.directory)
    db.writeIndex()
  }

  showProcessTree () {
    const db = new ProcessDB(this.processInfo.directory)
    console.log(db.renderTree(this))
  }

  checkCoverage (thresholds, perFile) {
    var map = this.getCoverageMapFromAllCoverageFiles()
    var nyc = this

    if (perFile) {
      map.files().forEach(function (file) {
        // ERROR: Coverage for lines (90.12%) does not meet threshold (120%) for index.js
        nyc._checkCoverage(map.fileCoverageFor(file).toSummary(), thresholds, file)
      })
    } else {
      // ERROR: Coverage for lines (90.12%) does not meet global threshold (120%)
      nyc._checkCoverage(map.getCoverageSummary(), thresholds)
    }
  }

  _checkCoverage (summary, thresholds, file) {
    Object.keys(thresholds).forEach(function (key) {
      var coverage = summary[key].pct
      if (coverage < thresholds[key]) {
        process.exitCode = 1
        if (file) {
          console.error('ERROR: Coverage for ' + key + ' (' + coverage + '%) does not meet threshold (' + thresholds[key] + '%) for ' + file)
        } else {
          console.error('ERROR: Coverage for ' + key + ' (' + coverage + '%) does not meet global threshold (' + thresholds[key] + '%)')
        }
      }
    })
  }

  eachReport (filenames, iterator, baseDirectory) {
    baseDirectory = baseDirectory || this.tempDirectory()

    if (typeof filenames === 'function') {
      iterator = filenames
      filenames = undefined
    }

    var _this = this
    var files = filenames || fs.readdirSync(baseDirectory)

    files.forEach(function (f) {
      var report
      try {
        report = JSON.parse(fs.readFileSync(
          path.resolve(baseDirectory, f),
          'utf-8'
        ))

        _this.sourceMaps.reloadCachedSourceMaps(report)
      } catch (e) { // handle corrupt JSON output.
        report = {}
      }

      iterator(report)
    })
  }

  loadReports (filenames) {
    var reports = []

    this.eachReport(filenames, (report) => {
      reports.push(report)
    })

    return reports
  }

  tempDirectory () {
    return path.resolve(this.cwd, this._tempDirectory)
  }

  reportDirectory () {
    return path.resolve(this.cwd, this._reportDir)
  }
}

module.exports = NYC
