/**
 * KaTeX 失败时的确定性回退策略（纯函数，不依赖 React / KaTeX 本体）。
 *
 * 流式中公式可能只写了一半，允许保留上一次成功结果避免闪烁；
 * 消息结束后的非法公式必须显示当前原文，绝不能继续展示旧公式。
 */
export interface MathHtmlResult {
  html: string
  renderMode: 'katex' | 'fallback'
}

export const failedMathResult = (
  input: string,
  streaming: boolean,
  previous: MathHtmlResult | null
): MathHtmlResult => {
  if (streaming && previous) {
    return previous
  }
  return { html: input, renderMode: 'fallback' }
}
