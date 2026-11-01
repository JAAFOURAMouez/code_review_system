export interface Settings {
  simulate: boolean
  speed: 'slow' | 'normal' | 'fast'
  injectFailures: boolean
  /** Blended price per one million tokens, used only for cost estimates. */
  pricePerMillionTokens: number
}

export const DEFAULT_SETTINGS: Settings = {
  simulate: true,
  speed: 'normal',
  injectFailures: true,
  pricePerMillionTokens: 5,
}

export const SPEED_INTERVAL_MS: Record<Settings['speed'], number> = {
  slow: 6000,
  normal: 3500,
  fast: 1500,
}

const KEY = 'horizon.settings.v1'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_SETTINGS
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // Storage can be unavailable (private mode). Settings then last for the session only.
  }
}
