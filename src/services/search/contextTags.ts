/**
 * 检索上下文的包装标签必须前后端共用同一个常量。
 *
 * 系统提示词里的防串台 / 防指令注入规则按这个标签名生效，检索客户端实际拼出的
 * 上下文块若用了另一个名字，规则就完全打不中真实检索内容。
 */
export const WEB_SEARCH_CONTEXT_TAG = 'web_search_context'
export const WEB_SEARCH_CONTEXT_OPEN = `<${WEB_SEARCH_CONTEXT_TAG}>`
export const WEB_SEARCH_CONTEXT_CLOSE = `</${WEB_SEARCH_CONTEXT_TAG}>`

/** 外部文本里的字面开 / 闭标签都要转义，避免提前闭合或伪造上下文块 */
export const escapeWebSearchContextTag = (value: string): string =>
  value.replace(/<\/?web_search_context/gi, (match) =>
    match.startsWith('</') ? '&lt;/web_search_context' : '&lt;web_search_context'
  )
