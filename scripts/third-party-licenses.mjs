/**
 * 收集运行时依赖的第三方许可证原文，输出 dist/THIRD_PARTY_LICENSES.txt。
 *
 * 只处理 package.json 的运行时 dependencies 及其递归传递依赖；devDependencies 不进入产物。
 * 按 pnpm 的 node_modules 真实布局解析（每个虚拟包目录内自带依赖链接），不依赖任何第三方库。
 * 输出按包名排序、UTF-8、不含本机绝对路径；许可证原文原样保留，只补齐末尾换行。
 *
 * 除包级许可证外，还补录三类内容：
 * 1. 已知的内嵌声明（KaTeX 的 mhchem、Cytoscape 的 Thenable）；
 * 2. 被运行时依赖预打包进发布产物的上游子包（扫描 .map 的 sources，如 path-browserify），
 *    提取其版权与完整许可证正文，并在构建自检中验证零遗漏；
 * 3. 自动扫描运行时依赖源码与最终 JS 产物中的 Copyright (c) / @license 注释块，
 *    把未被包级许可证覆盖的署名一并收录，避免内嵌第三方代码的版权声明被漏掉。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')
const outputFile = path.join(distDir, 'THIRD_PARTY_LICENSES.txt')

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const isDirectory = (target) => {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * 按 Node 的解析顺序从 fromDir 向上查找 node_modules/<name>。
 * 祖先目录本身叫 node_modules 时，候选路径直接是 <祖先>/<name>，与 Node 的 NODE_MODULES_PATHS 一致。
 */
const findPackageDir = (name, fromDir) => {
  const segments = name.split('/')
  let dir = fromDir
  for (;;) {
    const base =
      path.basename(dir) === 'node_modules'
        ? path.join(dir, ...segments)
        : path.join(dir, 'node_modules', ...segments)
    if (isDirectory(base)) {
      return fs.realpathSync(base)
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      return null
    }
    dir = parent
  }
}

const licenseFileNameOrder = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'COPYING',
  'COPYING.md',
  'COPYING.txt',
  'LICENSE-MIT',
  'LICENSE-APACHE',
]

/** 列出包里所有许可证类文件，先按约定文件名排序，再按字母序补足其余（如 LICENSE-MIT、COPYING.LESSER）。 */
const findLicenseFiles = (packageDir) => {
  let entries
  try {
    entries = fs.readdirSync(packageDir, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && /^(LICEN[SC]E|COPYING)/i.test(entry.name))
    .map((entry) => entry.name)
  const rank = (name) => {
    const upper = name.toUpperCase()
    const index = licenseFileNameOrder.findIndex((item) => item === upper)
    return index === -1 ? licenseFileNameOrder.length : index
  }
  return candidates.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

const normalizeLicenseText = (text) => {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return withoutBom
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\s+$/, '')
}

const README_CANDIDATES = [
  'README.md',
  'readme.md',
  'Readme.md',
  'README.markdown',
  'README.txt',
  'README',
]

/** 去掉 Markdown 链接语法，只保留可读文本（"[MIT][license] © [Titus Wormer][author]" → "MIT © Titus Wormer"） */
const stripMarkdownLinks = (text) =>
  text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const authorName = (manifest) => {
  const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name
  if (typeof author !== 'string' || !author.trim()) {
    return ''
  }
  return author
    .replace(/\s*<[^>]*>/g, '')
    .replace(/\s*\([^)]*\)/g, '')
    .trim()
}

/**
 * 部分子包（如 micromark-* 系列）只发 `license: "MIT"`，既不带 LICENSE 文件，也不在
 * package.json 之外给出任何署名。它们的 README 末尾通常有一段 `## License`：
 *
 *     [MIT][license] © [Titus Wormer][author]
 *
 * 这里提取该行（没有 License 章节时退回扫描带 © / Copyright 的许可证行）并去掉
 * Markdown 链接，得到 "MIT © Titus Wormer" 之类的自洽声明。返回 null 表示 README
 * 里也没有可用的署名信息，调用方仍会使用 package.json 的 author 字段兜底。
 */
const readReadmeAttribution = (packageDir) => {
  for (const fileName of README_CANDIDATES) {
    let text
    try {
      text = fs.readFileSync(path.join(packageDir, fileName), 'utf8')
    } catch {
      continue
    }
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    let sourceLine = ''
    for (let index = 0; index < lines.length && !sourceLine; index++) {
      if (!/^#{1,6}\s*licen[cs]e\b/i.test(lines[index].trim())) {
        continue
      }
      for (let next = index + 1; next < lines.length; next++) {
        const candidate = lines[next].trim()
        if (!candidate) {
          continue
        }
        // 许可证章节里的第一段有效正文就是署名；遇到下一个标题 / 注释即结束
        if (/^#{1,6}\s+/.test(candidate) || /^<!--/.test(candidate)) {
          break
        }
        sourceLine = candidate
        break
      }
    }
    if (!sourceLine) {
      sourceLine = lines.find(
        (line) => /©|copyright/i.test(line) && /licen[cs]e|mit|apache|isc|bsd/i.test(line)
      )?.trim() ?? ''
    }
    const attribution = stripMarkdownLinks(sourceLine).replace(/^[-*+]\s+/, '').trim()
    if (attribution) {
      return { fileName, attribution }
    }
  }
  return null
}

/** 读取一个已安装包的身份与许可证信息；读不到版本号说明 node_modules 布局异常，直接报错。 */
const collectPackage = (name, packageDir) => {
  const manifest = readJson(path.join(packageDir, 'package.json'))
  if (!manifest || typeof manifest.version !== 'string') {
    throw new Error(`cannot read package.json for installed package "${name}" at ${packageDir}`)
  }
  const licenseFiles = []
  for (const fileName of findLicenseFiles(packageDir)) {
    const text = normalizeLicenseText(fs.readFileSync(path.join(packageDir, fileName), 'utf8'))
    if (text) {
      licenseFiles.push({ fileName, text })
    }
  }
  let declaredLicense = ''
  if (typeof manifest.license === 'string') {
    declaredLicense = manifest.license.trim()
  } else if (manifest.license && typeof manifest.license.type === 'string') {
    declaredLicense = manifest.license.type.trim()
  } else if (Array.isArray(manifest.licenses)) {
    declaredLicense = manifest.licenses
      .map((entry) => (typeof entry === 'string' ? entry : entry?.type))
      .filter((value) => typeof value === 'string' && value.trim())
      .join(', ')
  }
  const dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  const optionalDependencies =
    manifest.optionalDependencies && typeof manifest.optionalDependencies === 'object'
      ? manifest.optionalDependencies
      : {}
  // 没有独立许可证文件的子包：从 README 提取署名，并用 package.json 的 author 兜底，
  // 让该条目自身即可完整说明许可证与版权归属，无需跨条目翻找。
  const readme = licenseFiles.length === 0 ? readReadmeAttribution(packageDir) : null
  return {
    name: typeof manifest.name === 'string' && manifest.name ? manifest.name : name,
    version: manifest.version,
    packageDir,
    licenseFiles,
    declaredLicense,
    readmeAttribution: readme?.attribution ?? '',
    readmeFileName: readme?.fileName ?? '',
    copyrightHolder: authorName(manifest),
    dependencies,
    optionalDependencies,
  }
}

const addDependency = (requestedName, fromDir, optional, queue, errors) => {
  const packageDir = findPackageDir(requestedName, fromDir)
  if (!packageDir) {
    if (optional) {
      return
    }
    errors.push(`missing installed dependency "${requestedName}"`)
    return
  }
  queue.push({ requestedName, packageDir })
}

const walkDependencies = () => {
  const rootManifest = readJson(path.join(root, 'package.json'))
  if (!rootManifest || typeof rootManifest.dependencies !== 'object' || rootManifest.dependencies === null) {
    throw new Error('package.json does not declare runtime dependencies')
  }
  const packages = new Map()
  const visitedDirs = new Set()
  const queue = []
  const errors = []
  for (const name of Object.keys(rootManifest.dependencies)) {
    addDependency(name, root, false, queue, errors)
  }
  while (queue.length > 0) {
    const { requestedName, packageDir } = queue.pop()
    if (visitedDirs.has(packageDir)) {
      continue
    }
    visitedDirs.add(packageDir)
    const record = collectPackage(requestedName, packageDir)
    const key = `${record.name}@${record.version}`
    if (!packages.has(key)) {
      packages.set(key, record)
    }
    for (const name of Object.keys(record.dependencies)) {
      addDependency(name, packageDir, false, queue, errors)
    }
    for (const name of Object.keys(record.optionalDependencies)) {
      addDependency(name, packageDir, true, queue, errors)
    }
  }
  if (errors.length > 0) {
    throw new Error(`incomplete dependency tree:\n  ${errors.join('\n  ')}`)
  }
  return [...packages.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0
  )
}

const section = (title) => {
  const bar = '='.repeat(78)
  return `${bar}\n${title}\n${bar}`
}

/**
 * KaTeX 的 mhchem 扩展不是独立 npm 包，但打包进了产物：其中嵌着从 MathJax 移植的
 * mhchem 代码，版权归 MathJax Consortium 与 Martin Hensel，遵循 Apache-2.0。
 * 许可证文件本身（katex/LICENSE，MIT）覆盖不到这段声明，这里按源码原文补录一次。
 */
const MH_CHEM_SOURCES = [
  ['dist', 'contrib', 'mhchem.mjs'],
  ['contrib', 'mhchem', 'mhchem.js'],
]

const readMhChemNotice = () => {
  const katexDir = findPackageDir('katex', root)
  if (!katexDir) {
    throw new Error('missing installed package "katex"')
  }
  for (const segments of MH_CHEM_SOURCES) {
    let text
    try {
      text = fs.readFileSync(path.join(katexDir, ...segments), 'utf8')
    } catch {
      continue
    }
    const marker = 'MathJax/extensions/TeX/mhchem.js'
    const markerIndex = text.indexOf(marker)
    if (markerIndex < 0) {
      continue
    }
    // 声明位于文件头部的一整段注释块内：从该块起始的 /* 截到第一个 */ 收尾
    const blockStart = text.lastIndexOf('/*', markerIndex)
    const blockEnd = text.indexOf('*/', markerIndex)
    if (blockStart < 0 || blockEnd < 0) {
      continue
    }
    const notice = normalizeLicenseText(text.slice(blockStart, blockEnd + 2))
    if (notice) {
      return { source: segments.join('/'), notice }
    }
  }
  throw new Error('cannot locate the bundled mhchem license notice in the installed katex package')
}

/**
 * Cytoscape 把 Thenable/1.0.7 的轻量 Promise 实现直接复制进 src/promise.mjs，
 * 随后被打进生产 chunk。Cytoscape 的 MIT 许可证文件只覆盖它自己的版权，
 * 因此这里按源码头部的声明补录 Ralf S. Engelschall 的独立版权与完整 MIT 正文。
 */
const THENABLE_SOURCE = ['src', 'promise.mjs']
const THENABLE_MARKER = 'Thenable/1.0.7'
const THENABLE_COPYRIGHT =
  'Copyright (c) 2013-2014 Ralf S. Engelschall <http://engelschall.com>'

const MIT_LICENSE_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

/**
 * SIL Open Font License 1.1 官方英文全文。
 *
 * KaTeX 字体文件按 OFL 1.1 分发，但安装包里只有一行 “Licensed under the SIL Open Font
 * License, Version 1.1.” 的索引，没有许可证正文；产物要能纯离线阅读，就必须把标准
 * 正文原样附在声明段内。正文与 SIL 发布的官方 OFL.txt（openfontlicense.org）逐字一致，
 * 不做改写、不翻译。
 */
const SIL_OFL_1_1_TEXT = `-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.`

/**
 * KaTeX 字体文件元数据：TTF 的 name 表记录的是 "Copyright (c) 2014-2018 Khan Academy"，
 * 与上面从 src/stretchy.js 提取的 SVG 字形路径数据声明（2014-2017）不是同一条记录。
 * 两组年份容易混淆，构建时从安装包字体文件里按 trueType name 表的 UTF-16BE 字节校验一次，
 * 避免声明里的年份与实际字体元数据脱节。
 */
const KATEX_FONT_FILE = ['dist', 'fonts', 'KaTeX_Main-Regular.ttf']
const KATEX_FONT_COPYRIGHT = 'Copyright (c) 2014-2018 Khan Academy'

const readKatexFontMetadata = () => {
  const katexDir = findPackageDir('katex', root)
  if (!katexDir) {
    throw new Error('missing installed package "katex"')
  }
  const fontPath = path.join(katexDir, ...KATEX_FONT_FILE)
  let buffer
  try {
    buffer = fs.readFileSync(fontPath)
  } catch {
    throw new Error(`cannot read the installed KaTeX font file ${KATEX_FONT_FILE.join('/')}`)
  }
  const encoded = Buffer.from(KATEX_FONT_COPYRIGHT, 'utf16le')
  encoded.swap16()
  if (!buffer.includes(encoded)) {
    throw new Error(
      `the installed KaTeX font metadata no longer carries "${KATEX_FONT_COPYRIGHT}"`
    )
  }
  return { source: `katex/${KATEX_FONT_FILE.join('/')}`, copyright: KATEX_FONT_COPYRIGHT }
}

/**
 * 内嵌算法 / 事件代码的上游来源索引。这两段代码不是独立 npm 包，却随运行时依赖一起
 * 打进产物，包级许可证文件只覆盖宿主包的版权，所以在这里静态记录来源，并在构建时
 * 校验安装包内仍保留对应的来源声明，避免将来换包后索引变成空话：
 * - layout-base 的 SVD 例程（含 hypot 辅助函数）改编自 JamaJS，后者是 NIST JAMA
 *   公有领域线性代数库的 JavaScript 移植；随源码附带的正文为 Apache License 2.0。
 * - cytoscape 的事件对象改编自 jQuery 事件机制；jQuery 由 OpenJS Foundation 维护，MIT。
 */
const EMBEDDED_SOURCE_INDEX = [
  {
    package: 'layout-base',
    source: 'src/util/SVD.js',
    marker: 'dragonfly-ai/JamaJS',
    summary:
      'the singular value decomposition routine, including its hypot helper, is adapted ' +
      'from JamaJS (https://github.com/dragonfly-ai/JamaJS), a JavaScript port of the NIST ' +
      'JAMA public-domain linear algebra library; the adopted source ships the Apache ' +
      'License 2.0 text',
  },
  {
    package: 'cytoscape',
    source: 'src/event.mjs',
    marker: 'Event object based on jQuery events',
    summary:
      'the event object is based on jQuery events; jQuery is maintained by the OpenJS ' +
      'Foundation and distributed under the MIT license',
  },
]

const readEmbeddedSourceIndex = (packages) => {
  const rows = []
  for (const item of EMBEDDED_SOURCE_INDEX) {
    const record = packages
      .filter((candidate) => candidate.name === item.package)
      .find((candidate) => {
        try {
          return fs
            .readFileSync(path.join(candidate.packageDir, ...item.source.split('/')), 'utf8')
            .includes(item.marker)
        } catch {
          return false
        }
      })
    if (!record) {
      throw new Error(
        `the installed "${item.package}" package no longer exposes ${item.source} with the expected provenance marker`
      )
    }
    rows.push(`${record.name}@${record.version} (${item.source}): ${item.summary}.`)
  }
  return rows
}

const readThenableNotice = (packages) => {
  // 转递依赖由 pnpm 放在各自的虚拟包目录下，必须从已解析的依赖树里取真实安装路径
  const record = packages.find((item) => item.name === 'cytoscape')
  if (!record) {
    throw new Error('missing installed package "cytoscape"')
  }
  const sourcePath = path.join(record.packageDir, ...THENABLE_SOURCE)
  let text
  try {
    text = fs.readFileSync(sourcePath, 'utf8')
  } catch {
    throw new Error('cannot read the embedded Thenable source in the installed cytoscape package')
  }
  if (!text.includes(THENABLE_MARKER) || !text.includes('Ralf S. Engelschall')) {
    throw new Error('the installed cytoscape package no longer contains the expected Thenable notice')
  }
  const headerMatch = text.match(/^\/\*![\s\S]*?\*\//)
  return {
    source: `cytoscape/${THENABLE_SOURCE.join('/')}`,
    header: headerMatch ? normalizeLicenseText(headerMatch[0]) : THENABLE_COPYRIGHT,
  }
}

/**
 * KaTeX 内嵌 SVG 几何字形数据不是独立 npm 包，却被打进产物：src/stretchy.js 的拉伸箭头 /
 * 括号 SVG path 数据改编自 KaTeX 字体，源码用行注释保留了 Khan Academy 与 MathJax
 * (Design Science) 的版权与 SIL OFL 1.1 声明。katex 的 MIT 许可证文件覆盖不到这段，
 * 这里按源码原文补录，保证 KaTeX SVG 字形数据的上游归属可追溯。
 */
const KATEX_GLYPH_SOURCES = [
  ['src', 'stretchy.js'],
  ['dist', 'katex.mjs'],
]

const readKatexGlyphNotice = () => {
  const katexDir = findPackageDir('katex', root)
  if (!katexDir) {
    throw new Error('missing installed package "katex"')
  }
  const marker = 'Many of the KaTeX SVG images have been adapted'
  for (const segments of KATEX_GLYPH_SOURCES) {
    let text
    try {
      text = fs.readFileSync(path.join(katexDir, ...segments), 'utf8')
    } catch {
      continue
    }
    const markerIndex = text.indexOf(marker)
    if (markerIndex < 0) {
      continue
    }
    // 声明是连续 // 行注释块：从 marker 所在行向前、向后各取连续的 // 行
    const lines = text.split('\n')
    const lineIndex = text.slice(0, markerIndex).split('\n').length - 1
    let start = lineIndex
    while (start > 0 && /^\s*\/\//.test(lines[start - 1])) {
      start--
    }
    let end = lineIndex
    while (end + 1 < lines.length && /^\s*\/\//.test(lines[end + 1])) {
      end++
    }
    const notice = normalizeLicenseText(lines.slice(start, end + 1).join('\n'))
    if (notice) {
      return { source: segments.join('/'), notice }
    }
  }
  throw new Error('cannot locate the bundled KaTeX SVG glyph notice in the installed katex package')
}

/**
 * DOMPurify 的上游运行时归属：npm 包内 LICENSE 是纯 Apache-2.0 正文，源码头只写
 * "(c) Cure53 and other contributors"；上游项目以 MPL-2.0 / Apache-2.0 双许可发布并声明
 * "Copyright 2015 Mario Heiderich, Cure53 and other contributors"。这里按上游原文补录署名，
 * 并校验安装包的许可证确实是双许可，避免将来换包后凭空写出错误声明。
 */
const DOMPURIFY_UPSTREAM_COPYRIGHT =
  'Copyright 2015 Mario Heiderich, Cure53 and other contributors'

/**
 * 预打包上游子包：运行时依赖在发布前可能把别的 npm 包直接打进自己的 dist（webpack 的
 * node_modules/<pkg>/ 源码路径只保留在 .map 里）。这类代码的许可证不在宿主包的 LICENSE
 * 文件里，必须单独补录，否则生产产物会带着没有版权归属的第三方代码。
 *
 * path-browserify 被 vscode-uri 3.0.8 与 mermaid 11 预打包进发布产物；本项目没有把它列入
 * dependencies，因此不会出现在主清单里。
 */
const PREBUNDLED_PACKAGE_NOTICES = [
  {
    name: 'js-yaml',
    version: '4.1.0',
    copyright: 'Copyright (C) 2011-2015 by Vitaly Puzrin',
    license: 'MIT',
  },
  {
    name: 'path-browserify',
    version: '1.0.1',
    copyright: 'Copyright (c) 2013 James Halliday',
    license: 'MIT',
  },
]

const SOURCE_MAP_FILE_BYTES_LIMIT = 16 * 1024 * 1024

/** 递归列出目录内指定后缀的文件；跳过嵌套 node_modules（传递依赖由独立包目录覆盖） */
const walkFilesWithExtension = (dir, extension, output = []) => {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return output
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === 'node_modules') {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFilesWithExtension(full, extension, output)
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      output.push(full)
    }
  }
  return output
}

/**
 * 自动审计预打包来源：遍历全部入包运行时依赖目录里的 .map，解析 sources 数组，
 * 提取其中引用的 node_modules/<pkg>/ 外部包名（pnpm 虚拟目录 .pnpm 不是包名，跳过）。
 * 已列入主清单的包视为覆盖；其余必须出现在 PREBUNDLED_PACKAGE_NOTICES 里，
 * 否则生产产物会带着未署名的第三方代码，构建直接失败。
 */
const auditPrebundledSources = (packages) => {
  const installedNames = new Set(packages.map((record) => record.name))
  const references = new Map()
  let scannedMaps = 0
  for (const record of packages) {
    for (const file of walkFilesWithExtension(record.packageDir, '.map')) {
      let stats
      try {
        stats = fs.statSync(file)
      } catch {
        continue
      }
      if (stats.size > SOURCE_MAP_FILE_BYTES_LIMIT) {
        continue
      }
      let map
      try {
        map = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        // 非 JSON 的 .map 文件不应让构建失败：只跳过并继续扫描其它来源
        continue
      }
      if (!map || !Array.isArray(map.sources)) {
        continue
      }
      scannedMaps += 1
      const provenance = `${record.name}@${record.version} (${path
        .relative(record.packageDir, file)
        .split(path.sep)
        .join('/')})`
      for (const source of map.sources) {
        if (typeof source !== 'string') {
          continue
        }
        for (const match of source.matchAll(/node_modules[\\/]+((?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/g)) {
          const name = match[1].replace(/\\/g, '/')
          // pnpm 的虚拟目录前缀不是 npm 包名
          if (name.startsWith('.')) {
            continue
          }
          if (installedNames.has(name)) {
            continue
          }
          if (!references.has(name)) {
            references.set(name, new Set())
          }
          references.get(name).add(provenance)
        }
      }
    }
  }
  const uncovered = [...references.keys()]
    .filter((name) => !PREBUNDLED_PACKAGE_NOTICES.some((notice) => notice.name === name))
    .sort()
  if (uncovered.length > 0) {
    throw new Error(
      'pre-bundled upstream package(s) are missing from ADDITIONAL NOTICES: ' +
        uncovered.join(', ')
    )
  }
  return { scannedMaps, references, uncovered }
}

const renderPrebundledNotices = (audit) => {
  const parts = [
    section('Pre-bundled upstream package scan'),
    '',
    'Runtime dependencies may pre-bundle other npm packages into their published',
    `bundles. ${audit.scannedMaps} source map file(s) were scanned for external`,
    'node_modules/<package>/ references; the pre-bundled upstream packages they',
    'point at are listed below with their original copyright and license text.',
    '',
  ]
  for (const notice of PREBUNDLED_PACKAGE_NOTICES) {
    const provenance = [...(audit.references.get(notice.name) ?? [])].sort()
    parts.push(
      section(`${notice.name} ${notice.version} (pre-bundled upstream package)`),
      '',
      `${notice.name} is not a dependency of this project. It is pre-bundled inside:`,
      '',
      ...(provenance.length > 0
        ? provenance.map((entry) => `- ${entry}`)
        : ['- (the installed runtime packages no longer reference it)']),
      '',
      notice.copyright,
      '',
      `Licensed under ${notice.license === 'MIT' ? 'The MIT License' : notice.license}:`,
      '',
      MIT_LICENSE_BODY,
      ''
    )
  }
  parts.push(
    `Uncovered pre-bundled upstream packages: ${audit.uncovered.length}.`,
    ''
  )
  return parts
}

const readDompurifyAttribution = (packages) => {
  const record = packages.find((item) => item.name === 'dompurify')
  if (!record) {
    throw new Error('missing installed package "dompurify"')
  }
  const declared = record.declaredLicense
  if (!/MPL-2\.0/i.test(declared) || !/Apache-2\.0/i.test(declared)) {
    throw new Error(
      `installed dompurify declares "${declared}", expected the MPL-2.0 OR Apache-2.0 dual license`
    )
  }
  return { version: record.version, declaredLicense: declared }
}

/**
 * 自动扫描：许可证文件里通常只写“本包”的版权，内嵌进来的第三方代码不会出现在其中。
 * 这里收集所有版权声明（含不带 (c) 的 "Copyright 2015 ..." 形式，以及 // 行注释），
 * 过滤掉确被包级许可证覆盖的部分，剩下的一律补录。
 */

const NOTICE_FILE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.h', '.c'])
const MAX_NOTICE_SCAN_FILE_BYTES = 8 * 1024 * 1024
const COMMENT_BLOCK_RE = /\/\*!?[\s\S]*?\*\//g
// 旧实现只认 "Copyright (c)"，会漏掉 "Copyright 2015 Mario Heiderich, ..." 这类写法
const COPYRIGHT_OR_LICENSE_RE = /copyright|@license/i
/** 行注释里真正像版权声明的形式：Copyright 后跟 (c)/©/年份；仅出现单词不算 */
const LINE_COMMENT_NOTICE_RE = /copyright\s*(?:\([cC]\)|©)?\s*(?:\d{4}|by\b)/i
const COVERED_MARKERS = [
  /MathJax\/extensions\/TeX\/mhchem\.js/i,
  /Martin Hensel/i,
  /Many of the KaTeX SVG images have been adapted/i,
  /Design Science, Inc\./i,
  /Ralf S\. Engelschall/i,
  /Thenable\/1\.0\.7/i,
]
/** React 系列源码头写 "Facebook, Inc."，但包内 LICENSE 已把版权主体更新为 Meta Platforms */
const HOLDER_ALIASES = new Map([['facebook', 'meta']])
const HOLDER_STOPWORDS = new Set([
  'copyright',
  'licensed',
  'license',
  'under',
  'the',
  'and',
  'its',
  'affiliates',
  'all',
  'rights',
  'reserved',
  'inc',
  'llc',
  'ltd',
  'corporation',
  'corp',
  'authors',
  'contributors',
  'other',
  'this',
  'source',
  'code',
  'released',
  'with',
  'permission',
  'granted',
  'any',
  'person',
  'obtaining',
  'copy',
  'software',
  'associated',
  'documentation',
  'files',
  'deal',
  'without',
  'restriction',
  'including',
  'limitation',
  'use',
  'modify',
  'merge',
  'publish',
  'distribute',
  'sublicense',
  'sell',
  'copies',
  'furnished',
  'subject',
  'following',
  'conditions',
  'above',
  'notice',
  'shall',
  'included',
  'substantial',
  'portions',
  'others',
  'reserved',
])
/** 许可证家族词不是版权主体，不能当作“未覆盖”的依据 */
const LICENSE_FAMILY_RE = /^(mit|apache|bsd|isc|gpl|lgpl|mpl|unlicense)$/

const normalizeNoticeText = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase()
/** 去掉注释装饰与标点，只留可比较的文本骨架 */
const noticeSkeleton = (text) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()

const copyrightTokens = (text) => {
  const tokens = new Set()
  // 同时识别 "Copyright ..." 与 "(c) Cure53 ..."：后者常见于打包后的 @license 头，
  // 缺失它会让“不同版权人”被误判成“无版权人”而按许可证家族跳过。
  for (const match of text.matchAll(/(?:copyright|\(c\))[^\n]*/gi)) {
    for (const raw of match[0].toLowerCase().match(/[a-z][a-z0-9.'-]{2,}/g) ?? []) {
      // 去掉句末标点，避免 "MarkedJS." 与许可证原文里的 "MarkedJS" 匹配不上
      const word = raw.replace(/[.'-]+$/, '')
      if (!HOLDER_STOPWORDS.has(word) && !LICENSE_FAMILY_RE.test(word) && word.length >= 4) {
        tokens.add(word)
      }
    }
  }
  return tokens
}

const collectCommentNotices = (text) => {
  const notices = []
  for (const match of text.matchAll(COMMENT_BLOCK_RE)) {
    if (COPYRIGHT_OR_LICENSE_RE.test(match[0])) {
      notices.push(match[0])
    }
  }
  return notices
}

/**
 * 行注释声明：部分包（如 KaTeX 的 SVG 字形数据）用 // 注释而不是块注释保留版权。
 * 把连续的 // 行合并成一个通知块，只收录真正带 Copyright 年份 / (c) / @license 的块。
 */
const collectLineCommentNotices = (text) => {
  const notices = []
  let run = []
  const flush = () => {
    if (run.length === 0) {
      return
    }
    const block = run.join('\n')
    if (LINE_COMMENT_NOTICE_RE.test(block) || /@license/i.test(block)) {
      notices.push(block)
    }
    run = []
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\/\//.test(line)) {
      run.push(line)
    } else {
      flush()
    }
  }
  flush()
  return notices
}

const walkSourceFiles = (dir, output = []) => {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return output
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === 'node_modules') {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkSourceFiles(full, output)
    } else if (entry.isFile() && NOTICE_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      output.push(full)
    }
  }
  return output
}

/**
 * 扫描运行时依赖源码，返回所有未被包级许可证覆盖的内嵌版权声明。
 * 判定为“已覆盖”的四种情况：
 * 1. 声明的全部版权主体词都出现在该包自己的许可证文件里（大小写不敏感，含 React→Meta 别名）；
 * 2. 只有 @license 标记、没有版权主体，且许可证家族与包声明的许可证一致；
 * 3. rollup 风格的 "Bundled license information" 聚合块：其引用的包在文件主体里都有独立条目；
 * 4. 已由上面的已知内嵌声明（mhchem / Thenable）人工收录。
 */
const scanEmbeddedNotices = (packages) => {
  const licenseCorpus = []
  const holderCorpus = new Set()
  for (const record of packages) {
    const text = record.licenseFiles.map((file) => file.text).join('\n')
    licenseCorpus.push(text)
    for (const token of copyrightTokens(text)) {
      holderCorpus.add(token)
    }
  }
  const corpus = normalizeNoticeText(licenseCorpus.join('\n'))
  const skeletonCorpus = noticeSkeleton(licenseCorpus.join('\n'))
  const uncovered = new Map()
  let scannedFiles = 0
  for (const record of packages) {
    const ownLicense = normalizeNoticeText(
      record.licenseFiles.map((file) => file.text).join('\n')
    )
    const ownSkeleton = noticeSkeleton(record.licenseFiles.map((file) => file.text).join('\n'))
    for (const file of walkSourceFiles(record.packageDir)) {
      let stats
      try {
        stats = fs.statSync(file)
      } catch {
        continue
      }
      if (stats.size > MAX_NOTICE_SCAN_FILE_BYTES) {
        continue
      }
      let text
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      scannedFiles += 1
      if (!COPYRIGHT_OR_LICENSE_RE.test(text)) {
        continue
      }
      const relative = path.relative(record.packageDir, file).split(path.sep).join('/')
      const notices = [...collectCommentNotices(text), ...collectLineCommentNotices(text)]
      for (const block of notices) {
        if (COVERED_MARKERS.some((marker) => marker.test(block))) {
          continue
        }
        if (/Bundled license information/i.test(block)) {
          continue
        }
        const blocked = normalizeNoticeText(block).slice(0, 120)
        if (blocked && ownLicense.includes(blocked)) {
          continue
        }
        // 注释装饰（/**、前导 *）会让逐字包含判断失败：再去掉装饰做一次骨架比对
        const skeleton = noticeSkeleton(block).slice(0, 160)
        if (skeleton && ownSkeleton.includes(skeleton)) {
          continue
        }
        if (skeleton && skeletonCorpus.includes(skeleton)) {
          continue
        }
        const holders = [...copyrightTokens(block)]
        if (holders.length === 0) {
          // 确实没有任何版权主体的纯 @license 标记：许可证家族与包一致才算覆盖。
          // 只要有版权主体（含 "(c) Cure53" 这种写法），就绝不能仅凭许可证家族跳过。
          const licenseFamily = /\b(MIT|Apache|BSD|ISC)\b/i.exec(block)?.[1]?.toLowerCase()
          if (licenseFamily && ownLicense.includes(licenseFamily)) {
            continue
          }
        } else {
          const covered = holders.every((holder) => {
            const token = HOLDER_ALIASES.get(holder) ?? holder
            return token.length >= 4 && (corpus.includes(token) || holderCorpus.has(token))
          })
          if (covered) {
            continue
          }
        }
        const signature = `${holders.sort().join(',')}|${block.replace(/\s+/g, ' ').slice(0, 160)}`
        if (!uncovered.has(signature)) {
          uncovered.set(signature, { package: record.name, version: record.version, file: relative, block })
        }
      }
    }
  }
  return {
    scannedFiles,
    notices: [...uncovered.values()].sort((left, right) =>
      left.package === right.package
        ? left.file.localeCompare(right.file)
        : left.package.localeCompare(right.package)
    ),
  }
}

/** 扫描最终生成的 JS 产物；构建过程会剥离普通注释，/*! 保留的声明在这里兜底收录 */
const scanBuiltBundles = () => {
  const jsDir = path.join(distDir, 'static', 'js')
  const notices = []
  let scannedFiles = 0
  for (const file of walkSourceFiles(jsDir)) {
    if (path.extname(file) !== '.js') {
      continue
    }
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    scannedFiles += 1
    for (const block of collectCommentNotices(text)) {
      notices.push({ file: path.relative(root, file).split(path.sep).join('/'), block })
    }
  }
  return { scannedFiles, notices }
}

const renderUncoveredNotice = (notice, heading) => [
  section(heading),
  '',
  notice.block,
]

/** 内嵌声明：不是独立依赖，但随产物一起分发，必须可追溯 */
const renderAdditionalNotices = (packages) => {
  const mhchem = readMhChemNotice()
  const katexGlyph = readKatexGlyphNotice()
  const katexFontMetadata = readKatexFontMetadata()
  const thenable = readThenableNotice(packages)
  const dompurify = readDompurifyAttribution(packages)
  const sourceIndex = readEmbeddedSourceIndex(packages)
  const prebundled = auditPrebundledSources(packages)
  const scan = scanEmbeddedNotices(packages)
  const bundleScan = scanBuiltBundles()
  const parts = [
    section('ADDITIONAL NOTICES'),
    '',
    'The notices below belong to material embedded in the bundled runtime packages.',
    'They are reproduced here because the package-level license files do not cover them.',
    '',
    section(`KaTeX mhchem extension (extracted from katex/${mhchem.source})`),
    '',
    mhchem.notice,
    '',
    section(`KaTeX SVG glyph geometry (extracted from katex/${katexGlyph.source})`),
    '',
    'The stretchy arrow / brace SVG path data in the bundled KaTeX build is adapted',
    'from glyphs in the KaTeX fonts and keeps the following upstream attribution:',
    '',
    katexGlyph.notice,
    '',
    section('KaTeX fonts'),
    '',
    'The KaTeX font files bundled under dist/static/media/ follow the',
    'SIL Open Font License 1.1. Their font metadata, carried inside',
    `${katexFontMetadata.source}, states:`,
    '',
    `  ${katexFontMetadata.copyright}`,
    '',
    'That is the font-file record. The SVG glyph path data extracted above keeps its',
    'own, separate "Copyright (c) 2014-2017 Khan Academy" line, so the two years must',
    'not be conflated.',
    'The full standard license text is reproduced below so this bundle is readable offline',
    'without a network connection (official English text, SIL Open Font License 1.1).',
    '',
    SIL_OFL_1_1_TEXT,
    '',
    section(`Thenable/1.0.7 (extracted from ${thenable.source})`),
    '',
    thenable.header,
    '',
    'Licensed under The MIT License:',
    '',
    MIT_LICENSE_BODY,
    '',
    ...renderPrebundledNotices(prebundled),
    section(`DOMPurify upstream attribution (dompurify@${dompurify.version})`),
    '',
    DOMPURIFY_UPSTREAM_COPYRIGHT,
    '',
    'DOMPurify, the DOM-only XSS sanitizer bundled by the Markdown / Mermaid rendering',
    `stack, is distributed under the ${dompurify.declaredLicense} dual license.`,
    'The upstream runtime core is attributed to Mario Heiderich and Cure53; the npm',
    'package LICENSE carries the Apache License 2.0 text and drops this copyright line.',
    '',
    section('Embedded algorithm and event code source index'),
    '',
    'Two pieces of embedded code are adapted from other upstream projects; the index',
    'below records where each one comes from:',
    '',
    ...sourceIndex.map((row) => `- ${row}`),
    '',
    section('Embedded-notice scan'),
    '',
    `Scanned ${scan.scannedFiles} installed runtime dependency source files for`,
    '"Copyright" / "@license" comment blocks (both /* */ blocks and // line comments,',
    'including notices written without "(c)"), and cross-checked them against the',
    'license text shipped by each package.',
    `Uncovered embedded notices found: ${scan.notices.length}.`,
    '',
    `Built JavaScript bundles scanned under dist/static/js: ${bundleScan.scannedFiles} file(s).`,
    `"Copyright" / "@license" comments retained in the built bundles: ${bundleScan.notices.length}.`,
  ]
  if (scan.notices.length > 0) {
    parts.push('', 'The following embedded notices are not covered by any package-level license file:')
    for (const notice of scan.notices) {
      parts.push(
        ...renderUncoveredNotice(
          notice,
          `Uncovered embedded notice: ${notice.package}@${notice.version} (${notice.file})`
        )
      )
    }
  }
  for (const notice of bundleScan.notices) {
    parts.push(...renderUncoveredNotice(notice, `Retained bundle notice: ${notice.file}`))
  }
  return parts.join('\n')
}

const renderPackage = (record) => {
  const parts = [section(`${record.name} ${record.version}`)]
  if (record.licenseFiles.length > 0) {
    for (const file of record.licenseFiles) {
      parts.push(`File: ${file.fileName}`)
      parts.push('')
      parts.push(file.text)
    }
  } else if (record.declaredLicense) {
    parts.push(`License declared in package.json: ${record.declaredLicense}`)
    // 无 LICENSE 文件的子包必须让本条目自身自洽：打印 README 中提取到的署名行，
    // 以及由 package.json author 兜底的版权人，再附标准 MIT 正文。
    if (record.readmeAttribution) {
      parts.push(
        '',
        `Attribution extracted from ${record.readmeFileName}: ${record.readmeAttribution}`
      )
    }
    if (record.copyrightHolder) {
      parts.push('', `Copyright (c) ${record.copyrightHolder}`)
    }
    if (/^MIT$/i.test(record.declaredLicense)) {
      parts.push('', 'Licensed under The MIT License:', '', MIT_LICENSE_BODY)
    }
  } else {
    parts.push('No license file or license field was found in this package.')
  }
  return parts.join('\n')
}

const main = () => {
  const packages = walkDependencies()
  const lines = [
    'THIRD-PARTY LICENSES',
    '',
    'This build bundles the runtime third-party packages listed below. Each entry',
    'reproduces the license text shipped with the installed package, or the license',
    'declared in its package.json when no license file exists.',
    '',
    `Packages: ${packages.length}`,
    '',
  ]
  for (const record of packages) {
    lines.push('')
    lines.push(renderPackage(record))
  }
  lines.push('')
  lines.push(renderAdditionalNotices(packages))
  fs.mkdirSync(distDir, { recursive: true })
  fs.writeFileSync(outputFile, `${lines.join('\n')}\n`, 'utf8')
  console.log(`third-party licenses: ${packages.length} packages -> dist/THIRD_PARTY_LICENSES.txt`)
}

main()
