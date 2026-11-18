/**
 * 流式未闭合代码块防抽搐。
 *
 * 只对传入解析器的临时字符串补齐未闭合围栏，绝不改动底层存储中的真实流文本。
 * 围栏必须成对同类型：``` 与 ~~~ 不能互相闭合；更短的同类围栏只是代码内容，
 * 只有连续长度不短于开启围栏、且行尾没有信息文本的行才算闭合。
 *
 * CommonMark 对 info string 另有限制：反引号围栏的 info string 不允许再出现反引号，
 * 因此含反引号的行不是合法围栏（既不能开启也不能闭合）；波浪号围栏的 info string
 * 允许反引号，照常参与配对。
 */
export const balanceCodeFences = (input: string): string => {
  let open: { char: string; length: number } | null = null
  for (const line of input.split('\n')) {
    // CommonMark: 围栏最多缩进 3 个空格，再深就属于代码内容
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!fence) {
      continue
    }
    const marker = fence[1] ?? ''
    const rest = fence[2] ?? ''
    const char = marker[0] ?? ''
    // 反引号 info string 含反引号时整行只是普通文本，不能参与任何围栏配对
    if (char === '`' && rest.includes('`')) {
      continue
    }
    if (!open) {
      open = { char, length: marker.length }
      continue
    }
    if (char === open.char && marker.length >= open.length && rest.trim() === '') {
      open = null
    }
  }
  return open ? `${input}\n${open.char.repeat(open.length)}` : input
}
