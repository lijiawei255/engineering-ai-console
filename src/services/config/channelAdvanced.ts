/**
 * 通道编辑器“高级设置”的状态推导。
 *
 * 两个判断都只依赖通道配置本身：
 * - 切换协议时，仍处于协议默认值的思考字段策略跟随新协议，手动选过的策略保持不动；
 * - 折叠栏标题旁的计数徽章列出当前有多少个高级项偏离了默认值，避免“改完就忘”。
 *
 * 纯函数，供设置界面与逻辑自检共用，不依赖 React 或浏览器环境。
 */

import {
  DEFAULT_REQUEST_TIMEOUT_SEC,
  type ChannelConfig,
  type ChannelSlot,
  type Protocol,
  type ThinkingParamMode,
} from './types.js'

/** 新通道的默认名称；与配置层 createChannelConfig 的初始值保持一致。 */
export const DEFAULT_CHANNEL_LABELS: Record<ChannelSlot, string> = {
  primary: 'Primary',
  backup: 'Backup',
}

/**
 * 协议对应的默认思考字段策略。
 * OpenAI 兼容通道默认标准透传，不向未知自定义网关注入 reasoning_effort 等私有字段；
 * Anthropic 通道默认使用扩展思考（budget_tokens 由序列化层按 max_tokens 推导）。
 */
export const defaultThinkingModeFor = (protocol: Protocol): ThinkingParamMode =>
  protocol === 'anthropic' ? 'anthropic_thinking' : 'none'

/**
 * 切换协议时的新思考策略：只有“仍等于当前协议默认值”的策略才自动跟随，
 * 用户手动选过其他格式时保持原值，绝不覆盖手工配置。
 */
export const thinkingModeForProtocolSwitch = (
  channel: Pick<ChannelConfig, 'protocol' | 'thinkingParamMode'>,
  nextProtocol: Protocol
): ThinkingParamMode =>
  channel.thinkingParamMode === defaultThinkingModeFor(channel.protocol)
    ? defaultThinkingModeFor(nextProtocol)
    : channel.thinkingParamMode

/** 标准透传：开启“深度思考”也不会附加任何厂商私有请求字段。 */
export const isThinkingPassthrough = (
  channel: Pick<ChannelConfig, 'thinkingParamMode'>
): boolean => channel.thinkingParamMode === 'none'

/**
 * 输入栏深度思考开关的提示词键：标准透传时解释“只会切换思考模型”，
 * 配了具体请求格式时才显示中性的开关名称。返回字面量键，避免配置层依赖 i18n。
 */
export const thinkingToggleHintKey = (
  channel: Pick<ChannelConfig, 'thinkingParamMode'>
): 'thinkingToggle' | 'thinkingPassthroughHint' =>
  isThinkingPassthrough(channel) ? 'thinkingPassthroughHint' : 'thinkingToggle'

export type AdvancedOptionId =
  | 'label'
  | 'lockRawUrl'
  | 'thinkingModel'
  | 'thinkingParamMode'
  | 'apiKeyEnv'
  | 'customHeaders'
  | 'requestTimeoutSec'
  | 'enableRemoteFileApi'
  | 'modalityMode'
  | 'webSearchMode'
  | 'proxy'
  | 'sampling'

export interface AdvancedOptionState {
  id: AdvancedOptionId
  active: boolean
}

/** 逐项列出高级设置是否偏离默认值；顺序与折叠区里的展示顺序无关。 */
export const advancedOptionStates = (
  channel: ChannelConfig,
  slot: ChannelSlot
): AdvancedOptionState[] => [
  { id: 'label', active: channel.label !== DEFAULT_CHANNEL_LABELS[slot] },
  { id: 'lockRawUrl', active: channel.lockRawUrl },
  { id: 'thinkingModel', active: channel.thinkingModel.trim().length > 0 },
  {
    id: 'thinkingParamMode',
    active: channel.thinkingParamMode !== defaultThinkingModeFor(channel.protocol),
  },
  { id: 'apiKeyEnv', active: channel.apiKeyEnv.trim().length > 0 },
  { id: 'customHeaders', active: channel.customHeaders.length > 0 },
  { id: 'requestTimeoutSec', active: channel.requestTimeoutSec !== DEFAULT_REQUEST_TIMEOUT_SEC },
  { id: 'enableRemoteFileApi', active: channel.enableRemoteFileApi },
  { id: 'modalityMode', active: channel.modalityMode !== 'auto' },
  { id: 'webSearchMode', active: channel.webSearchMode !== 'off' },
  {
    id: 'proxy',
    active:
      channel.proxyMode !== 'system' ||
      channel.proxyUrl.trim().length > 0 ||
      channel.allowInsecureTls,
  },
  {
    id: 'sampling',
    active: channel.temperatureEnabled || channel.maxTokensEnabled,
  },
]

export const countActiveAdvancedOptions = (
  channel: ChannelConfig,
  slot: ChannelSlot
): number => advancedOptionStates(channel, slot).filter((option) => option.active).length
