import { memo, useMemo } from 'react'
import { balanceCodeFences } from '../../services/markdown/fences.js'
import { toMdAst } from '../../services/markdown/parse.js'
import { useScrollToBottom } from '../messages/scrollContext.js'
import { MarkdownAstRenderer } from './MarkdownAstRenderer.js'
import { useThrottleMarkdownRender } from './useThrottleMarkdownRender.js'
import './markdown.css'
import './highlight.css'


/** 渲染链路：节流 → 解析 AST → 渲染 */
export const Markdown = memo(function Markdown({
  content,
  loading,
  cacheKey,
  className,
  disableLink = false,
}: {
  content: string
  loading: boolean
  cacheKey: string
  className?: string
  disableLink?: boolean
}) {
  const scrollToBottom = useScrollToBottom()
  const throttledMarkdown = useThrottleMarkdownRender(content, loading)
  const ast = useMemo(() => {
    const source = loading ? balanceCodeFences(throttledMarkdown) : throttledMarkdown
    return source ? toMdAst(source, { disableLink }) : null
  }, [throttledMarkdown, disableLink, loading])
  return ast ? (
    <MarkdownAstRenderer
      key={cacheKey}
      className={className}
      ast={ast}
      loading={loading}
      onUpdate={scrollToBottom}
    />
  ) : null
})
