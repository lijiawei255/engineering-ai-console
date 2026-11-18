/**
 * 浏览器端确定性自检：Office Open XML 内存提取（真实 DOMParser + fflate）与编码回退。
 * 由 tests/run-browser-selftest.mjs 用无头 Edge/Chromium 打开 file:// 页面并抓取 DOM 结果。
 */

import { strToU8, zipSync } from 'fflate'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { openDB } from 'idb'
import { App } from '../src/app/App.js'
import { extractOfficeText } from '../src/services/attachments/office.js'
import { parseAttachmentFile } from '../src/services/attachments/index.js'
import type { Attachment } from '../src/services/attachments/index.js'
import { decodeTextBytes } from '../src/services/attachments/decode.js'
import { balanceCodeFences } from '../src/services/markdown/fences.js'
import {
  sanitizeMermaid,
  sanitizeMermaidSvg,
  stripMermaidDirectives,
} from '../src/services/markdown/mermaid.js'
import { failedMathResult } from '../src/services/markdown/mathFallback.js'
import { formatExaContext } from '../src/services/search/exa.js'
import {
  WEB_SEARCH_CONTEXT_CLOSE,
  WEB_SEARCH_CONTEXT_OPEN,
} from '../src/services/search/contextTags.js'
import { DEFAULT_SYSTEM_PROMPTS } from '../src/prompts/defaults.js'
import {
  buildJsonBackup,
  buildJsonBackupFromSources,
  parseJsonBackup,
  restoreJsonBackup,
} from '../src/services/chat/backup.js'
import {
  clearDatabase,
  deleteSessionRecord,
  importSessionsAtomically,
  listSessionSummaries,
  loadAllSessions,
  loadSession,
  saveSession,
} from '../src/services/chat/db.js'
import {
  addParsedAttachmentIfAlive,
  adoptImportedSessions,
  deleteAllSessions,
  deleteSession,
  getCachedSession,
  getSessionRev,
  initChat,
  retryAssistant,
  selectSession,
  sendMessage,
  softReset,
  useChatStore,
} from '../src/services/chat/store.js'
import {
  hardReset,
  hardResetLocalData,
  importJsonBackup,
  setReloadAfterReset,
} from '../src/services/chat/reset.js'
import {
  clearAllDrafts,
  clearDraft,
  getDraft,
  setDraftText,
  addDraftAttachment,
} from '../src/services/chat/drafts.js'
import { useToast } from '../src/components/base/toastState.js'
import {
  configSaveFailureKey,
  patchChannel,
  remoteKeyFingerprintOf,
  setSecret,
  useConfigStore,
} from '../src/services/config/store.js'
import { startLifecycleTracking } from '../src/services/config/lifecycle.js'
import { uploadRemoteFile, type RemoteContext } from '../src/services/api/files.js'
import { ChannelEditor } from '../src/components/settings/ChannelEditor.js'
import { ChatInput } from '../src/components/chatInput/ChatInput.js'
import { SettingsDialog } from '../src/components/settings/SettingsDialog.js'
import { useUiStore } from '../src/app/uiState.js'
import {
  createChannelConfig,
  createDefaultSettings,
  secretFingerprint,
} from '../src/services/config/types.js'
import type { Session } from '../src/services/chat/types.js'
import { toSessionSummary } from '../src/services/chat/types.js'

const lines: string[] = []
let failed = 0

const ok = (condition: boolean, label: string, detail = '') => {
  if (condition) {
    lines.push(`ok - ${label}`)
  } else {
    failed++
    lines.push(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const eq = (actual: unknown, expected: unknown, label: string) => {
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )
}

const zipOf = (files: Record<string, string | Uint8Array>) => {
  const entries: Record<string, Uint8Array> = {}
  for (const [name, content] of Object.entries(files)) {
    entries[name] = typeof content === 'string' ? strToU8(content) : content
  }
  return zipSync(entries)
}

const longestLine = (text: string): number =>
  text.split('\n').reduce((max, line) => Math.max(max, line.length), 0)

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------
const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>工程日志标题</w:t></w:r></w:p>
<w:p><w:r><w:t>传感器采样异常，检查 AI1 通道</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>通道</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>电压</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>AI1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>3.3V</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
</w:body></w:document>`
const docx = zipOf({ 'word/document.xml': docXml })
const docxResult = extractOfficeText('docx', docx, new DOMParser())
ok(docxResult.ok, 'DOCX extraction succeeds')
if (docxResult.ok) {
  ok(docxResult.text.includes('工程日志标题'), 'DOCX paragraph text extracted')
  ok(docxResult.text.includes('传感器采样异常'), 'DOCX long paragraph extracted')
  ok(docxResult.text.includes('| 通道 | 电压 |'), 'DOCX table rendered as Markdown header')
  ok(docxResult.text.includes('| AI1 | 3.3V |'), 'DOCX table row extracted')
}

// 压缩炸弹预算：40MB 声明大小的无关条目必须在解压前被拒绝
const hugeDeclared = new Uint8Array(40 * 1024 * 1024)
const oversizedDocx = zipOf({
  'word/document.xml': docXml,
  'docProps/unrelated.bin': hugeDeclared,
})
eq(
  extractOfficeText('docx', oversizedDocx, new DOMParser()),
  { ok: false, error: 'officeTooLarge' },
  'DOCX with oversized declared entry refused before decompression'
)

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------
const sharedStrings = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<si><t>通道</t></si><si><t>采样值</t></si><si><t>AI1</t></si><si><t>3.3</t></si><si><r><t>备</t></r><r><t>注</t></r></si></sst>`
const workbook = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>`
const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`
const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="n"><v>3.3</v></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>AI2</t></is></c><c r="B3" t="s"><v>4</v></c></row>
</sheetData></worksheet>`
const xlsx = zipOf({
  'xl/sharedStrings.xml': sharedStrings,
  'xl/workbook.xml': workbook,
  'xl/_rels/workbook.xml.rels': rels,
  'xl/worksheets/sheet1.xml': sheet,
})
const xlsxResult = extractOfficeText('xlsx', xlsx, new DOMParser())
ok(xlsxResult.ok, 'XLSX extraction succeeds')
if (xlsxResult.ok) {
  ok(xlsxResult.text.includes('### 数据'), 'XLSX sheet name preserved')
  ok(xlsxResult.text.includes('| 通道 | 采样值 |'), 'XLSX header row with shared strings')
  ok(xlsxResult.text.includes('| AI1 | 3.3 |'), 'XLSX numeric row extracted')
  ok(xlsxResult.text.includes('| AI2 | 备注 |'), 'XLSX inline string and rich shared string extracted')
}

// 绝对路径 Target：以 / 开头的包内路径不能被拼成 xl/xl/...
const absoluteTargetWorkbook = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Absolute" sheetId="1" r:id="rId1"/></sheets></workbook>`
const absoluteTargetRels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml"/>
</Relationships>`
const absoluteTargetSheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>abs-ok</t></is></c></row>
</sheetData></worksheet>`
const absoluteTargetXlsx = zipOf({
  'xl/workbook.xml': absoluteTargetWorkbook,
  'xl/_rels/workbook.xml.rels': absoluteTargetRels,
  'xl/worksheets/sheet1.xml': absoluteTargetSheet,
})
const absoluteTargetResult = extractOfficeText('xlsx', absoluteTargetXlsx, new DOMParser())
ok(absoluteTargetResult.ok, 'XLSX with absolute Target extraction succeeds')
if (absoluteTargetResult.ok) {
  ok(
    absoluteTargetResult.text.includes('abs-ok'),
    'XLSX absolute Target path resolves without duplicated xl prefix'
  )
}

// 稀疏大坐标：A1 与 ZZ20000，不允许按 20000 行 / 702 列分配稠密数组
const sparseSheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>A1value</t></is></c></row>
<row r="20000"><c r="ZZ20000" t="inlineStr"><is><t>ZZvalue</t></is></c></row>
</sheetData></worksheet>`
const sparseXlsx = zipOf({
  'xl/workbook.xml': workbook.replace('数据', 'Sparse'),
  'xl/_rels/workbook.xml.rels': rels,
  'xl/worksheets/sheet1.xml': sparseSheet,
})
const sparseResult = extractOfficeText('xlsx', sparseXlsx, new DOMParser())
ok(sparseResult.ok, 'Sparse XLSX extraction succeeds')
if (sparseResult.ok) {
  ok(sparseResult.text.includes('A1value'), 'Sparse XLSX keeps in-range cell A1')
  ok(!sparseResult.text.includes('ZZvalue'), 'Sparse XLSX drops out-of-range column ZZ')
  ok(
    sparseResult.text.includes(
      '[Truncated: showing the first 1 non-empty rows and 1 columns]'
    ),
    'Sparse XLSX reports row/column truncation marker'
  )
  ok(sparseResult.text.length < 2000, 'Sparse XLSX does not allocate a dense table')
  ok(longestLine(sparseResult.text) < 500, 'Sparse XLSX table line length stays bounded')
}

// 只有公式没有缓存值：输出 =公式
const formulaSheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1"><f>SUM(B1:B2)</f></c></row>
</sheetData></worksheet>`
const formulaXlsx = zipOf({
  'xl/workbook.xml': workbook.replace('数据', 'Formula'),
  'xl/_rels/workbook.xml.rels': rels,
  'xl/worksheets/sheet1.xml': formulaSheet,
})
const formulaResult = extractOfficeText('xlsx', formulaXlsx, new DOMParser())
ok(formulaResult.ok, 'Formula-only XLSX extraction succeeds')
if (formulaResult.ok) {
  ok(formulaResult.text.includes('=SUM(B1:B2)'), 'Formula-only cell rendered as =formula')
}

// 单列 501 行：保留前 500 行并附截断说明，结构截断必须让结果与附件都标记 truncated
const rows501Sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${Array.from(
  { length: 501 },
  (_unused, index) =>
    `<row r="${index + 1}"><c r="A${index + 1}" t="inlineStr"><is><t>row-${index + 1}</t></is></c></row>`
).join('')}</sheetData></worksheet>`
const rows501Xlsx = zipOf({
  'xl/workbook.xml': workbook.replace('数据', 'Rows501'),
  'xl/_rels/workbook.xml.rels': rels,
  'xl/worksheets/sheet1.xml': rows501Sheet,
})
const rows501Result = extractOfficeText('xlsx', rows501Xlsx, new DOMParser())
ok(rows501Result.ok, '501-row XLSX extraction succeeds')
if (rows501Result.ok) {
  eq(rows501Result.truncated, true, '501-row XLSX is marked truncated by the row limit')
  ok(rows501Result.text.includes('row-1'), '501-row XLSX keeps the first row')
  ok(rows501Result.text.includes('row-500'), '501-row XLSX keeps the first 500 rows')
  ok(!rows501Result.text.includes('row-501'), '501-row XLSX drops the row beyond the 500-row limit')
  ok(
    rows501Result.text.includes(
      '[Truncated: showing the first 500 non-empty rows and 1 columns]'
    ),
    '501-row XLSX carries the row-limit truncation marker'
  )
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------
const slide1 = `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>
<p:sp><p:txBody><a:p><a:r><a:t>第一页：系统框图</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:txBody><a:p><a:r><a:t>采样率与截止频率冲突</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`
const slide2 = `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>
<p:sp><p:txBody><a:p><a:r><a:t>第二页：台架实验项</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`
const pptx = zipOf({
  'ppt/slides/slide1.xml': slide1,
  'ppt/slides/slide2.xml': slide2,
  'ppt/presentation.xml': '<presentation/>',
})
const pptxResult = extractOfficeText('pptx', pptx, new DOMParser())
ok(pptxResult.ok, 'PPTX extraction succeeds')
if (pptxResult.ok) {
  ok(pptxResult.text.indexOf('第一页') < pptxResult.text.indexOf('第二页'), 'PPTX slides fallback to numeric order')
  ok(pptxResult.text.includes('采样率与截止频率冲突'), 'PPTX text box extracted')
}

// sldIdLst 顺序与文件名数字序相反时，按 presentation.xml 的真实页序输出
const orderedPresentation = `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst>
</p:presentation>`
const orderedRels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>`
const orderedPptx = zipOf({
  'ppt/slides/slide1.xml': slide1,
  'ppt/slides/slide2.xml': slide2,
  'ppt/presentation.xml': orderedPresentation,
  'ppt/_rels/presentation.xml.rels': orderedRels,
})
const orderedResult = extractOfficeText('pptx', orderedPptx, new DOMParser())
ok(orderedResult.ok, 'PPTX with sldIdLst extraction succeeds')
if (orderedResult.ok) {
  ok(
    orderedResult.text.indexOf('第二页') < orderedResult.text.indexOf('第一页'),
    'PPTX presentation order follows sldIdLst instead of file number order'
  )
  ok(orderedResult.text.includes('## Slide 1'), 'PPTX slide heading rendered')
}

// xl/ 前缀的 Target 也不能拼成 xl/xl/...
const prefixedTargetRels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="xl/worksheets/sheet1.xml"/>
</Relationships>`
const prefixedTargetXlsx = zipOf({
  'xl/workbook.xml': absoluteTargetWorkbook,
  'xl/_rels/workbook.xml.rels': prefixedTargetRels,
  'xl/worksheets/sheet1.xml': absoluteTargetSheet,
})
const prefixedTargetResult = extractOfficeText('xlsx', prefixedTargetXlsx, new DOMParser())
ok(prefixedTargetResult.ok, 'XLSX with xl-prefixed Target extraction succeeds')
if (prefixedTargetResult.ok) {
  ok(prefixedTargetResult.text.includes('abs-ok'), 'XLSX xl-prefixed Target does not duplicate the xl segment')
}

// ---------------------------------------------------------------------------
// 流式围栏与 Mermaid 渲染安全（纯函数）
// ---------------------------------------------------------------------------
eq(balanceCodeFences('~~~js\nconst a = 1'), '~~~js\nconst a = 1\n~~~', 'wave fence closed with same type')
eq(
  balanceCodeFences('````md\n```\ncode'),
  '````md\n```\ncode\n````',
  'shorter same-type fence line does not close'
)
eq(
  balanceCodeFences('```js\ncode\n~~~~'),
  '```js\ncode\n~~~~\n```',
  'different fence type does not close'
)

const strippedMermaid = sanitizeMermaid(
  'A[<img src="https://cdn.example/x.png">]\nB@{ img: "https://cdn.example/y.png", label: "pic" }\nC'
)
ok(!/img/i.test(strippedMermaid), 'mermaid image syntax stripped before render')
ok(strippedMermaid.includes('A[') && strippedMermaid.includes('C'), 'mermaid non-image content kept')

eq(
  sanitizeMermaidSvg(
    '<svg><image href="https://cdn.example/x.png"/><image xlink:href="//cdn.example/y.svg"/><image href="data:image/png;base64,AA"/><image href="blob:abc"/></svg>'
  ),
  '<svg><image href="data:image/png;base64,AA"/><image href="blob:abc"/></svg>',
  'external mermaid SVG images removed, inline data/blob kept'
)

// 损坏 ZIP 必须确定性失败，不做猜测
const broken = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])
const brokenResult = extractOfficeText('docx', broken, new DOMParser())
eq(brokenResult, { ok: false, error: 'officeFailed' }, 'broken DOCX ZIP rejected deterministically')

// ---------------------------------------------------------------------------
// DOCX 内容控件 w:sdt / 输出预算
// ---------------------------------------------------------------------------
const sdtDocXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>普通段落</w:t></w:r></w:p>
<w:sdt><w:sdtPr/><w:sdtContent>
<w:p><w:r><w:t>控件内段落</w:t></w:r></w:p>
<w:sdt><w:sdtPr/><w:sdtContent>
<w:p><w:r><w:t>嵌套控件段落</w:t></w:r></w:p>
</w:sdtContent></w:sdt>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>控件表格列</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
</w:sdtContent></w:sdt>
<w:p><w:r><w:t>末尾段落</w:t></w:r></w:p>
</w:body></w:document>`
const sdtDocx = zipOf({ 'word/document.xml': sdtDocXml })
const sdtResult = extractOfficeText('docx', sdtDocx, new DOMParser())
ok(sdtResult.ok, 'DOCX with content controls extraction succeeds')
if (sdtResult.ok) {
  ok(sdtResult.text.includes('普通段落'), 'DOCX ordinary paragraph kept')
  ok(sdtResult.text.includes('控件内段落'), 'DOCX paragraph inside w:sdtContent extracted')
  ok(sdtResult.text.includes('嵌套控件段落'), 'DOCX nested content control extracted')
  ok(sdtResult.text.includes('控件表格列'), 'DOCX table inside w:sdtContent extracted')
  ok(sdtResult.text.includes('末尾段落'), 'DOCX paragraph after content control kept')
  ok(
    sdtResult.text.indexOf('普通段落') < sdtResult.text.indexOf('控件内段落') &&
      sdtResult.text.indexOf('控件内段落') < sdtResult.text.indexOf('末尾段落'),
    'DOCX content-control blocks keep document order'
  )
}

const wideCell = 'w'.repeat(200)
const wideRow = `<w:tr>${Array.from({ length: 30 }, () => `<w:tc><w:p><w:r><w:t>${wideCell}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`
const wideTableXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:tbl>${Array.from({ length: 500 }, () => wideRow).join('')}</w:tbl>
</w:body></w:document>`
const wideTableDocx = zipOf({ 'word/document.xml': wideTableXml })
const wideTableResult = extractOfficeText('docx', wideTableDocx, new DOMParser())
ok(wideTableResult.ok, 'DOCX wide table extraction succeeds')
if (wideTableResult.ok) {
  ok(
    wideTableResult.text.length <= 250 * 1024 + 2048,
    'DOCX table output stays inside the 250 KiB character budget',
    `length=${wideTableResult.text.length}`
  )
  ok(
    /Truncated|已截断/.test(wideTableResult.text),
    'DOCX wide table reports an explicit truncation marker'
  )
}

// 12000 行宽表：逐行预判预算，总输出必须严格 <= 256,000 字符（P2-05）
const manyRowCell = `固定行内容-${'x'.repeat(30)}`
const manyRows = Array.from(
  { length: 12000 },
  (_unused, index) =>
    `<w:tr><w:tc><w:p><w:r><w:t>${index}-${manyRowCell}</w:t></w:r></w:p></w:tc></w:tr>`
).join('')
const manyRowsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:tbl>${manyRows}</w:tbl>
</w:body></w:document>`
const manyRowsDocx = zipOf({ 'word/document.xml': manyRowsXml })
const manyRowsResult = extractOfficeText('docx', manyRowsDocx, new DOMParser())
ok(manyRowsResult.ok, '12000-row DOCX table extraction succeeds')
if (manyRowsResult.ok) {
  ok(
    manyRowsResult.text.length <= 256_000,
    'a 12000-row DOCX table strictly stays within the 256,000 character budget',
    `length=${manyRowsResult.text.length}`
  )
  ok(
    /Truncated|已截断/.test(manyRowsResult.text),
    'a 12000-row DOCX table appends an explicit truncation marker'
  )
  ok(
    !manyRowsResult.text.includes('11999-'),
    'rows beyond the live budget are never emitted'
  )
}

// 非空单元格全部位于第 64 列之后：必须报列超限截断，而不是空表
const farColumnSheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="BZ1" t="inlineStr"><is><t>far-away</t></is></c></row>
</sheetData></worksheet>`
const farColumnXlsx = zipOf({
  'xl/workbook.xml': workbook.replace('数据', 'FarColumns'),
  'xl/_rels/workbook.xml.rels': rels,
  'xl/worksheets/sheet1.xml': farColumnSheet,
})
const farColumnResult = extractOfficeText('xlsx', farColumnXlsx, new DOMParser())
ok(farColumnResult.ok, 'all-out-of-range XLSX sheet extraction succeeds')
if (farColumnResult.ok) {
  ok(!farColumnResult.text.includes('(empty sheet)'), 'all-out-of-range XLSX is not reported as empty')
  ok(
    farColumnResult.text.includes('[Truncated: every non-empty cell is beyond the 64-column limit]'),
    'all-out-of-range XLSX reports the column-limit truncation'
  )
}

// 共享字符串被大量重复引用：250 KB 实时预算必须在展开途中截断，而不是先拼出十几 MB
const longSharedText = 'x'.repeat(2000)
const repeatedSharedStrings = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<si><t>${longSharedText}</t></si></sst>`
const repeatedRows = Array.from({ length: 500 }, (_unused, rowIndex) => {
  const cells = Array.from({ length: 10 }, (_cell, columnIndex) => {
    const column = String.fromCharCode(65 + columnIndex)
    return `<c r="${column}${rowIndex + 1}" t="s"><v>0</v></c>`
  }).join('')
  return `<row r="${rowIndex + 1}">${cells}</row>`
}).join('')
const repeatedSheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${repeatedRows}</sheetData></worksheet>`
const repeatedSharedXlsx = zipOf({
  'xl/sharedStrings.xml': repeatedSharedStrings,
  'xl/workbook.xml': workbook.replace('数据', 'Repeated'),
  'xl/_rels/workbook.xml.rels': rels,
  'xl/worksheets/sheet1.xml': repeatedSheet,
})
const repeatedSharedResult = extractOfficeText('xlsx', repeatedSharedXlsx, new DOMParser())
ok(repeatedSharedResult.ok, 'XLSX with repeated shared strings extraction succeeds')
if (repeatedSharedResult.ok) {
  ok(
    repeatedSharedResult.text.length <= 250 * 1024 + 4096,
    'XLSX repeated shared strings stay inside the 250 KiB character budget',
    `length=${repeatedSharedResult.text.length}`
  )
  ok(
    /Truncated|已截断/.test(repeatedSharedResult.text),
    'XLSX shared-string budget reports an explicit truncation marker'
  )
}

// ---------------------------------------------------------------------------
// Office 整份文档 UTF-8 字节预算 + DOCX 单元格嵌套表格（P1-5 / P2-1）
// ---------------------------------------------------------------------------
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

// 单元格内 [段落 Sensor] -> [嵌套表格 30 Hz] -> [段落 Output]：按 DOM 顺序全部保留
const nestedTableDocXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:tbl><w:tr><w:tc>
<w:p><w:r><w:t>Sensor</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>30 Hz</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>Output</w:t></w:r></w:p>
</w:tc></w:tr></w:tbl>
</w:body></w:document>`
const nestedTableResult = extractOfficeText(
  'docx',
  zipOf({ 'word/document.xml': nestedTableDocXml }),
  new DOMParser()
)
ok(nestedTableResult.ok, 'DOCX with a nested table inside a cell extraction succeeds')
if (nestedTableResult.ok) {
  ok(nestedTableResult.text.includes('Sensor'), 'nested-table cell keeps the leading paragraph')
  ok(nestedTableResult.text.includes('30 Hz'), 'nested-table cell keeps the inner table text')
  ok(nestedTableResult.text.includes('Output'), 'nested-table cell keeps the trailing paragraph')
  ok(
    nestedTableResult.text.indexOf('Sensor') < nestedTableResult.text.indexOf('30 Hz') &&
      nestedTableResult.text.indexOf('30 Hz') < nestedTableResult.text.indexOf('Output'),
    'nested-table cell text follows DOM order'
  )
}

// 24 张宽表（CJK 多字节）：整份文档中间结果必须严格 < 256,000 UTF-8 字节
const bulkCellText = '中文字符样本'.repeat(6)
const bulkRow = `<w:tr>${Array.from(
  { length: 20 },
  () => `<w:tc><w:p><w:r><w:t>${bulkCellText}</w:t></w:r></w:p></w:tc>`
).join('')}</w:tr>`
const bulkTable = `<w:tbl>${Array.from({ length: 40 }, () => bulkRow).join('')}</w:tbl>`
const bulkDocXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
${Array.from({ length: 24 }, () => bulkTable).join('')}
</w:body></w:document>`
const bulkDocResult = extractOfficeText(
  'docx',
  zipOf({ 'word/document.xml': bulkDocXml }),
  new DOMParser()
)
ok(bulkDocResult.ok, '24-table DOCX extraction succeeds')
if (bulkDocResult.ok) {
  ok(
    utf8Bytes(bulkDocResult.text) < 256_000,
    '24-table DOCX result stays strictly below 256,000 UTF-8 bytes',
    `bytes=${utf8Bytes(bulkDocResult.text)}`
  )
  eq(bulkDocResult.truncated, true, '24-table DOCX result is marked truncated')
  ok(/Truncated|已截断/.test(bulkDocResult.text), '24-table DOCX result carries a truncation marker')
}

// 2 张超大工作表：跨工作表的总字节预算必须生效，不能把两张表拼成 1 MB 中间字符串
const bulkSheetCell = '中文字段内容'.repeat(8)
const bulkSheetRow = (rowIndex: number) =>
  `<row r="${rowIndex}">${Array.from(
    { length: 16 },
    (_unused, columnIndex) =>
      `<c r="${String.fromCharCode(65 + (columnIndex % 26))}${rowIndex}" t="inlineStr"><is><t>${bulkSheetCell}</t></is></c>`
  ).join('')}</row>`
const bulkSheetXml = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${Array.from(
  { length: 400 },
  (_unused, rowIndex) => bulkSheetRow(rowIndex + 1)
).join('')}</sheetData></worksheet>`
const bulkWorkbook = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="SheetA" sheetId="1" r:id="rId1"/><sheet name="SheetB" sheetId="2" r:id="rId2"/></sheets></workbook>`
const bulkWorkbookRels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`
const bulkXlsxResult = extractOfficeText(
  'xlsx',
  zipOf({
    'xl/workbook.xml': bulkWorkbook,
    'xl/_rels/workbook.xml.rels': bulkWorkbookRels,
    'xl/worksheets/sheet1.xml': bulkSheetXml,
    'xl/worksheets/sheet2.xml': bulkSheetXml,
  }),
  new DOMParser()
)
ok(bulkXlsxResult.ok, 'two-huge-sheet XLSX extraction succeeds')
if (bulkXlsxResult.ok) {
  ok(
    utf8Bytes(bulkXlsxResult.text) < 256_000,
    'two-huge-sheet XLSX result stays strictly below 256,000 UTF-8 bytes',
    `bytes=${utf8Bytes(bulkXlsxResult.text)}`
  )
  eq(bulkXlsxResult.truncated, true, 'two-huge-sheet XLSX result is marked truncated')
}

// 48 页幻灯片：跨幻灯片总字节预算必须生效
const bulkSlideXml = `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>
${Array.from(
  { length: 40 },
  (_unused, index) =>
    `<p:sp><p:txBody><a:p><a:r><a:t>第${index}段-${'中文字符样本'.repeat(10)}</a:t></a:r></a:p></p:txBody></p:sp>`
).join('')}
</p:spTree></p:cSld></p:sld>`
const bulkSlides: Record<string, string> = {}
for (let index = 1; index <= 48; index++) {
  bulkSlides[`ppt/slides/slide${index}.xml`] = bulkSlideXml
}
const bulkPptxResult = extractOfficeText('pptx', zipOf(bulkSlides), new DOMParser())
ok(bulkPptxResult.ok, '48-slide PPTX extraction succeeds')
if (bulkPptxResult.ok) {
  ok(
    utf8Bytes(bulkPptxResult.text) < 256_000,
    '48-slide PPTX result stays strictly below 256,000 UTF-8 bytes',
    `bytes=${utf8Bytes(bulkPptxResult.text)}`
  )
  eq(bulkPptxResult.truncated, true, '48-slide PPTX result is marked truncated')
}

// CommonMark：反引号围栏的 info string 含反引号时不是合法围栏
eq(
  balanceCodeFences('```js`bad\ncode'),
  '```js`bad\ncode',
  'backtick fence with a backtick in the info string is not a fence'
)
eq(
  balanceCodeFences('~~~js`ok\ncode'),
  '~~~js`ok\ncode\n~~~',
  'tilde fence allows a backtick in the info string'
)

// Mermaid 图内 init 指令不得篡改主题 / 字号
const strippedDirectives = stripMermaidDirectives(
  '%%{init: {"theme":"dark","themeVariables":{"fontSize":"42px"}}}%%\ngraph TD;A-->B'
)
ok(!strippedDirectives.includes('init:'), 'mermaid init directive stripped')
ok(strippedDirectives.includes('graph TD;A-->B'), 'mermaid graph body kept after directive stripping')
const multiLineDirective = stripMermaidDirectives(
  '%%{init: {\n  "theme": "dark"\n}}%%\nflowchart TD\n A-->B'
)
ok(!multiLineDirective.includes('init:') && multiLineDirective.includes('flowchart TD'), 'multi-line mermaid init directive stripped')
// init 的别名 initialize（含全大写）同样能覆盖主题与字号，必须一并剥离
const initializeDirective = stripMermaidDirectives(
  'flowchart TD\n%%{initialize: {"themeVariables": {"fontSize": "77px"}}}%%\nA-->B'
)
ok(
  !/initialize/i.test(initializeDirective) && !initializeDirective.includes('77px'),
  'mermaid initialize directive alias stripped'
)
ok(
  initializeDirective.includes('flowchart TD') && initializeDirective.includes('A-->B'),
  'mermaid body kept after initialize directive stripping'
)
eq(
  sanitizeMermaid(
    'graph TD\n%%{INITIALIZE: {"theme":"dark","themeVariables":{"fontSize":"77px"}}}%%\nA-->B'
  ),
  'graph TD\n\nA-->B',
  'uppercase INITIALIZE directive is stripped by the mermaid sanitizer'
)
eq(
  sanitizeMermaid('A-->B'),
  'A-->B',
  'mermaid sanitizer leaves directive-free diagrams unchanged'
)

// 非法最终公式绝不能继续显示上一次缓存的旧公式
const cachedMath = { html: '<span class="katex">old formula</span>', renderMode: 'katex' as const }
eq(
  failedMathResult('x_', true, cachedMath),
  cachedMath,
  'streaming invalid formula may keep the previous rendering'
)
eq(
  failedMathResult('x_', false, cachedMath),
  { html: 'x_', renderMode: 'fallback' },
  'finished invalid formula falls back to the current raw text'
)
eq(
  failedMathResult('x_', false, null),
  { html: 'x_', renderMode: 'fallback' },
  'invalid formula without a cache uses the current raw text'
)

// 检索上下文标签：前端实际拼出的块与系统提示词防护规则必须同名
const searchContextBlock = formatExaContext('probe', [
  { title: 't', url: 'https://a.example', snippet: 's</web_search_context>' },
])
ok(
  searchContextBlock.startsWith(WEB_SEARCH_CONTEXT_OPEN.replace('>', ' query=')),
  'search context block uses the shared web_search_context opening tag'
)
ok(searchContextBlock.includes(WEB_SEARCH_CONTEXT_CLOSE), 'search context block closes with the shared tag')
ok(
  (searchContextBlock.match(new RegExp(WEB_SEARCH_CONTEXT_CLOSE.replace('/', '\\/'), 'g')) ?? []).length === 1,
  'external text cannot inject a second search context closing tag'
)
ok(
  DEFAULT_SYSTEM_PROMPTS.en?.includes(WEB_SEARCH_CONTEXT_OPEN) === true &&
    DEFAULT_SYSTEM_PROMPTS.zh?.includes(WEB_SEARCH_CONTEXT_OPEN) === true,
  'system prompt guard rules and retrieval block use the same tag'
)

// ---------------------------------------------------------------------------
// 编码回退（浏览器 TextDecoder 实测）
// ---------------------------------------------------------------------------
const gbk = new Uint8Array([0xb9, 0xa4, 0xb3, 0xcc, 0xc8, 0xd5, 0xd6, 0xbe])
eq(decodeTextBytes(gbk), { text: '工程日志', encoding: 'gb18030' }, 'browser GB18030 fallback')

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const waitForCondition = async (
  predicate: () => boolean,
  timeoutMs = 8000
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (predicate()) {
        return true
      }
    } catch {
      // iframe 尚未完成导航时继续等待
    }
    await sleep(60)
  }
  return false
}

interface MockSseStream {
  response: Response
  push: (text: string) => void
  close: () => void
}

/** 可手动喂帧的 SSE 响应：在真实 IndexedDB 上复现流式生成途中的删除 / 软复位竞态 */
const makeMockSseStream = (): MockSseStream => {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next
    },
  })
  return {
    response: new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    push: (text: string) => {
      try {
        controller?.enqueue(encoder.encode(text))
      } catch {
        // 流已被取消：旧帧丢弃即可
      }
    },
    close: () => {
      try {
        controller?.close()
      } catch {
        // 流已被取消
      }
    },
  }
}

const makeSession = (id: string, content: string, createdAt = Date.now()): Session => ({
  id,
  title: `session ${id}`,
  createdAt,
  updatedAt: createdAt,
  messages: [
    {
      id: `${id}-u`,
      role: 'user',
      content,
      attachments: [],
      createdAt,
    },
    {
      id: `${id}-a`,
      role: 'assistant',
      content: 'ack',
      status: 'done',
      createdAt: createdAt + 1,
    },
  ],
})

// ---------------------------------------------------------------------------
// 事务中止与读取门控测试夹具
// ---------------------------------------------------------------------------

interface GatedIdbRequest {
  request: IDBRequest
  key: IDBValidKey
  release: () => void
}

/**
 * 构造“可延后放行”的 IDBRequest 替身，用于精确控制两次 selectSession 的读取回调顺序。
 *
 * 用 Object.create(IDBRequest.prototype) 保证 idb 的 `instanceof IDBRequest` 判定成立，
 * 但 addEventListener / removeEventListener 由测试接管：真实请求可以照常完成并提交事务，
 * 只有调用 release() 时替身才向 idb 派发 success，从而让旧 A 的回调停在新 A' 之后。
 */
const createGatedRequest = (real: IDBRequest, key: IDBValidKey): GatedIdbRequest => {
  const listeners = new Map<string, Set<(event: Event) => void>>()
  const fake = Object.create(IDBRequest.prototype) as IDBRequest
  Object.defineProperties(fake, {
    result: { configurable: true, get: () => real.result },
    error: { configurable: true, get: () => real.error },
    addEventListener: {
      configurable: true,
      value: (type: string, listener: (event: Event) => void) => {
        let bucket = listeners.get(type)
        if (!bucket) {
          bucket = new Set()
          listeners.set(type, bucket)
        }
        bucket.add(listener)
      },
    },
    removeEventListener: {
      configurable: true,
      value: (type: string, listener: (event: Event) => void) => {
        listeners.get(type)?.delete(listener)
      },
    },
  })
  let released = false
  const dispatch = () => {
    if (released) {
      return
    }
    released = true
    for (const listener of listeners.get('success') ?? []) {
      listener(new Event('success'))
    }
  }
  return {
    request: fake,
    key,
    release: () => {
      if (real.readyState === 'done') {
        dispatch()
      } else {
        real.addEventListener('success', () => dispatch(), { once: true })
      }
    },
  }
}

interface IdbAbortTicket {
  fired: boolean
  cancel: () => void
}

type AbortableReadMethod = 'count' | 'get' | 'getAll'

/**
 * 原生 IDBTransaction 中止注入器（仅测试用）。
 *
 * 包装原生 `IDBDatabase.prototype.transaction` 记录每个事务的 store 与 mode，再包装
 * `IDBObjectStore.prototype.count / get / getAll`：被武装的“store + 方法”在目标 readonly
 * 事务里入队请求后，于微任务末尾调用原生 `tx.abort()`，复现浏览器真实的中止时序。
 * 升级事务通过包装 `IDBOpenDBRequest.prototype.addEventListener` 挂在 idb 自己的
 * upgradeneeded 监听器之后，等升级回调建好 store 并消费 tx.done 后再中止 versionchange 事务。
 */
const createIdbAbortInjector = () => {
  const databaseProto = IDBDatabase.prototype as unknown as Record<string, unknown>
  const storeProto = IDBObjectStore.prototype as unknown as Record<string, unknown>
  const openRequestProto = IDBOpenDBRequest.prototype as unknown as Record<string, unknown>
  const originalTransaction = databaseProto.transaction as (...args: unknown[]) => IDBTransaction
  const originalAddEventListener = openRequestProto.addEventListener as (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) => void
  const readMethods: AbortableReadMethod[] = ['count', 'get', 'getAll']
  const originalReads = new Map<AbortableReadMethod, (...args: unknown[]) => unknown>()

  interface ReadRule {
    store: string
    method: AbortableReadMethod
    key: IDBValidKey | undefined
    ticket: IdbAbortTicket
    cancelled: boolean
  }

  interface UpgradeRule {
    request: IDBOpenDBRequest | null
    ticket: IdbAbortTicket
    cancelled: boolean
  }

  const readRules: ReadRule[] = []
  const upgradeRules: UpgradeRule[] = []
  // 只允许中止通过被包装的 transaction() 原生创建的事务，避免误伤别处伪造的对象
  const createdTransactions = new WeakSet<IDBTransaction>()
  let installed = false

  const armReadAbort = (
    store: string,
    method: AbortableReadMethod,
    key?: IDBValidKey
  ): IdbAbortTicket => {
    const ticket: IdbAbortTicket = { fired: false, cancel: () => undefined }
    const rule: ReadRule = {
      store,
      method,
      key,
      ticket,
      cancelled: false,
    }
    ticket.cancel = () => {
      rule.cancelled = true
    }
    readRules.push(rule)
    return ticket
  }

  const armUpgradeAbort = (): IdbAbortTicket => {
    const ticket: IdbAbortTicket = { fired: false, cancel: () => undefined }
    const rule: UpgradeRule = { request: null, ticket, cancelled: false }
    ticket.cancel = () => {
      rule.cancelled = true
    }
    upgradeRules.push(rule)
    return ticket
  }

  const install = () => {
    if (installed) {
      return
    }
    installed = true
    databaseProto.transaction = function patchedTransaction(
      this: IDBDatabase,
      ...args: unknown[]
    ) {
      const tx = originalTransaction.apply(this, args)
      createdTransactions.add(tx)
      return tx
    }
    for (const method of readMethods) {
      const original = storeProto[method] as (...args: unknown[]) => unknown
      originalReads.set(method, original)
      storeProto[method] = function patchedRead(this: IDBObjectStore, ...args: unknown[]) {
        const request = original.apply(this, args)
        for (const rule of readRules) {
          if (rule.cancelled || rule.ticket.fired) {
            continue
          }
          if (
            !createdTransactions.has(this.transaction) ||
            this.transaction.mode !== 'readonly'
          ) {
            continue
          }
          if (rule.store !== this.name || rule.method !== method) {
            continue
          }
          if (rule.key !== undefined && args[0] !== rule.key) {
            continue
          }
          rule.ticket.fired = true
          const tx = this.transaction
          // 请求入队后到 microtask 末尾再中止：浏览器会把请求以 AbortError 拒绝，
          // 同时 tx.done 也拒绝——正是旧快捷调用会泄漏全局 unhandledrejection 的路径
          queueMicrotask(() => {
            try {
              tx.abort()
            } catch {
              // 事务可能已经提交或中止
            }
          })
          break
        }
        return request
      }
    }
    openRequestProto.addEventListener = function patchedAddEventListener(
      this: IDBOpenDBRequest,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions
    ) {
      originalAddEventListener.call(this, type, listener, options)
      if (type !== 'upgradeneeded') {
        return
      }
      for (const rule of upgradeRules) {
        if (rule.cancelled || rule.ticket.fired || rule.request !== null) {
          continue
        }
        rule.request = this
        // idb 先注册自己的 upgrade 监听器，这里在其后追加：升级回调已经建好 store、
        // 也已经执行了 `void transaction.done.catch(...)`，此时中止才是真实时序
        originalAddEventListener.call(this, 'upgradeneeded', () => {
          if (rule.ticket.fired) {
            return
          }
          rule.ticket.fired = true
          const request = this
          queueMicrotask(() => {
            try {
              request.transaction?.abort()
            } catch {
              // 升级事务可能已经提交
            }
          })
        })
        break
      }
    }
  }

  const uninstall = () => {
    if (!installed) {
      return
    }
    installed = false
    readRules.length = 0
    upgradeRules.length = 0
    databaseProto.transaction = originalTransaction
    openRequestProto.addEventListener = originalAddEventListener
    for (const method of readMethods) {
      const original = originalReads.get(method)
      if (original) {
        storeProto[method] = original
      }
    }
    originalReads.clear()
  }

  return { install, uninstall, armReadAbort, armUpgradeAbort }
}

const deleteConsoleDatabase = () =>
  new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('engineering-ai-console')
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })

/** 删掉整库并丢弃 db.ts 里的连接缓存，让下一次访问真正走一次 openDB 升级流程 */
const resetConsoleDatabase = async (): Promise<void> => {
  try {
    await clearDatabase()
  } catch {
    // 上一次中止可能留下半初始化状态：直接删除重建
  }
  await deleteConsoleDatabase()
}

/** 造一个 version 1 的旧库（只有 sessions），用于触发 v1→v2 的摘要回填路径 */
const seedLegacyDatabase = async (session: Session): Promise<void> => {
  await resetConsoleDatabase()
  const legacy = await openDB('engineering-ai-console', 1, {
    upgrade(db) {
      db.createObjectStore('sessions', { keyPath: 'id' })
    },
  })
  await legacy.put('sessions', session)
  legacy.close()
}

const runAsyncTests = async () => {
  // 1) 真实备份导入 + 会话切换：会话 id 是原型链键也不能白屏
  await clearDatabase()
  const protoSessions = [makeSession('toString', 'hello proto'), makeSession('__proto__', 'hello dunder')]
  const backupJson = JSON.stringify(buildJsonBackup(protoSessions))
  const parsed = parseJsonBackup(backupJson)
  ok(parsed.ok, 'backup with prototype-shaped ids parses')
  if (parsed.ok) {
    const restored = await restoreJsonBackup(parsed.sessions)
    eq(restored.sessions, 2, 'backup import writes both prototype-shaped sessions')
  }
  useChatStore.setState({
    ready: true,
    activeId: null,
    sessionCache: {},
    summaries: await listSessionSummaries(),
    streaming: {},
    pendingCapsule: null,
  })
  await selectSession('toString')
  eq(useChatStore.getState().activeId, 'toString', 'switching to the toString session keeps the id')
  eq(getCachedSession('toString')?.messages[0]?.content, 'hello proto', 'toString session renders its real content')
  ok(getCachedSession('valueOf') === undefined, 'valueOf is not a cached session')
  await selectSession('__proto__')
  eq(getCachedSession('__proto__')?.messages[0]?.content, 'hello dunder', '__proto__ session renders its real content')
  ok(
    Object.getPrototypeOf(useChatStore.getState().sessionCache) === Object.prototype,
    'session cache keeps Object.prototype after importing a __proto__ key'
  )
  ok(true, 'switching prototype-shaped sessions completes without a render-time exception')

  // 2) 硬复位：另一连接打开数据库时，原子 clear 立即成功且不使另一连接失效
  const otherConnection = await openDB('engineering-ai-console')
  await clearDatabase()
  eq((await listSessionSummaries()).length, 0, 'atomic clear empties the summaries store')
  const otherRows = await otherConnection.getAll('sessions')
  eq(otherRows.length, 0, 'another open connection stays valid after the atomic clear')
  await otherConnection.put('sessions', makeSession('after-reset', 'still writable'))
  const written = await otherConnection.get('sessions', 'after-reset')
  ok(Boolean(written), 'another open connection can still write after the atomic clear')
  otherConnection.close()
  await clearDatabase()

  // 3) 导入中途写入异常：整批回滚，不留半截会话
  await importSessionsAtomically([makeSession('baseline', 'keep me')])
  const baselineCount = (await loadAllSessions()).length
  const storePrototype = IDBObjectStore.prototype as unknown as Record<string, unknown>
  const originalPut = storePrototype.put as (...args: unknown[]) => unknown
  let putCalls = 0
  let quotaRolledBack = false
  try {
    Object.defineProperty(storePrototype, 'put', {
      configurable: true,
      writable: true,
      value: function patchedPut(this: IDBObjectStore, ...args: unknown[]) {
        putCalls += 1
        if (putCalls === 3) {
          throw new DOMException('simulated quota exceeded', 'QuotaExceededError')
        }
        return originalPut.apply(this, args)
      },
    })
    try {
      await importSessionsAtomically([
        makeSession('quota-a', 'first half'),
        makeSession('quota-b', 'second half'),
      ])
    } catch {
      quotaRolledBack = true
    }
  } finally {
    Object.defineProperty(storePrototype, 'put', {
      configurable: true,
      writable: true,
      value: originalPut,
    })
  }
  ok(quotaRolledBack, 'simulated QuotaExceededError rejects the import')
  const afterQuota = await loadAllSessions()
  eq(afterQuota.length, baselineCount, 'failed import leaves the session count unchanged')
  ok(
    !afterQuota.some((session) => session.id === 'quota-a' || session.id === 'quota-b'),
    'failed import leaves no half-written sessions behind'
  )

  // 3b) 事务中止连带产生的 rejection 不得逃逸成浏览器全局未处理事件
  const unhandledRejections: unknown[] = []
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    unhandledRejections.push(event.reason)
  }
  window.addEventListener('unhandledrejection', onUnhandledRejection)
  try {
    const atomicStoreProto = IDBObjectStore.prototype as unknown as Record<string, unknown>
    const atomicOriginalPut = atomicStoreProto.put as (...args: unknown[]) => unknown
    let atomicPutCalls = 0
    Object.defineProperty(atomicStoreProto, 'put', {
      configurable: true,
      writable: true,
      value: function patchedAtomicPut(this: IDBObjectStore, ...args: unknown[]) {
        atomicPutCalls += 1
        if (atomicPutCalls === 3) {
          throw new DOMException('simulated quota exceeded', 'QuotaExceededError')
        }
        return atomicOriginalPut.apply(this, args)
      },
    })
    let atomicImportFailed = false
    try {
      await importSessionsAtomically([
        makeSession('atomic-quota-a', 'first half'),
        makeSession('atomic-quota-b', 'second half'),
      ])
    } catch {
      atomicImportFailed = true
    } finally {
      Object.defineProperty(atomicStoreProto, 'put', {
        configurable: true,
        writable: true,
        value: atomicOriginalPut,
      })
    }
    ok(atomicImportFailed, 'quota failure rejects the atomic import')
    // 给浏览器留出上报 unhandledrejection 的任务边界
    await sleep(300)
  } finally {
    window.removeEventListener('unhandledrejection', onUnhandledRejection)
  }
  eq(
    unhandledRejections.length,
    0,
    'aborted import transaction never leaks a global unhandled rejection'
  )
  const afterAtomicQuota = await loadAllSessions()
  eq(
    afterAtomicQuota.length,
    baselineCount,
    'second quota rollback also leaves the session count unchanged'
  )

  // 4) 发送后落盘期间新敲的草稿：成功回调也绝不能清掉
  clearAllDrafts()
  const settings = createDefaultSettings()
  settings.channels.primary = {
    ...createChannelConfig('Primary'),
    baseUrl: 'http://127.0.0.1:9',
    model: 'selftest-model',
  }
  useConfigStore.setState({
    mode: 'static',
    ready: true,
    offline: false,
    settings,
  })
  const raceSession = makeSession('draft-save-race', '', Date.now())
  useChatStore.setState({
    ready: true,
    activeId: 'draft-save-race',
    sessionCache: { 'draft-save-race': raceSession },
    summaries: [],
    streaming: {},
    pendingCapsule: null,
  })
  setDraftText('draft-save-race', 'old draft text')
  const sent = sendMessage({ text: 'old draft text', attachments: [] })
  eq(sent, true, 'draft race send starts')
  eq(getDraft('draft-save-race').text, '', 'input clears immediately on send')
  setDraftText('draft-save-race', 'typed while the first save was running')
  await sleep(250)
  eq(
    getDraft('draft-save-race').text,
    'typed while the first save was running',
    'successful IndexedDB save callback never clears newer input'
  )
  softReset()
  await sleep(50)
  clearAllDrafts()

  // 4b) 真实 IndexedDB + 真实 SSE 解析：流式途中删除会话 / 清空会话 / 软复位重试
  const originalFetch = globalThis.fetch
  const resetStreamConfig = () => {
    const streamSettings = createDefaultSettings()
    streamSettings.channels.primary = {
      ...createChannelConfig('Primary'),
      baseUrl: 'http://127.0.0.1:9',
      model: 'selftest-model',
    }
    useConfigStore.setState({
      mode: 'static',
      ready: true,
      offline: false,
      settings: streamSettings,
    })
  }
  const fetchWithStreams = (bucket: MockSseStream[]) => {
    globalThis.fetch = (() => {
      const stream = makeMockSseStream()
      bucket.push(stream)
      return Promise.resolve(stream.response)
    }) as typeof fetch
  }
  try {
    // 4b-1) 流式途中 deleteSession：IndexedDB 重读为 0，草稿一并清空
    resetStreamConfig()
    await clearDatabase()
    clearAllDrafts()
    useChatStore.setState({
      ready: true,
      activeId: null,
      sessionCache: {},
      summaries: [],
      streaming: {},
      pendingCapsule: null,
    })
    const deleteStreams: MockSseStream[] = []
    fetchWithStreams(deleteStreams)
    eq(
      sendMessage({ text: 'delete during stream', attachments: [] }),
      true,
      'delete-while-streaming send starts'
    )
    const liveDeletingId = useChatStore.getState().activeId ?? ''
    ok(Boolean(liveDeletingId), 'delete-while-streaming session id assigned')
    setDraftText(liveDeletingId, 'draft that must vanish with the session')
    deleteStreams[0].push('data: {"choices":[{"delta":{"content":"half"}}]}\n\n')
    await sleep(420)
    ok(
      localStorage.getItem(`eac:draft:session:${liveDeletingId}`) !== null,
      'draft is persisted to localStorage before deletion'
    )
    await deleteSession(liveDeletingId)
    eq(getDraft(liveDeletingId).text, '', 'deleteSession clears the in-memory draft')
    eq(
      localStorage.getItem(`eac:draft:session:${liveDeletingId}`),
      null,
      'deleteSession clears the persisted draft'
    )
    eq(getCachedSession(liveDeletingId), undefined, 'deleteSession drops the cached session')
    // 旧上游流随后收尾；重开连接等价于刷新后重读 IndexedDB
    deleteStreams[0].push('data: [DONE]\n\n')
    deleteStreams[0].close()
    await sleep(300)
    const afterDeleteDb = await openDB('engineering-ai-console')
    const afterDeleteRows = (await afterDeleteDb.getAll('sessions')) as Session[]
    const afterDeleteSummaries = (await afterDeleteDb.getAll('summaries')) as Session[]
    afterDeleteDb.close()
    eq(
      afterDeleteRows.filter((row) => row.id === liveDeletingId).length,
      0,
      'deleted session never reappears in a fresh IndexedDB read'
    )
    eq(
      afterDeleteSummaries.filter((row) => row.id === liveDeletingId).length,
      0,
      'deleted summary never reappears in a fresh IndexedDB read'
    )

    // 4b-2) 流式途中 deleteAllSessions：会话库与草稿缓存全部归零且不复活
    resetStreamConfig()
    await clearDatabase()
    clearAllDrafts()
    useChatStore.setState({
      ready: true,
      activeId: null,
      sessionCache: {},
      summaries: [],
      streaming: {},
      pendingCapsule: null,
    })
    const wipeStreams: MockSseStream[] = []
    fetchWithStreams(wipeStreams)
    eq(
      sendMessage({ text: 'wipe during stream', attachments: [] }),
      true,
      'delete-all-while-streaming send starts'
    )
    const wipingId = useChatStore.getState().activeId ?? ''
    setDraftText(wipingId, 'leftover draft after wipe')
    wipeStreams[0].push('data: {"choices":[{"delta":{"content":"half"}}]}\n\n')
    await sleep(420)
    ok(
      localStorage.getItem(`eac:draft:session:${wipingId}`) !== null,
      'draft is persisted before the full wipe'
    )
    await deleteAllSessions()
    eq(useChatStore.getState().summaries.length, 0, 'deleteAllSessions clears the summary list')
    eq(useChatStore.getState().activeId, null, 'deleteAllSessions resets the active session')
    eq(
      Object.keys(useChatStore.getState().sessionCache).length,
      0,
      'deleteAllSessions clears the session cache'
    )
    eq(getDraft(wipingId).text, '', 'deleteAllSessions clears the in-memory draft')
    eq(
      localStorage.getItem(`eac:draft:session:${wipingId}`),
      null,
      'deleteAllSessions clears the persisted draft'
    )
    wipeStreams[0].push('data: [DONE]\n\n')
    wipeStreams[0].close()
    await sleep(300)
    const wipedDb = await openDB('engineering-ai-console')
    const wipedSessions = (await wipedDb.getAll('sessions')) as Session[]
    const wipedSummaries = (await wipedDb.getAll('summaries')) as Session[]
    wipedDb.close()
    eq(wipedSessions.length, 0, 'deleteAllSessions leaves zero sessions after a fresh IndexedDB read')
    eq(wipedSummaries.length, 0, 'deleteAllSessions leaves zero summaries after a fresh IndexedDB read')

    // 4b-3) 软复位后立即同消息重试：旧取消回调不得把新尝试标成 stopped
    resetStreamConfig()
    await clearDatabase()
    clearAllDrafts()
    const retrySession: Session = {
      id: 'soft-retry-browser',
      title: 'soft retry browser',
      createdAt: 1,
      updatedAt: 1,
      messages: [
        { id: 'u1', role: 'user', content: 'question', attachments: [], createdAt: 2 },
        { id: 'a1', role: 'assistant', content: '', status: 'done', createdAt: 3 },
      ],
    }
    useChatStore.setState({
      ready: true,
      activeId: 'soft-retry-browser',
      sessionCache: { 'soft-retry-browser': retrySession },
      summaries: [toSessionSummary(retrySession)],
      streaming: {},
      pendingCapsule: null,
    })
    const browserRetryStreams: MockSseStream[] = []
    fetchWithStreams(browserRetryStreams)
    eq(retryAssistant('soft-retry-browser', 'a1'), true, 'browser retry attempt starts')
    await waitForCondition(() => browserRetryStreams.length === 1, 2000)
    browserRetryStreams[0].push('data: {"choices":[{"delta":{"content":"old-"}}]}\n\n')
    await sleep(150)
    softReset()
    eq(
      retryAssistant('soft-retry-browser', 'a1'),
      true,
      'immediate same-message retry after a browser soft reset starts'
    )
    await waitForCondition(() => browserRetryStreams.length === 2, 2000)
    await sleep(200)
    const assistantAfterSoftReset = (() => {
      const session = getCachedSession('soft-retry-browser')
      const message = session?.messages.find((item) => item.id === 'a1')
      return message && message.role === 'assistant' ? message : undefined
    })()
    ok(
      assistantAfterSoftReset?.status !== 'stopped' && assistantAfterSoftReset?.status !== 'error',
      'stale stream cancellation never marks the newer browser retry as stopped',
      String(assistantAfterSoftReset?.status)
    )
    browserRetryStreams[1].push(
      'data: {"choices":[{"delta":{"content":"new-answer"}}]}\n\n'
    )
    browserRetryStreams[1].push('data: [DONE]\n\n')
    browserRetryStreams[1].close()
    await waitForCondition(
      () => useChatStore.getState().streaming['soft-retry-browser'] !== true,
      5000
    )
    const finishedRetry = (() => {
      const session = getCachedSession('soft-retry-browser')
      const message = session?.messages.find((item) => item.id === 'a1')
      return message && message.role === 'assistant' ? message : undefined
    })()
    eq(finishedRetry?.content, 'new-answer', 'only the new attempt content survives')
    eq(finishedRetry?.status, 'done', 'new attempt finishes as done')
    await sleep(300)
    const retryDb = await openDB('engineering-ai-console')
    const storedRetry = (await retryDb.get('sessions', 'soft-retry-browser')) as Session | undefined
    retryDb.close()
    const storedAssistant = storedRetry?.messages.find((item) => item.id === 'a1')
    eq(
      storedAssistant && storedAssistant.role === 'assistant' ? storedAssistant.content : undefined,
      'new-answer',
      'IndexedDB persists only the new attempt result'
    )
    eq(
      storedAssistant && storedAssistant.role === 'assistant' ? storedAssistant.status : undefined,
      'done',
      'IndexedDB persists the final done status'
    )
  } finally {
    globalThis.fetch = originalFetch
    softReset()
    await sleep(50)
    clearAllDrafts()
    await clearDatabase()
  }

  // 4c) 过期 selectSession 读取 + 同 ID 备份导入：旧内容绝不覆盖导入后的新内容
  await clearDatabase()
  clearAllDrafts()
  useChatStore.setState({
    ready: true,
    activeId: null,
    sessionCache: {},
    summaries: [],
    streaming: {},
    pendingCapsule: null,
  })
  const staleSessionId = 'stale-read-imported'
  const oldSession = makeSession(staleSessionId, 'OLD CONTENT', Date.now() - 60_000)
  await saveSession(oldSession)
  useChatStore.setState({ summaries: await listSessionSummaries() })
  const staleStoreProto = IDBObjectStore.prototype as unknown as Record<string, unknown>
  const staleOriginalGet = staleStoreProto.get as (...args: unknown[]) => unknown
  let staleReadPending = false
  const staleReadGate: { release: ((value: Session | undefined) => void) | null } = {
    release: null,
  }
  try {
    Object.defineProperty(staleStoreProto, 'get', {
      configurable: true,
      writable: true,
      value: function patchedStaleGet(this: IDBObjectStore, ...args: unknown[]) {
        if (this.name === 'sessions' && args[0] === staleSessionId) {
          staleReadPending = true
          // 假 thenable：idb 会 await 这里返回的“请求”，读取完成时机由测试显式放行
          return {
            then(resolve: (value: Session | undefined) => void) {
              staleReadGate.release = resolve
            },
          }
        }
        return staleOriginalGet.apply(this, args)
      },
    })
    const selecting = selectSession(staleSessionId)
    ok(
      await waitForCondition(() => staleReadPending, 3000),
      'selectSession starts a pending IndexedDB read for the target session'
    )
    await deleteSession(staleSessionId)
    eq(getCachedSession(staleSessionId), undefined, 'deleting the session clears its memory cache')
    staleReadGate.release?.(oldSession)
    await selecting
    eq(
      getCachedSession(staleSessionId),
      undefined,
      'stale read that outlived the deletion is discarded instead of reviving the session'
    )
    eq(useChatStore.getState().activeId, null, 'deleted session is no longer selected')
  } finally {
    Object.defineProperty(staleStoreProto, 'get', {
      configurable: true,
      writable: true,
      value: staleOriginalGet,
    })
  }
  const restoredText = 'NEW RESTORED CONTENT'
  const importResult = await importJsonBackup(
    JSON.stringify(buildJsonBackup([makeSession(staleSessionId, restoredText, Date.now())]))
  )
  ok(importResult.ok, 'same-id JSON backup import succeeds after the deletion')
  eq(
    Object.keys(useChatStore.getState().sessionCache).length,
    0,
    'backup import leaves no stale cache entry for the re-imported session'
  )
  ok(
    useChatStore.getState().summaries.some((summary) => summary.id === staleSessionId),
    'imported session reappears in the summary list'
  )
  await selectSession(staleSessionId)
  eq(
    getCachedSession(staleSessionId)?.messages[0]?.content,
    restoredText,
    'selecting the imported session loads the restored content, not the stale read'
  )
  const postImportSettings = createDefaultSettings()
  postImportSettings.channels.primary = {
    ...createChannelConfig('Primary'),
    baseUrl: 'http://127.0.0.1:9',
    model: 'selftest-model',
  }
  useConfigStore.setState({
    mode: 'static',
    ready: true,
    offline: false,
    settings: postImportSettings,
  })
  eq(
    sendMessage({ text: 'message after import', attachments: [] }),
    true,
    'sending into the imported session starts after the import'
  )
  await waitForCondition(
    () => useChatStore.getState().streaming[staleSessionId] !== true,
    5000
  )
  await sleep(150)
  const persistedAfterImport = await loadSession(staleSessionId)
  const persistedUserTexts = (persistedAfterImport?.messages ?? [])
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
  eq(
    persistedUserTexts,
    [restoredText, 'message after import'],
    'IndexedDB keeps the restored history plus the new message'
  )
  ok(
    !persistedUserTexts.some((content) => content.includes('OLD CONTENT')),
    'stale pre-delete content never returns to IndexedDB'
  )

  // 4d) 附件解析途中删除会话：解析完成后不得把草稿写回内存或 localStorage
  await clearDatabase()
  clearAllDrafts()
  const attachmentSessionId = 'attachment-parse-race'
  const attachmentSession = makeSession(attachmentSessionId, 'attachment draft target')
  useChatStore.setState({
    ready: true,
    activeId: attachmentSessionId,
    sessionCache: { [attachmentSessionId]: attachmentSession },
    summaries: [toSessionSummary(attachmentSession)],
    streaming: {},
    pendingCapsule: null,
  })
  const parseEpoch = useChatStore.getState().resetEpoch
  const parseSessionRev = getSessionRev(attachmentSessionId)
  const pendingAttachment = new File(['pending attachment body'], 'pending.txt', {
    type: 'text/plain',
  })
  const attachmentGate: { release: (() => void) | null } = { release: null }
  Object.defineProperty(pendingAttachment, 'arrayBuffer', {
    configurable: true,
    value: () =>
      new Promise<ArrayBuffer>((resolve) => {
        attachmentGate.release = () =>
          resolve(new TextEncoder().encode('pending attachment body').buffer)
      }),
  })
  const parsingAttachment = parseAttachmentFile(pendingAttachment, { remote: null })
  ok(
    await waitForCondition(() => attachmentGate.release !== null, 2000),
    'attachment parsing is held in the middle of the file read'
  )
  await deleteSession(attachmentSessionId)
  eq(
    getDraft(attachmentSessionId).attachments.length,
    0,
    'deleting the session clears its in-memory draft'
  )
  attachmentGate.release?.()
  const parsedAttachment = await parsingAttachment
  eq(parsedAttachment.kind, 'text', 'held attachment finishes parsing after the deletion')
  eq(
    addParsedAttachmentIfAlive(attachmentSessionId, parseEpoch, parseSessionRev, parsedAttachment),
    false,
    'parsed attachment write is rejected for the deleted session'
  )
  eq(
    getDraft(attachmentSessionId).attachments.length,
    0,
    'parsed attachment never reaches the deleted session draft'
  )
  await sleep(450)
  eq(
    localStorage.getItem(`eac:draft:session:${attachmentSessionId}`),
    null,
    'no draft residue is written to localStorage after the parse completes'
  )
  await clearDatabase()
  clearAllDrafts()
  useChatStore.setState({
    ready: true,
    activeId: null,
    sessionCache: {},
    summaries: [],
    streaming: {},
    pendingCapsule: null,
  })

  // 4e) 删除事务被 abort：UI、摘要与未发草稿零丢失，只弹失败提示（P1-05）
  await clearDatabase()
  clearAllDrafts()
  const failingDeleteId = 'delete-transaction-fail'
  const failingDeleteSession = makeSession(failingDeleteId, 'keep me after a failed delete')
  await saveSession(failingDeleteSession)
  useChatStore.setState({
    ready: true,
    activeId: failingDeleteId,
    sessionCache: { [failingDeleteId]: failingDeleteSession },
    summaries: [toSessionSummary(failingDeleteSession)],
    streaming: {},
    pendingCapsule: null,
  })
  setDraftText(failingDeleteId, 'unsent draft must survive a failed delete')
  await sleep(420)
  const deleteTargetProto = IDBObjectStore.prototype as unknown as Record<string, unknown>
  const originalDeleteRequest = deleteTargetProto.delete as (...args: unknown[]) => unknown
  let deleteAbortInjected = false
  try {
    Object.defineProperty(deleteTargetProto, 'delete', {
      configurable: true,
      writable: true,
      value: function patchedDelete(this: IDBObjectStore, ...args: unknown[]) {
        if (!deleteAbortInjected && this.name === 'sessions') {
          deleteAbortInjected = true
          throw new DOMException('simulated delete transaction abort', 'AbortError')
        }
        return originalDeleteRequest.apply(this, args)
      },
    })
    await deleteSession(failingDeleteId)
  } finally {
    Object.defineProperty(deleteTargetProto, 'delete', {
      configurable: true,
      writable: true,
      value: originalDeleteRequest,
    })
  }
  ok(deleteAbortInjected, 'the simulated IndexedDB delete abort fired')
  ok(
    Boolean(getCachedSession(failingDeleteId)),
    'a failed delete keeps the session in the memory cache instead of wiping it'
  )
  ok(
    useChatStore.getState().summaries.some((summary) => summary.id === failingDeleteId),
    'a failed delete keeps the session summary'
  )
  eq(
    getDraft(failingDeleteId).text,
    'unsent draft must survive a failed delete',
    'a failed delete preserves the unsent draft text'
  )
  ok(
    localStorage.getItem(`eac:draft:session:${failingDeleteId}`) !== null,
    'a failed delete preserves the persisted draft snapshot'
  )
  eq(
    (useToast.getState().message as { key?: string } | null)?.key,
    'deleteFailed',
    'a failed delete reports the localized delete failure toast'
  )
  ok(
    Boolean(await loadSession(failingDeleteId)),
    'the IndexedDB record still exists after the aborted delete transaction'
  )
  await deleteSession(failingDeleteId)
  eq(getCachedSession(failingDeleteId), undefined, 'retrying after the abort removes the session')
  eq(getDraft(failingDeleteId).text, '', 'retrying after the abort clears the draft')
  eq(await loadSession(failingDeleteId), null, 'retrying after the abort removes the IndexedDB record')

  // 4f) 清空全部会话的事务被 abort：会话、缓存与全部草稿零丢失（P1-05）
  await clearDatabase()
  clearAllDrafts()
  const wipeFailA = makeSession('wipe-fail-a', 'first kept session')
  const wipeFailB = makeSession('wipe-fail-b', 'second kept session')
  await saveSession(wipeFailA)
  await saveSession(wipeFailB)
  useChatStore.setState({
    ready: true,
    activeId: 'wipe-fail-a',
    sessionCache: { 'wipe-fail-a': wipeFailA, 'wipe-fail-b': wipeFailB },
    summaries: [toSessionSummary(wipeFailA), toSessionSummary(wipeFailB)],
    streaming: {},
    pendingCapsule: null,
  })
  setDraftText('wipe-fail-a', 'draft A must survive a failed wipe')
  setDraftText('wipe-fail-b', 'draft B must survive a failed wipe')
  await sleep(420)
  const wipeProto = IDBObjectStore.prototype as unknown as Record<string, unknown>
  const originalClearRequest = wipeProto.clear as (...args: unknown[]) => unknown
  let clearAbortInjected = false
  try {
    Object.defineProperty(wipeProto, 'clear', {
      configurable: true,
      writable: true,
      value: function patchedClear(this: IDBObjectStore, ...args: unknown[]) {
        if (!clearAbortInjected) {
          clearAbortInjected = true
          throw new DOMException('simulated clear transaction abort', 'AbortError')
        }
        return originalClearRequest.apply(this, args)
      },
    })
    await deleteAllSessions()
  } finally {
    Object.defineProperty(wipeProto, 'clear', {
      configurable: true,
      writable: true,
      value: originalClearRequest,
    })
  }
  ok(clearAbortInjected, 'the simulated IndexedDB clear abort fired')
  eq(
    useChatStore.getState().summaries.map((summary) => summary.id).sort(),
    ['wipe-fail-a', 'wipe-fail-b'],
    'a failed delete-all keeps the summary list intact'
  )
  ok(
    Boolean(getCachedSession('wipe-fail-a')) && Boolean(getCachedSession('wipe-fail-b')),
    'a failed delete-all keeps both session cache entries'
  )
  eq(getDraft('wipe-fail-a').text, 'draft A must survive a failed wipe', 'a failed delete-all keeps draft A')
  eq(getDraft('wipe-fail-b').text, 'draft B must survive a failed wipe', 'a failed delete-all keeps draft B')
  eq(
    (useToast.getState().message as { key?: string } | null)?.key,
    'deleteAllFailed',
    'a failed delete-all reports the localized failure toast'
  )
  eq((await loadAllSessions()).length, 2, 'a failed delete-all leaves both IndexedDB records')
  await deleteAllSessions()
  eq(useChatStore.getState().summaries.length, 0, 'retrying the delete-all clears the summary list')
  eq(Object.keys(useChatStore.getState().sessionCache).length, 0, 'retrying the delete-all clears the cache')
  eq(getDraft('wipe-fail-a').text, '', 'retrying the delete-all clears draft A')
  eq((await loadAllSessions()).length, 0, 'retrying the delete-all empties IndexedDB')
  clearAllDrafts()

  // 4f-2) 删除 / 清空事务 abort：只向主调用 Promise 抛一次，绝不产生全局 unhandledrejection
  await clearDatabase()
  clearAllDrafts()
  const abortRejections: unknown[] = []
  const onAbortRejection = (event: PromiseRejectionEvent) => {
    abortRejections.push(event.reason)
  }
  window.addEventListener('unhandledrejection', onAbortRejection)
  const abortSession = makeSession('abort-record-target', 'must survive an aborted delete')
  await saveSession(abortSession)
  const abortStoreProto = IDBObjectStore.prototype as unknown as Record<string, unknown>
  const abortOriginalDelete = abortStoreProto.delete as (...args: unknown[]) => unknown
  let abortDeleteRejected = false
  try {
    Object.defineProperty(abortStoreProto, 'delete', {
      configurable: true,
      writable: true,
      value: function patchedAbortDelete(this: IDBObjectStore, ...args: unknown[]) {
        const request = abortOriginalDelete.apply(this, args)
        if (this.name === 'sessions') {
          // 排入请求后在本轮微任务末尾中止事务：两个删除请求都已交给 Promise.all，
          // 请求以 AbortError 失败、事务的 tx.done 也会再次拒绝，这正是旧实现漏出
          // 全局 unhandledrejection 的真实路径
          queueMicrotask(() => {
            try {
              this.transaction.abort()
            } catch {
              // 事务可能已结束
            }
          })
        }
        return request
      },
    })
    try {
      await deleteSessionRecord('abort-record-target')
    } catch {
      abortDeleteRejected = true
    }
  } finally {
    Object.defineProperty(abortStoreProto, 'delete', {
      configurable: true,
      writable: true,
      value: abortOriginalDelete,
    })
  }
  ok(abortDeleteRejected, 'deleteSessionRecord rejects exactly once on an aborted transaction')
  const abortOriginalClear = abortStoreProto.clear as (...args: unknown[]) => unknown
  let abortClearRejected = false
  try {
    Object.defineProperty(abortStoreProto, 'clear', {
      configurable: true,
      writable: true,
      value: function patchedAbortClear(this: IDBObjectStore, ...args: unknown[]) {
        const request = abortOriginalClear.apply(this, args)
        queueMicrotask(() => {
          try {
            this.transaction.abort()
          } catch {
            // 事务可能已结束
          }
        })
        return request
      },
    })
    try {
      await clearDatabase()
    } catch {
      abortClearRejected = true
    }
  } finally {
    Object.defineProperty(abortStoreProto, 'clear', {
      configurable: true,
      writable: true,
      value: abortOriginalClear,
    })
  }
  ok(abortClearRejected, 'clearDatabase rejects exactly once on an aborted transaction')
  // 给浏览器留出上报 unhandledrejection 的任务边界
  await sleep(300)
  window.removeEventListener('unhandledrejection', onAbortRejection)
  eq(
    abortRejections.length,
    0,
    'aborted delete / clear transactions never leak a global unhandled rejection'
  )
  ok(
    Boolean(await loadSession('abort-record-target')),
    'an aborted delete leaves the IndexedDB record intact'
  )

  // 4f-3) 硬复位清库失败：内存消息收敛为 stopped，流锁清空，不留“生成中”半死锁
  await clearDatabase()
  clearAllDrafts()
  const hardResetSettings = createDefaultSettings()
  hardResetSettings.channels.primary = {
    ...createChannelConfig('Primary'),
    baseUrl: 'http://127.0.0.1:9',
    model: 'hard-reset-model',
  }
  hardResetSettings.webSearch = false
  useConfigStore.setState({
    mode: 'static',
    ready: true,
    offline: false,
    settings: hardResetSettings,
  })
  const hardResetStream = makeMockSseStream()
  const fetchBeforeHardReset = globalThis.fetch
  globalThis.fetch = (() => Promise.resolve(hardResetStream.response)) as typeof fetch
  try {
    useChatStore.setState({
      ready: true,
      activeId: null,
      sessionCache: {},
      summaries: [],
      streaming: {},
      pendingCapsule: null,
    })
    eq(
      sendMessage({ text: 'hard reset while streaming', attachments: [] }),
      true,
      'the hard-reset mid-stream send starts'
    )
    const hardResetSessionId = useChatStore.getState().activeId ?? ''
    ok(
      await waitForCondition(
        () => useChatStore.getState().streaming[hardResetSessionId] === true,
        4000
      ),
      'the hard-reset target session holds the streaming lock'
    )
    const hardStoreProto = IDBObjectStore.prototype as unknown as Record<string, unknown>
    const hardOriginalClear = hardStoreProto.clear as (...args: unknown[]) => unknown
    try {
      Object.defineProperty(hardStoreProto, 'clear', {
        configurable: true,
        writable: true,
        value: function patchedHardClear(): never {
          throw new DOMException('simulated clear failure', 'AbortError')
        },
      })
      eq(
        await hardResetLocalData(),
        { ok: false, reason: 'databaseFailed' },
        'a failed database purge reports the failure reason instead of reloading'
      )
    } finally {
      Object.defineProperty(hardStoreProto, 'clear', {
        configurable: true,
        writable: true,
        value: hardOriginalClear,
      })
    }
    const survivedSession = getCachedSession(hardResetSessionId)
    const survivedAssistant = (survivedSession?.messages ?? []).find(
      (message) => message.role === 'assistant'
    )
    eq(
      survivedAssistant && survivedAssistant.role === 'assistant'
        ? survivedAssistant.status
        : undefined,
      'stopped',
      'the interrupted assistant message is settled to stopped after a failed hard reset'
    )
    ok(
      !(survivedSession?.messages ?? []).some(
        (message) =>
          message.role === 'assistant' &&
          (message.status === 'pending' || message.status === 'streaming')
      ),
      'no message remains pending or streaming after a failed hard reset'
    )
    eq(
      Object.keys(useChatStore.getState().streaming).length,
      0,
      'the streaming lock dictionary is empty after a failed hard reset'
    )
  } finally {
    globalThis.fetch = fetchBeforeHardReset
    hardResetStream.close()
    await clearDatabase()
    softReset()
    await sleep(50)
    clearAllDrafts()
  }

  // 4f-4) file:// 纯静态模式 localStorage 配额写满：保存必须报错并回滚，绝不虚假显示成功
  useConfigStore.setState({
    mode: 'static',
    ready: true,
    offline: false,
    settings: createDefaultSettings(),
    secrets: {
      primary: { hasKey: false, mask: '' },
      backup: { hasKey: false, mask: '' },
      exa: { hasKey: false, mask: '' },
      customHeaders: { primary: [], backup: [] },
    },
  })
  const storageProto = Storage.prototype as unknown as Record<string, unknown>
  const originalStorageSetItem = storageProto.setItem as (key: string, value: string) => void
  let quotaArmed = false
  Object.defineProperty(storageProto, 'setItem', {
    configurable: true,
    writable: true,
    value: function patchedQuotaSetItem(this: Storage, key: string, value: string) {
      if (quotaArmed && String(key).startsWith('eac:settings:v1')) {
        throw new DOMException('simulated quota exceeded', 'QuotaExceededError')
      }
      return originalStorageSetItem.call(this, key, value)
    },
  })
  let browserQuotaRejected = false
  try {
    quotaArmed = true
    try {
      await setSecret('primary', 'sk-browser-quota-9999')
    } catch {
      browserQuotaRejected = true
    }
  } finally {
    quotaArmed = false
    Object.defineProperty(storageProto, 'setItem', {
      configurable: true,
      writable: true,
      value: originalStorageSetItem,
    })
  }
  ok(browserQuotaRejected, 'a full localStorage rejects the static key save')
  eq(
    useConfigStore.getState().settings.channels.primary.apiKey,
    '',
    'the failed static save leaves the in-memory key unchanged'
  )
  eq(useConfigStore.getState().saveError, true, 'the failed static save raises saveError')
  eq(
    (useToast.getState().message as { key?: string } | null)?.key,
    'saveFailedLocalStorage',
    'the failed static save shows the localized local-storage error toast'
  )
  eq(useToast.getState().tone, 'error', 'the static save failure toast uses the error tone')
  await setSecret('primary', 'sk-browser-quota-9999')
  eq(
    useConfigStore.getState().settings.channels.primary.apiKey,
    'sk-browser-quota-9999',
    'the retried static save persists the key'
  )
  eq(useConfigStore.getState().saveError, false, 'the retried static save clears saveError')
  eq(
    (
      JSON.parse(localStorage.getItem('eac:settings:v1') ?? '{}') as {
        channels?: { primary?: { apiKey?: string } }
      }
    ).channels?.primary?.apiKey,
    'sk-browser-quota-9999',
    'the retried key reached the primary localStorage slot'
  )
  eq(
    localStorage.getItem('eac:settings:v1'),
    localStorage.getItem('eac:settings:v1.bak'),
    'the retried static save mirrors the same bytes into the backup slot'
  )
  localStorage.removeItem('eac:settings:v1')
  localStorage.removeItem('eac:settings:v1.bak')
  clearAllDrafts()

  // 4f-5) 最终落盘事务被原生 abort：自动重试一次成功，且全局 unhandledrejection 为 0（P1-2）
  resetStreamConfig()
  await clearDatabase()
  clearAllDrafts()
  useChatStore.setState({
    ready: true,
    activeId: null,
    sessionCache: {},
    summaries: [],
    streaming: {},
    pendingCapsule: null,
  })
  const finalAbortStreams: MockSseStream[] = []
  const finalAbortRejections: unknown[] = []
  const onFinalAbortRejection = (event: PromiseRejectionEvent) => {
    finalAbortRejections.push(event.reason)
  }
  window.addEventListener('unhandledrejection', onFinalAbortRejection)
  const finalAbortStoreProto = IDBObjectStore.prototype as unknown as Record<string, unknown>
  const finalAbortOriginalPut = finalAbortStoreProto.put as (...args: unknown[]) => unknown
  const finalAbortFetch = globalThis.fetch
  let finalAbortSessionId = ''
  let finalAbortArmed = false
  let finalAbortInjected = false
  try {
    fetchWithStreams(finalAbortStreams)
    Object.defineProperty(finalAbortStoreProto, 'put', {
      configurable: true,
      writable: true,
      value: function patchedFinalPut(this: IDBObjectStore, ...args: unknown[]) {
        const record = args[0] as Session | undefined
        if (
          this.name === 'sessions' &&
          finalAbortArmed &&
          record?.id === finalAbortSessionId &&
          (record.messages ?? []).some(
            (message) => message.role === 'assistant' && message.content === 'first-last'
          )
        ) {
          finalAbortArmed = false
          finalAbortInjected = true
          // 写入请求已排队，在本轮微任务末尾中止整个事务：第一次落盘必然失败
          queueMicrotask(() => {
            try {
              this.transaction.abort()
            } catch {
              // 事务可能已经结束
            }
          })
        }
        return finalAbortOriginalPut.apply(this, args)
      },
    })
    eq(
      sendMessage({ text: 'persist the final answer', attachments: [] }),
      true,
      'final-save abort test send starts'
    )
    finalAbortSessionId = useChatStore.getState().activeId ?? ''
    ok(Boolean(finalAbortSessionId), 'final-save abort test session created')
    finalAbortArmed = true
    await waitForCondition(() => finalAbortStreams.length === 1, 4000)
    finalAbortStreams[0].push('data: {"choices":[{"delta":{"content":"first-"}}]}\n\n')
    finalAbortStreams[0].push('data: {"choices":[{"delta":{"content":"last"}}]}\n\n')
    finalAbortStreams[0].push('data: [DONE]\n\n')
    finalAbortStreams[0].close()
    await waitForCondition(() => finalAbortInjected, 6000)
    ok(finalAbortInjected, 'a native abort was injected into the final save transaction')
    await waitForCondition(
      () => useChatStore.getState().streaming[finalAbortSessionId] !== true,
      6000
    )
    await sleep(500)
    const finalSaved = await loadSession(finalAbortSessionId)
    const finalSavedAssistant = (finalSaved?.messages ?? []).find(
      (message) => message.role === 'assistant'
    )
    eq(
      finalSavedAssistant && finalSavedAssistant.role === 'assistant'
        ? finalSavedAssistant.content
        : '',
      'first-last',
      'the aborted final save is retried on a fresh transaction and lands in IndexedDB'
    )
    eq(
      (finalSaved?.messages ?? []).filter((message) => message.role === 'assistant').length,
      1,
      'the retried final save does not duplicate the assistant message'
    )
    eq(useChatStore.getState().saveError, false, 'the successful retry clears saveError')
    await sleep(300)
  } finally {
    globalThis.fetch = finalAbortFetch
    Object.defineProperty(finalAbortStoreProto, 'put', {
      configurable: true,
      writable: true,
      value: finalAbortOriginalPut,
    })
    window.removeEventListener('unhandledrejection', onFinalAbortRejection)
  }
  eq(
    finalAbortRejections.length,
    0,
    'an aborted final save transaction never leaks a global unhandled rejection'
  )
  softReset()
  await sleep(50)
  clearAllDrafts()

  // 4f-6) 数据库连续彻底拒绝写入：应急快照在刷新后恢复完整回复并补写回 IndexedDB（P1-2）
  resetStreamConfig()
  await clearDatabase()
  clearAllDrafts()
  useChatStore.setState({
    ready: true,
    activeId: null,
    sessionCache: {},
    summaries: [],
    streaming: {},
    pendingCapsule: null,
  })
  const emergencyStreams: MockSseStream[] = []
  const emergencyRejections: unknown[] = []
  const onEmergencyRejection = (event: PromiseRejectionEvent) => {
    emergencyRejections.push(event.reason)
  }
  window.addEventListener('unhandledrejection', onEmergencyRejection)
  const emergencyStoreProto = IDBObjectStore.prototype as unknown as Record<string, unknown>
  const emergencyOriginalPut = emergencyStoreProto.put as (...args: unknown[]) => unknown
  const emergencyFetch = globalThis.fetch
  const emergencyKeyOf = (sessionId: string) => `eac:unsaved:session:${sessionId}`
  let emergencySessionId = ''
  try {
    fetchWithStreams(emergencyStreams)
    Object.defineProperty(emergencyStoreProto, 'put', {
      configurable: true,
      writable: true,
      value: function patchedEmergencyPut(this: IDBObjectStore, ...args: unknown[]) {
        if (this.name === 'sessions') {
          throw new DOMException('simulated persistent disk failure', 'UnknownError')
        }
        return emergencyOriginalPut.apply(this, args)
      },
    })
    eq(
      sendMessage({ text: 'the completed answer must survive', attachments: [] }),
      true,
      'emergency-snapshot test send starts while every database write is rejected'
    )
    emergencySessionId = useChatStore.getState().activeId ?? ''
    await waitForCondition(() => emergencyStreams.length === 1, 4000)
    emergencyStreams[0].push('data: {"choices":[{"delta":{"content":"survived-"}}]}\n\n')
    emergencyStreams[0].push('data: {"choices":[{"delta":{"content":"reply"}}]}\n\n')
    emergencyStreams[0].push('data: [DONE]\n\n')
    emergencyStreams[0].close()
    await waitForCondition(
      () => useChatStore.getState().streaming[emergencySessionId] !== true,
      6000
    )
    ok(
      await waitForCondition(() => localStorage.getItem(emergencyKeyOf(emergencySessionId)) !== null, 4000),
      'a persistently failing database stores the latest complete snapshot under the emergency key'
    )
    eq(useChatStore.getState().saveError, true, 'the failed save raises saveError')
  } finally {
    globalThis.fetch = emergencyFetch
  }
  // 模拟刷新：内存全部丢弃，数据库仍拒绝写入；initChat / selectSession 必须从应急快照恢复
  useChatStore.setState({
    ready: false,
    activeId: null,
    sessionCache: {},
    summaries: [],
    streaming: {},
    pendingCapsule: null,
  })
  try {
    await initChat()
    ok(
      useChatStore.getState().summaries.some((summary) => summary.id === emergencySessionId),
      'initChat re-lists the session recovered from the emergency snapshot'
    )
    await selectSession(emergencySessionId)
    const recoveredSession = getCachedSession(emergencySessionId)
    const recoveredAssistant = (recoveredSession?.messages ?? []).find(
      (message) => message.role === 'assistant'
    )
    eq(
      recoveredAssistant && recoveredAssistant.role === 'assistant'
        ? recoveredAssistant.content
        : '',
      'survived-reply',
      'selectSession restores the full completed reply from the emergency snapshot'
    )
    eq(
      recoveredAssistant && recoveredAssistant.role === 'assistant'
        ? recoveredAssistant.status
        : undefined,
      'done',
      'the restored reply keeps its done status instead of a pending placeholder'
    )
    ok(
      localStorage.getItem(emergencyKeyOf(emergencySessionId)) !== null,
      'the emergency snapshot is kept while the write-back still fails'
    )
  } finally {
    Object.defineProperty(emergencyStoreProto, 'put', {
      configurable: true,
      writable: true,
      value: emergencyOriginalPut,
    })
    window.removeEventListener('unhandledrejection', onEmergencyRejection)
  }
  eq(
    emergencyRejections.length,
    0,
    'a database that rejects every write never leaks a global unhandled rejection'
  )
  // 写入能力恢复：重新选择同一会话应触发补写，成功后清掉应急键
  useChatStore.setState({ sessionCache: {} })
  await selectSession(emergencySessionId)
  await sleep(600)
  ok(
    Boolean(await loadSession(emergencySessionId)),
    'the recovered session is written back to IndexedDB once writes succeed again'
  )
  eq(
    localStorage.getItem(emergencyKeyOf(emergencySessionId)),
    null,
    'the emergency key is cleared after a successful write-back'
  )
  await clearDatabase()
  clearAllDrafts()

  // 4f-7) v1 -> v2 摘要回填事务 abort：只抛一次且全局 unhandledrejection 为 0（P1-2）
  await clearDatabase()
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('engineering-ai-console')
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
  })
  const v1Database = await openDB('engineering-ai-console', 1, {
    upgrade(db) {
      db.createObjectStore('sessions', { keyPath: 'id' })
    },
  })
  await v1Database.put('sessions', makeSession('backfill-target', 'v1 session body'))
  v1Database.close()
  const backfillRejections: unknown[] = []
  const onBackfillRejection = (event: PromiseRejectionEvent) => {
    backfillRejections.push(event.reason)
  }
  window.addEventListener('unhandledrejection', onBackfillRejection)
  const backfillStoreProto = IDBObjectStore.prototype as unknown as Record<string, unknown>
  const backfillOriginalPut = backfillStoreProto.put as (...args: unknown[]) => unknown
  let backfillInjected = false
  try {
    Object.defineProperty(backfillStoreProto, 'put', {
      configurable: true,
      writable: true,
      value: function patchedBackfillPut(this: IDBObjectStore, ...args: unknown[]) {
        if (this.name === 'summaries' && !backfillInjected) {
          backfillInjected = true
          queueMicrotask(() => {
            try {
              this.transaction.abort()
            } catch {
              // 事务可能已经结束
            }
          })
        }
        return backfillOriginalPut.apply(this, args)
      },
    })
    let backfillRejected = false
    try {
      await loadSession('backfill-target')
    } catch {
      backfillRejected = true
    }
    ok(backfillInjected, 'a native abort was injected into the v1→v2 summary backfill transaction')
    ok(backfillRejected, 'the aborted summary backfill rejects the database open')
    await sleep(300)
  } finally {
    Object.defineProperty(backfillStoreProto, 'put', {
      configurable: true,
      writable: true,
      value: backfillOriginalPut,
    })
    window.removeEventListener('unhandledrejection', onBackfillRejection)
  }
  eq(
    backfillRejections.length,
    0,
    'an aborted v1→v2 summary backfill never leaks a global unhandled rejection'
  )
  // 恢复写入后重新打开：升级与回填都应成功
  const backfilledSession = await loadSession('backfill-target')
  eq(
    backfilledSession?.messages[0]?.content,
    'v1 session body',
    'a retried v1→v2 upgrade returns the original session body'
  )
  const backfillVerify = await openDB('engineering-ai-console', 2)
  const backfilledSummaries = await backfillVerify.getAll('summaries')
  backfillVerify.close()
  ok(
    (backfilledSummaries as Session[]).some((summary) => summary.id === 'backfill-target'),
    'the retried v1→v2 backfill fills the summary store'
  )
  await clearDatabase()
  clearAllDrafts()

  // 4f-8) file:// 静态模式 localStorage 写满：ChannelEditor 保存密钥必须提示本地存储失败（P2-2）
  useConfigStore.setState({
    mode: 'static',
    ready: true,
    offline: false,
    settings: createDefaultSettings(),
    secrets: {
      primary: { hasKey: false, mask: '' },
      backup: { hasKey: false, mask: '' },
      exa: { hasKey: false, mask: '' },
      customHeaders: { primary: [], backup: [] },
    },
    saveError: false,
  })
  const editorContainer = document.createElement('div')
  document.body.appendChild(editorContainer)
  const editorRoot = createRoot(editorContainer)
  try {
    editorRoot.render(createElement(ChannelEditor, { slot: 'primary' }))
    const keyInput = await new Promise<HTMLInputElement | null>((resolve) => {
      const deadline = Date.now() + 5000
      const poll = () => {
        const input = editorContainer.querySelector('input[type="password"]')
        if (input) {
          resolve(input as HTMLInputElement)
          return
        }
        if (Date.now() > deadline) {
          resolve(null)
          return
        }
        setTimeout(poll, 30)
      }
      poll()
    })
    ok(Boolean(keyInput), 'ChannelEditor renders the API key input')
    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set
    nativeValueSetter?.call(keyInput, 'sk-static-quota-edit')
    keyInput?.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(80)
    eq(
      Array.from(editorContainer.querySelectorAll('button')).some(
        (button) => (button.textContent ?? '').trim() === 'Save'
      ),
      false,
      'ChannelEditor uses autosave instead of a separate key Save button'
    )
    useToast.setState({ id: 0, message: null, tone: null })
    const editorStorageProto = Storage.prototype as unknown as Record<string, unknown>
    const editorOriginalSetItem = editorStorageProto.setItem as (
      key: string,
      value: string
    ) => void
    let editorQuotaArmed = false
    Object.defineProperty(editorStorageProto, 'setItem', {
      configurable: true,
      writable: true,
      value: function patchedEditorQuota(this: Storage, key: string, value: string) {
        if (editorQuotaArmed && String(key).startsWith('eac:settings:v1')) {
          throw new DOMException('simulated quota exceeded', 'QuotaExceededError')
        }
        return editorOriginalSetItem.call(this, key, value)
      },
    })
    try {
      editorQuotaArmed = true
      // 失焦即自动保存：不需要找到并点击独立的保存按钮
      keyInput?.focus()
      keyInput?.blur()
      await sleep(350)
    } finally {
      editorQuotaArmed = false
      Object.defineProperty(editorStorageProto, 'setItem', {
        configurable: true,
        writable: true,
        value: editorOriginalSetItem,
      })
    }
    eq(
      (useToast.getState().message as { key?: string } | null)?.key,
      'saveFailedLocalStorage',
      'ChannelEditor reports the browser local-storage failure instead of the server-side error'
    )
    eq(useToast.getState().tone, 'error', 'the ChannelEditor local-storage toast uses the error tone')
    eq(useConfigStore.getState().saveError, true, 'the failed ChannelEditor save raises saveError')
  } finally {
    editorRoot.unmount()
    editorContainer.remove()
    localStorage.removeItem('eac:settings:v1')
    localStorage.removeItem('eac:settings:v1.bak')
  }
  clearAllDrafts()

  // 4f-9) 硬复位抢救包（分支 A：清库 abort）：最终落盘全部失败时，完整回复必须同时
  //       出现在导出的抢救包里，并在模拟刷新后从保留下来的应急快照完整恢复（P1-1）
  resetStreamConfig()
  await clearDatabase()
  clearAllDrafts()
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('eac:unsaved:session:')) {
      localStorage.removeItem(key)
    }
  }
  useChatStore.setState({
    ready: true,
    activeId: null,
    sessionCache: {},
    summaries: [],
    streaming: {},
    pendingCapsule: null,
    saveError: false,
  })
  const rescueStreams: MockSseStream[] = []
  const rescueFetch = globalThis.fetch
  const rescueStoreProto = IDBObjectStore.prototype as unknown as Record<string, unknown>
  const rescueOriginalPut = rescueStoreProto.put as (...args: unknown[]) => unknown
  const rescueOriginalClear = rescueStoreProto.clear as (...args: unknown[]) => unknown
  const rescueOriginalCreateObjectURL = URL.createObjectURL
  const rescueOriginalDefineUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  const rescueBlobs: Blob[] = []
  const rescueUnsavedKey = (sessionId: string) => `eac:unsaved:session:${sessionId}`
  let rescueSessionId = ''
  let rescueAbortedFinalWrites = 0
  let rescueArmFinalAbort = false
  let rescueReloads = 0
  let rescueClearAborts = 0
  setReloadAfterReset(() => {
    rescueReloads += 1
  })
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: function patchedRescueCreateObjectURL(blob: Blob) {
      rescueBlobs.push(blob)
      return rescueOriginalCreateObjectURL.call(URL, blob)
    },
  })
  let rescueUploadedSession: Session | null = null
  try {
    fetchWithStreams(rescueStreams)
    Object.defineProperty(rescueStoreProto, 'put', {
      configurable: true,
      writable: true,
      value: function patchedRescuePut(this: IDBObjectStore, ...args: unknown[]) {
        const record = args[0] as Session | undefined
        if (
          this.name === 'sessions' &&
          rescueArmFinalAbort &&
          record?.id === rescueSessionId &&
          (record.messages ?? []).some(
            (message) => message.role === 'assistant' && message.content === 'first-last'
          )
        ) {
          rescueAbortedFinalWrites += 1
          queueMicrotask(() => {
            try {
              this.transaction.abort()
            } catch {
              // 事务可能已经结束
            }
          })
        }
        return rescueOriginalPut.apply(this, args)
      },
    })
    eq(
      sendMessage({ text: 'the whole answer must be rescued', attachments: [] }),
      true,
      'hard-reset rescue test send starts'
    )
    rescueSessionId = useChatStore.getState().activeId ?? ''
    ok(Boolean(rescueSessionId), 'hard-reset rescue test session created')
    rescueArmFinalAbort = true
    // 先等发送瞬间的首次落盘真正提交：否则它的成功回调会在最终落盘失败之后清掉应急快照
    let rescueInitialPersisted = false
    for (let attempt = 0; attempt < 100 && !rescueInitialPersisted; attempt++) {
      rescueInitialPersisted = Boolean(await loadSession(rescueSessionId))
      if (!rescueInitialPersisted) {
        await sleep(30)
      }
    }
    ok(rescueInitialPersisted, 'the initial send write lands before the final-save abort test')
    await sleep(80)
    await waitForCondition(() => rescueStreams.length === 1, 4000)
    rescueStreams[0].push('data: {"choices":[{"delta":{"content":"first-"}}]}\n\n')
    rescueStreams[0].push('data: {"choices":[{"delta":{"content":"last"}}]}\n\n')
    rescueStreams[0].push('data: [DONE]\n\n')
    rescueStreams[0].close()
    ok(
      await waitForCondition(() => rescueAbortedFinalWrites >= 2, 8000),
      'both the final save and its automatic retry were aborted, leaving the reply only in memory and the emergency snapshot'
    )
    await waitForCondition(
      () => useChatStore.getState().streaming[rescueSessionId] !== true,
      6000
    )
    ok(
      await waitForCondition(
        () => localStorage.getItem(rescueUnsavedKey(rescueSessionId)) !== null,
        4000
      ),
      'the completed reply is stored under the emergency snapshot key'
    )
    eq(useChatStore.getState().saveError, true, 'the failed final saves raise saveError')
    const rescueJson = await buildJsonBackupFromSources()
    const rescueJsonReply = rescueJson.sessions
      .flatMap((session) => session.messages)
      .find((message) => message.role === 'assistant' && message.content === 'first-last')
    ok(
      Boolean(rescueJsonReply),
      'the merged JSON backup includes the snapshot-only completed reply'
    )
    setDraftText(rescueSessionId, 'unsent draft must survive a failed hard reset')
    await sleep(420)
    const rescueDraftBeforeFailure = localStorage.getItem(
      `eac:draft:session:${rescueSessionId}`
    )
    ok(rescueDraftBeforeFailure !== null, 'the unsent draft is persisted before the hard reset')
    rescueBlobs.length = 0
    Object.defineProperty(rescueStoreProto, 'clear', {
      configurable: true,
      writable: true,
      value: function patchedRescueClear(): never {
        rescueClearAborts += 1
        throw new DOMException('simulated hard-reset purge abort', 'AbortError')
      },
    })
    const abortedReset = await hardReset({ exportBackup: true, keepKeys: false })
    eq(
      abortedReset,
      { ok: false, reason: 'databaseFailed' },
      'an aborted database purge aborts the hard reset instead of reloading'
    )
    ok(rescueClearAborts > 0, 'the simulated hard-reset purge abort fired')
    eq(rescueReloads, 0, 'a failed hard reset never reloads the page')
    const rescueText = rescueBlobs.length > 0 ? await rescueBlobs[0].text() : ''
    ok(rescueText.trim().length > 0, 'the rescue package is not empty')
    ok(
      rescueText.includes('first-last'),
      'the rescue package generated before the aborted purge contains the complete assistant reply'
    )
    ok(
      localStorage.getItem(rescueUnsavedKey(rescueSessionId)) !== null,
      'a failed purge keeps the emergency snapshot for a later refresh'
    )
    eq(
      localStorage.getItem(`eac:draft:session:${rescueSessionId}`),
      rescueDraftBeforeFailure,
      'a failed purge keeps the persisted draft untouched'
    )
    const rescueMemorySession = getCachedSession(rescueSessionId)
    const rescueMemoryReply = (rescueMemorySession?.messages ?? []).find(
      (message) => message.role === 'assistant'
    )
    eq(
      rescueMemoryReply && rescueMemoryReply.role === 'assistant'
        ? rescueMemoryReply.content
        : '',
      'first-last',
      'a failed purge keeps the complete reply in the in-memory session cache'
    )
    eq(
      rescueMemoryReply && rescueMemoryReply.role === 'assistant'
        ? rescueMemoryReply.status
        : undefined,
      'done',
      'an already finished reply keeps its done status through the failed hard reset'
    )
    // 模拟刷新页面：内存全部丢弃，数据库写入仍然失败，必须从保留下来的应急快照恢复
    useChatStore.setState({
      ready: false,
      activeId: null,
      sessionCache: {},
      summaries: [],
      streaming: {},
      pendingCapsule: null,
    })
    await initChat()
    ok(
      useChatStore.getState().summaries.some((summary) => summary.id === rescueSessionId),
      'initChat re-lists the session recovered from the retained emergency snapshot'
    )
    await selectSession(rescueSessionId)
    const recoveredRescueSession = getCachedSession(rescueSessionId)
    const recoveredRescueReply = (recoveredRescueSession?.messages ?? []).find(
      (message) => message.role === 'assistant'
    )
    eq(
      recoveredRescueReply && recoveredRescueReply.role === 'assistant'
        ? recoveredRescueReply.content
        : '',
      'first-last',
      'selectSession after a simulated refresh restores the complete reply from the emergency snapshot'
    )
    eq(
      recoveredRescueReply && recoveredRescueReply.role === 'assistant'
        ? recoveredRescueReply.status
        : undefined,
      'done',
      'the restored reply keeps its done status instead of a pending placeholder'
    )
    ok(
      localStorage.getItem(rescueUnsavedKey(rescueSessionId)) !== null,
      'the emergency snapshot is kept while the write-back still fails'
    )
    // 写入能力恢复：重新选择同一会话应补写成功并清掉应急键
    Object.defineProperty(rescueStoreProto, 'put', {
      configurable: true,
      writable: true,
      value: rescueOriginalPut,
    })
    useChatStore.setState({ sessionCache: {} })
    await selectSession(rescueSessionId)
    await sleep(600)
    rescueUploadedSession = await loadSession(rescueSessionId)
    ok(
      Boolean(rescueUploadedSession),
      'the recovered session is written back to IndexedDB once writes succeed again'
    )
    eq(
      localStorage.getItem(rescueUnsavedKey(rescueSessionId)),
      null,
      'the emergency key is cleared after the successful write-back'
    )
  } finally {
    Object.defineProperty(rescueStoreProto, 'put', {
      configurable: true,
      writable: true,
      value: rescueOriginalPut,
    })
    Object.defineProperty(rescueStoreProto, 'clear', {
      configurable: true,
      writable: true,
      value: rescueOriginalClear,
    })
    if (rescueOriginalDefineUrl) {
      Object.defineProperty(URL, 'createObjectURL', rescueOriginalDefineUrl)
    } else {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: rescueOriginalCreateObjectURL,
      })
    }
    setReloadAfterReset(null)
    globalThis.fetch = rescueFetch
    rescueStreams[0]?.close()
  }
  ok(Boolean(rescueUploadedSession), 'the hard-reset rescue scenario finished with a persisted session')

  // 4f-10) 硬复位抢救包（分支 B：清库成功）：抢救包包含完整回复；清库提交后才清
  //        应急快照 / 草稿 / 内存会话 / IndexedDB（P1-1）
  resetStreamConfig()
  await clearDatabase()
  clearAllDrafts()
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('eac:unsaved:session:')) {
      localStorage.removeItem(key)
    }
  }
  useChatStore.setState({
    ready: true,
    activeId: null,
    sessionCache: {},
    summaries: [],
    streaming: {},
    pendingCapsule: null,
    saveError: false,
  })
  const purgeStreams: MockSseStream[] = []
  const purgeFetch = globalThis.fetch
  const purgeStoreProto = IDBObjectStore.prototype as unknown as Record<string, unknown>
  const purgeOriginalPut = purgeStoreProto.put as (...args: unknown[]) => unknown
  const purgeOriginalCreateObjectURL = URL.createObjectURL
  const purgeOriginalDefineUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  const purgeBlobs: Blob[] = []
  let purgeSessionId = ''
  let purgeAbortedFinalWrites = 0
  let purgeArmFinalAbort = false
  let purgeReloads = 0
  setReloadAfterReset(() => {
    purgeReloads += 1
  })
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: function patchedPurgeCreateObjectURL(blob: Blob) {
      purgeBlobs.push(blob)
      return purgeOriginalCreateObjectURL.call(URL, blob)
    },
  })
  try {
    fetchWithStreams(purgeStreams)
    Object.defineProperty(purgeStoreProto, 'put', {
      configurable: true,
      writable: true,
      value: function patchedPurgePut(this: IDBObjectStore, ...args: unknown[]) {
        const record = args[0] as Session | undefined
        if (
          this.name === 'sessions' &&
          purgeArmFinalAbort &&
          record?.id === purgeSessionId &&
          (record.messages ?? []).some(
            (message) => message.role === 'assistant' && message.content === 'first-last'
          )
        ) {
          purgeAbortedFinalWrites += 1
          queueMicrotask(() => {
            try {
              this.transaction.abort()
            } catch {
              // 事务可能已经结束
            }
          })
        }
        return purgeOriginalPut.apply(this, args)
      },
    })
    eq(
      sendMessage({ text: 'the answer must be in the reset rescue file', attachments: [] }),
      true,
      'hard-reset purge test send starts'
    )
    purgeSessionId = useChatStore.getState().activeId ?? ''
    ok(Boolean(purgeSessionId), 'hard-reset purge test session created')
    purgeArmFinalAbort = true
    let purgeInitialPersisted = false
    for (let attempt = 0; attempt < 100 && !purgeInitialPersisted; attempt++) {
      purgeInitialPersisted = Boolean(await loadSession(purgeSessionId))
      if (!purgeInitialPersisted) {
        await sleep(30)
      }
    }
    ok(purgeInitialPersisted, 'the initial send write lands before the purge-scenario abort test')
    await sleep(80)
    await waitForCondition(() => purgeStreams.length === 1, 4000)
    purgeStreams[0].push('data: {"choices":[{"delta":{"content":"first-"}}]}\n\n')
    purgeStreams[0].push('data: {"choices":[{"delta":{"content":"last"}}]}\n\n')
    purgeStreams[0].push('data: [DONE]\n\n')
    purgeStreams[0].close()
    ok(
      await waitForCondition(() => purgeAbortedFinalWrites >= 2, 8000),
      'the purge scenario also leaves the completed reply only in memory and the emergency snapshot'
    )
    await waitForCondition(
      () => useChatStore.getState().streaming[purgeSessionId] !== true,
      6000
    )
    ok(
      await waitForCondition(
        () => localStorage.getItem(`eac:unsaved:session:${purgeSessionId}`) !== null,
        4000
      ),
      'the purge scenario has an emergency snapshot with the completed reply'
    )
    setDraftText(purgeSessionId, 'draft that must be purged after a successful reset')
    await sleep(420)
    ok(
      localStorage.getItem(`eac:draft:session:${purgeSessionId}`) !== null,
      'the purge scenario has a persisted draft before the reset'
    )
    purgeBlobs.length = 0
    Object.defineProperty(purgeStoreProto, 'put', {
      configurable: true,
      writable: true,
      value: purgeOriginalPut,
    })
    const successfulReset = await hardReset({ exportBackup: true, keepKeys: false })
    eq(successfulReset, { ok: true }, 'a successful hard reset reports ok')
    eq(purgeReloads, 1, 'a successful hard reset reloads the page exactly once')
    const purgeText = purgeBlobs.length > 0 ? await purgeBlobs[0].text() : ''
    ok(purgeText.trim().length > 0, 'the successful reset still produced a non-empty rescue package')
    ok(
      purgeText.includes('first-last'),
      'the rescue package of the successful reset contains the complete assistant reply'
    )
    eq(
      localStorage.getItem(`eac:unsaved:session:${purgeSessionId}`),
      null,
      'only a successful database purge clears the emergency snapshot'
    )
    eq(
      localStorage.getItem(`eac:draft:session:${purgeSessionId}`),
      null,
      'only a successful database purge clears the persisted draft'
    )
    eq(getDraft(purgeSessionId).text, '', 'the in-memory draft is cleared after a successful purge')
    eq(useChatStore.getState().summaries.length, 0, 'the summary list is cleared after a successful purge')
    eq(
      Object.keys(useChatStore.getState().sessionCache).length,
      0,
      'the in-memory session cache is cleared after a successful purge'
    )
    eq(useChatStore.getState().activeId, null, 'the welcome page is selected after a successful purge')
    eq((await loadAllSessions()).length, 0, 'the successful purge leaves IndexedDB empty')
  } finally {
    Object.defineProperty(purgeStoreProto, 'put', {
      configurable: true,
      writable: true,
      value: purgeOriginalPut,
    })
    if (purgeOriginalDefineUrl) {
      Object.defineProperty(URL, 'createObjectURL', purgeOriginalDefineUrl)
    } else {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: purgeOriginalCreateObjectURL,
      })
    }
    setReloadAfterReset(null)
    globalThis.fetch = purgeFetch
    purgeStreams[0]?.close()
  }
  clearAllDrafts()
  await clearDatabase()

  // 4f-11) server 模式 /api/config 500：设置组件必须提示 saveFailed，绝不误报浏览器存储；
  //         解锁后一次合并重试 POST + 一次业务请求即可完成远端 PDF 上传（P1-2 / P2）
  const browserServerSettings = createDefaultSettings()
  browserServerSettings.channels.primary = {
    ...createChannelConfig('Primary'),
    protocol: 'anthropic',
    baseUrl: 'https://gateway-browser-sync.example/anthropic/v1',
    model: 'browser-server-model',
    enableRemoteFileApi: true,
  }
  useConfigStore.setState({
    mode: 'server',
    ready: true,
    offline: false,
    initError: null,
    serverToken: 'browser-server-token',
    settings: browserServerSettings,
    secrets: {
      primary: { hasKey: true, mask: '...0000', envSet: false, keyFingerprint: 'aaaaaaaaaaaa' },
      backup: { hasKey: false, mask: '', envSet: false, keyFingerprint: 'none' },
      exa: { hasKey: false, mask: '' },
      customHeaders: { primary: [], backup: [] },
    },
    storage: { settings: 'ok', secrets: 'ok', recovered: false, degraded: false },
    saving: false,
    saveError: false,
    saveFailure: 'none',
  })
  const browserServerFetch = globalThis.fetch
  let browserServerFingerprint = 'aaaaaaaaaaaa'
  let browserServerWritesLocked = true
  let browserServerConfigPosts: Array<Record<string, unknown>> = []
  let browserServerUploads = 0
  const browserServerSnapshot = () => ({
    settings: browserServerSettings,
    secrets: {
      primary: {
        hasKey: true,
        mask: '...0003',
        envSet: false,
        keyFingerprint: browserServerFingerprint,
      },
      backup: { hasKey: false, mask: '', envSet: false, keyFingerprint: 'none' },
      exa: { hasKey: false, mask: '' },
      customHeaders: { primary: [], backup: [] },
    },
    storage: { settings: 'ok', secrets: 'ok', recovered: false, degraded: false },
  })
  const browserServerKey = 'sk-browser-server-0003'
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/api/config' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      browserServerConfigPosts.push(body)
      if (browserServerWritesLocked) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'configPersistFailed' } }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      }
      const keys = body.keys as Record<string, string> | undefined
      if (keys?.primary) {
        browserServerFingerprint = secretFingerprint(keys.primary)
      }
      return Promise.resolve(
        new Response(JSON.stringify(browserServerSnapshot()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    }
    if (url === '/api/files/upload') {
      browserServerUploads += 1
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'file-browser-sync-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    }
    return Promise.resolve(
      new Response(JSON.stringify({ error: 'unexpected' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  }) as typeof fetch
  try {
    // 先制造一次普通设置保存失败：saveError 会残留，旧实现据此误报本地存储文案
    patchChannel('primary', { model: 'browser-server-model-2' })
    await sleep(450)
    eq(
      useConfigStore.getState().saveError,
      true,
      'the server-mode settings write failure raises saveError'
    )
    eq(
      configSaveFailureKey(),
      'saveFailed',
      'a server-mode config failure maps to the server wording before any credential save'
    )
    const serverEditorContainer = document.createElement('div')
    document.body.appendChild(serverEditorContainer)
    const serverEditorRoot = createRoot(serverEditorContainer)
    try {
      serverEditorRoot.render(createElement(ChannelEditor, { slot: 'primary' }))
      const serverKeyInput = await new Promise<HTMLInputElement | null>((resolve) => {
        const deadline = Date.now() + 5000
        const poll = () => {
          const input = serverEditorContainer.querySelector('input[type="password"]')
          if (input) {
            resolve(input as HTMLInputElement)
            return
          }
          if (Date.now() > deadline) {
            resolve(null)
            return
          }
          setTimeout(poll, 30)
        }
        poll()
      })
      ok(Boolean(serverKeyInput), 'server-mode ChannelEditor renders the API key input')
      const nativeServerValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )?.set
      nativeServerValueSetter?.call(serverKeyInput, browserServerKey)
      serverKeyInput?.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(80)
      const serverCoreSection = serverEditorContainer.querySelector('section')
      eq(
        Array.from(serverCoreSection?.querySelectorAll('button') ?? []).some(
          (button) => (button.textContent ?? '').trim() === 'Save'
        ),
        false,
        'server-mode ChannelEditor uses autosave instead of a separate key Save button'
      )
      useToast.setState({ id: 0, message: null, tone: null })
      browserServerWritesLocked = true
      serverKeyInput?.focus()
      serverKeyInput?.blur()
      await sleep(350)
      eq(
        (useToast.getState().message as { key?: string } | null)?.key,
        'saveFailed',
        'the server-mode key save reports saveFailed instead of the local-storage wording'
      )
      eq(useToast.getState().tone, 'error', 'the server-mode save failure toast uses the error tone')
      eq(useConfigStore.getState().saveError, true, 'the rejected key save keeps saveError set')
      eq(
        configSaveFailureKey(),
        'saveFailed',
        'a server-mode credential failure never maps to saveFailedLocalStorage'
      )
      // 解锁后上传远端 PDF：应为 1 次合并重试 POST（200）+ 1 次上传业务请求
      browserServerWritesLocked = false
      browserServerConfigPosts = []
      browserServerUploads = 0
      const serverSyncPdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'server-sync.pdf', {
        type: 'application/pdf',
      })
      const serverSyncContext: RemoteContext = {
        mode: 'server',
        token: 'browser-server-token',
        slot: 'primary',
        channel: browserServerSettings.channels.primary,
        keyFingerprint: 'aaaaaaaaaaaa',
      }
      const serverUpload = await uploadRemoteFile(serverSyncContext, serverSyncPdf)
      eq(
        browserServerConfigPosts.length,
        1,
        'the remote PDF upload flushed the pending credential with exactly one merged config POST'
      )
      eq(
        (browserServerConfigPosts[0]?.keys as Record<string, string> | undefined)?.primary,
        browserServerKey,
        'the merged retry POST carried the credential that previously failed'
      )
      eq(browserServerUploads, 1, 'the remote PDF upload reached the service exactly once')
      ok(serverUpload.ok, 'the remote PDF upload succeeds after the bounded config retry')
      eq(
        remoteKeyFingerprintOf('primary'),
        secretFingerprint(browserServerKey),
        'the retried 200 snapshot advances the effective key fingerprint'
      )
      ok(
        serverUpload.ok && serverUpload.fingerprint.includes(secretFingerprint(browserServerKey)),
        'the uploaded remote file records the retried key fingerprint'
      )
      eq(
        useConfigStore.getState().saveError,
        false,
        'a successful merged retry clears the lingering saveError state'
      )
    } finally {
      serverEditorRoot.unmount()
      serverEditorContainer.remove()
    }
  } finally {
    globalThis.fetch = browserServerFetch
    localStorage.removeItem('eac:settings:v1')
    localStorage.removeItem('eac:settings:v1.bak')
  }
  clearAllDrafts()

  // 4g) 删除无关会话 B 绝不卡死正在加载的 A（P2-03）
  await clearDatabase()
  clearAllDrafts()
  const slowLoadA = makeSession('slow-load-a', 'A content loaded slowly')
  const victimB = makeSession('deleted-other-b', 'B content')
  await saveSession(slowLoadA)
  await saveSession(victimB)
  useChatStore.setState({
    ready: true,
    activeId: null,
    sessionCache: {},
    summaries: await listSessionSummaries(),
    streaming: {},
    pendingCapsule: null,
  })
  const slowGetProto = IDBObjectStore.prototype as unknown as Record<string, unknown>
  const originalSlowGet = slowGetProto.get as (...args: unknown[]) => unknown
  const slowLoadGate: { release: ((value: Session | undefined) => void) | null } = { release: null }
  let slowLoadPending = false
  try {
    Object.defineProperty(slowGetProto, 'get', {
      configurable: true,
      writable: true,
      value: function patchedSlowGet(this: IDBObjectStore, ...args: unknown[]) {
        if (this.name === 'sessions' && args[0] === 'slow-load-a') {
          slowLoadPending = true
          return {
            then(resolve: (value: Session | undefined) => void) {
              slowLoadGate.release = resolve
            },
          }
        }
        return originalSlowGet.apply(this, args)
      },
    })
    const slowSelecting = selectSession('slow-load-a')
    ok(
      await waitForCondition(() => slowLoadPending, 3000),
      'selectSession holds a pending IndexedDB read for session A'
    )
    await deleteSession('deleted-other-b')
    eq(
      useChatStore.getState().activeId,
      'slow-load-a',
      'deleting an unrelated session keeps the pending load selected'
    )
    slowLoadGate.release?.(slowLoadA)
    await slowSelecting
  } finally {
    Object.defineProperty(slowGetProto, 'get', {
      configurable: true,
      writable: true,
      value: originalSlowGet,
    })
  }
  eq(
    getCachedSession('slow-load-a')?.messages[0]?.content,
    'A content loaded slowly',
    'deleting B never invalidates the in-flight load of A'
  )
  ok(
    useChatStore.getState().summaries.some((summary) => summary.id === 'deleted-other-b') === false,
    'the unrelated session B is actually removed'
  )
  eq(useChatStore.getState().activeId, 'slow-load-a', 'A stays selected after the unrelated deletion')

  // 4h) 后台流 + 未发图片草稿：导入无关备份不得断流、不得清缓存、不得丢图（P1-03 / P2-01）
  resetStreamConfig()
  await clearDatabase()
  clearAllDrafts()
  useChatStore.setState({
    ready: true,
    activeId: null,
    sessionCache: {},
    summaries: [],
    streaming: {},
    pendingCapsule: null,
  })
  const backgroundStreams: MockSseStream[] = []
  const fetchBeforeBackground = globalThis.fetch
  try {
    fetchWithStreams(backgroundStreams)
    eq(
      sendMessage({ text: 'background question', attachments: [] }),
      true,
      'background streaming session starts'
    )
    const backgroundId = useChatStore.getState().activeId ?? ''
    ok(Boolean(backgroundId), 'background streaming session id assigned')
    backgroundStreams[0].push('data: {"choices":[{"delta":{"content":"streaming-"}}]}\n\n')
    await sleep(120)
    setDraftText(backgroundId, 'unsent image note')
    const backgroundImage: Attachment = {
      id: 'background-image',
      name: 'background.png',
      size: 4,
      mime: 'image/png',
      kind: 'image',
      dataUrl: 'data:image/png;base64,AAAA',
      mediaType: 'image/png',
    }
    addDraftAttachment(backgroundId, backgroundImage)
    // 让文本快照先落 localStorage：旧实现会在导入时用它覆盖带图片的内存草稿
    await sleep(420)
    const backgroundRevBefore = getSessionRev(backgroundId)
    const importWhileStreaming = await importJsonBackup(
      JSON.stringify(buildJsonBackup([makeSession('background-import-b', 'imported content')]))
    )
    ok(importWhileStreaming.ok, 'an unrelated JSON backup import succeeds during a background stream')
    eq(
      getSessionRev(backgroundId),
      backgroundRevBefore,
      'importing another session never bumps the background session revision'
    )
    ok(
      Boolean(getCachedSession(backgroundId)),
      'importing another session keeps the background session cache entry'
    )
    ok(
      useChatStore.getState().streaming[backgroundId] === true,
      'importing another session never aborts the background stream'
    )
    eq(
      getDraft(backgroundId).attachments.map((attachment) => attachment.id),
      ['background-image'],
      'importing another session preserves the unsent image draft'
    )
    ok(
      useChatStore.getState().summaries.some((summary) => summary.id === 'background-import-b'),
      'the imported session appears in the refreshed summary list'
    )
    backgroundStreams[0].push('data: {"choices":[{"delta":{"content":"finished"}}]}\n\n')
    backgroundStreams[0].push('data: [DONE]\n\n')
    backgroundStreams[0].close()
    await waitForCondition(
      () => useChatStore.getState().streaming[backgroundId] !== true,
      5000
    )
    const backgroundSession = getCachedSession(backgroundId)
    const backgroundReply = [...(backgroundSession?.messages ?? [])]
      .reverse()
      .find((message) => message.role === 'assistant')
    eq(
      backgroundReply && backgroundReply.role === 'assistant' ? backgroundReply.content : undefined,
      'streaming-finished',
      'the background stream finishes into the preserved cache entry'
    )
    await sleep(200)
    const persistedBackground = await loadSession(backgroundId)
    const persistedBackgroundReply = [...(persistedBackground?.messages ?? [])]
      .reverse()
      .find((message) => message.role === 'assistant')
    eq(
      persistedBackgroundReply && persistedBackgroundReply.role === 'assistant'
        ? persistedBackgroundReply.content
        : undefined,
      'streaming-finished',
      'the finished background answer is persisted to IndexedDB'
    )
  } finally {
    globalThis.fetch = fetchBeforeBackground
  }
  clearAllDrafts()
  await clearDatabase()

  // 4i) 删除 A 后导入同 ID 的 A'：旧会话迟到的异步附件必须被确定性丢弃（P1-04）
  await clearDatabase()
  clearAllDrafts()
  const reimportTargetId = 'reimport-attachment-target'
  const oldReimportSession = makeSession(reimportTargetId, 'OLD SAME-ID CONTENT')
  useChatStore.setState({
    ready: true,
    activeId: reimportTargetId,
    sessionCache: { [reimportTargetId]: oldReimportSession },
    summaries: [toSessionSummary(oldReimportSession)],
    streaming: {},
    pendingCapsule: null,
  })
  const staleRev = getSessionRev(reimportTargetId)
  const staleEpoch = useChatStore.getState().resetEpoch
  const gatedAttachmentFile = new File(['pending attachment body'], 'pending.txt', {
    type: 'text/plain',
  })
  const reimportGate: { release: (() => void) | null } = { release: null }
  Object.defineProperty(gatedAttachmentFile, 'arrayBuffer', {
    configurable: true,
    value: () =>
      new Promise<ArrayBuffer>((resolve) => {
        reimportGate.release = () =>
          resolve(new TextEncoder().encode('pending attachment body').buffer)
      }),
  })
  const parsingStaleAttachment = parseAttachmentFile(gatedAttachmentFile, { remote: null })
  ok(
    await waitForCondition(() => reimportGate.release !== null, 2000),
    'the stale attachment parse is held in the middle of the file read'
  )
  await deleteSession(reimportTargetId)
  const reimportResult = await importJsonBackup(
    JSON.stringify(buildJsonBackup([makeSession(reimportTargetId, 'NEW SAME-ID CONTENT')]))
  )
  ok(reimportResult.ok, 're-importing a session with the same id succeeds after the deletion')
  eq(
    getSessionRev(reimportTargetId),
    staleRev + 2,
    'deleting A and importing A-prime bump the session revision twice'
  )
  reimportGate.release?.()
  const staleAttachment = await parsingStaleAttachment
  eq(staleAttachment.kind, 'text', 'the held attachment finishes parsing after the re-import')
  eq(
    addParsedAttachmentIfAlive(reimportTargetId, staleEpoch, staleRev, staleAttachment),
    false,
    'an attachment from the deleted same-id session is rejected by the revision check'
  )
  eq(
    getDraft(reimportTargetId).attachments.length,
    0,
    'the re-imported A-prime draft never receives the stale attachment'
  )
  await selectSession(reimportTargetId)
  eq(
    getCachedSession(reimportTargetId)?.messages[0]?.content,
    'NEW SAME-ID CONTENT',
    'the re-imported session keeps its own content'
  )

  // 4j) 草稿键严格单射：欢迎页与 target / s:target / __welcome__ 等会话互不误伤
  clearAllDrafts()
  setDraftText(null, 'welcome page real draft')
  setDraftText('new', 'session named new real draft')
  setDraftText('target', 'session target real draft')
  setDraftText('s:target', 'session s-target real draft')
  setDraftText('__welcome__', 'session dunder welcome real draft')
  setDraftText('welcome', 'session literally named welcome real draft')
  await sleep(420)
  ok(
    localStorage.getItem('eac:draft:welcome') !== null,
    'the welcome draft uses the dedicated welcome localStorage key'
  )
  ok(
    localStorage.getItem('eac:draft:session:new') !== null,
    'a session literally named "new" stores its draft under the session namespace'
  )
  eq(getDraft(null).text, 'welcome page real draft', 'the welcome draft keeps its own text')
  eq(getDraft('new').text, 'session named new real draft', 'the "new" session keeps its own text')
  clearDraft('s:target')
  eq(getDraft('s:target').text, '', 'deleting the "s:target" draft clears only that session')
  eq(
    getDraft('target').text,
    'session target real draft',
    'deleting "s:target" never touches the "target" session draft'
  )
  eq(
    localStorage.getItem('eac:draft:session:target') !== null,
    true,
    'the "target" persisted draft snapshot survives'
  )
  clearDraft('__welcome__')
  eq(
    getDraft(null).text,
    'welcome page real draft',
    'deleting the "__welcome__" session never clears the welcome draft'
  )
  eq(getDraft('__welcome__').text, '', 'the "__welcome__" session draft is cleared')
  eq(
    getDraft('target').text,
    'session target real draft',
    'deleting "__welcome__" never touches other session drafts'
  )
  eq(
    getDraft('welcome').text,
    'session literally named welcome real draft',
    'a session whose ID is literally "welcome" keeps its own draft'
  )
  clearDraft('welcome')
  eq(
    getDraft(null).text,
    'welcome page real draft',
    'clearing the "welcome"-ID session never clears the welcome-page draft'
  )
  eq(getDraft('welcome').text, '', 'clearing the "welcome"-ID session draft clears only itself')
  clearAllDrafts()

  // 4k) 7 条只读 / 升级路径逐一注入原生 tx.abort()：业务 Promise 收到拒绝、全局 unhandledrejection 为 0
  // 覆盖 openDB 建库升级、启动回填的 3 条读取、摘要列表、单会话读取（含生产页点击）与全量读取。
  const matrixRejections: unknown[] = []
  const onMatrixRejection = (event: PromiseRejectionEvent) => {
    matrixRejections.push(event.reason)
  }
  const abortInjector = createIdbAbortInjector()
  const expectReject = async (operation: () => Promise<unknown>): Promise<unknown | null> => {
    try {
      await operation()
      return null
    } catch (error) {
      return error
    }
  }
  const errorNameOf = (error: unknown): string =>
    error instanceof DOMException || error instanceof Error ? error.name : ''
  window.addEventListener('unhandledrejection', onMatrixRejection)
  abortInjector.install()
  try {
    // ① openDB 建库升级 versionchange 事务
    await resetConsoleDatabase()
    const upgradeTicket = abortInjector.armUpgradeAbort()
    const upgradeError = await expectReject(() => loadAllSessions())
    ok(
      upgradeTicket.fired,
      'path 1 aborts the native versionchange upgrade transaction inside openDB'
    )
    ok(
      Boolean(upgradeError),
      'path 1: the business promise rejects when the upgrade transaction is aborted'
    )
    eq(errorNameOf(upgradeError), 'AbortError', 'path 1 rejects with AbortError')
    upgradeTicket.cancel()
    await sleep(150)
    eq(matrixRejections.length, 0, 'path 1 leaks no global unhandledrejection')
    eq(
      (await loadAllSessions()).length,
      0,
      'a retried open after the aborted upgrade recreates the v2 schema'
    )
    await clearDatabase()

    // ② backfillSummariesIfNeeded 统计 summaries 数量的只读事务
    await seedLegacyDatabase(makeSession('backfill-target', 'v1 session body'))
    const summaryCountTicket = abortInjector.armReadAbort('summaries', 'count')
    const summaryCountError = await expectReject(() => loadSession('backfill-target'))
    ok(
      summaryCountTicket.fired,
      'path 2 aborts the native readonly transaction that counts summaries during backfill'
    )
    ok(
      Boolean(summaryCountError),
      'path 2: the database open rejects when the summaries-count transaction is aborted'
    )
    eq(errorNameOf(summaryCountError), 'AbortError', 'path 2 rejects with AbortError')
    summaryCountTicket.cancel()
    await sleep(150)
    eq(matrixRejections.length, 0, 'path 2 leaks no global unhandledrejection')

    // ③ backfillSummariesIfNeeded 统计 sessions 数量的只读事务
    const sessionCountTicket = abortInjector.armReadAbort('sessions', 'count')
    const sessionCountError = await expectReject(() => loadSession('backfill-target'))
    ok(
      sessionCountTicket.fired,
      'path 3 aborts the native readonly transaction that counts sessions during backfill'
    )
    ok(
      Boolean(sessionCountError),
      'path 3: the database open rejects when the sessions-count transaction is aborted'
    )
    eq(errorNameOf(sessionCountError), 'AbortError', 'path 3 rejects with AbortError')
    sessionCountTicket.cancel()
    await sleep(150)
    eq(matrixRejections.length, 0, 'path 3 leaks no global unhandledrejection')

    // ④ backfillSummariesIfNeeded 读取全部 sessions 待回填数据的只读事务
    const backfillSessionsTicket = abortInjector.armReadAbort('sessions', 'getAll')
    const backfillSessionsError = await expectReject(() => listSessionSummaries())
    ok(
      backfillSessionsTicket.fired,
      'path 4 aborts the native readonly transaction that reads sessions for backfill'
    )
    ok(
      Boolean(backfillSessionsError),
      'path 4: the database open rejects when the backfill sessions read is aborted'
    )
    eq(errorNameOf(backfillSessionsError), 'AbortError', 'path 4 rejects with AbortError')
    backfillSessionsTicket.cancel()
    await sleep(150)
    eq(matrixRejections.length, 0, 'path 4 leaks no global unhandledrejection')

    // ⑤ listSessionSummaries 的只读事务
    const listTicket = abortInjector.armReadAbort('summaries', 'getAll')
    const listError = await expectReject(() => listSessionSummaries())
    ok(
      listTicket.fired,
      'path 5 aborts the native readonly transaction behind listSessionSummaries'
    )
    ok(Boolean(listError), 'path 5: listSessionSummaries rejects on the native abort')
    eq(errorNameOf(listError), 'AbortError', 'path 5 rejects with AbortError')
    listTicket.cancel()
    await sleep(150)
    eq(matrixRejections.length, 0, 'path 5 leaks no global unhandledrejection')

    // ⑥ loadSession 的只读事务：先直接调用，再模拟生产页点击已有会话
    const loadTicket = abortInjector.armReadAbort('sessions', 'get', 'backfill-target')
    const loadError = await expectReject(() => loadSession('backfill-target'))
    ok(loadTicket.fired, 'path 6 aborts the native readonly transaction behind loadSession')
    ok(Boolean(loadError), 'path 6: loadSession rejects on the native abort')
    eq(errorNameOf(loadError), 'AbortError', 'path 6 rejects with AbortError')
    loadTicket.cancel()
    await sleep(150)
    eq(matrixRejections.length, 0, 'path 6 leaks no global unhandledrejection')
    useChatStore.setState({
      ready: true,
      activeId: null,
      sessionCache: {},
      summaries: await listSessionSummaries(),
      streaming: {},
      pendingCapsule: null,
    })
    useToast.setState({ id: 0, message: null, tone: null })
    const clickTicket = abortInjector.armReadAbort('sessions', 'get', 'backfill-target')
    await selectSession('backfill-target')
    ok(
      clickTicket.fired,
      'path 6 aborts the session read triggered by selecting an existing chat on the production page'
    )
    eq(
      useChatStore.getState().activeId,
      null,
      'an aborted session read leaves no dangling loading state behind'
    )
    eq(
      (useToast.getState().message as { key?: string } | null)?.key,
      'sessionReadFailed',
      'a failed session read shows the read-failure wording instead of a save failure'
    )
    clickTicket.cancel()
    await sleep(150)
    eq(matrixRejections.length, 0, 'the production click path leaks no global unhandledrejection')

    // ⑦ loadAllSessions 的只读事务
    const allSessionsTicket = abortInjector.armReadAbort('sessions', 'getAll')
    const allSessionsError = await expectReject(() => loadAllSessions())
    ok(
      allSessionsTicket.fired,
      'path 7 aborts the native readonly transaction behind loadAllSessions'
    )
    ok(Boolean(allSessionsError), 'path 7: loadAllSessions rejects on the native abort')
    eq(errorNameOf(allSessionsError), 'AbortError', 'path 7 rejects with AbortError')
    allSessionsTicket.cancel()
    await sleep(150)
    eq(matrixRejections.length, 0, 'path 7 leaks no global unhandledrejection')
  } finally {
    abortInjector.uninstall()
    window.removeEventListener('unhandledrejection', onMatrixRejection)
  }
  eq(
    matrixRejections.length,
    0,
    'the full seven-path native IDBTransaction abort matrix leaks zero global unhandledrejection events'
  )
  await clearDatabase()
  clearAllDrafts()
  useChatStore.setState({
    ready: true,
    activeId: null,
    sessionCache: {},
    summaries: [],
    streaming: {},
    pendingCapsule: null,
  })

  // 4l) 冷/热缓存硬复位抢救反例（P1）：真实 IndexedDB 里写入 cold / hot 两条不同正文，
  //     模拟刷新重置内存后分别在“缓存为空”和“只点开 hot”两种状态下触发导出读取中止。
  const rescueGuardInjector = createIdbAbortInjector()
  const rescueGuardBlobs: Blob[] = []
  const rescueGuardOriginalCreateObjectURL = URL.createObjectURL
  const rescueGuardOriginalDefineUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  const coldBody = 'COLD-SESSION-BODY-7f31'
  const hotBody = 'HOT-SESSION-BODY-9c42'
  const coldId = 'rescue-cold'
  const hotId = 'rescue-hot'
  const coldHotSettings = createDefaultSettings()
  const resetRescueResidue = () => {
    for (const storageKey of Object.keys(localStorage)) {
      if (storageKey.startsWith('eac:unsaved:session:')) {
        localStorage.removeItem(storageKey)
      }
    }
    clearAllDrafts()
  }
  const resetChatBeforeRefresh = () =>
    useChatStore.setState({
      ready: false,
      initFailure: null,
      activeId: null,
      sessionCache: {},
      summaries: [],
      streaming: {},
      pendingCapsule: null,
      saveError: false,
    })
  let rescueGuardReloads = 0
  setReloadAfterReset(() => {
    rescueGuardReloads += 1
  })
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: function patchedRescueGuardCreateObjectURL(blob: Blob) {
      rescueGuardBlobs.push(blob)
      return rescueGuardOriginalCreateObjectURL.call(URL, blob)
    },
  })
  rescueGuardInjector.install()
  try {
    // 4l-1) 场景 A（组 1：两条均未点开，内存缓存为空）：首次导出读取注入 1 次原生
    //        IDBTransaction.abort() → 自动重试必须导出 cold 与 hot 的完整正文（2/2）。
    resetRescueResidue()
    resetChatBeforeRefresh()
    await clearDatabase()
    await saveSession(makeSession(coldId, coldBody, Date.now() - 2000))
    await saveSession(makeSession(hotId, hotBody, Date.now() - 1000))
    // 模拟刷新：内存全部丢弃后重新初始化，两条会话都不点开 → sessionCache 保持为空
    await initChat()
    eq(
      Object.keys(useChatStore.getState().sessionCache),
      [],
      'scenario A starts with an empty in-memory session cache and two database sessions'
    )
    eq(useChatStore.getState().summaries.length, 2, 'scenario A lists both stored sessions')
    useConfigStore.setState({
      mode: 'static',
      ready: true,
      offline: false,
      settings: coldHotSettings,
    })
    const singleAbortTicket = rescueGuardInjector.armReadAbort('sessions', 'getAll')
    rescueGuardBlobs.length = 0
    const scenarioA = await hardReset({ exportBackup: true, keepKeys: false })
    eq(
      scenarioA,
      { ok: true },
      'scenario A: a single aborted export read is retried and the hard reset completes'
    )
    ok(
      singleAbortTicket.fired,
      'scenario A injected exactly one native abort into the first export read'
    )
    eq(rescueGuardReloads, 1, 'scenario A reloads the page once after the successful purge')
    const scenarioAText = rescueGuardBlobs.length > 0 ? await rescueGuardBlobs[0].text() : ''
    ok(
      scenarioAText.includes(coldBody),
      'scenario A rescue export contains the unique cold session body after the retry'
    )
    ok(
      scenarioAText.includes(hotBody),
      'scenario A rescue export contains the unique hot session body after the retry'
    )
    eq(
      scenarioAText.split('\n').filter((line) => line.startsWith('## session rescue-')).length,
      2,
      'scenario A rescue export carries both sessions in full (2/2)'
    )

    // 4l-2) 场景 B（组 2：仅点开 hot，缓存只有 1 条）：连续两次原生 abort 让导出读取
    //       彻底失败 → hardReset 必须在 clearDatabase() 之前中止、不下载残缺抢救包，
    //       重新打开数据库后 cold 与 hot 的完整正文必须 100% 保留。
    resetRescueResidue()
    resetChatBeforeRefresh()
    await clearDatabase()
    await saveSession(makeSession(coldId, coldBody, Date.now() - 2000))
    await saveSession(makeSession(hotId, hotBody, Date.now() - 1000))
    await initChat()
    // 真实点开 hot：缓存里只有这一条，旧实现会拿它拼出“非空但不完整”的抢救包
    await selectSession(hotId)
    eq(
      Object.keys(useChatStore.getState().sessionCache),
      [hotId],
      'scenario B keeps only the opened hot session in the in-memory cache'
    )
    useConfigStore.setState({
      mode: 'static',
      ready: true,
      offline: false,
      settings: coldHotSettings,
    })
    const firstExportAbort = rescueGuardInjector.armReadAbort('sessions', 'getAll')
    const retryExportAbort = rescueGuardInjector.armReadAbort('sessions', 'getAll')
    rescueGuardBlobs.length = 0
    const reloadsBeforeScenarioB = rescueGuardReloads
    const scenarioB = await hardReset({ exportBackup: true, keepKeys: false })
    eq(
      scenarioB,
      { ok: false, reason: 'backupFailed' },
      'scenario B: persistent export-read aborts abort the hard reset before any purge'
    )
    ok(
      firstExportAbort.fired,
      'scenario B aborted the first native export read'
    )
    ok(
      retryExportAbort.fired,
      'scenario B aborted the single automatic retry of the export read as well'
    )
    eq(
      rescueGuardBlobs.length,
      0,
      'scenario B downloads no partial rescue file when the full database read is incomplete'
    )
    eq(
      rescueGuardReloads,
      reloadsBeforeScenarioB,
      'scenario B never reloads the page after the aborted rescue export'
    )
    eq(
      useChatStore.getState().summaries.length,
      2,
      'scenario B keeps the summary list untouched instead of clearing it'
    )
    // 直接重开数据库核对：aborted reset 绝不允许删掉任何一条完整正文
    const preservedSessions = await loadAllSessions()
    eq(preservedSessions.length, 2, 'scenario B leaves both database session records in place')
    eq(
      preservedSessions.map((session) => session.messages[0]?.content).sort(),
      [coldBody, hotBody].sort(),
      'scenario B keeps the cold and hot unique bodies byte-for-byte intact in IndexedDB'
    )
    firstExportAbort.cancel()
    retryExportAbort.cancel()
  } finally {
    rescueGuardInjector.uninstall()
    if (rescueGuardOriginalDefineUrl) {
      Object.defineProperty(URL, 'createObjectURL', rescueGuardOriginalDefineUrl)
    } else {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: rescueGuardOriginalCreateObjectURL,
      })
    }
    setReloadAfterReset(null)
  }

  // 4m) 启动摘要读取中止：界面必须显示 sessionReadFailed，而不是误报 saveFailed；
  //     点击重试按钮后重新执行 initChat() 并恢复会话列表。
  resetRescueResidue()
  resetChatBeforeRefresh()
  await clearDatabase()
  await saveSession(makeSession('startup-read-target', 'STARTUP-READ-BODY-a17c'))
  useConfigStore.setState({
    mode: 'static',
    ready: true,
    offline: false,
    settings: coldHotSettings,
  })
  const startupContainer = document.createElement('div')
  document.body.appendChild(startupContainer)
  const startupRoot = createRoot(startupContainer)
  const startupAbortInjector = createIdbAbortInjector()
  startupAbortInjector.install()
  const startupTicket = startupAbortInjector.armReadAbort('summaries', 'getAll')
  try {
    startupRoot.render(createElement(App))
    ok(
      await waitForCondition(
        () => (startupContainer.textContent ?? '').includes('Loading the chat failed'),
        8000
      ),
      'an aborted startup summary read renders the session-read failure banner'
    )
    ok(
      !(startupContainer.textContent ?? '').includes('Saving failed'),
      'the startup read failure never shows the misleading saveFailed wording'
    )
    ok(
      startupTicket.fired,
      'the startup test injected one native abort into the initial summaries.getAll() read'
    )
    eq(
      useChatStore.getState().initFailure,
      'read',
      'initChat records the read-specific failure state instead of a save failure'
    )
    const retryInitButton = Array.from(startupContainer.querySelectorAll('button')).find(
      (button) => (button.textContent ?? '').trim() === 'Retry'
    )
    ok(Boolean(retryInitButton), 'the session-read failure banner renders a Retry button')
    retryInitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ok(
      await waitForCondition(
        () =>
          useChatStore
            .getState()
            .summaries.some((summary) => summary.id === 'startup-read-target'),
        8000
      ),
      'clicking Retry re-runs initChat and restores the summary list'
    )
    ok(
      await waitForCondition(
        () => !(startupContainer.textContent ?? '').includes('Loading the chat failed'),
        5000
      ),
      'the session-read failure banner disappears after the successful retry'
    )
    eq(
      useChatStore.getState().initFailure,
      null,
      'a successful initChat clears the recorded read-failure state'
    )
  } finally {
    startupTicket.cancel()
    startupAbortInjector.uninstall()
    startupRoot.unmount()
    startupContainer.remove()
  }
  await clearDatabase()
  clearAllDrafts()

  // 4n) 读取旧 A → 删除 A → 导入同 ID 的 A' 并立即选中：先放行旧回调再放行新回调（P2）
  await clearDatabase()
  clearAllDrafts()
  // 清掉之前用例可能残留的应急快照，避免 initChat 的补写路径额外发起读取
  for (const storageKey of Object.keys(localStorage)) {
    if (storageKey.startsWith('eac:unsaved:session:')) {
      localStorage.removeItem(storageKey)
    }
  }
  const crossRaceId = 'same-id-selection-race'
  const crossOldA = makeSession(crossRaceId, 'OLD A CONTENT BEFORE DELETE')
  await saveSession(crossOldA)
  useChatStore.setState({
    ready: true,
    activeId: null,
    sessionCache: {},
    summaries: [toSessionSummary(crossOldA)],
    streaming: {},
    pendingCapsule: null,
  })
  const crossStoreProto = IDBObjectStore.prototype as unknown as Record<string, unknown>
  const crossOriginalGet = crossStoreProto.get as (...args: unknown[]) => IDBRequest
  const crossGates: GatedIdbRequest[] = []
  let crossGateArmed = false
  try {
    Object.defineProperty(crossStoreProto, 'get', {
      configurable: true,
      writable: true,
      value: function gatedSessionGet(this: IDBObjectStore, ...args: unknown[]) {
        const request = crossOriginalGet.apply(this, args) as IDBRequest
        if (!crossGateArmed || this.name !== 'sessions') {
          return request
        }
        const gated = createGatedRequest(request, args[0] as IDBValidKey)
        crossGates.push(gated)
        return gated.request
      },
    })
    crossGateArmed = true
    const oldSelection = selectSession(crossRaceId)
    ok(
      await waitForCondition(() => crossGates.length === 1, 4000),
      'the first read of the old A is held before its callback is released'
    )
    await deleteSession(crossRaceId)
    eq(
      useChatStore.getState().activeId,
      null,
      'deleting the active old A clears the selection before the re-import'
    )
    const reimported = makeSession(crossRaceId, 'NEW A PRIME CONTENT')
    const atomicImport = await importSessionsAtomically([reimported])
    adoptImportedSessions(atomicImport.ids)
    await initChat()
    const newSelection = selectSession(crossRaceId)
    ok(
      await waitForCondition(() => crossGates.length === 2, 4000),
      'the read of the re-imported A-prime is issued and held as well'
    )
    // 先放行旧 A：它的选择序号已经过期，绝不能把界面退回欢迎页
    crossGates[0].release()
    await sleep(150)
    eq(
      useChatStore.getState().activeId,
      crossRaceId,
      'the stale old-A read callback never clears the newly selected A-prime'
    )
    // 再放行新 A'：正文必须来自 A'
    crossGates[1].release()
    await Promise.all([oldSelection, newSelection])
    eq(
      useChatStore.getState().activeId,
      crossRaceId,
      'the selection stays on A-prime after both reads settle'
    )
    eq(
      getCachedSession(crossRaceId)?.messages[0]?.content,
      'NEW A PRIME CONTENT',
      'the loaded body belongs to the re-imported A-prime'
    )
  } finally {
    crossGateArmed = false
    Object.defineProperty(crossStoreProto, 'get', {
      configurable: true,
      writable: true,
      value: crossOriginalGet,
    })
  }
  await clearDatabase()
  clearAllDrafts()

  // 4o-0) 501 行 XLSX 经真实附件解析入口：行上限截断必须同步到 attachment.truncated
  const rows501File = new File([rows501Xlsx], 'rows-501.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const rows501Attachment = await parseAttachmentFile(rows501File, { remote: null })
  eq(rows501Attachment.kind, 'office', '501-row XLSX is parsed as an Office attachment')
  eq(
    rows501Attachment.truncated,
    true,
    '501-row XLSX attachment carries truncated === true instead of a silent row cut'
  )
  ok(
    (rows501Attachment.text ?? '').includes('row-500'),
    '501-row XLSX attachment keeps the first 500 rows'
  )
  ok(
    (rows501Attachment.text ?? '').includes(
      '[Truncated: showing the first 500 non-empty rows and 1 columns]'
    ),
    '501-row XLSX attachment carries the row-limit truncation marker'
  )

  // 4o) 流式生成途中硬复位失败：已显示的半截回复必须安全落到 IndexedDB / 应急快照（P1）
  const liveStreams: MockSseStream[] = []
  const liveFetch = globalThis.fetch
  globalThis.fetch = (() => {
    const stream = makeMockSseStream()
    liveStreams.push(stream)
    return Promise.resolve(stream.response)
  }) as typeof fetch
  const liveSettings = createDefaultSettings()
  liveSettings.channels.primary = {
    ...createChannelConfig('Primary'),
    baseUrl: 'http://127.0.0.1:9',
    model: 'selftest-model',
  }
  useConfigStore.setState({
    mode: 'static',
    ready: true,
    offline: false,
    settings: liveSettings,
  })
  const liveStoreProto = IDBObjectStore.prototype as unknown as Record<string, unknown>
  const liveOriginalPut = liveStoreProto.put as (...args: unknown[]) => unknown
  const liveOriginalClear = liveStoreProto.clear as (...args: unknown[]) => unknown
  const liveOriginalCreateObjectURL = URL.createObjectURL
  const liveOriginalDefineUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  const liveBlobs: Blob[] = []
  let liveReloads = 0
  let clearCalls = 0
  let clearAborts = 0
  let clearAbortArmed = false
  let settlePutAborts = 0
  let settlePutAbortArmed = false
  let settlePutTargetId = ''
  const liveUnsavedKey = (sessionId: string) => `eac:unsaved:session:${sessionId}`
  const clearLiveEmergencySnapshots = () => {
    for (const storageKey of Object.keys(localStorage)) {
      if (storageKey.startsWith('eac:unsaved:session:')) {
        localStorage.removeItem(storageKey)
      }
    }
  }
  const resetLiveStore = () =>
    useChatStore.setState({
      ready: true,
      initFailure: null,
      activeId: null,
      sessionCache: {},
      summaries: [],
      streaming: {},
      pendingCapsule: null,
      saveError: false,
    })
  const simulateLiveRefresh = () =>
    useChatStore.setState({
      ready: false,
      initFailure: null,
      activeId: null,
      sessionCache: {},
      summaries: [],
      streaming: {},
      pendingCapsule: null,
      saveError: false,
    })
  const liveAssistant = (sessionId: string) =>
    (getCachedSession(sessionId)?.messages ?? []).find((message) => message.role === 'assistant')
  const readDbAssistant = async (sessionId: string) => {
    const db = await openDB('engineering-ai-console')
    try {
      const record = (await db.get('sessions', sessionId)) as Session | undefined
      return (record?.messages ?? []).find((message) => message.role === 'assistant')
    } finally {
      db.close()
    }
  }
  const startLiveReply = async (label: string): Promise<string> => {
    await clearDatabase()
    clearAllDrafts()
    clearLiveEmergencySnapshots()
    resetLiveStore()
    liveStreams.length = 0
    eq(sendMessage({ text: label, attachments: [] }), true, `${label}: live send starts`)
    const sessionId = useChatStore.getState().activeId ?? ''
    ok(Boolean(sessionId), `${label}: live session id assigned`)
    await waitForCondition(() => liveStreams.length === 1, 4000)
    liveStreams[0].push('data: {"choices":[{"delta":{"content":"LIVE-"}}]}\n\n')
    liveStreams[0].push('data: {"choices":[{"delta":{"content":"HALF"}}]}\n\n')
    ok(
      await waitForCondition(
        () =>
          (getCachedSession(sessionId)?.messages ?? []).some(
            (message) => message.role === 'assistant' && message.content === 'LIVE-HALF'
          ),
        4000
      ),
      `${label}: the displayed half reply arrives over a real SSE stream`
    )
    const storedBeforeReset = (await loadSession(sessionId))?.messages.find(
      (message) => message.role === 'assistant'
    )
    ok(
      !storedBeforeReset || storedBeforeReset.content !== 'LIVE-HALF',
      `${label}: IndexedDB still lacks the displayed half reply before the hard reset`
    )
    return sessionId
  }
  setReloadAfterReset(() => {
    liveReloads += 1
  })
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: function patchedLiveCreateObjectURL(blob: Blob) {
      liveBlobs.push(blob)
      return liveOriginalCreateObjectURL.call(URL, blob)
    },
  })
  Object.defineProperty(liveStoreProto, 'put', {
    configurable: true,
    writable: true,
    value: function patchedLivePut(this: IDBObjectStore, ...args: unknown[]) {
      const record = args[0] as Session | undefined
      if (
        settlePutAbortArmed &&
        this.name === 'sessions' &&
        this.transaction.mode === 'readwrite' &&
        record?.id === settlePutTargetId &&
        (record.messages ?? []).some(
          (message) => message.role === 'assistant' && message.content === 'LIVE-HALF'
        )
      ) {
        settlePutAborts += 1
        const tx = this.transaction
        queueMicrotask(() => {
          try {
            tx.abort()
          } catch {
            // 事务可能已提交 / 已中止
          }
        })
      }
      return liveOriginalPut.apply(this, args)
    },
  })
  Object.defineProperty(liveStoreProto, 'clear', {
    configurable: true,
    writable: true,
    value: function patchedLiveClear(this: IDBObjectStore, ...args: unknown[]) {
      clearCalls += 1
      const request = liveOriginalClear.apply(this, args)
      if (
        clearAbortArmed &&
        clearAborts === 0 &&
        this.name === 'sessions' &&
        this.transaction.mode === 'readwrite'
      ) {
        clearAborts += 1
        const tx = this.transaction
        queueMicrotask(() => {
          try {
            tx.abort()
          } catch {
            // 事务可能已提交 / 已中止
          }
        })
      }
      return request
    },
  })
  const liveInjector = createIdbAbortInjector()
  liveInjector.install()
  try {
    // 变体 A1：导出读取连续两次中止 → backupFailed；清库 0 次、下载 0 个；
    //          刷新后原会话必须从 IndexedDB 恢复 LIVE-HALF（stopped），而非空串 pending。
    const a1Id = await startLiveReply('variant A1')
    const a1FirstAbort = liveInjector.armReadAbort('sessions', 'getAll')
    const a1RetryAbort = liveInjector.armReadAbort('sessions', 'getAll')
    const a1Rejections: unknown[] = []
    const onA1Rejection = (event: PromiseRejectionEvent) => {
      a1Rejections.push(event.reason)
    }
    window.addEventListener('unhandledrejection', onA1Rejection)
    clearCalls = 0
    liveBlobs.length = 0
    liveReloads = 0
    const a1Result = await hardReset({ exportBackup: true, keepKeys: false })
    await sleep(150)
    window.removeEventListener('unhandledrejection', onA1Rejection)
    eq(
      a1Result,
      { ok: false, reason: 'backupFailed' },
      'variant A1: persistent export-read aborts abort the reset as backupFailed'
    )
    ok(a1FirstAbort.fired, 'variant A1: the first export read was aborted natively')
    ok(a1RetryAbort.fired, 'variant A1: the retried export read was aborted natively as well')
    eq(liveBlobs.length, 0, 'variant A1: no partial rescue file is downloaded')
    eq(clearCalls, 0, 'variant A1: clearDatabase() is never called before a complete backup')
    eq(a1Rejections.length, 0, 'variant A1: the aborted reset leaks no global unhandledrejection')
    eq(liveReloads, 0, 'variant A1: a failed hard reset never reloads the page')
    const a1Memory = liveAssistant(a1Id)
    eq(
      a1Memory && a1Memory.role === 'assistant' ? a1Memory.content : '',
      'LIVE-HALF',
      'variant A1: the in-memory half reply is kept after the aborted reset'
    )
    eq(
      a1Memory && a1Memory.role === 'assistant' ? a1Memory.status : undefined,
      'stopped',
      'variant A1: the in-memory half reply is settled to stopped'
    )
    const a1DbReply = await readDbAssistant(a1Id)
    eq(
      a1DbReply && a1DbReply.role === 'assistant' ? a1DbReply.content : '',
      'LIVE-HALF',
      'variant A1: a fresh IndexedDB connection sees the displayed half reply persisted'
    )
    eq(
      a1DbReply && a1DbReply.role === 'assistant' ? a1DbReply.status : undefined,
      'stopped',
      'variant A1: the persisted half reply is stopped, never an empty pending placeholder'
    )
    eq(
      localStorage.getItem(liveUnsavedKey(a1Id)),
      null,
      'variant A1: the successful convergence save clears the emergency snapshot'
    )
    simulateLiveRefresh()
    await initChat()
    await selectSession(a1Id)
    const a1Recovered = liveAssistant(a1Id)
    eq(
      a1Recovered && a1Recovered.role === 'assistant' ? a1Recovered.content : '',
      'LIVE-HALF',
      'variant A1: a simulated refresh restores the complete displayed half reply'
    )
    eq(
      a1Recovered && a1Recovered.role === 'assistant' ? a1Recovered.status : undefined,
      'stopped',
      'variant A1: the refreshed session shows stopped instead of a pending empty message'
    )

    // 变体 A2：连收敛落盘 saveSession 也被原生 abort → 应急快照必须独立兜底，
    //          刷新后仍能恢复 LIVE-HALF（stopped）。
    const a2Id = await startLiveReply('variant A2')
    settlePutTargetId = a2Id
    settlePutAborts = 0
    settlePutAbortArmed = true
    const a2FirstAbort = liveInjector.armReadAbort('sessions', 'getAll')
    const a2RetryAbort = liveInjector.armReadAbort('sessions', 'getAll')
    clearCalls = 0
    liveBlobs.length = 0
    liveReloads = 0
    const a2Result = await hardReset({ exportBackup: true, keepKeys: false })
    settlePutAbortArmed = false
    eq(
      a2Result,
      { ok: false, reason: 'backupFailed' },
      'variant A2: export-read aborts still abort the reset before any purge'
    )
    ok(a2FirstAbort.fired && a2RetryAbort.fired, 'variant A2: both export reads were aborted')
    ok(
      settlePutAborts >= 2,
      'variant A2: the convergence save and its retry were both aborted natively'
    )
    eq(clearCalls, 0, 'variant A2: clearDatabase() is never reached')
    const a2DbReply = await readDbAssistant(a2Id)
    ok(
      !a2DbReply || a2DbReply.content !== 'LIVE-HALF',
      'variant A2: the aborted convergence save leaves the database without the displayed text'
    )
    const a2SnapshotRaw = localStorage.getItem(liveUnsavedKey(a2Id))
    ok(Boolean(a2SnapshotRaw), 'variant A2: the emergency snapshot survives the aborted save')
    const a2Snapshot = a2SnapshotRaw ? (JSON.parse(a2SnapshotRaw) as { session: Session }) : null
    const a2SnapshotReply = (a2Snapshot?.session.messages ?? []).find(
      (message) => message.role === 'assistant'
    )
    eq(
      a2SnapshotReply && a2SnapshotReply.role === 'assistant' ? a2SnapshotReply.content : '',
      'LIVE-HALF',
      'variant A2: the emergency snapshot carries the displayed half reply'
    )
    eq(
      a2SnapshotReply && a2SnapshotReply.role === 'assistant' ? a2SnapshotReply.status : undefined,
      'stopped',
      'variant A2: the emergency snapshot stores the reply as stopped'
    )
    simulateLiveRefresh()
    await initChat()
    await selectSession(a2Id)
    const a2Recovered = liveAssistant(a2Id)
    eq(
      a2Recovered && a2Recovered.role === 'assistant' ? a2Recovered.content : '',
      'LIVE-HALF',
      'variant A2: a simulated refresh restores the half reply from the emergency snapshot'
    )
    eq(
      a2Recovered && a2Recovered.role === 'assistant' ? a2Recovered.status : undefined,
      'stopped',
      'variant A2: the snapshot-restored reply is stopped instead of pending'
    )

    // 变体 B：抢救包下载成功、清库事务被原生 abort → databaseFailed；
    //        导出文件包含 LIVE-HALF，刷新重开原会话仍完整恢复。
    const bId = await startLiveReply('variant B')
    const bRejections: unknown[] = []
    const onBRejection = (event: PromiseRejectionEvent) => {
      bRejections.push(event.reason)
    }
    window.addEventListener('unhandledrejection', onBRejection)
    clearCalls = 0
    clearAborts = 0
    clearAbortArmed = true
    liveBlobs.length = 0
    liveReloads = 0
    const bResult = await hardReset({ exportBackup: true, keepKeys: false })
    clearAbortArmed = false
    await sleep(150)
    window.removeEventListener('unhandledrejection', onBRejection)
    eq(
      bResult,
      { ok: false, reason: 'databaseFailed' },
      'variant B: an aborted purge fails the reset instead of reloading'
    )
    eq(clearAborts, 1, 'variant B: the purge transaction was aborted natively exactly once')
    eq(liveReloads, 0, 'variant B: the aborted purge never reloads the page')
    eq(bRejections.length, 0, 'variant B: the aborted purge leaks no global unhandledrejection')
    ok(liveBlobs.length > 0, 'variant B: the rescue package was downloaded before the purge')
    const bRescueText = liveBlobs.length > 0 ? await liveBlobs[0].text() : ''
    ok(
      bRescueText.includes('LIVE-HALF'),
      'variant B: the rescue package contains the displayed half reply'
    )
    eq(
      useChatStore.getState().summaries.length,
      1,
      'variant B: the aborted purge keeps the session list untouched'
    )
    const bDbReply = await readDbAssistant(bId)
    eq(
      bDbReply && bDbReply.role === 'assistant' ? bDbReply.content : '',
      'LIVE-HALF',
      'variant B: the aborted purge keeps the persisted half reply in IndexedDB'
    )
    eq(
      bDbReply && bDbReply.role === 'assistant' ? bDbReply.status : undefined,
      'stopped',
      'variant B: the persisted half reply survives the aborted purge as stopped'
    )
    simulateLiveRefresh()
    await initChat()
    await selectSession(bId)
    const bRecovered = liveAssistant(bId)
    eq(
      bRecovered && bRecovered.role === 'assistant' ? bRecovered.content : '',
      'LIVE-HALF',
      'variant B: a simulated refresh still restores the complete half reply'
    )
    eq(
      bRecovered && bRecovered.role === 'assistant' ? bRecovered.status : undefined,
      'stopped',
      'variant B: the refreshed reply is stopped, never a pending empty placeholder'
    )
  } finally {
    settlePutAbortArmed = false
    clearAbortArmed = false
    Object.defineProperty(liveStoreProto, 'put', {
      configurable: true,
      writable: true,
      value: liveOriginalPut,
    })
    Object.defineProperty(liveStoreProto, 'clear', {
      configurable: true,
      writable: true,
      value: liveOriginalClear,
    })
    if (liveOriginalDefineUrl) {
      Object.defineProperty(URL, 'createObjectURL', liveOriginalDefineUrl)
    } else {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: liveOriginalCreateObjectURL,
      })
    }
    setReloadAfterReset(null)
    liveInjector.uninstall()
    globalThis.fetch = liveFetch
    await clearDatabase()
    clearAllDrafts()
    clearLiveEmergencySnapshots()
  }

  // 4p) 设置页 JSON 导出读取连续中止：必须显示 sessionReadFailed，而非 saveFailed（P2）
  await clearDatabase()
  clearAllDrafts()
  await saveSession(makeSession('settings-export-target', 'EXPORT-BODY-c3d9'))
  useConfigStore.setState({
    mode: 'static',
    ready: true,
    offline: false,
    settings: createDefaultSettings(),
  })
  const exportInjector = createIdbAbortInjector()
  exportInjector.install()
  const exportRoot = createRoot(document.createElement('div'))
  const latestDialog = () =>
    document.querySelectorAll<HTMLElement>('[role="dialog"]').item(
      document.querySelectorAll('[role="dialog"]').length - 1
    )
  useUiStore.setState({ settingsOpen: true })
  try {
    exportRoot.render(createElement(SettingsDialog))
    ok(
      await waitForCondition(() => Boolean(latestDialog()), 6000),
      'the settings dialog opens for the JSON export read-failure test'
    )
    const dataTab = Array.from(latestDialog()?.querySelectorAll('button') ?? []).find(
      (button) => (button.textContent ?? '').trim() === 'Data'
    )
    ok(Boolean(dataTab), 'the settings dialog renders the Data tab button')
    dataTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ok(
      await waitForCondition(
        () =>
          Array.from(latestDialog()?.querySelectorAll('button') ?? []).some(
            (button) => (button.textContent ?? '').trim() === 'Export chats as JSON'
          ),
        4000
      ),
      'the Data tab renders the JSON export button'
    )
    const firstExportAbort = exportInjector.armReadAbort('sessions', 'getAll')
    const retryExportAbort = exportInjector.armReadAbort('sessions', 'getAll')
    const exportButton = Array.from(latestDialog()?.querySelectorAll('button') ?? []).find(
      (button) => (button.textContent ?? '').trim() === 'Export chats as JSON'
    )
    exportButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ok(
      await waitForCondition(
        () => (latestDialog()?.textContent ?? '').includes('Loading the chat failed'),
        6000
      ),
      'a JSON export whose full database read aborts shows the sessionReadFailed wording'
    )
    ok(
      !(latestDialog()?.textContent ?? '').includes('Saving failed'),
      'a JSON export read failure never shows the misleading saveFailed wording'
    )
    ok(
      firstExportAbort.fired && retryExportAbort.fired,
      'the JSON export test aborted both the export read and its single retry natively'
    )
  } finally {
    exportInjector.uninstall()
    useUiStore.setState({ settingsOpen: false })
    exportRoot.unmount()
    await clearDatabase()
    clearAllDrafts()
  }

  // 5) 附件：修正图片 Data URL MIME；旧版二进制与音频即使开远端也明确拒止
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const pngFile = new File([pngBytes], 'sample.png', { type: 'application/octet-stream' })
  const pngAttachment = await parseAttachmentFile(pngFile, { remote: null })
  ok(pngAttachment.kind === 'image', 'PNG with octet-stream MIME is recognised as an image')
  eq(pngAttachment.mediaType, 'image/png', 'PNG attachment media type is corrected to image/png')
  ok(
    pngAttachment.dataUrl?.startsWith('data:image/png;base64,') === true,
    'PNG data URL header MIME is synchronised to image/png'
  )
  // P2-05：既没有 MIME 也没有扩展名时，按前 12 字节魔数识别合法图片
  const magicCases: Array<{ head: number[]; name: string; mime: string }> = [
    { head: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], name: 'snapshot-png', mime: 'image/png' },
    { head: [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], name: 'snapshot-jpeg', mime: 'image/jpeg' },
    { head: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], name: 'snapshot-gif', mime: 'image/gif' },
    {
      head: [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
      name: 'snapshot-webp',
      mime: 'image/webp',
    },
  ]
  for (const magic of magicCases) {
    const extensionless = new File([new Uint8Array(magic.head)], magic.name, { type: '' })
    const sniffed = await parseAttachmentFile(extensionless, { remote: null })
    eq(sniffed.kind, 'image', `extension-less ${magic.mime} is recognised by its magic bytes`)
    eq(sniffed.mediaType, magic.mime, `magic-sniffed ${magic.mime} media type is corrected`)
    ok(
      sniffed.dataUrl?.startsWith(`data:${magic.mime};base64,`) === true,
      `magic-sniffed ${magic.mime} data URL MIME is corrected`
    )
  }
  const unknownBinary = new File([new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])], 'mystery', {
    type: '',
  })
  eq(
    (await parseAttachmentFile(unknownBinary, { remote: null })).kind,
    'rejected',
    'an extension-less unknown binary is still rejected instead of guessed'
  )
  const remoteChannel = {
    ...createChannelConfig('Remote'),
    protocol: 'anthropic' as const,
    enableRemoteFileApi: true,
    baseUrl: 'https://gateway.example/anthropic/v1',
  }
  const remoteContext = {
    mode: 'server' as const,
    token: '',
    slot: 'primary' as const,
    channel: remoteChannel,
    keyFingerprint: 'none',
  }
  const legacyDoc = new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])], 'legacy.doc', {
    type: 'application/msword',
  })
  const legacyAttachment = await parseAttachmentFile(legacyDoc, { remote: remoteContext })
  eq(legacyAttachment.kind, 'rejected', 'legacy .doc is rejected even with remote parsing enabled')
  eq(legacyAttachment.error, 'binaryUnsupported', 'legacy .doc reports an explicit unsupported reason')
  const audioFile = new File([new Uint8Array([0x49, 0x44, 0x33])], 'clip.mp3', {
    type: 'audio/mpeg',
  })
  const audioAttachment = await parseAttachmentFile(audioFile, { remote: remoteContext })
  eq(audioAttachment.kind, 'rejected', 'audio is rejected even with remote parsing enabled')
  const pdfFile = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'spec.pdf', {
    type: 'application/pdf',
  })
  const pdfLocalAttachment = await parseAttachmentFile(pdfFile, { remote: null })
  eq(pdfLocalAttachment.error, 'binaryUnsupported', 'PDF without remote parsing is explicitly refused')

  // 6) 标签页生命周期：挂载即心跳、可见时补心跳、pagehide 发 keepalive leave（server --auto-exit）
  const lifecycleCalls: Array<{
    action: string
    tabId: string
    token: string
    keepalive: boolean
  }> = []
  const lifecycleFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string; tabId?: string }
    lifecycleCalls.push({
      action: String(body.action),
      tabId: String(body.tabId),
      token: new Headers(init?.headers).get('X-Console-Token') ?? '',
      keepalive: Boolean(init?.keepalive),
    })
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  const lifecycleTracker = startLifecycleTracking({
    token: 'lifecycle-token-1234',
    fetchImpl: lifecycleFetch,
    heartbeatMs: 60_000,
  })
  try {
    await waitForCondition(() => lifecycleCalls.length >= 1, 3000)
    eq(lifecycleCalls.length, 1, 'mounting the page sends one immediate lifecycle heartbeat')
    eq(lifecycleCalls[0]?.action, 'heartbeat', 'the first lifecycle event is a heartbeat')
    eq(lifecycleCalls[0]?.token, 'lifecycle-token-1234', 'the heartbeat carries the console token')
    eq(lifecycleCalls[0]?.tabId, lifecycleTracker.tabId, 'the heartbeat carries this page tabId')
    document.dispatchEvent(new Event('visibilitychange'))
    await waitForCondition(() => lifecycleCalls.length >= 2, 3000)
    eq(
      lifecycleCalls.length,
      2,
      'returning to a visible tab sends an extra heartbeat'
    )
    window.dispatchEvent(new Event('pagehide'))
    await waitForCondition(() => lifecycleCalls.length >= 3, 3000)
    eq(lifecycleCalls.length, 3, 'pagehide sends exactly the leave notification')
    eq(lifecycleCalls[2]?.action, 'leave', 'closing the page sends the leave action')
    eq(lifecycleCalls[2]?.tabId, lifecycleTracker.tabId, 'the leave carries the same tabId')
    eq(lifecycleCalls[2]?.keepalive, true, 'the leave request uses keepalive so it survives unload')
    lifecycleTracker.stop()
    window.dispatchEvent(new Event('pagehide'))
    await sleep(30)
    eq(lifecycleCalls.length, 3, 'stop() removes the pagehide listener')
  } finally {
    lifecycleTracker.stop()
  }

  // 7) 密钥草稿自动提交：填了 KEY 直接点连通性自检，必须先把密钥真正存进服务端
  const autoCommitSettings = createDefaultSettings()
  autoCommitSettings.channels.primary = {
    ...createChannelConfig('Primary'),
    baseUrl: 'https://gateway-autocommit.example/v1',
    model: 'autocommit-model',
  }
  const autoCommitSnapshot = () => ({
    settings: autoCommitSettings,
    secrets: {
      primary: { hasKey: true, mask: '...7788', envSet: false, keyFingerprint: 'aaaaaaaaaaaa' },
      backup: { hasKey: false, mask: '', envSet: false, keyFingerprint: 'none' },
      exa: { hasKey: false, mask: '' },
      customHeaders: { primary: [], backup: [] },
    },
    storage: { settings: 'ok', secrets: 'ok', recovered: false, degraded: false },
  })
  useConfigStore.setState({
    mode: 'server',
    ready: true,
    offline: false,
    initError: null,
    serverToken: 'auto-commit-token',
    settings: autoCommitSettings,
    secrets: {
      primary: { hasKey: false, mask: '', envSet: false, keyFingerprint: 'none' },
      backup: { hasKey: false, mask: '', envSet: false, keyFingerprint: 'none' },
      exa: { hasKey: false, mask: '' },
      customHeaders: { primary: [], backup: [] },
    },
    storage: { settings: 'ok', secrets: 'ok', recovered: false, degraded: false },
    saving: false,
    saveError: false,
    saveFailure: 'none',
  })
  const autoCommitOriginalFetch = globalThis.fetch
  const autoCommitPosts: Array<Record<string, unknown>> = []
  const autoCommitPings: Array<Record<string, unknown>> = []
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/config' && (init?.method ?? 'GET') === 'POST') {
      autoCommitPosts.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return Promise.resolve(
        new Response(JSON.stringify(autoCommitSnapshot()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    }
    if (url === '/api/ping') {
      autoCommitPings.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return Promise.resolve(
        new Response(JSON.stringify({ reachable: true, modelsAvailable: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    }
    return Promise.resolve(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    )
  }) as typeof fetch
  const autoCommitContainer = document.createElement('div')
  document.body.appendChild(autoCommitContainer)
  const autoCommitRoot = createRoot(autoCommitContainer)
  try {
    autoCommitRoot.render(createElement(ChannelEditor, { slot: 'primary' }))
    const autoCommitKeyInput = await new Promise<HTMLInputElement | null>((resolve) => {
      const deadline = Date.now() + 5000
      const poll = () => {
        const input = autoCommitContainer.querySelector('input[type="password"]')
        if (input) {
          resolve(input as HTMLInputElement)
          return
        }
        if (Date.now() > deadline) {
          resolve(null)
          return
        }
        setTimeout(poll, 30)
      }
      poll()
    })
    ok(Boolean(autoCommitKeyInput), 'the auto-commit ChannelEditor renders the API key input')
    const autoCommitSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set
    autoCommitSetter?.call(autoCommitKeyInput, 'sk-autocommit-7788')
    autoCommitKeyInput?.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(60)
    useToast.setState({ id: 0, message: null, tone: null })
    const autoCommitPingButton = Array.from(
      autoCommitContainer.querySelectorAll('button')
    ).find((button) => (button.textContent ?? '').trim() === 'Test connection')
    ok(Boolean(autoCommitPingButton), 'the auto-commit test finds the connectivity button')
    autoCommitPingButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ok(
      await waitForCondition(
        () => autoCommitPings.length >= 1 && autoCommitPosts.length >= 1,
        6000
      ),
      'clicking the connectivity check saves the unsaved key and then pings'
    )
    eq(
      (autoCommitPosts[0]?.keys as Record<string, string> | undefined)?.primary,
      'sk-autocommit-7788',
      'the unsaved API key is persisted before the connectivity check'
    )
    eq(
      autoCommitPings[0]?.draftKey,
      undefined,
      'the ping no longer needs to smuggle an unsaved draft key'
    )
    ok(
      autoCommitContainer.textContent?.includes('Endpoint reachable.') === true,
      'the connectivity result is shown after the automatic save'
    )
  } finally {
    autoCommitRoot.unmount()
    autoCommitContainer.remove()
    globalThis.fetch = autoCommitOriginalFetch
  }

  // 8) 关闭设置弹窗：未点保存的密钥必须先落盘再关闭，不能静默丢输入
  const closeSettingsSettings = createDefaultSettings()
  closeSettingsSettings.channels.primary = {
    ...createChannelConfig('Primary'),
    baseUrl: 'https://gateway-close.example/v1',
    model: 'close-model',
  }
  useConfigStore.setState({
    mode: 'server',
    ready: true,
    offline: false,
    initError: null,
    serverToken: 'close-token',
    settings: closeSettingsSettings,
    secrets: {
      primary: { hasKey: false, mask: '', envSet: false, keyFingerprint: 'none' },
      backup: { hasKey: false, mask: '', envSet: false, keyFingerprint: 'none' },
      exa: { hasKey: false, mask: '' },
      customHeaders: { primary: [], backup: [] },
    },
    storage: { settings: 'ok', secrets: 'ok', recovered: false, degraded: false },
    saving: false,
    saveError: false,
    saveFailure: 'none',
  })
  const closeSettingsOriginalFetch = globalThis.fetch
  const closeSettingsPosts: Array<Record<string, unknown>> = []
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/config' && (init?.method ?? 'GET') === 'POST') {
      closeSettingsPosts.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return Promise.resolve(
        new Response(JSON.stringify({
          settings: closeSettingsSettings,
          secrets: {
            primary: { hasKey: true, mask: '...9900', envSet: false, keyFingerprint: 'bbbbbbbbbbbb' },
            backup: { hasKey: false, mask: '', envSet: false, keyFingerprint: 'none' },
            exa: { hasKey: false, mask: '' },
            customHeaders: { primary: [], backup: [] },
          },
          storage: { settings: 'ok', secrets: 'ok', recovered: false, degraded: false },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    }
    return Promise.resolve(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    )
  }) as typeof fetch
  const closeSettingsRoot = createRoot(document.createElement('div'))
  useUiStore.setState({ settingsOpen: true })
  try {
    closeSettingsRoot.render(createElement(SettingsDialog))
    const closeDialog = () =>
      document.querySelectorAll<HTMLElement>('[role="dialog"]').item(
        document.querySelectorAll('[role="dialog"]').length - 1
      )
    ok(
      await waitForCondition(() => Boolean(closeDialog()), 6000),
      'the settings dialog opens for the close-autocommit test'
    )
    const channelsTab = Array.from(closeDialog()?.querySelectorAll('button') ?? []).find(
      (button) => (button.textContent ?? '').trim() === 'Channels'
    )
    ok(Boolean(channelsTab), 'the settings dialog renders the Channels tab')
    channelsTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const closeKeyInput = await new Promise<HTMLInputElement | null>((resolve) => {
      const deadline = Date.now() + 5000
      const poll = () => {
        const input = closeDialog()?.querySelector('input[type="password"]')
        if (input) {
          resolve(input as HTMLInputElement)
          return
        }
        if (Date.now() > deadline) {
          resolve(null)
          return
        }
        setTimeout(poll, 30)
      }
      poll()
    })
    ok(Boolean(closeKeyInput), 'the Channels tab renders the API key input')
    const closeKeySetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set
    closeKeySetter?.call(closeKeyInput, 'sk-close-9900')
    closeKeyInput?.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(60)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    ok(
      await waitForCondition(() => closeSettingsPosts.length >= 1, 6000),
      'closing the settings dialog first saves the unsaved key'
    )
    eq(
      (closeSettingsPosts[0]?.keys as Record<string, string> | undefined)?.primary,
      'sk-close-9900',
      'the unsaved key really reaches the local service before the dialog closes'
    )
    ok(
      await waitForCondition(() => useUiStore.getState().settingsOpen === false, 3000),
      'the settings dialog closes after the draft is committed'
    )
  } finally {
    useUiStore.setState({ settingsOpen: false })
    closeSettingsRoot.unmount()
    globalThis.fetch = closeSettingsOriginalFetch
  }

  // 9) 通道编辑器：首屏四件套、实时最终地址、默认折叠的高级设置与激活计数
  const channelUiSettings = createDefaultSettings()
  channelUiSettings.channels.primary = {
    ...createChannelConfig('Primary'),
    baseUrl: 'https://api.example.com/v1',
    model: 'model-id',
  }
  const channelUiSecrets = () => ({
    primary: { hasKey: false, mask: '' },
    backup: { hasKey: false, mask: '' },
    exa: { hasKey: false, mask: '' },
    customHeaders: { primary: [], backup: [] },
  })
  useConfigStore.setState({
    mode: 'static',
    ready: true,
    offline: false,
    settings: channelUiSettings,
    secrets: channelUiSecrets(),
    saving: false,
    saveError: false,
    saveFailure: 'none',
  })
  const channelEditorContainer = document.createElement('div')
  document.body.appendChild(channelEditorContainer)
  const channelEditorRoot = createRoot(channelEditorContainer)
  const channelUiOriginalFetch = globalThis.fetch
  try {
    channelEditorRoot.render(createElement(ChannelEditor, { slot: 'primary' }))
    ok(
      await waitForCondition(
        () => Boolean(channelEditorContainer.querySelector('section')),
        5000
      ),
      'ChannelEditor renders its core section'
    )
    const coreSection = channelEditorContainer.querySelector('section') as HTMLElement
    const coreInputs = Array.from(coreSection.querySelectorAll('input'))
    eq(
      coreInputs.length,
      3,
      'the first screen keeps only the Base URL, API key and model inputs'
    )
    const protocolButtons = Array.from(
      coreSection.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')
    )
    eq(
      protocolButtons.map((button) => (button.textContent ?? '').trim()),
      ['OpenAI Compatible', 'Anthropic Messages'],
      'the protocol switch is a two-state segmented control with neutral labels'
    )
    const previewText = () =>
      (coreSection.querySelector('[aria-live="polite"]')?.textContent ?? '').trim()
    ok(
      previewText().includes('https://api.example.com/v1/chat/completions'),
      'the final request URL preview joins /chat/completions from the Base URL'
    )
    protocolButtons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ok(
      await waitForCondition(
        () => useConfigStore.getState().settings.channels.primary.protocol === 'anthropic',
        2000
      ),
      'clicking the Anthropic segment switches the protocol'
    )
    ok(
      previewText().includes('https://api.example.com/v1/messages'),
      'the preview follows the protocol switch'
    )
    eq(
      useConfigStore.getState().settings.channels.primary.thinkingParamMode,
      'anthropic_thinking',
      'switching to Anthropic applies its default thinking format'
    )
    const protocolButtonsAfterSwitch = Array.from(
      coreSection.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')
    )
    protocolButtonsAfterSwitch[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ok(
      await waitForCondition(
        () => useConfigStore.getState().settings.channels.primary.protocol === 'openai',
        2000
      ),
      'clicking the OpenAI segment switches back'
    )
    eq(
      useConfigStore.getState().settings.channels.primary.thinkingParamMode,
      'none',
      'switching back to OpenAI restores the passthrough default'
    )
    ok(previewText().includes('/chat/completions'), 'the preview returns to the OpenAI endpoint')

    const baseUrlInput = coreSection.querySelector('input') as HTMLInputElement
    const inputValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set
    inputValueSetter?.call(baseUrlInput, '')
    baseUrlInput.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(30)
    ok(
      previewText().includes('preview the final request URL'),
      'an empty Base URL shows the gentle preview hint instead of a broken URL'
    )
    inputValueSetter?.call(baseUrlInput, 'not-a-url')
    baseUrlInput.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(30)
    ok(
      previewText().includes('not a valid http(s) URL'),
      'an invalid Base URL explains the problem in the preview line'
    )
    inputValueSetter?.call(baseUrlInput, 'https://api.example.com/v1')
    baseUrlInput.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(30)

    const advanced = channelEditorContainer.querySelector('details') as HTMLDetailsElement | null
    ok(Boolean(advanced) && advanced?.open === false, 'Advanced settings is collapsed by default')
    advanced?.querySelector('summary')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(60)
    ok(advanced?.open === true, 'clicking the advanced summary expands the panel')
    const badgeText = () =>
      (advanced?.querySelector('summary span[aria-label]')?.textContent ?? '').trim()
    eq(badgeText(), '', 'a default channel shows no advanced badge')

    const lockCheckbox = Array.from(
      advanced?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? []
    ).find((input) =>
      (input.closest('label')?.textContent ?? '').includes('Lock the raw endpoint URL')
    )
    ok(Boolean(lockCheckbox), 'the advanced panel exposes the raw URL lock')
    lockCheckbox?.click()
    ok(
      await waitForCondition(
        () => useConfigStore.getState().settings.channels.primary.lockRawUrl === true,
        2000
      ),
      'toggling the raw URL lock writes the channel config'
    )
    eq(badgeText(), '(1)', 'the advanced badge reflects one active override')
    ok(
      previewText().includes('https://api.example.com/v1') &&
        !previewText().includes('/chat/completions'),
      'locking the raw URL makes the preview show the address exactly as written'
    )

    const timeoutInput = advanced?.querySelector('input[type="number"]') as
      | HTMLInputElement
      | null
    if (timeoutInput) {
      inputValueSetter?.call(timeoutInput, '30')
      timeoutInput.dispatchEvent(new Event('input', { bubbles: true }))
    }
    ok(
      await waitForCondition(
        () => useConfigStore.getState().settings.channels.primary.requestTimeoutSec === 30,
        2000
      ),
      'editing the request timeout writes the channel config'
    )
    eq(badgeText(), '(2)', 'the advanced badge counts the request timeout override')

    const thinkingSelect = Array.from(
      advanced?.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="listbox"]') ?? []
    ).find((button) => button.getAttribute('aria-label') === 'Thinking request fields')
    thinkingSelect?.click()
    ok(
      await waitForCondition(() => document.querySelector('[role="listbox"]') !== null, 2000),
      'the thinking format select opens its list'
    )
    const thinkingOption = Array.from(document.querySelectorAll('[role="option"]')).find(
      (option) => (option.textContent ?? '').includes('thinking: {type: "enabled"}')
    )
    thinkingOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ok(
      await waitForCondition(
        () =>
          useConfigStore.getState().settings.channels.primary.thinkingParamMode ===
          'deepseek_thinking',
        2000
      ),
      'choosing a thinking format writes the channel config'
    )
    eq(badgeText(), '(3)', 'a manually chosen thinking format counts as an override')
    const protocolButtonsAfterManual = Array.from(
      coreSection.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')
    )
    protocolButtonsAfterManual[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ok(
      await waitForCondition(
        () => useConfigStore.getState().settings.channels.primary.protocol === 'anthropic',
        2000
      ),
      'the protocol can still be switched after manually locking a thinking format'
    )
    eq(
      useConfigStore.getState().settings.channels.primary.thinkingParamMode,
      'deepseek_thinking',
      'a manually chosen thinking format is never overwritten by the protocol default'
    )

    const envInput = Array.from(
      advanced?.querySelectorAll<HTMLInputElement>('input') ?? []
    ).find((input) => input.placeholder === 'API_KEY')
    ok(Boolean(envInput), 'the advanced panel exposes the API key environment variable')
    if (envInput) {
      inputValueSetter?.call(envInput, 'MY_GATEWAY_KEY')
      envInput.dispatchEvent(new Event('input', { bubbles: true }))
    }
    ok(
      await waitForCondition(
        () => useConfigStore.getState().settings.channels.primary.apiKeyEnv === 'MY_GATEWAY_KEY',
        2000
      ),
      'editing the API key environment variable writes the channel config'
    )
    eq(badgeText(), '(4)', 'the environment variable name counts as an override')

    // 还原为干净的 OpenAI 通道后验证模型拉取与连通性测试
    useConfigStore.setState((state) => ({
      settings: {
        ...state.settings,
        channels: {
          ...state.settings.channels,
          primary: {
            ...state.settings.channels.primary,
            protocol: 'openai',
            lockRawUrl: false,
            requestTimeoutSec: 60,
            thinkingParamMode: 'none',
            apiKeyEnv: '',
            baseUrl: 'https://api.example.com/v1',
          },
        },
      },
    }))
    await sleep(30)
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const target = String(input)
      if (target.endsWith('/models')) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: [{ id: 'probe-model-a' }, { id: 'probe-model-b' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    }) as typeof fetch
    const fetchModelsButton = Array.from(
      coreSection.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => (button.textContent ?? '').trim() === 'Fetch models')
    ok(Boolean(fetchModelsButton), 'the model row exposes an inline Fetch models button')
    fetchModelsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ok(
      await waitForCondition(
        () => (channelEditorContainer.textContent ?? '').includes('probe-model-a'),
        4000
      ),
      'fetching models lists the returned ids inline'
    )
    const modelChip = Array.from(
      channelEditorContainer.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => (button.textContent ?? '').trim() === 'probe-model-b')
    modelChip?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ok(
      await waitForCondition(
        () => useConfigStore.getState().settings.channels.primary.model === 'probe-model-b',
        2000
      ),
      'clicking a fetched model fills the model field'
    )
    const testConnectionButton = Array.from(
      coreSection.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => (button.textContent ?? '').trim() === 'Test connection')
    ok(Boolean(testConnectionButton), 'the model section ends with a connectivity test button')
    testConnectionButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ok(
      await waitForCondition(
        () => (coreSection.textContent ?? '').includes('Endpoint reachable.'),
        4000
      ),
      'the connectivity test reports the reachable endpoint inline'
    )

    // 深度思考开关在标准透传通道上仍必须可用：点击只切换全局思考开关
    useConfigStore.setState({
      mode: 'static',
      ready: true,
      offline: false,
      settings: channelUiSettings,
      secrets: channelUiSecrets(),
    })
    const chatInputContainer = document.createElement('div')
    document.body.appendChild(chatInputContainer)
    const chatInputRoot = createRoot(chatInputContainer)
    chatInputRoot.render(createElement(ChatInput, { sessionId: null }))
    try {
      ok(
        await waitForCondition(
          () => Boolean(chatInputContainer.querySelector('button[aria-label="Deep thinking"]')),
          5000
        ),
        'the chat input renders the thinking toggle'
      )
      const thinkingToggle = chatInputContainer.querySelector(
        'button[aria-label="Deep thinking"]'
      ) as HTMLButtonElement | null
      thinkingToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      ok(
        await waitForCondition(
          () => useConfigStore.getState().settings.thinking === true,
          2000
        ),
        'the passthrough channel still lets the thinking toggle switch the global setting'
      )
    } finally {
      chatInputRoot.unmount()
      chatInputContainer.remove()
    }
  } finally {
    channelEditorRoot.unmount()
    channelEditorContainer.remove()
    globalThis.fetch = channelUiOriginalFetch
    localStorage.removeItem('eac:settings:v1')
    localStorage.removeItem('eac:settings:v1.bak')
  }

  // 9b) 高级设置：点击 Add header 的空白行必须跨过防抖与服务端快照回写周期仍然保留（P2 回归）
  const headerSettings = createDefaultSettings()
  headerSettings.channels.primary = {
    ...createChannelConfig('Primary'),
    baseUrl: 'https://api.example.com/v1',
    model: 'model-id',
  }
  useConfigStore.setState({
    mode: 'server',
    ready: true,
    offline: false,
    initError: null,
    serverToken: 'header-draft-token',
    settings: headerSettings,
    secrets: {
      primary: { hasKey: false, mask: '', envSet: false, keyFingerprint: 'none' },
      backup: { hasKey: false, mask: '', envSet: false, keyFingerprint: 'none' },
      exa: { hasKey: false, mask: '' },
      customHeaders: { primary: [], backup: [] },
    },
    storage: { settings: 'ok', secrets: 'ok', recovered: false, degraded: false },
    saving: false,
    saveError: false,
    saveFailure: 'none',
  })
  const headerOriginalFetch = globalThis.fetch
  const headerConfigPosts: Array<Record<string, unknown>> = []
  // 与 server.py 的 sanitize 行为一致：快照里只保留名称非空的 Header
  const headerSnapshotOf = (settings: ReturnType<typeof createDefaultSettings>) => ({
    settings,
    secrets: {
      primary: { hasKey: false, mask: '', envSet: false, keyFingerprint: 'none' },
      backup: { hasKey: false, mask: '', envSet: false, keyFingerprint: 'none' },
      exa: { hasKey: false, mask: '' },
      customHeaders: {
        primary: settings.channels.primary.customHeaders
          .filter((header) => header.name.trim().length > 0)
          .map((header) => ({ name: header.name, mask: '***' })),
        backup: [],
      },
    },
    storage: { settings: 'ok', secrets: 'ok', recovered: false, degraded: false },
  })
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/config' && (init?.method ?? 'GET') === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      headerConfigPosts.push(body)
      const submitted =
        (body.settings as ReturnType<typeof createDefaultSettings> | undefined) ??
        headerSettings
      const filtered = {
        ...submitted,
        channels: {
          ...submitted.channels,
          primary: {
            ...submitted.channels.primary,
            customHeaders: submitted.channels.primary.customHeaders.filter(
              (header) => header.name.trim().length > 0
            ),
          },
        },
      }
      return Promise.resolve(
        new Response(JSON.stringify(headerSnapshotOf(filtered)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    }
    return Promise.resolve(
      new Response(JSON.stringify(headerSnapshotOf(headerSettings)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  }) as typeof fetch
  const headerContainer = document.createElement('div')
  document.body.appendChild(headerContainer)
  const headerRoot = createRoot(headerContainer)
  try {
    headerRoot.render(createElement(ChannelEditor, { slot: 'primary' }))
    const headerDetailsReady = await waitForCondition(
      () => Boolean(headerContainer.querySelector('details')),
      5000
    )
    ok(headerDetailsReady, 'the header-draft ChannelEditor renders its advanced panel')
    const headerDetails = headerContainer.querySelector('details') as HTMLDetailsElement
    headerDetails.querySelector('summary')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    )
    await sleep(60)
    const addHeaderButton = Array.from(
      headerContainer.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => (button.textContent ?? '').trim() === 'Add header')
    ok(Boolean(addHeaderButton), 'the advanced panel exposes Add header')
    const headerNameInputs = () =>
      Array.from(headerContainer.querySelectorAll<HTMLInputElement>('input')).filter(
        (input) => input.placeholder === 'Header name'
      )
    eq(headerNameInputs().length, 0, 'a channel without custom headers starts with zero rows')
    addHeaderButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ok(
      await waitForCondition(() => headerNameInputs().length === 1, 2000),
      'clicking Add header appends one local draft row'
    )
    await sleep(600)
    eq(
      headerNameInputs().length,
      1,
      'the blank header row survives the debounce and the server snapshot (600 ms)'
    )
    eq(
      useConfigStore.getState().settings.channels.primary.customHeaders.length,
      0,
      'the blank row never reaches the store or the server'
    )
    eq(headerConfigPosts.length, 0, 'adding a blank row issues no config write')
    const headerSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set
    headerSetter?.call(headerNameInputs()[0], 'X-Trace-Id')
    headerNameInputs()[0]?.dispatchEvent(new Event('input', { bubbles: true }))
    headerNameInputs()[0]?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    ok(
      await waitForCondition(
        () =>
          useConfigStore.getState().settings.channels.primary.customHeaders[0]?.name ===
          'X-Trace-Id',
        3000
      ),
      'naming a draft row moves it into the channel configuration'
    )
    addHeaderButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    ok(
      await waitForCondition(() => headerNameInputs().length === 2, 2000),
      'a second blank draft row is appended after the persisted row'
    )
    await sleep(700)
    eq(
      headerNameInputs().length,
      2,
      'an external config snapshot keeps the trailing unfinished draft row'
    )
    ok(headerConfigPosts.length >= 1, 'the named header row was persisted through /api/config')
  } finally {
    headerRoot.unmount()
    headerContainer.remove()
    globalThis.fetch = headerOriginalFetch
  }

  // 10) 构建后的 dist 应用：真实浏览器加载、真实 IndexedDB 启动、欢迎页必须渲染
  const frame = document.createElement('iframe')
  frame.width = '900'
  frame.height = '700'
  frame.src = '/app/'
  frame.style.position = 'absolute'
  frame.style.left = '-2000px'
  document.body.appendChild(frame)
  try {
    const loaded = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 12_000)
      frame.addEventListener(
        'load',
        () => {
          clearTimeout(timer)
          resolve(true)
        },
        { once: true }
      )
    })
    ok(loaded, 'built dist application page loads in a real browser')
    const welcomeRendered = await waitForCondition(
      () =>
        (frame.contentDocument?.body?.textContent ?? '').includes(
          'What are we building today?'
        ),
      8000
    )
    ok(welcomeRendered, 'built dist application renders the welcome screen instead of a white page')
    const frameWindow = frame.contentWindow as
      | (Window & { __appErrors?: string[] })
      | null
    eq(frameWindow?.__appErrors ?? [], [], 'built dist application boots without uncaught runtime errors')
  } finally {
    frame.remove()
  }
}

const finish = () => {
  const result = document.createElement('pre')
  result.id = 'selftest-result'
  const header = failed === 0 ? 'SELFTEST OK' : 'SELFTEST FAILED'
  const text = [`${header} (${failed} failures)`, ...lines].join('\n')
  result.textContent = text
  document.body.appendChild(result)
  document.title = header
  void fetch('/result', { method: 'POST', body: text }).catch(() => undefined)
}

void runAsyncTests()
  .catch((error) => {
    failed++
    lines.push(`FAIL: async IndexedDB selftest crashed — ${error instanceof Error ? error.message : String(error)}`)
  })
  .finally(finish)
