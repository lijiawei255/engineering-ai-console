/**
 * 浏览器端自检运行器：构建 tests/.browser 静态页面，用临时 HTTP 服务托管，
 * 在无头 Edge/Chromium 中加载真实页面与真实 IndexedDB，页面完成后把结果 POST 回来。
 *
 * 必须走 http(s) 同源而不是 file://：IndexedDB 在 file:// 下不可靠，
 * 桌面自检要覆盖的原子清库 / 导入回滚 / 会话切换都依赖真实数据库。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBrowser } from './build.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const browserDir = path.join(root, 'tests/.browser')
const distDir = path.join(root, 'dist')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

/** 构建后应用的冒烟接口：让 dist 页面能真实启动而不依赖 Python 服务 */
const APP_HEALTH = {
  ok: true,
  service: 'engineering-ai-console',
  version: '0.1.0',
  bind: '127.0.0.1',
  port: 0,
  storage: { settings: 'ok', secrets: 'ok', recovered: false, degraded: false },
}

const APP_CONFIG = {
  settings: { version: 1 },
  secrets: {
    primary: { hasKey: false, mask: '' },
    backup: { hasKey: false, mask: '' },
    exa: { hasKey: false, mask: '' },
    customHeaders: { primary: [], backup: [] },
  },
  storage: { settings: 'ok', secrets: 'ok', recovered: false, degraded: false },
}

const ERROR_HOOK = `window.__appErrors = [];
addEventListener('error', function (event) { window.__appErrors.push(String(event.message || 'error')); });
addEventListener('unhandledrejection', function (event) { window.__appErrors.push(String(event.reason)); });`

const browserCandidates = () => {
  const candidates = []
  if (process.env.EDGE_PATH) {
    candidates.push(process.env.EDGE_PATH)
  }
  if (process.env.CHROME_PATH) {
    candidates.push(process.env.CHROME_PATH)
  }
  if (process.platform === 'win32') {
    // 用系统环境变量推导安装路径，仓库中不出现任何硬编码盘符路径
    for (const variable of ['ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA']) {
      const base = process.env[variable]
      if (!base) {
        continue
      }
      candidates.push(
        path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')
      )
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    )
  } else {
    candidates.push(
      '/usr/bin/microsoft-edge',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser'
    )
  }
  return candidates.filter((candidate) => {
    try {
      return fs.statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

const serve = () =>
  new Promise((resolve, reject) => {
    let resultText = null
    let finish = null
    const sendJson = (response, payload) => {
      const body = JSON.stringify(payload)
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      response.end(body)
    }
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'POST' && url.pathname === '/result') {
        const chunks = []
        request.on('data', (chunk) => chunks.push(chunk))
        request.on('end', () => {
          resultText = Buffer.concat(chunks).toString('utf8')
          response.writeHead(204)
          response.end()
          finish?.()
        })
        return
      }
      // 构建后应用（dist）的启动冒烟：只提供最小可用的健康与配置快照
      if (url.pathname === '/api/health' || url.pathname === '/api/config') {
        sendJson(response, url.pathname === '/api/health' ? APP_HEALTH : APP_CONFIG)
        return
      }
      if (url.pathname === '/smoke-error-hook.js') {
        response.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        response.end(ERROR_HOOK)
        return
      }
      let baseDir = browserDir
      let requested = url.pathname === '/' ? '/index.html' : url.pathname
      if (requested === '/app' || requested.startsWith('/app/')) {
        baseDir = distDir
        requested = requested.slice('/app'.length) || '/index.html'
        if (requested === '/') {
          requested = '/index.html'
        }
      }
      const resolved = path.resolve(baseDir, `.${requested}`)
      if (!resolved.startsWith(baseDir + path.sep) || !fs.existsSync(resolved)) {
        response.writeHead(404, { 'Content-Type': 'text/plain' })
        response.end('not found')
        return
      }
      let body = fs.readFileSync(resolved)
      if (requested === '/index.html' && baseDir === distDir) {
        const html = body.toString('utf8')
        const injected =
          '<meta name="console-session-token" content="browser-smoke-token">' +
          '<script src="/smoke-error-hook.js"></script>'
        body = Buffer.from(
          html.includes('<head>') ? html.replace('<head>', `<head>${injected}`) : injected + html,
          'utf8'
        )
      }
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(resolved)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      })
      response.end(body)
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        url: `http://127.0.0.1:${port}/`,
        waitForResult: (timeoutMs) =>
          new Promise((resolveResult, rejectResult) => {
            if (resultText !== null) {
              resolveResult(resultText)
              return
            }
            const timer = setTimeout(() => {
              finish = null
              rejectResult(new Error('browser selftest timed out waiting for the page result'))
            }, timeoutMs)
            finish = () => {
              clearTimeout(timer)
              finish = null
              resolveResult(resultText ?? '')
            }
          }),
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })

const waitForExit = (child, timeoutMs = 5_000) =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })

const killBrowser = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  if (process.platform === 'win32') {
    // Edge/Chromium 会拉起子进程；taskkill /T 一并结束，避免临时 profile 被占用
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    await waitForExit(killer, 5_000)
  } else {
    child.kill('SIGKILL')
  }
  await waitForExit(child, 5_000)
}

const removeProfile = async (profile) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

const main = async () => {
  await buildBrowser()
  const browsers = browserCandidates()
  if (browsers.length === 0) {
    console.error(
      'No headless browser found. Set EDGE_PATH or CHROME_PATH to an Edge/Chromium executable.'
    )
    process.exit(1)
  }
  const site = await serve()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-selftest-'))
  const browser = browsers[0]
  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      `--user-data-dir=${profile}`,
      site.url,
    ],
    { stdio: 'ignore', windowsHide: true }
  )

  let resultText = ''
  try {
    resultText = await site.waitForResult(120_000)
  } catch (error) {
    console.error(String(error))
  } finally {
    await killBrowser(child)
    await removeProfile(profile)
    await site.close()
  }

  fs.writeFileSync(path.join(browserDir, 'dom.txt'), resultText, 'utf8')
  const failLines = resultText
    .split(/\r?\n/)
    .filter((line) => line.includes('FAIL:') || line.includes('SELFTEST FAILED'))
  if (resultText.includes('SELFTEST OK') && failLines.length === 0) {
    console.log('browser selftest: OK')
    const okCount = (resultText.match(/\bok - /g) ?? []).length
    console.log(`browser selftest assertions passed: ${okCount}`)
    return
  }
  console.error('browser selftest FAILED')
  for (const line of failLines.slice(0, 40)) {
    console.error(line.trim())
  }
  console.error('page result dump: tests/.browser/dom.txt')
  process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
