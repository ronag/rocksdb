import path from 'node:path'

type NativeBinding = Record<string, (...args: any[]) => any>

const nodeGypBuild = require('node-gyp-build') as (directory: string) => NativeBinding

export = nodeGypBuild(path.join(__dirname, '..'))
