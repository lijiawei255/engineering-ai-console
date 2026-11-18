/**
 * English dictionary — source of truth for translation keys.
 * All other locales must satisfy Record<keyof typeof en, string>.
 */
export const en = {
  // App shell
  appName: 'Engineering AI Console',
  appTagline: 'Cloud-side chief of staff for engineering ideation, dispatch and audit',
  welcomeTitle: 'What are we building today?',
  welcomeLead:
    'Plain engineering talk first. When the plan is solid, generate the implementation instruction and the audit request for your local agents.',
  welcomeHint: 'Agent 1 · cloud console. No code runs here.',
  modeServer: 'Local service mode',
  modeServerHint:
    'Connected to the local service on 127.0.0.1. API keys stay on this machine and are never sent to the page.',
  modeStatic: 'Static direct mode',
  modeStaticHint:
    'No local Python service detected. Channels and keys are kept in this browser only, and requests go straight to your endpoints.',
  storageRecovered: 'A damaged local config file was recovered from its .bak backup.',
  storageMissing: 'No local config file yet; defaults are in use.',
  storageDegraded:
    'Storage warning: migrating legacy plaintext headers to secrets.json failed. The legacy values were kept in place and the migration is retried on the next read; check write permissions for the data directory.',
  serverStorageHint: 'Storage health',
  serverOfflineBanner:
    'Cannot reach the local service. Start it with "python server.py", then retry. Pure static direct mode is available only when this page is opened from a local file (file://).',
  retryConnection: 'Retry connection',

  // Common actions
  newChat: 'New chat',
  untitledChat: 'New chat',
  chatHistory: 'Chats',
  sessionDateToday: 'Today {time}',
  sessionDateYesterday: 'Yesterday {time}',
  deleteChat: 'Delete chat',
  deleteChatConfirm: 'This chat will be deleted permanently. Continue?',
  delete: 'Delete',
  cancel: 'Cancel',
  confirm: 'Confirm',
  close: 'Close',
  retry: 'Retry',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Copy failed. Select the text and copy it manually.',
  send: 'Send',
  stop: 'Stop',
  settings: 'Settings',
  more: 'More',
  remove: 'Remove',
  add: 'Add',
  expand: 'Expand',
  collapse: 'Collapse',
  reset: 'Reset',
  loading: 'Loading…',
  unknownError: 'Unknown error',
  openSettings: 'Open settings',
  configured: 'Configured',
  notConfigured: 'Not configured',

  // Top bar / reset
  resetMenu: 'Reset',
  softReset: 'Soft reset',
  hardReset: 'Hard reset',
  softResetHint:
    'Kills all pending streams and uploads, clears stuck dialogs and send locks. Chats, drafts and configuration are kept.',
  hardResetHint:
    'Clears the browser database and cache, then reloads the page. Optionally export a plain-text chat rescue file first.',
  exportBeforeReset: 'Export a plain-text chat rescue file before resetting',
  keepLocalKeys: 'Keep locally stored API keys',
  hardResetConfirmTitle: 'Hard reset?',
  hardResetConfirmText:
    'The local chat database and browser cache will be cleared. This cannot be undone.',
  softResetDone: 'Pending streams were stopped and the interface was unlocked.',
  exportDone: 'Chat rescue file exported.',
  resetExportEmpty: 'There is nothing to export yet.',
  resetBackupFailed:
    'Reset aborted: the rescue backup was incomplete or could not be generated. Nothing was deleted; retry, or turn off the pre-reset export to clear the database anyway.',
  resetDatabaseBlocked:
    'The browser database is still open in another tab. Close every other tab of this console, then retry.',
  resetDatabaseFailed: 'Reset aborted: the browser database could not be deleted.',

  // Preferences
  language: 'Language',
  theme: 'Theme',
  themeLight: 'Solarized Light',
  themeDark: 'Solarized Dark',
  themeSystem: 'Follow system',
  fontSize: 'Font size',
  fontScale90: '90%',
  fontScale100: '100%',
  fontScale112: '112%',
  fontScale125: '125%',
  contentWidth: 'Content width',
  widthStandard: 'Standard 860px',
  widthWide: 'Wide 1120px',
  reduceFlicker: 'Reduce flicker',
  reduceFlickerHint:
    'Disables looping pulses, bouncing dots and shimmer animations. Recommended for long sessions.',
  general: 'General',
  channels: 'Channels',
  prompts: 'Prompts',
  advanced: 'Advanced',
  data: 'Data',
  settingsHint:
    'Most changes apply immediately. The system prompt and capsule templates are written only after you press Save or Restore default.',
  collapseSidebar: 'Collapse sidebar',
  expandSidebar: 'Expand sidebar',

  // Channels
  channelPrimary: 'Primary',
  channelBackup: 'Backup',
  switchChannel: 'Switch channel',
  active: 'Active',
  channelLabel: 'Label',
  protocol: 'Protocol',
  protocolOpenAi: 'OpenAI Compatible',
  protocolAnthropic: 'Anthropic Messages',
  baseUrl: 'Base URL',
  baseUrlPlaceholder: 'https://api.example.com/v1',
  apiKey: 'API key',
  apiKeyEnv: 'API key environment variable',
  apiKeyHint:
    'Leave empty for keyless intranet servers (Ollama, vLLM, llama.cpp). The optional environment variable name under Advanced settings is read first (its value itself is never written to disk; leave the key field empty if you do not need a locally stored fallback key).',
  apiKeyMasked: 'A key is stored; only the last four characters are shown.',
  apiKeyPlaceholder: 'Paste a new key to replace the stored one',
  apiKeyPlaceholderStatic: 'Paste the key used for direct requests',
  apiKeyAutoSaveHint:
    'Saved automatically when the field loses focus or the settings dialog closes.',
  clearKey: 'Clear key',
  model: 'Model',
  modelPlaceholder: 'model-id',
  thinkingModel: 'Thinking model (optional)',
  thinkingModelHint:
    'Used when the Deep thinking switch is on. Empty means the normal model is used.',
  thinkingParamMode: 'Thinking request fields',
  thinkingParamNone: 'None (default, avoids 400 errors)',
  thinkingParamAnthropic: 'Anthropic: thinking with budget_tokens',
  thinkingParamDeepseek: 'thinking: {type: "enabled"}',
  thinkingParamReasoning: 'OpenAI: reasoning_effort "high"',
  thinkingParamEnable: 'enable_thinking: true',
  thinkingPassthroughHint:
    'Standard passthrough: this channel sends no extra thinking request fields. Turning it on only switches to the configured thinking model; add a request format under Advanced settings if the gateway needs one.',
  thinkingBudgetHint:
    'Anthropic extended thinking: budget_tokens {budget}; max_tokens is raised to at least {maxTokens} and always stays above the budget.',
  modalityMode: 'Modality policy',
  modalityAuto: 'Auto (fall back to text on 400/415/422)',
  modalityTextOnly: 'Text only (force plain text)',
  modalityMultimodal: 'Multimodal (send inline images)',
  webSearchMode: 'Web search mode',
  webSearchOff: 'Off (search switch disabled)',
  webSearchExa: 'Exa retrieval (works with any model)',
  webSearchNative:
    'DeepSeek native web tool deepseek_web_search (only Anthropic-compatible gateways that declare support for it)',
  remoteFileApi: 'Remote document parsing (Anthropic Files API)',
  remoteFileApiHint:
    'Off by default for privacy: attachments are parsed locally. Enable only when the endpoint supports the Anthropic Files Beta and you accept remote parsing. Only PDF files are valid remote document blocks; legacy binary documents (.doc/.xls/.ppt) and audio are rejected even with this option on.',
  lockRawUrl: 'Lock the raw endpoint URL',
  lockRawUrlHint:
    'Use the Base URL exactly as written, with no path joining. For special enterprise gateways only.',
  proxyMode: 'Proxy policy',
  proxySystem: 'Follow system proxy',
  proxyDirect: 'Force direct connection (bypass proxy)',
  proxyCustom: 'Custom proxy',
  proxyUrl: 'Custom proxy URL',
  allowInsecureTls: 'Skip TLS certificate verification (trusted intranet only)',
  customHeaders: 'Custom headers',
  headerName: 'Header name',
  headerValue: 'Header value',
  addHeader: 'Add header',
  customHeadersMaskedHint:
    'Stored header values live in secrets.json and are shown masked. Type a new value to replace one; leave it empty to keep the stored value.',
  temperature: 'Temperature',
  maxTokens: 'Max output tokens',
  requestTimeout: 'Request timeout (seconds)',
  ping: 'Test connection',
  pinging: 'Testing…',
  pingOk: 'Endpoint reachable.',
  pingOkNoModels: 'Endpoint reachable, but it does not expose a model list.',
  pingFail: 'Endpoint unreachable: {message}',
  probeModels: 'Fetch models',
  probing: 'Fetching…',
  modelsReceived: 'Found {count} models. Pick one or keep typing manually.',
  modelsEmpty: 'The endpoint did not return a model list. Type the model ID manually.',
  urlPreview: 'Final request URL',
  urlPreviewEmpty: 'Enter a Base URL to preview the final request URL.',
  urlErrorEmpty: 'Base URL is empty.',
  urlErrorInvalid: 'Base URL is not a valid http(s) URL.',
  urlErrorProtocol: 'Only http:// and https:// endpoints are allowed.',
  urlErrorQuery: 'Query strings require the "Lock the raw endpoint URL" option.',
  urlLockedHint: 'Raw URL locked; sent exactly as written.',
  emptyModelError: 'Model ID is empty.',
  saveFailed: 'Saving failed. Check the local service and retry.',
  saveFailedLocalStorage:
    'Saving failed: the browser’s local storage is full or blocked. Free some space and retry.',
  sessionReadFailed:
    'Loading the chat failed: the saved conversation could not be read from browser storage. Retry.',
  deleteFailed: 'Deleting failed: the chat was not removed and its draft is preserved. Retry.',
  deleteAllFailed: 'Deleting all chats failed: nothing was removed and your drafts are preserved. Retry.',
  channelSaveFailed: 'Channel configuration could not be saved.',
  exaEndpoint: 'Exa endpoint',
  exaKey: 'Exa API key',
  exaKeyEnv: 'Exa key environment variable',
  exaNumResults: 'Search results per query',
  exaMissingKey: 'No Exa API key is configured; web search is unavailable.',
  advancedSettings: 'Advanced settings',
  advancedActiveCount: 'Active advanced options: {count}',
  watchdogSection: 'Stream watchdogs',
  firstByteTimeout: 'First byte timeout (ms)',
  idleTimeout: 'Idle timeout between chunks (ms)',
  watchdogHint:
    'On timeout the request is aborted, partial output is kept and the message offers retry actions.',

  // Prompts
  systemPrompt: 'System prompt (Agent 1)',
  systemPromptHint:
    'Kept stable across every round to protect the prefix KV cache. Capsules never modify this field. Edits are written only after you press Save or Restore default.',
  resetDefault: 'Restore default',
  capsuleTemplates: 'Action capsule templates',
  capsuleTemplatesHint:
    'Appended only to the next outgoing message; the injected template text is never shown in the chat bubbles. Template language follows the interface language. Edits are written only after you press Save or Restore default. {language} is replaced at send time: the Agent 2 and Agent 3 templates use the downstream instruction language, while the report distillation template always follows the language of your current message.',
  capsuleTemplateRawHint:
    'Keep {language} in the template. The Agent 2 and Agent 3 templates replace it with the downstream instruction language; the report distillation template always replaces it with the language of your current message.',
  downstreamLanguage: 'Downstream agent instruction language (Agents 2 and 3)',
  downstreamLanguageHint:
    'Applies only to the {language} placeholder in the Agent 2 and Agent 3 capsule templates; this select takes effect immediately. The report distillation capsule always follows the language of your own message.',
  languageFollow: 'Follow the current conversation (default)',
  promptLanguageFallback:
    'French and Russian interfaces use the English default system prompt; edit it freely above.',
  savedDefault: 'Using the built-in default.',

  // Capsules
  capsuleBarLabel: 'Single-shot action for this message',
  capsuleAgent2: 'Generate Agent 2 execution instruction',
  capsuleAgent2Desc:
    'Writes the agreed plan into a copy-ready implementation prompt for the local stateless executor, with a hard scope constraint and a mandatory change list plus exception report.',
  capsuleAgent3: 'Generate Agent 3 audit request',
  capsuleAgent3Desc:
    'Writes a non-leading, falsification-first audit prompt: top-level sanity, hidden assumptions, real-time and physical failure modes, required experiments, and over-design.',
  capsuleDistill: 'Distill the returned report',
  capsuleDistillDesc:
    'Turns a pasted execution error or audit report into a three-point plain-language traffic-light decision sheet: can we stop and ship, what must really change, and which nitpicks to throw away.',
  capsuleActive: 'Applied to the next message only',
  capsuleInjectedNote: 'Applies to this message only',
  capsuleTagAgent2: 'Agent 2 prompt',
  capsuleTagAgent3: 'Agent 3 audit',
  capsuleTagDistill: 'Report distillation',
  noSessions: 'No chats yet',

  // Input
  inputPlaceholder: 'Describe the engineering problem, or paste the report to distill…',
  attachFile: 'Attach files',
  parsingFiles: 'Parsing files locally…',
  dropFiles: 'Drop files to attach',
  dropFilesHint: 'Local deterministic parsing. Up to {count} files, {size} MB each.',
  thinkingToggle: 'Deep thinking',
  searchToggle: 'Web search',
  searchUnavailableOff: 'Web search is disabled for this channel (Settings → Channels).',
  searchUnavailableNative:
    'Native search uses the DeepSeek deepseek_web_search server tool and works only on Anthropic-compatible gateways that declare support for it.',
  safetyNotice:
    'AI output is not a safety certification. Verify every result line by line and with real tests before it touches hardware.',
  attachmentBinaryUnsupported:
    'Local deterministic parsing is active. To avoid silently distorted formulas and layout, binary PDF files are not read directly, and legacy binary documents (.doc/.xls/.ppt) plus audio files are rejected even when remote parsing is enabled. Paste the key paragraphs, attach a screenshot, or enable remote document parsing for PDF files only.',
  attachmentTooLarge: 'File is too large (limit {size} MB).',
  attachmentUnsupported: 'Unsupported file type.',
  attachmentReadFailed: 'The file could not be read.',
  attachmentOfficeFailed: 'The Office document structure could not be parsed.',
  attachmentOfficeTooLarge:
    'The Office file exceeds the safe local extraction budget and was not parsed.',
  attachmentImageUnsupported:
    'This image format is not supported for inline vision. Use PNG, JPEG, WebP or GIF; SVG files are read as text.',
  attachmentTruncated: 'Truncated to protect the context window',
  attachmentRemote: 'Remote parsing',
  attachmentLocal: 'Local parsing',
  attachmentCountLimit: 'At most {count} attachments per message.',
  attachmentNeedsRemote:
    'This attachment must be parsed remotely; enable remote document parsing for this channel first.',
  remoteFileStale:
    'This attachment was uploaded through a different channel slot, endpoint or key and was not sent. Re-upload it for the active channel.',
  officeEmptySheet: '(empty sheet)',
  officeTruncatedRows: '[Truncated: showing the first {rows} non-empty rows and {columns} columns]',
  officeColumnsTruncated: '[Truncated: every non-empty cell is beyond the 64-column limit]',
  officeTruncatedDocument:
    '[Truncated: the extracted document text reached the 256 KB size budget]',
  officeSlideHeading: '## Slide {index}',
  attachmentParseProgress: 'Parsing {name}…',
  enterToSend: 'Enter to send · Shift+Enter for a new line',
  stopGenerating: 'Stop generating',
  configRequired: 'Configure a channel first (Settings → Channels).',
  draftRestored: 'Unsent draft restored',
  draftAttachmentLost: 'Draft text restored; images could not be kept after reload.',

  // Messages
  agent1Name: 'Agent 1',
  thoughtFor: 'Thought for {seconds}s',
  reasoningLabel: 'Reasoning',
  showReasoning: 'Show reasoning',
  hideReasoning: 'Hide reasoning',
  usageLabel: 'Tokens: {input} in / {output} out',
  compactAction: 'Compact context',
  compactTooltip:
    'Keep the full text readable in the chat, but send a short summary into later model context.',
  compactDialogTitle: 'Compact this message',
  compactDialogHint:
    'The model will receive this summary instead of the full text in the following rounds. The original stays expandable in the chat.',
  compactAttachmentWarning:
    'After compaction, later model context will use this summary instead of the original text and attachment contents.',
  compactAttachmentIndex: 'Attachments in this message: {items}',
  compactBadge: 'Compacted',
  expandOriginal: 'Show original',
  hideOriginal: 'Hide original',
  compactSummaryLabel: 'Summary sent to the model',
  compactSummaryPlaceholder: 'Summary used in later rounds',
  compactDefaultMarker: '[Compacted summary of the original message]',
  rewind: 'Rewind to here',
  rewindConfirmTitle: 'Replace the current draft?',
  rewindConfirmText:
    'The input box already contains an unsent draft. Rewinding will replace it.',
  rewindDone: 'Conversation truncated; the message was put back into the input box.',
  retryRound: 'Retry this round',
  retryTrimmed:
    'Later rounds were removed so the context chain stays consistent; retrying from this round.',
  retryOnBackup: 'Retry on backup channel',
  stoppedByUser: 'Stopped by you.',
  waitingFirstToken: 'Waiting for the first token…',
  streamingLabel: 'Generating',
  messageActions: 'Message actions',
  editMessage: 'Edit and resend',

  // Errors
  errorHttp: 'Request rejected by the endpoint (HTTP {status}): {message}',
  errorNetwork: 'Network error: {message}',
  errorWatchdogFirstByte: 'No first token within {seconds}s; the request was aborted.',
  errorWatchdogIdle: 'No data for {seconds}s; the request was aborted.',
  errorProtocol: 'The endpoint returned an unexpected stream format: {message}',
  errorInvalidJson: 'The endpoint returned invalid JSON.',
  errorEmptyBody: 'The endpoint returned an empty response body.',
  errorStream: 'The endpoint reported a stream error: {message}',
  errorInterrupted: 'The stream ended before completion; the reply may be truncated.',
  errorAuth: 'Authentication failed (HTTP {status}). Check the API key for this channel.',
  errorRateLimited: 'Rate limited (HTTP 429). Please wait and retry.',
  errorServerBusy: 'Upstream server busy (HTTP {status}). Retry or switch to the backup channel.',
  errorConfig: 'Request configuration is incomplete: {message}',
  errorPayloadTooLarge: 'The request is larger than the 32 MB forwarding limit.',
  errorCrossOriginRedirect:
    'The upstream endpoint attempted a cross-origin redirect. The request was blocked to protect credentials.',
  errorInvalidExaEndpoint: 'The Exa endpoint is invalid.',
  errorUpstreamStream: 'The upstream stream reported an error.',
  errorFileIdMissing: 'The file API response did not contain a file id.',
  jsonBackupNotJson: 'The selected file is not valid JSON.',
  jsonBackupWrongSchema:
    'The selected file is not an Engineering AI Console session backup.',
  jsonBackupUnsupportedVersion: 'Unsupported backup version: {version}.',
  jsonBackupNoSessions: 'The backup file has no session list.',
  jsonBackupMalformedSession:
    'Session {index} is malformed or contains an invalid message.',
  errorAborted: 'Request aborted.',
  errorImageOnly:
    'The active model accepts text only, and this message contains images but no text. Your draft and attachments were kept; add some text or switch to a vision-capable channel.',
  imageOmittedToast:
    'The active model does not accept image input. The message was downgraded to plain text automatically.',
  searchFailedContinue: 'Web search failed; the message was sent without search results.',
  searchEmpty: 'Web search returned no usable results.',

  // Data / reset details
  exportSessions: 'Export chats as plain text',
  exportHint: 'Plain text rescue file. API keys are never included.',
  exportSessionsJson: 'Export chats as JSON',
  exportJsonHint:
    'Structured JSON backup with full message trees, attachment text and image data. API keys are never included.',
  importSessionsJson: 'Import chats from JSON',
  importJsonHint:
    'Strict schema validation; API keys are never read. Existing chats are kept.',
  exportJsonDone: 'JSON backup exported.',
  importJsonDone: 'Imported {sessions} chats and {messages} messages.',
  importJsonInvalid: 'The JSON backup is invalid: {message}',
  importJsonFailed: 'Import failed: {message}',
  importJsonEmpty: 'No valid chats were found in the selected file.',
  importJsonBusy: 'Importing…',
  importJsonTooLarge: 'The selected backup file exceeds the {size} MB import limit.',
  importJsonTooMany: 'The backup contains too many sessions or messages to import safely.',
  exportFieldGenerated: 'Generated: {time}',
  exportFieldSession: 'Session: {id}',
  exportFieldAttachments: 'Attachments: {items}',
  exportFieldStatus: 'Status: {status}',
  exportFieldUser: 'User',
  exportFieldAgent: 'Agent 1',
  exportAttachmentBlock: '--- attachment: {name} ({size} bytes) ---',
  clearBrowserData: 'Clear browser data',
  deleteAllChats: 'Delete all chats',
  deleteAllChatsConfirm: 'All chats and drafts in this browser will be deleted. Continue?',
  exportPlainTextHeader: 'Engineering AI Console — plain-text chat rescue file',

  // Markdown / Mermaid
  mermaidDiagram: 'Diagram',
  mermaidCode: 'Code',
  mermaidEmpty: 'This diagram is empty.',
  mermaidLoading: 'Rendering diagram…',
  mermaidRenderFail: 'Mermaid rendering failed.',
  mermaidSwitchLabel: 'Toggle between Mermaid diagram and code',

  // Misc
  download: 'Download',
  fileSizeUnknown: 'Unknown size',
  scrollToBottom: 'Scroll to bottom',
  charCount: '{count} chars',
  remoteEndpointKey: 'Remote parsing endpoint',
} as const
