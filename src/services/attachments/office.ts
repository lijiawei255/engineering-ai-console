/**
 * Office Open XML 纯本地确定性提取：fflate.unzipSync + 浏览器原生 DOMParser。
 *
 * 只处理 .docx / .xlsx / .pptx 三种基于 ZIP 的格式：
 * - docx：按文档顺序提取 body 与内容控件（sdt / sdtContent）中的段落和表格；
 * - xlsx：稀疏读取非空单元格，结合 sharedStrings 输出紧凑 Markdown 表格；
 * - pptx：按 presentation.xml 的 sldIdLst 真实页序提取文本框。
 *
 * 安全边界：ZIP 先做预算检查再解压。第一遍只用 filter 回调收集条目名与声明解压大小，
 * 不 inflate 任何条目；超过条目数 / 单条目 / 累计声明大小上限立即中止（officeTooLarge）。
 * 通过后第二遍仍然用 filter 只解压所需的 XML 部件，压缩炸弹无法把内存打爆。
 *
 * 旧版二进制 .doc/.xls/.ppt 与 PDF 不在此处解析：见 index.ts 的确定性拒止路径。
 */

import { unzipSync, strFromU8, type Unzipped } from 'fflate'
import { translate } from '../../i18n/index.js'

export type OfficeExt = 'docx' | 'xlsx' | 'pptx'

export type OfficeError = 'officeFailed' | 'officeTooLarge'

export type OfficeResult =
  | { ok: true; text: string; truncated?: boolean }
  | { ok: false; error: OfficeError }

/** 解压预算：条目数、单条目声明大小、累计声明大小 */
const MAX_ZIP_ENTRIES = 500
const MAX_ENTRY_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 10 * 1024 * 1024

/** 稀疏表格渲染上限：非空行 / 列 */
const MAX_SHEET_ROWS = 500
const MAX_SHEET_COLUMNS = 64

interface ZipEntryInfo {
  name: string
  originalSize: number
}

/** 预算超限哨兵：从 filter 回调抛出即可立刻中止中央目录扫描 */
class ZipBudgetExceeded extends Error {}

const readXml = (files: Unzipped, path: string): string | null => {
  const data = files[path]
  return data ? strFromU8(data) : null
}

const parseXml = (parser: DOMParser, xml: string): Document | null => {
  try {
    const doc = parser.parseFromString(xml, 'application/xml')
    const errors = doc.getElementsByTagName('parsererror')
    if (errors.length > 0) {
      return null
    }
    return doc
  } catch {
    return null
  }
}

/** 按 localName 收集元素（忽略命名空间前缀） */
const collect = (root: Document | Element, localName: string): Element[] => {
  const all = root.getElementsByTagName('*')
  const result: Element[] = []
  for (let index = 0; index < all.length; index++) {
    const element = all[index]
    if (element.localName === localName) {
      result.push(element)
    }
  }
  return result
}

const directChildren = (element: Element, localName: string): Element[] =>
  Array.from(element.children).filter((child) => child.localName === localName)

const textOf = (element: Element): string => {
  const parts = collect(element, 't')
  return parts.map((part) => part.textContent ?? '').join('')
}

/** ZIP 内部路径归一化：去掉前导斜杠与 . / .. 段，统一正斜杠 */
const normalizeZipPath = (target: string): string => {
  const parts: string[] = []
  for (const part of target.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') {
      continue
    }
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.join('/')
}

/**
 * 把关系文件的 Target 解析成 ZIP 内绝对路径。
 * Target 可能相对关系文件所在目录（base 目录），也可能直接写成以 / 或 base 目录开头的
 * 包内绝对路径；两种写法都归一化成不含重复前缀的路径，绝不允许拼出 xl/xl/...。
 */
const resolveRelationshipTarget = (baseDir: string, target: string): string => {
  let raw = target.replace(/\\/g, '/').trim()
  const rootRelative =
    raw.startsWith('/') || (baseDir !== '' && (raw === baseDir || raw.startsWith(`${baseDir}/`)))
  if (raw.startsWith('/')) {
    raw = raw.replace(/^\/+/, '')
  }
  const parts = rootRelative ? [] : baseDir.split('/').filter(Boolean)
  for (const part of raw.split('/')) {
    if (!part || part === '.') {
      continue
    }
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.join('/')
}

const normalizedEntryFilter = (predicate: (path: string) => boolean) => (file: {
  name: string
}) => predicate(normalizeZipPath(file.name))

/**
 * 第一遍：只收集条目元信息，不解压任何数据。
 * 返回条目列表或 'officeTooLarge'；ZIP 结构损坏抛异常由调用方判 officeFailed。
 */
const inspectZip = (data: Uint8Array): ZipEntryInfo[] | 'officeTooLarge' => {
  const entries: ZipEntryInfo[] = []
  let totalBytes = 0
  try {
    unzipSync(data, {
      filter: (file) => {
        if (entries.length >= MAX_ZIP_ENTRIES) {
          throw new ZipBudgetExceeded()
        }
        if (file.originalSize > MAX_ENTRY_BYTES) {
          throw new ZipBudgetExceeded()
        }
        totalBytes += file.originalSize
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw new ZipBudgetExceeded()
        }
        entries.push({ name: normalizeZipPath(file.name), originalSize: file.originalSize })
        return false
      },
    })
  } catch (error) {
    if (error instanceof ZipBudgetExceeded) {
      return 'officeTooLarge'
    }
    throw error
  }
  return entries
}

/** 第二遍：只解压 predicate 选中的条目，并把键统一成归一化路径 */
const unzipSelected = (data: Uint8Array, predicate: (path: string) => boolean): Unzipped => {
  const raw = unzipSync(data, { filter: normalizedEntryFilter(predicate) })
  const files: Unzipped = {}
  for (const [name, bytes] of Object.entries(raw)) {
    files[normalizeZipPath(name)] = bytes
  }
  return files
}

/** 需要的 XML 部件白名单；后续解析只在这些路径里读取 */
const requiredParts = (ext: OfficeExt): ((path: string) => boolean) => {
  if (ext === 'docx') {
    return (path) => path === 'word/document.xml'
  }
  if (ext === 'xlsx') {
    return (path) =>
      path === 'xl/workbook.xml' ||
      path === 'xl/_rels/workbook.xml.rels' ||
      path === 'xl/sharedStrings.xml' ||
      /^xl\/worksheets\/[^/]+\.xml$/i.test(path)
  }
  return (path) =>
    path === 'ppt/presentation.xml' ||
    path === 'ppt/_rels/presentation.xml.rels' ||
    /^ppt\/slides\/slide\d+\.xml$/i.test(path)
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

const paragraphText = (paragraph: Element): string => {
  const all = paragraph.getElementsByTagName('*')
  let text = ''
  for (let index = 0; index < all.length; index++) {
    const element = all[index]
    if (element.localName === 't') {
      text += element.textContent ?? ''
    } else if (element.localName === 'tab') {
      text += '\t'
    } else if (element.localName === 'br' || element.localName === 'cr') {
      text += '\n'
    }
  }
  return text
}

const escapeTableCell = (value: string): string =>
  value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()

/**
 * 输出预算：宽表逐行 / 逐单元格拼接时累计字符数，逼近上限就停下。
 * 不设上限的话，一个几千列、几百行的表格会先展开成十几 MB 的中间字符串再交给截断逻辑。
 * DOCX 表格与 XLSX 工作表共用同一 250,000 字符硬预算；追加截断提示后总输出仍
 * 严格小于 256,000 字符。
 */
const MAX_OFFICE_TABLE_CHARS = 250_000

interface OutputBudget {
  used: number
}

/** 在预算内记一笔；超限返回 false，调用方立即停止拼接并标记截断 */
const consumeOutputBudget = (budget: OutputBudget, chars: number): boolean => {
  if (budget.used + chars > MAX_OFFICE_TABLE_CHARS) {
    return false
  }
  budget.used += chars
  return true
}

/**
 * 整份文档的 UTF-8 字节预算。
 *
 * 单个表格 / 工作表另有 250,000 字符预算，但多表、多工作表、多幻灯片拼装后仍可能突破
 * 256 KB；中文等三字节字符还会让“字符数”显著低估“字节数”。因此在三个格式的最外层
 * 拼装循环统一按真实 UTF-8 字节累加，达到 240,000 字节就停止解析后续块并标记截断，
 * 预留的 16 KB 余量足以容纳截断提示，保证 extractOfficeText 返回的中间结果严格小于 256,000 字节。
 */
const MAX_OFFICE_DOCUMENT_BYTES = 240_000
const utf8Encoder = new TextEncoder()

const utf8ByteLength = (text: string): number => utf8Encoder.encode(text).length

/** 按 UTF-8 字节截断，按码点推进，绝不劈开代理对 / 多字节字符 */
const truncateToUtf8Bytes = (text: string, maxBytes: number): string => {
  if (maxBytes <= 0) {
    return ''
  }
  if (utf8ByteLength(text) <= maxBytes) {
    return text
  }
  let used = 0
  let end = 0
  for (const char of text) {
    const bytes = utf8ByteLength(char)
    if (used + bytes > maxBytes) {
      break
    }
    used += bytes
    end += char.length
  }
  return text.slice(0, end)
}

interface DocumentAccumulator {
  parts: string[]
  used: number
  truncated: boolean
}

const createDocumentAccumulator = (): DocumentAccumulator => ({
  parts: [],
  used: 0,
  truncated: false,
})

/**
 * 追加一个文档级内容块；放不下时只保留能放下的 UTF-8 前缀并标记截断。
 * 返回 false 表示调用方必须立即停止解析后续段落 / 表格 / 工作表 / 幻灯片。
 */
const appendDocumentBlock = (
  accumulator: DocumentAccumulator,
  block: string
): boolean => {
  if (!block) {
    return true
  }
  const separatorBytes = accumulator.parts.length > 0 ? 1 : 0
  const room = MAX_OFFICE_DOCUMENT_BYTES - accumulator.used - separatorBytes
  if (room <= 0) {
    accumulator.truncated = true
    return false
  }
  const blockBytes = utf8ByteLength(block)
  if (blockBytes <= room) {
    accumulator.parts.push(block)
    accumulator.used += separatorBytes + blockBytes
    return true
  }
  const prefix = truncateToUtf8Bytes(block, room)
  if (prefix) {
    accumulator.parts.push(prefix)
    accumulator.used += separatorBytes + utf8ByteLength(prefix)
  }
  accumulator.truncated = true
  return false
}

/** 收尾：截断时补一行明确说明（提示本身也远小于预留的 16 KB 余量），再统一压缩空行 */
const finishDocument = (accumulator: DocumentAccumulator): string => {
  if (accumulator.truncated) {
    accumulator.parts.push('', translate('officeTruncatedDocument'))
  }
  return accumulator.parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 块级内容控件容器：内容控件本身不产生文本，只负责继续向下遍历 */
const BLOCK_CONTAINER_NAMES = new Set([
  'body',
  'sdt',
  'sdtContent',
  'customXml',
  'ins',
  'del',
  'moveFrom',
  'moveTo',
])

const CELL_CONTAINER_NAMES = new Set(['sdt', 'sdtContent', 'customXml', 'ins', 'del'])

/** 沿内容控件容器收集指定子元素：控件也可以包住表格行 / 单元格，不能只看直接子节点 */
const containerChildren = (element: Element, localName: string): Element[] => {
  const result: Element[] = []
  const visit = (container: Element): void => {
    for (const child of Array.from(container.children)) {
      if (child.localName === localName) {
        result.push(child)
      } else if (CELL_CONTAINER_NAMES.has(child.localName)) {
        visit(child)
      }
    }
  }
  visit(element)
  return result
}

/**
 * 嵌套表格扁平化：按行、按单元格递归提取内表文本，用空格拼接。
 * Word 允许单元格里再套整张表格；只找段落会整块吞掉内表文字，这里让内表内容也进入单元格文本。
 */
const flattenNestedTable = (table: Element): string =>
  containerChildren(table, 'tr')
    .map((row) =>
      containerChildren(row, 'tc')
        .map((cell) => cellText(cell))
        .filter(Boolean)
        .join(' ')
    )
    .filter(Boolean)
    .join(' ')

/**
 * 单元格内容提取：按 DOM 子节点出现顺序递归处理普通段落 w:p、内容控件与嵌套子表格 w:tbl。
 * 单元格也可能被内容控件包一层，因此不能只找直接子节点。
 */
const cellText = (cell: Element): string => {
  const parts: string[] = []
  const visit = (container: Element): void => {
    for (const child of Array.from(container.children)) {
      if (child.localName === 'p') {
        parts.push(paragraphText(child))
      } else if (child.localName === 'tbl') {
        parts.push(flattenNestedTable(child))
      } else if (CELL_CONTAINER_NAMES.has(child.localName)) {
        visit(child)
      }
    }
  }
  visit(cell)
  return parts.filter(Boolean).join(' ')
}

/**
 * 按文档顺序递归遍历段落 / 表格块。表格与行内容控件都不展开为块，
 * 只沿 body / sdt / sdtContent 等容器下钻，保证控件内的段落和表格不漏读且顺序不变。
 * handle 返回 false 时立即停止整个遍历（文档级字节预算触底后不再解析后续内容）。
 */
const walkBlocks = (
  container: Element,
  handle: (element: Element) => boolean
): boolean => {
  for (const child of Array.from(container.children)) {
    if (child.localName === 'p' || child.localName === 'tbl') {
      if (!handle(child)) {
        return false
      }
    } else if (BLOCK_CONTAINER_NAMES.has(child.localName)) {
      if (!walkBlocks(child, handle)) {
        return false
      }
    }
  }
  return true
}

interface RenderedTable {
  text: string
  /** 单表 250,000 字符 / 行数结构上限触发过截断 */
  truncated: boolean
}

const tableMarkdown = (table: Element): RenderedTable => {
  const rows = containerChildren(table, 'tr')
  // 只数单元格数量，不展开内容；列数确定后再逐格拼接
  let columns = 0
  for (const row of rows) {
    columns = Math.max(columns, containerChildren(row, 'tc').length)
  }
  if (columns === 0) {
    return { text: '', truncated: false }
  }
  // 每张表独立累计预算：逐行预判“当前长度 + 下一行长度”，超限立即停止并附截断提示。
  // 预留的截断提示远小于 6 KB，因此最终文本严格不超过 256,000 字符。
  const lines: string[] = []
  let currentLen = 0
  let emittedRows = 0
  let truncated = false
  /** 追加一行：返回 false 表示这一行放不进 250,000 字符预算 */
  const appendLine = (line: string): boolean => {
    const addition = line.length + (lines.length > 0 ? 1 : 0)
    if (currentLen + addition > MAX_OFFICE_TABLE_CHARS) {
      return false
    }
    currentLen += addition
    lines.push(line)
    return true
  }
  for (const row of rows) {
    const cells = containerChildren(row, 'tc')
    let line = '|'
    let rowFits = true
    for (let index = 0; index < columns; index++) {
      const cell = index < cells.length ? cells[index] : null
      const value = cell ? escapeTableCell(cellText(cell)) : ''
      line += ` ${value} |`
      // 单行本身就超预算时立即中止，避免先拼出多 MB 的中间字符串
      if (line.length > MAX_OFFICE_TABLE_CHARS) {
        rowFits = false
        break
      }
    }
    if (!rowFits || !appendLine(line)) {
      truncated = true
      break
    }
    emittedRows++
    if (emittedRows === 1) {
      let separator = '|'
      for (let index = 0; index < columns; index++) {
        separator += ' --- |'
      }
      if (!appendLine(separator)) {
        truncated = true
        break
      }
    }
  }
  if (truncated) {
    lines.push(
      '',
      translate('officeTruncatedRows', {
        rows: emittedRows,
        columns,
      })
    )
  }
  return { text: lines.join('\n'), truncated }
}

const extractDocx = (files: Unzipped, parser: DOMParser): OfficeResult => {
  const xml = readXml(files, 'word/document.xml')
  if (!xml) {
    return { ok: false, error: 'officeFailed' }
  }
  const doc = parseXml(parser, xml)
  if (!doc) {
    return { ok: false, error: 'officeFailed' }
  }
  const body = collect(doc, 'body')[0]
  if (!body) {
    return { ok: false, error: 'officeFailed' }
  }
  // 整份文档的跨段落 / 跨表格 UTF-8 字节预算：触底后不再解析后续块
  const accumulator = createDocumentAccumulator()
  // 单表 250,000 字符预算属于结构截断：即使整份文档字节预算没触底，
  // 返回值也必须标记 truncated，界面与落盘的 attachment.truncated 才能如实显示。
  let structuralTruncated = false
  walkBlocks(body, (element) => {
    if (element.localName === 'p') {
      return appendDocumentBlock(accumulator, paragraphText(element))
    }
    const table = tableMarkdown(element)
    structuralTruncated = structuralTruncated || table.truncated
    return appendDocumentBlock(accumulator, table.text)
  })
  return {
    ok: true,
    text: finishDocument(accumulator),
    truncated: accumulator.truncated || structuralTruncated,
  }
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

const columnIndex = (reference: string): number => {
  const letters = reference.replace(/[^A-Z]/gi, '').toUpperCase()
  if (!letters) {
    return -1
  }
  let index = 0
  for (const letter of letters) {
    index = index * 26 + (letter.charCodeAt(0) - 64)
  }
  return index - 1
}

const cellValue = (cell: Element, sharedStrings: string[]): string => {
  const type = cell.getAttribute('t') ?? ''
  const valueElement = directChildren(cell, 'v')[0]
  const rawValue = valueElement?.textContent ?? ''
  const formula = directChildren(cell, 'f')[0]?.textContent?.trim() ?? ''
  // 公式单元格没有缓存值时输出公式本身，避免整格空白丢失
  if (!rawValue && formula) {
    return `=${formula}`
  }
  if (type === 's') {
    // 无缓存值时不把空串当索引 0，避免错误引用第一条共享字符串
    if (!rawValue) {
      return ''
    }
    const index = Number(rawValue)
    return Number.isInteger(index) ? (sharedStrings[index] ?? '') : ''
  }
  if (type === 'inlineStr') {
    const inline = directChildren(cell, 'is')[0]
    return inline ? textOf(inline) : ''
  }
  if (type === 'b') {
    return rawValue === '1' ? 'TRUE' : 'FALSE'
  }
  return rawValue
}

interface SparseSheet {
  rows: Array<Array<{ column: number; value: string }>>
  columns: number
  truncatedRows: boolean
  truncatedColumns: boolean
  /** 单元格文本累计超过 250 KB 字符预算，已提前停止展开 */
  truncatedChars: boolean
}

/**
 * 稀疏读取：只保存非空单元格，不按最大行号 / 最大列号分配数组。
 * 同时在提取阶段实时累计字符预算：小体积 ZIP 里反复引用同一条超长 sharedStrings
 * 时，绝不允许先展开成十几 MB 的中间文本再交给最终截断。
 */
const readSparseSheet = (doc: Document, sharedStrings: string[]): SparseSheet => {
  const rows: SparseSheet['rows'] = []
  const budget: OutputBudget = { used: 0 }
  let columns = 0
  let truncatedRows = false
  let truncatedColumns = false
  let truncatedChars = false
  outer: for (const row of collect(doc, 'row')) {
    const cells: Array<{ column: number; value: string }> = []
    for (const cell of directChildren(row, 'c')) {
      const value = escapeTableCell(cellValue(cell, sharedStrings))
      if (!value) {
        continue
      }
      const column = columnIndex(cell.getAttribute('r') ?? '')
      if (column < 0) {
        continue
      }
      if (column >= MAX_SHEET_COLUMNS) {
        truncatedColumns = true
        continue
      }
      if (!consumeOutputBudget(budget, value.length + 4)) {
        truncatedChars = true
        break outer
      }
      cells.push({ column, value })
    }
    if (cells.length === 0) {
      continue
    }
    if (rows.length >= MAX_SHEET_ROWS) {
      truncatedRows = true
      continue
    }
    rows.push(cells)
    for (const cell of cells) {
      columns = Math.max(columns, cell.column + 1)
    }
  }
  return { rows, columns, truncatedRows, truncatedColumns, truncatedChars }
}

interface RenderedSheet {
  text: string
  /** 行数 / 列数 / 字符预算中任意一项触发过结构截断 */
  truncated: boolean
}

const sheetMarkdown = (name: string, sheet: SparseSheet): RenderedSheet => {
  if (sheet.rows.length === 0 || sheet.columns === 0) {
    // 有非空单元格但全部越过列上限时，不能误报空表；直接说明列截断
    if (sheet.truncatedChars) {
      return {
        text: `### ${name}\n\n${translate('officeTruncatedRows', { rows: 0, columns: 0 })}`,
        truncated: true,
      }
    }
    const marker = sheet.truncatedColumns
      ? translate('officeColumnsTruncated')
      : translate('officeEmptySheet')
    return {
      text: `### ${name}\n\n${marker}`,
      truncated: sheet.truncatedColumns,
    }
  }
  const lines: string[] = [`### ${name}`, '']
  // 拼装阶段再累计一次预算：单元格文本本身已在提取阶段受限，这里防止分隔符与
  // 补齐空列在宽表上把最终 Markdown 推出预算。
  const budget: OutputBudget = { used: 0 }
  let emittedRows = 0
  let truncated = sheet.truncatedRows || sheet.truncatedColumns || sheet.truncatedChars
  for (const cells of sheet.rows) {
    const padded = Array.from({ length: sheet.columns }, () => '')
    for (const cell of cells) {
      padded[cell.column] = cell.value
    }
    const line = `| ${padded.join(' | ')} |`
    if (!consumeOutputBudget(budget, line.length + 1)) {
      truncated = true
      break
    }
    lines.push(line)
    if (emittedRows === 0) {
      const separator = `| ${Array.from({ length: sheet.columns }, () => '---').join(' | ')} |`
      if (!consumeOutputBudget(budget, separator.length + 1)) {
        truncated = true
        break
      }
      lines.push(separator)
    }
    emittedRows++
  }
  if (truncated) {
    lines.push(
      '',
      translate('officeTruncatedRows', {
        rows: emittedRows,
        columns: sheet.columns,
      })
    )
  }
  return { text: lines.join('\n'), truncated }
}

const extractXlsx = (files: Unzipped, parser: DOMParser): OfficeResult => {
  const sharedStrings: string[] = []
  const sharedXml = readXml(files, 'xl/sharedStrings.xml')
  if (sharedXml) {
    const doc = parseXml(parser, sharedXml)
    if (doc) {
      for (const item of collect(doc, 'si')) {
        sharedStrings.push(textOf(item))
      }
    }
  }
  const workbookXml = readXml(files, 'xl/workbook.xml')
  if (!workbookXml) {
    return { ok: false, error: 'officeFailed' }
  }
  const workbook = parseXml(parser, workbookXml)
  if (!workbook) {
    return { ok: false, error: 'officeFailed' }
  }
  const rels = new Map<string, string>()
  const relsXml = readXml(files, 'xl/_rels/workbook.xml.rels')
  if (relsXml) {
    const relDoc = parseXml(parser, relsXml)
    if (relDoc) {
      for (const relationship of collect(relDoc, 'Relationship')) {
        const id = relationship.getAttribute('Id')
        const target = relationship.getAttribute('Target')
        if (id && target) {
          rels.set(id, resolveRelationshipTarget('xl', target))
        }
      }
    }
  }
  // 整份工作簿的跨工作表 UTF-8 字节预算：触底后立即停止解析后续工作表
  const accumulator = createDocumentAccumulator()
  // 单表 500 行 / 64 列 / 250,000 字符预算同样是结构截断，必须反映到返回值
  let structuralTruncated = false
  const sheets = collect(workbook, 'sheet')
  for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex++) {
    const sheet = sheets[sheetIndex]
    const name = sheet.getAttribute('name') ?? `Sheet${sheetIndex + 1}`
    const relId =
      sheet.getAttribute('r:id') ??
      sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ??
      ''
    const target = rels.get(relId) ?? 'xl/worksheets/sheet' + (sheetIndex + 1) + '.xml'
    const path = target.startsWith('xl/') ? target : `xl/${target}`
    const sheetXml = readXml(files, path)
    if (!sheetXml) {
      continue
    }
    const doc = parseXml(parser, sheetXml)
    if (!doc) {
      continue
    }
    const rendered = sheetMarkdown(name, readSparseSheet(doc, sharedStrings))
    structuralTruncated = structuralTruncated || rendered.truncated
    if (!appendDocumentBlock(accumulator, rendered.text)) {
      break
    }
  }
  return {
    ok: true,
    text: finishDocument(accumulator),
    truncated: accumulator.truncated || structuralTruncated,
  }
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

const slideNumber = (path: string): number => Number(path.match(/slide(\d+)\.xml$/)?.[1] ?? 0)

/** 按 presentation.xml 的 p:sldIdLst + 关系映射还原真实页序；缺失映射时返回 null */
const presentationOrder = (
  files: Unzipped,
  parser: DOMParser
): string[] | null => {
  const presentationsXml = readXml(files, 'ppt/presentation.xml')
  if (!presentationsXml) {
    return null
  }
  const presentation = parseXml(parser, presentationsXml)
  if (!presentation) {
    return null
  }
  const relsXml = readXml(files, 'ppt/_rels/presentation.xml.rels')
  if (!relsXml) {
    return null
  }
  const relDoc = parseXml(parser, relsXml)
  if (!relDoc) {
    return null
  }
  const rels = new Map<string, string>()
  for (const relationship of collect(relDoc, 'Relationship')) {
    const id = relationship.getAttribute('Id')
    const target = relationship.getAttribute('Target')
    if (id && target) {
      rels.set(id, resolveRelationshipTarget('ppt', target))
    }
  }
  const sldIdLst = collect(presentation, 'sldIdLst')[0]
  if (!sldIdLst) {
    return null
  }
  const relNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const ordered: string[] = []
  for (const slideId of directChildren(sldIdLst, 'sldId')) {
    const relId = slideId.getAttribute('r:id') ?? slideId.getAttributeNS(relNamespace, 'id') ?? ''
    const target = rels.get(relId)
    if (target) {
      ordered.push(target)
    }
  }
  return ordered.length > 0 ? ordered : null
}

const extractPptx = (files: Unzipped, parser: DOMParser): OfficeResult => {
  const slidePaths = Object.keys(files).filter((path) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(path)
  )
  const numericOrder = [...slidePaths].sort((left, right) => slideNumber(left) - slideNumber(right))
  const presentationPaths = presentationOrder(files, parser)
  const ordered: string[] = []
  const seen = new Set<string>()
  const push = (path: string) => {
    if (!seen.has(path) && slidePaths.includes(path)) {
      seen.add(path)
      ordered.push(path)
    }
  }
  for (const path of presentationPaths ?? []) {
    push(path)
  }
  // sldIdLst 未覆盖到的幻灯片按数字序补在末尾，避免丢页
  for (const path of numericOrder) {
    push(path)
  }
  // 整份演示文稿的跨幻灯片 UTF-8 字节预算：触底后立即停止解析后续幻灯片
  const accumulator = createDocumentAccumulator()
  for (let index = 0; index < ordered.length; index++) {
    const path = ordered[index]
    const xml = readXml(files, path)
    if (!xml) {
      continue
    }
    const doc = parseXml(parser, xml)
    if (!doc) {
      continue
    }
    const lines: string[] = []
    for (const paragraph of collect(doc, 'p')) {
      const parts = collect(paragraph, 't').map((part) => part.textContent ?? '')
      const text = parts.join('').trim()
      if (text) {
        lines.push(text)
      }
    }
    const slideText = `${translate('officeSlideHeading', { index: index + 1 })}\n\n${lines.join('\n')}`.trim()
    if (!appendDocumentBlock(accumulator, slideText)) {
      break
    }
  }
  return {
    ok: true,
    text: finishDocument(accumulator),
    truncated: accumulator.truncated,
  }
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

/** 统一入口：按扩展名分派；结构异常返回 officeFailed，预算超限返回 officeTooLarge，绝不猜测 */
export const extractOfficeText = (
  ext: OfficeExt,
  data: Uint8Array,
  parser: DOMParser
): OfficeResult => {
  let entries: ZipEntryInfo[] | 'officeTooLarge'
  try {
    entries = inspectZip(data)
  } catch {
    return { ok: false, error: 'officeFailed' }
  }
  if (entries === 'officeTooLarge') {
    return { ok: false, error: 'officeTooLarge' }
  }
  let files: Unzipped
  try {
    files = unzipSelected(data, requiredParts(ext))
  } catch {
    return { ok: false, error: 'officeFailed' }
  }
  try {
    if (ext === 'docx') {
      return extractDocx(files, parser)
    }
    if (ext === 'xlsx') {
      return extractXlsx(files, parser)
    }
    return extractPptx(files, parser)
  } catch {
    return { ok: false, error: 'officeFailed' }
  }
}
