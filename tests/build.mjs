/**
 * 自检打包器：用项目自身的 @rspack/core JS API 生成两个 Node / 浏览器测试产物。
 * 不依赖 pnpm、npx 或全局二进制，跨平台可用。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rspack } from '@rspack/core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const common = {
  mode: 'production',
  devtool: false,
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
  module: {
    // CSS Modules 必须走默认导出对象（namedExports:false），与生产构建保持一致
    parser: { 'css/module': { namedExports: false } },
    rules: [
      // 浏览器自检直接渲染真实设置组件，需要把 CSS Modules 与普通 CSS 一并处理
      { test: /\.module\.css$/, type: 'css/module' },
      { test: /\.css$/, exclude: /\.module\.css$/, type: 'css' },
      {
        test: /\.(j|t)sx?$/,
        exclude: /[\\/]node_modules[\\/]/,
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic' } },
          },
        },
      },
    ],
  },
  optimization: { minimize: false },
  performance: { hints: false },
}

export const logicConfig = {
  ...common,
  name: 'logic',
  target: 'node',
  entry: path.join(root, 'tests/logic.selftest.ts'),
  output: {
    path: path.join(root, 'tests/.selftest'),
    filename: 'logic.js',
    clean: true,
    publicPath: '',
    chunkFormat: 'commonjs',
  },
}

export const browserConfig = {
  ...common,
  name: 'browser',
  target: 'web',
  entry: path.join(root, 'tests/browser.selftest.ts'),
  output: {
    path: path.join(root, 'tests/.browser'),
    filename: 'selftest.js',
    clean: true,
    publicPath: '',
  },
  plugins: [
    new rspack.HtmlRspackPlugin({
      template: path.join(root, 'tests/browser.selftest.html'),
      scriptLoading: 'defer',
    }),
  ],
}

export const build = (config) =>
  new Promise((resolve, reject) => {
    rspack(config, (error, stats) => {
      if (error) {
        reject(error)
        return
      }
      if (stats?.hasErrors()) {
        reject(new Error(stats.toString({ colors: false, all: false, errors: true })))
        return
      }
      resolve(stats)
    })
  })

export const buildLogic = () => build(logicConfig)
export const buildBrowser = () => build(browserConfig)

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const which = process.argv[2]
  const task = which === 'browser' ? buildBrowser : which === 'logic' ? buildLogic : null
  if (!task) {
    console.error('usage: node tests/build.mjs <logic|browser>')
    process.exit(2)
  }
  task()
    .then(() => console.log('selftest bundle built'))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}
