/**
 * Provider table and key resolution.
 *
 * The browser half sends `{ endpoint, provider, key, body }`; a key that
 * arrives in the payload always wins (that is the app's own settings screen),
 * then the plugin's own settings file, then the environment. Nothing here is
 * ever logged or echoed back: /rp/api/status only reports `hasKey` booleans.
 */

export const DEFAULT_ENDPOINT = 'https://api.deepseek.com/chat/completions'

export const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    env: ['DEEPSEEK_API_KEY', 'DSH_DEEPSEEK_API_KEY'],
    hosts: ['api.deepseek.com'],
  },
  kimi: {
    label: 'Kimi（月之暗面）',
    env: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
    hosts: ['api.moonshot.cn', 'api.moonshot.ai'],
  },
  glm: {
    label: 'GLM（智谱）',
    env: ['GLM_API_KEY', 'ZHIPU_API_KEY'],
    hosts: ['open.bigmodel.cn', 'api.z.ai'],
  },
  relay88: {
    label: '88api · Gemini 中转',
    env: ['RELAY88_API_KEY'],
    hosts: ['88api.ai'],
  },
  xin: {
    label: 'xin1122 · Gemini 直连',
    env: ['XIN_API_KEY'],
    hosts: ['xin1122.zeabur.app'],
  },
  custom: {
    label: '自定义',
    env: ['CUSTOM_API_KEY', 'OPENAI_API_KEY'],
    hosts: [],
  },
}

/** endpoint host -> provider id, '' when unknown. */
export function providerOfEndpoint(endpoint) {
  let host = ''
  try {
    host = new URL(String(endpoint || '')).hostname.toLowerCase()
  } catch {
    return ''
  }
  for (const name of Object.keys(PROVIDERS)) {
    const hosts = PROVIDERS[name].hosts
    if (hosts.some((h) => host === h || host.endsWith('.' + h))) return name
  }
  return ''
}

function envKeyOf(provider) {
  const entry = PROVIDERS[provider]
  if (!entry) return ''
  for (const name of entry.env) {
    const value = String(process.env[name] || '').trim()
    if (value) return value
  }
  return ''
}

/**
 * Resolve the bearer key for one request.
 * Order: payload key (typed in the app's settings) -> plugin settings file ->
 * environment variable for the resolved provider. An endpoint that maps to no
 * provider still gets the `custom` key, matching the app's own fallback.
 */
export function resolveKey(provider, payloadKey, settingsKeys) {
  const typed = String(payloadKey || '').trim()
  if (typed) return typed
  const stored = settingsKeys && typeof settingsKeys === 'object' ? String(settingsKeys[provider] || '').trim() : ''
  if (stored) return stored
  const fromEnv = envKeyOf(provider)
  if (fromEnv) return fromEnv
  if (provider !== 'custom') {
    const customStored = settingsKeys && typeof settingsKeys === 'object' ? String(settingsKeys.custom || '').trim() : ''
    if (customStored) return customStored
    return envKeyOf('custom')
  }
  return ''
}

/** Provider inventory for /rp/api/status — booleans only. */
export function providerStatus(settingsKeys) {
  const out = {}
  for (const name of Object.keys(PROVIDERS)) {
    const stored = settingsKeys && typeof settingsKeys === 'object' ? String(settingsKeys[name] || '').trim() : ''
    out[name] = {
      label: PROVIDERS[name].label,
      hasKey: !!(stored || envKeyOf(name)),
    }
  }
  return out
}

export function isHttpEndpoint(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}
