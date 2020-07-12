const rubico = require('rubico')
const trace = require('rubico/x/trace')
const execa = require('execa')
const nodePath = require('path')
const fs = require('fs')
const cratosPackageJSON = require('./package.json')

const {
  pipe, fork, assign,
  tap, tryCatch, switchCase,
  map, filter, reduce, transform, flatMap,
  any, all, and, or, not,
  eq, gt, lt, gte, lte,
  get, pick, omit,
} = rubico

const identity = x => x

const pathResolve = nodePath.resolve

const isDefined = x => typeof x !== 'undefined' && x !== null

const last = arr => get(arr.length - 1)(arr)

const slice = (from, to) => arr => arr.slice(
  from,
  typeof to === 'undefined' ? undefined : to === -1 ? arr.length - 1 : to,
)

const log = (...args) => x => tap(() => console.log(
  ...args.map(arg => typeof arg === 'function' ? arg(x) : arg),
))(x)

const includes = value => arr => arr.includes(value)

const isEmpty = x => x.length === 0

const split = delim => s => s.split(delim)

const USAGE = `
usage: cratos [--version] [-v] [--help] [-h] [--path=<path>] <command> [<args>]

commands:

    list, ls                      list cratos modules

    branch, b                     get branch for cratos modules

    s[tatus]                      get status for cratos modules

    ch[eckout] <branch>           checkout branch for relevant cratos modules

    fetch                         fetch remotes for cratos modules

    merge                         merge remote into current branch for cratos modules

    pull                          fetch+merge remote into current branch for cratos modules

    push                          push current branch to remote for cratos modules

    dist <major|minor|patch>      version bump && publish cratos modules, skip unchanged modules

    clean                         remove ignored and untracked files for cratos modules

    i[nstall]                     install cratos module dependencies into local node_modules

    i[nstall] --save, -s <mod>    install and save mod into cratos module dependencies modify package.json

    link, ln                      symlink cratos modules into all other cratos modules\' local node_modules
`.trimStart()
//     test <path|module>            run module tests defined by test script or mocha at module root
//     run <script> <path|module>    run module script

const FLAGS = new Set([
  '-h', '--help',
  '-n', '--dry-run',
  '-v', '--version',
  '--path',
])

// string => boolean
const isFlag = s => FLAGS.has(s.split('=')[0])

// string => string => boolean
const startsWith = prefix => s => s.startsWith(prefix)

/* argv [string] => parsedArgv {
 *   arguments: [string],
 *   flags: [string],
 * }
 */
const parseArgv = argv => fork({
  arguments: pipe([
    filter(and([
      not(startsWith('-')),
      not(isFlag),
    ])),
    slice(2), // node ./cli.js ...
  ]),
  flags: filter(isFlag),
})(argv)

const hasEnvVar = name => () => !!process.env[name]

const getEnvVar = name => () => process.env[name]

// Directory {
//   path: string,
//   dirents: [NodeDirent],
// } => boolean
const isCratosModule = ({ dirents }) => pipe([
  map(get('name')),
  and([
    includes('.git'),
    includes('package.json'),
  ]),
])(dirents)

const IGNORE_DIRS = new Set(['.git', 'node_modules'])

// NodeDirent => boolean
const isIgnoreDir = dirent => IGNORE_DIRS.has(dirent.name)

// path string => moduleNames [string]
const walkPathForModuleNames = pathArg => pipe([
  fork({
    path: identity,
    dirents: tryCatch(
      path => fs.promises.readdir(path, { withFileTypes: true }),
      () => [],
    ),
  }),
  switchCase([
    isCratosModule, ({ path }) => [path],
    ({ path, dirents }) => transform(pipe([
      filter(and([
        not(isIgnoreDir),
        dirent => dirent.isDirectory(),
      ])),
      flatMap(pipe([
        get('name'),
        dirName => pathResolve(path, dirName),
        walkPathForModuleNames,
      ])),
    ]), () => [])(dirents),
  ]),
])(pathArg)

// path string => packageJSON object
const getPackageJSON = pathArg => pipe([
  path => pathResolve(path, 'package.json'),
  fs.promises.readFile,
  JSON.parse,
])(pathArg)

// path string => gitStatus object
const getGitStatus = pathArg => pipe([
  tryCatch(
    path => execa('git', [
      `--git-dir=${pathResolve(path, '.git')}`,
      `--work-tree=${path}`,
      'status',
      '--porcelain',
      '--branch',
    ]),
    err => {
      throw new Error(err.stderr)
    },
  ),
  get('stdout'),
  stdout => stdout.split('\n'),
  fork({
    branch: get(0),
    files: slice(1),
  }),
])(pathArg)

/* path string => cratosModule {
 *   packageName: string,
 *   packageVersion: string,
 *   gitStatusBranch: [string],
 *   gitStatusFiles: [string],
 * }
 */
const getModuleInfo = pathArg => pipe([
  fork({
    path: identity,
    packageJSON: getPackageJSON,
    gitStatus: getGitStatus,
  }),
  fork({
    path: get('path'),
    packageName: get('packageJSON.name'),
    packageVersion: get('packageJSON.version'),
    gitStatusBranch: pipe([
      get('gitStatus.branch'),
      s => s.slice(3),
    ]),
    gitStatusFiles: get('gitStatus.files'),
  }),
])(pathArg)

const logWithLevel = level => (...args) => tap(x => console.log(
  level,
  ...args.map(arg => typeof arg === 'function' ? arg(x) : arg),
))

const logger = {
  warn: logWithLevel('[WARNING]'),
}

// parsedArgv {
//   arguments: [string],
// } => modulePaths [string]
const findModules = parsedArgv => pipe([
  switchCase([
    hasEnvVar('CRATOS_PATH'), getEnvVar('CRATOS_PATH'),
    hasEnvVar('HOME'), pipe([
      logger.warn('CRATOS_PATH not set; finding modules from HOME'),
      getEnvVar('HOME'),
    ]),
    () => {
      throw new Error('no entrypoint found; CRATOS_PATH or HOME environment variables required')
    },
  ]),
  maybeDelimitedPath => maybeDelimitedPath.split(':'),
  flatMap(pipe([
    pathResolve,
    walkPathForModuleNames,
    map(getModuleInfo),
  ])),
])(parsedArgv)

// () => ()
const commandList = () => pipe([
  findModules,
  map(pipe([
    fork([
      get('packageName'),
      get('packageVersion'),
    ]),
    fields => fields.join('-'),
    trace,
  ])),
])()

// () => ()
const commandStatus = () => pipe([
  findModules,
  map(pipe([
    ({ packageName, gitStatusFiles }) => map(pipe([
      file => [packageName, file].join(' '),
      trace,
    ]))(gitStatusFiles),
  ])),
])()

// () => ()
const commandBranch = () => pipe([
  findModules,
  map(pipe([
    fork([
      get('packageName'),
      get('gitStatusBranch'),
    ]),
    fields => fields.join(' '),
    trace,
  ])),
])()

// string => parsedArgv => boolean
const hasFlag = flag => ({ flags }) => flags.includes(flag)

// parsedArgv => boolean
const isBaseCommand = ({ arguments }) => arguments.length === 0

// string => parsedArgv => boolean
const isCommand = cmd => ({ arguments }) => arguments[0] === cmd

// parsedArgv => ()
const switchCommand = parsedArgv => switchCase([
  or([
    hasFlag('--version'),
    hasFlag('-v'),
  ]), log('v' + cratosPackageJSON.version),
  or([
    hasFlag('--help'),
    hasFlag('-h'),
    isBaseCommand,
  ]), log(USAGE),
  or([
    isCommand('list'),
    isCommand('ls'),
  ]), commandList,
  or([
    isCommand('status'),
    isCommand('s'),
  ]), commandStatus,
  or([
    isCommand('branch'),
    isCommand('b'),
  ]), commandBranch,
  log(x => `${x.arguments[0]} is not a cratos command\n${USAGE}`),
])(parsedArgv)

// argv [string] => ()
const cli = argv => pipe([
  parseArgv,
  switchCommand,
])(argv)

const cratos = {}

cratos.cli = cli
cratos.getUsage = () => USAGE + '\n'
cratos.parseArgv = parseArgv
cratos.walkPathForModuleNames = walkPathForModuleNames
cratos.getPackageJSON = getPackageJSON
cratos.getGitStatus = getGitStatus
cratos.getModuleInfo = getModuleInfo
cratos.findModules = findModules
cratos.switchCommand = switchCommand

module.exports = cratos
