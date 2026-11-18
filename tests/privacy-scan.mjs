/**
 * 全仓隐私与硬编码路径红线扫描。
 *
 * 扫描范围：git 跟踪文件 + dist/ 构建产物（跳过 node_modules、.git、.console_data、
 * 自检产物目录与二进制文件）。没有 git 元数据时（例如导出的纯源码压缩包）自动回退为
 * 递归遍历仓库根目录，扫描覆盖全部源码、脚本、文档、测试与产物。命中即退出码 1。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const username = os.userInfo().username || ''
const S = '/'

const patterns = [
  {
    name: 'Windows drive path',
    // 仅匹配形如盘符加反斜杠或正斜杠的绝对用户路径；排除 JavaScript 正则字面量误报
    re: /(?<![A-Za-z0-9"'`])[A-Za-z]:[\\/](?=[A-Za-z0-9_.~-])/,
  },
  {
    name: 'macOS user home path',
    re: new RegExp(`${S}Users${S}`),
  },
  {
    name: 'Linux user home path',
    re: new RegExp(`${S}home${S}`),
  },
  {
    name: 'upstream temp directory residue',
    re: new RegExp(`_upstream${'_chat_demo'}`),
    allowFiles: ['.gitignore'],
  },
  {
    name: 'upstream API host',
    re: new RegExp(`api${S === '/' ? '\\.' : ''}deepseek\\.com`),
  },
  {
    name: 'upstream platform host',
    re: new RegExp(`platform\\.deepseek\\.com`),
  },
  {
    name: 'OpenAI-style secret',
    re: new RegExp(`sk${'-'}[A-Za-z0-9_-]{20,}`),
  },
  {
    name: 'Anthropic-style secret',
    re: new RegExp(`sk${'-'}ant-`),
  },
  {
    name: 'AWS access key',
    re: /AKIA[0-9A-Z]{16}/,
  },
  {
    name: 'GitHub token',
    re: new RegExp(`gh${'p_'}[A-Za-z0-9]{20,}`),
  },
]

if (username.length >= 3) {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  patterns.push({
    name: 'current system username',
    re: new RegExp(`\\b${escaped}\\b`, 'i'),
    sourceOnly: true,
  })
}

const skipDirs = new Set([
  'node_modules',
  '.git',
  '.console_data',
  '.selftest',
  '.browser',
  '__pycache__',
])

const binaryExtensions = new Set([
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.zip',
  '.gz',
  '.pdf',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
])

const walk = (dir, output = []) => {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return output
  }
  for (const entry of entries) {
    if (skipDirs.has(entry.name)) {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, output)
    } else if (entry.isFile()) {
      output.push(full)
    }
  }
  return output
}

const tracked = (() => {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      // 无 git 仓库时预期 git 会打印 fatal 到 stderr：这里静默，改走下面的递归回退
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .filter(Boolean)
      .map((file) => path.join(root, file))
  } catch {
    // 没有 git 元数据（例如导出后的纯源码压缩包）：回退为递归遍历仓库根目录。
    // 遍历会按 skipDirs 排除 node_modules / .git / .console_data 与自检产物目录，
    // 覆盖源码、脚本、文档、测试与已提交的 dist/ 产物，扫描范围不缩水。
    return null
  }
})()

const allFiles = new Set(
  tracked === null ? walk(root) : [...tracked, ...walk(path.join(root, 'dist'))]
)
const textFiles = []
const mapFiles = []

for (const file of allFiles) {
  const relative = path.relative(root, file).split(path.sep).join('/')
  if (file.endsWith('.map')) {
    mapFiles.push(relative)
    continue
  }
  if (binaryExtensions.has(path.extname(file).toLowerCase())) {
    continue
  }
  let buffer
  try {
    buffer = fs.readFileSync(file)
  } catch {
    continue
  }
  if (buffer.subarray(0, 8192).includes(0)) {
    continue
  }
  textFiles.push({ relative, file, text: buffer.toString('utf8') })
}

const hits = []
for (const { relative, text } of textFiles) {
  if (relative.startsWith('tests/.selftest/') || relative.startsWith('tests/.browser/')) {
    continue
  }
  const isSource = /\.(ts|tsx|js|mjs|css|html|md|py|json|bat|sh|yml|yaml|toml|txt)$/.test(relative)
  const lines = text.split(/\r?\n/)
  for (const pattern of patterns) {
    if (pattern.sourceOnly && !isSource) {
      continue
    }
    if (pattern.allowFiles?.includes(relative)) {
      continue
    }
    for (let index = 0; index < lines.length; index++) {
      pattern.re.lastIndex = 0
      if (pattern.re.test(lines[index])) {
        hits.push({
          rule: pattern.name,
          file: relative,
          line: index + 1,
          sample: lines[index].trim().slice(0, 200),
        })
      }
    }
  }
}

console.log(`privacy scan: ${textFiles.length} text files, ${mapFiles.length} source maps`)
if (mapFiles.length > 0) {
  console.error(`FAIL: source maps must not be shipped: ${mapFiles.join(', ')}`)
  process.exit(1)
}
if (hits.length > 0) {
  console.error(`FAIL: ${hits.length} privacy red-line hit(s)`)
  for (const hit of hits.slice(0, 50)) {
    console.error(`  [${hit.rule}] ${hit.file}:${hit.line} :: ${hit.sample}`)
  }
  process.exit(1)
}
console.log('privacy scan: 0 hits (paths, usernames, residual upstream dir, vendor hosts, secrets, source maps)')
