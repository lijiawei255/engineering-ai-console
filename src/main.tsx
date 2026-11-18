import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupFontScale, setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import { initConfig } from './services/config/store.js'
import { readPageLifecycleToken, startLifecycleTracking } from './services/config/lifecycle.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()
setupFontScale()

// 服务端模式（HTML 由本地服务注入进程令牌）才上报标签页生命周期；纯静态直连没有本地
// 服务可退出，file:// 下也不该发无关请求。令牌必须直接读首屏 meta：initConfig() 之前
// 状态仓库里还是空串，读仓库会让心跳永远不启动，真实页面在 --auto-exit 下 60 秒后
// 被误判成无页面而退出。服务端未开 --auto-exit 时会忽略这些事件。
const lifecycleToken = readPageLifecycleToken()
if (lifecycleToken) {
  startLifecycleTracking({ token: lifecycleToken })
}

void initConfig()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
