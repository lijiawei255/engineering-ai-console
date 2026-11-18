/**
 * 全量自检编排：逻辑自检 → 浏览器 Office 提取自检 → server.py 实测 → 隐私红线扫描。
 * 任一项失败即整体失败；成功时打印统一汇总。
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const steps = [
  { name: 'logic selftest', command: process.execPath, args: ['tests/run-logic-selftest.mjs'] },
  { name: 'browser document selftest', command: process.execPath, args: ['tests/run-browser-selftest.mjs'] },
  { name: 'server.py selftest', command: 'python', args: ['tests/server_selftest.py'] },
  { name: 'privacy scan', command: process.execPath, args: ['tests/privacy-scan.mjs'] },
]

const results = []
for (const step of steps) {
  console.log(`\n=== ${step.name} ===`)
  const result = spawnSync(step.command, step.args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  })
  const status = result.status ?? 1
  results.push({ name: step.name, status })
  if (status !== 0) {
    console.error(`\nstep failed: ${step.name} (exit ${status})`)
  }
}

console.log('\n=== SELFTEST SUMMARY ===')
for (const item of results) {
  console.log(`${item.status === 0 ? 'PASS' : 'FAIL'}  ${item.name}`)
}
const failed = results.filter((item) => item.status !== 0)
process.exit(failed.length === 0 ? 0 : 1)
