/**
 * 控制台标签页生命周期（配合 server.py --auto-exit）。
 *
 * 服务端只有显式开启 --auto-exit 时才会按心跳表回收进程，所以这里可以无条件发送：
 * 常驻启动（自动化测试 / `python server.py --no-browser`）下 /api/lifecycle 只是一个
 * 200 空操作，不会缩短任何长期运行实例的寿命。
 *
 * 约定：
 * - 每个页面实例生成一个随机 tabId；
 * - 挂载时立即心跳一次，之后每 20 秒一次，页面重新可见时补一次；
 * - pagehide 用 keepalive fetch 通知 leave，刷新（F5）后新页面会在 1 秒内重新心跳，
 *   服务端 5 秒刷新缓冲因此不会误杀；
 * - 所有请求异常静默吞掉，绝不在关页瞬间产生未捕获的 Promise 拒绝。
 */

const HEARTBEAT_INTERVAL_MS = 20000
const TAB_ID_BYTES = 16

export const LIFECYCLE_HEARTBEAT_MS = HEARTBEAT_INTERVAL_MS

export type LifecycleAction = 'heartbeat' | 'leave'

/**
 * 从服务端注入的 `<meta name="console-session-token">` 直接读取本进程令牌。
 *
 * 不能在 `initConfig()` 之前读状态仓库里的 serverToken：那里初始值是空串，真实页面
 * 因此永远不启动心跳，`--auto-exit` 下 60 秒后会把仍在使用的页面当成无页面误退出。
 * meta 标签随首屏 HTML 一起到达，可以立即使用；`file://` 纯静态页面没有这个标签，
 * 所以“能读到非空令牌”同时就是“页面由本地服务托管”的判据。
 */
export const readPageLifecycleToken = (): string => {
  if (typeof document === 'undefined' || location.protocol === 'file:') {
    return ''
  }
  const meta = document.querySelector('meta[name="console-session-token"]')
  return meta?.getAttribute('content')?.trim() ?? ''
}

export interface LifecycleRequest {
  url: string
  init: RequestInit
}

/** 每个页面实例一个随机 tabId；crypto.randomUUID 不可用时退回随机十六进制。 */
export const createTabId = (): string => {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  const bytes = new Uint8Array(TAB_ID_BYTES)
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** 关页通知需要 keepalive，心跳则保持普通请求即可。 */
export const lifecycleRequest = (
  action: LifecycleAction,
  tabId: string,
  token: string
): LifecycleRequest => ({
  url: '/api/lifecycle',
  init: {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Console-Token': token },
    body: JSON.stringify({ action, tabId }),
    keepalive: action === 'leave',
    cache: 'no-store',
  },
})

/** 发送一次生命周期事件；任何网络异常都必须静默吞掉。 */
export const sendLifecycle = async (
  action: LifecycleAction,
  tabId: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> => {
  const request = lifecycleRequest(action, tabId, token)
  try {
    await fetchImpl(request.url, request.init)
  } catch {
    // 服务已退出或页面正在卸载：这里没有补救动作，也不能冒出未捕获拒绝
  }
}

export interface LifecycleTracker {
  tabId: string
  stop: () => void
}

export interface LifecycleOptions {
  token: string
  fetchImpl?: typeof fetch
  heartbeatMs?: number
}

/** 开始跟踪当前页面；返回的 stop() 会清掉定时器与事件监听（测试与硬复位复用）。 */
export const startLifecycleTracking = (options: LifecycleOptions): LifecycleTracker => {
  const tabId = createTabId()
  const fetchImpl = options.fetchImpl ?? fetch
  const heartbeatMs = Math.max(1000, options.heartbeatMs ?? LIFECYCLE_HEARTBEAT_MS)
  const beat = () => {
    void sendLifecycle('heartbeat', tabId, options.token, fetchImpl)
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      beat()
    }
  }
  const onPageHide = () => {
    void sendLifecycle('leave', tabId, options.token, fetchImpl)
  }
  const timer = setInterval(beat, heartbeatMs)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', onPageHide)
  beat()
  return {
    tabId,
    stop: () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
    },
  }
}
