type Mermaid = typeof import('mermaid').default

let mermaidPromise: Promise<Mermaid> | null = null
let renderQueue = Promise.resolve()
let nextId = 0

const loadMermaid = () => {
  mermaidPromise ??= import('mermaid')
    .then((module) => module.default)
    .catch((error: unknown) => {
      mermaidPromise = null
      throw error
    })
  return mermaidPromise
}

/**
 * 定位 `%%{ ... }%%` 指令块的结束花括号下标；找不到完整块时返回 -1。
 * 指令体里允许嵌套对象和字符串，所以按大括号深度扫描；跨行指令也能正确合上，
 * 字符串里的花括号不参与配对，避免把主题配置里的色值文本误判成结构。
 */
const directiveEnd = (code: string, start: number): number => {
  let depth = 0
  let quote = ''
  for (let index = start + 3; index < code.length; index++) {
    const char = code[index]
    if (quote) {
      if (char === '\\') {
        index++
      } else if (char === quote) {
        quote = ''
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '{') {
      depth++
      continue
    }
    if (char !== '}') {
      continue
    }
    if (depth === 0) {
      return code.startsWith('%%', index + 1) ? index : -1
    }
    depth--
  }
  return -1
}

/**
 * 渲染前剥离图内的 `%%{init: ...}%%` 指令。
 *
 * 主题与字号只允许来自 initialize 的 themeVariables；图内 init 指令可以覆盖
 * themeVariables / themeCSS 并改变 Solarized 背景，属于必须阻断的非法配置注入。
 * 只删除 init 指令本身，其它指令与普通图表文本原样保留。
 */
export const stripMermaidDirectives = (code: string): string => {
  let output = ''
  let cursor = 0
  while (cursor < code.length) {
    const start = code.indexOf('%%{', cursor)
    if (start === -1) {
      output += code.slice(cursor)
      break
    }
    output += code.slice(cursor, start)
    const end = directiveEnd(code, start)
    if (end === -1) {
      // 指令块没合上：保留剩余原文，宁可让 Mermaid 报语法错误也不吞正文
      output += code.slice(start)
      break
    }
    const body = code.slice(start + 3, end)
    // init 的官方别名 initialize 同样能覆盖主题与字号，必须一并阻断（大小写不敏感）
    if (!/^\s*init(?:ialize)?\s*:/i.test(body)) {
      output += code.slice(start, end + 3)
    }
    cursor = end + 3
  }
  return output
}

/**
 * 图源码顶部的 YAML frontmatter（`---` 包裹的 config 块）同样属于图内配置注入：
 * Mermaid 会用它覆盖主题与字号，必须先于指令清理整段剥掉。
 * 只匹配起始位置，正文里的 `---` 分隔线保持不变。
 */
const YAML_FRONTMATTER = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/

/**
 * 渲染前剥离图片语法：图表定义里的图片会触发对外网络请求，本控制台只展示图结构本身。
 * 覆盖 YAML frontmatter、@{ img: "..." } 样式块、<img>/<image> 标签与 Markdown 图片语法。
 */
export const sanitizeMermaid = (code: string) => {
  let result = stripMermaidDirectives(code.replace(YAML_FRONTMATTER, ''))
  result = result.replace(/@\{[^}]*\}/g, (block) =>
    /\bimg(?:age)?\s*:/i.test(block) ? '' : block
  )
  result = result.replace(/<\/?(?:img|image)\b[^>]*>/gi, '')
  return result.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
}

const SAFE_IMAGE_SCHEME = /^(?:data:|blob:)/i
const EXTERNAL_REFERENCE = /^(?:https?:)?\/\//i
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:/i

const imageHrefOf = (tag: string): string => {
  const match = /(?:xlink:)?href\s*=\s*["']([^"']*)["']/i.exec(tag)
  return match?.[1] ?? ''
}

/**
 * 渲染后再扫一遍 SVG：图片元素只要引用了 http/https、协议相对或其它显式协议就移除；
 * data: / blob: 内嵌图允许保留，同源相对路径不在自动外链范围内。
 */
export const sanitizeMermaidSvg = (svg: string): string =>
  svg.replace(/<image\b[^>]*>/gi, (tag) => {
    const href = imageHrefOf(tag)
    if (!href || SAFE_IMAGE_SCHEME.test(href)) {
      return tag
    }
    return EXTERNAL_REFERENCE.test(href) || EXPLICIT_SCHEME.test(href) ? '' : tag
  })

/** 缩放后的正文字号：优先按 --console-font-scale 计算，缺失时退回实际 body 字号 */
const consoleFontSize = (fontScale: number): string => {
  if (Number.isFinite(fontScale) && fontScale > 0) {
    return `${Math.round(16 * fontScale * 100) / 100}px`
  }
  const scale = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--console-font-scale').trim()
  )
  if (Number.isFinite(scale) && scale > 0) {
    return `${Math.round(16 * scale * 100) / 100}px`
  }
  const bodySize = Number.parseFloat(getComputedStyle(document.body).fontSize)
  return Number.isFinite(bodySize) && bodySize > 0 ? `${bodySize}px` : '16px'
}

/** Mermaid 主题变量统一映射到 Solarized Light / Dark 标准色 */
const solarizedVariables = (dark: boolean, fontFamily: string, fontSize: string) =>
  dark
    ? {
        background: '#002b36',
        mainBkg: '#073642',
        primaryColor: '#073642',
        primaryTextColor: '#93a1a1',
        primaryBorderColor: '#586e75',
        secondaryColor: '#073642',
        tertiaryColor: '#002b36',
        lineColor: '#839496',
        textColor: '#93a1a1',
        titleColor: '#93a1a1',
        nodeBorder: '#586e75',
        clusterBkg: '#002b36',
        clusterBorder: '#586e75',
        edgeLabelBackground: '#002b36',
        noteBkgColor: '#073642',
        noteTextColor: '#93a1a1',
        noteBorderColor: '#586e75',
        actorBkg: '#073642',
        actorBorder: '#586e75',
        actorTextColor: '#93a1a1',
        signalColor: '#839496',
        signalTextColor: '#93a1a1',
        labelBoxBkgColor: '#073642',
        labelBoxBorderColor: '#586e75',
        labelTextColor: '#93a1a1',
        loopTextColor: '#93a1a1',
        activationBorderColor: '#268bd2',
        activationBkgColor: '#073642',
        sequenceNumberColor: '#002b36',
        fontFamily,
        fontSize,
      }
    : {
        background: '#fdf6e3',
        mainBkg: '#eee8d5',
        primaryColor: '#eee8d5',
        primaryTextColor: '#586e75',
        primaryBorderColor: '#93a1a1',
        secondaryColor: '#eee8d5',
        tertiaryColor: '#fdf6e3',
        lineColor: '#657b83',
        textColor: '#586e75',
        titleColor: '#586e75',
        nodeBorder: '#93a1a1',
        clusterBkg: '#eee8d5',
        clusterBorder: '#93a1a1',
        edgeLabelBackground: '#fdf6e3',
        noteBkgColor: '#eee8d5',
        noteTextColor: '#586e75',
        noteBorderColor: '#93a1a1',
        actorBkg: '#eee8d5',
        actorBorder: '#93a1a1',
        actorTextColor: '#586e75',
        signalColor: '#657b83',
        signalTextColor: '#586e75',
        labelBoxBkgColor: '#eee8d5',
        labelBoxBorderColor: '#93a1a1',
        labelTextColor: '#586e75',
        loopTextColor: '#586e75',
        activationBorderColor: '#268bd2',
        activationBkgColor: '#eee8d5',
        sequenceNumberColor: '#fdf6e3',
        fontFamily,
        fontSize,
      }

/** 串行执行初始化和绘制，避免不同图表互相覆盖 Mermaid 的全局配置。 */
export const renderMermaid = (
  code: string,
  dark: boolean,
  fontScale: number,
  isCancelled: () => boolean
): Promise<string | null> => {
  const result = renderQueue.then(async () => {
    if (isCancelled() || !code.trim()) {
      return null
    }

    const mermaid = await loadMermaid()
    if (isCancelled()) {
      return null
    }
    const fontFamily =
      getComputedStyle(document.body).getPropertyValue('--dsw-font-family').trim() ||
      'sans-serif'
    const fontSize = consoleFontSize(fontScale)

    mermaid.initialize({
      theme: 'base',
      themeVariables: solarizedVariables(dark, fontFamily, fontSize),
      // 主题只能来自上面的 themeVariables；清空 themeCSS 防止图内样式注入
      themeCSS: '',
      securityLevel: 'strict',
      startOnLoad: false,
      suppressErrorRendering: true,
    })

    const { svg } = await mermaid.render(`standalone-mermaid-${nextId++}`, sanitizeMermaid(code))
    return isCancelled() ? null : sanitizeMermaidSvg(svg)
  })

  // 某张图失败不阻塞后续图表；调用方仍收到原始任务的错误。
  renderQueue = result.then(
    () => {},
    () => {}
  )
  return result
}
