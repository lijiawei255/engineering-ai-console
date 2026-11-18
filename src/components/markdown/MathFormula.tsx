import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ensureKatex, type Katex } from '../../services/markdown/katex.js'
import {
  failedMathResult,
  type MathHtmlResult,
} from '../../services/markdown/mathFallback.js'

/** renderToString 外层包裹的标签，组件自己渲染外层，这里切掉 */
const KATEX_WRAPPER = {
  inline: ['<span class="katex">', '</span>'],
  display: ['<span class="katex-display"><span class="katex">', '</span></span>'],
} as const

const noop = () => {}

/**
 * KaTeX 渲染公式；出错时按流式状态决定回退：
 * 仍在流式输出说明公式可能只写了一半，保留上一次成功结果避免闪烁；
 * 消息结束后必须展示当前原文，不能继续显示上一次成功的旧公式 HTML。
 */
const useMathHtml = (input: string, isInline: boolean, streaming: boolean): MathHtmlResult => {
  const previousResultRef = useRef<MathHtmlResult | null>(null)
  const katexRef = useRef(ensureKatex())
  const [katex, setKatex] = useState<Katex | null>(
    katexRef.current instanceof Promise ? null : katexRef.current
  )

  useEffect(() => {
    if (katexRef.current instanceof Promise) {
      katexRef.current.then(setKatex, noop)
    }
  }, [])

  return useMemo((): MathHtmlResult => {
    if (!katex) {
      return { html: input, renderMode: 'fallback' }
    }
    try {
      const [prefix, suffix] = KATEX_WRAPPER[isInline ? 'inline' : 'display']
      const html = katex
        .renderToString(input, { throwOnError: true, strict: false, displayMode: !isInline })
        .slice(prefix.length, -suffix.length)
      const result = { html, renderMode: 'katex' } as const
      previousResultRef.current = result
      return result
    } catch {
      const fallback = failedMathResult(input, streaming, previousResultRef.current)
      return fallback
    }
  }, [input, isInline, streaming, katex])
}

export const MathBlock = memo(function MathBlock({
  value,
  streaming = false,
}: {
  value: string
  streaming?: boolean
}) {
  const { html, renderMode } = useMathHtml(value, false, streaming)
  if (renderMode === 'fallback') {
    return <p className="ds-markdown-paragraph">{html}</p>
  }
  return (
    <span className="katex-display ds-markdown-math">
      <span className="katex" dangerouslySetInnerHTML={{ __html: html }}></span>
    </span>
  )
})

export const InlineMath = memo(function InlineMath({
  value,
  streaming = false,
}: {
  value: string
  streaming?: boolean
}) {
  const { html, renderMode } = useMathHtml(value, true, streaming)
  if (renderMode === 'fallback') {
    return html
  }
  return <span className="katex" dangerouslySetInnerHTML={{ __html: html }}></span>
})
