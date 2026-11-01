// The visitor's own Hugging Face key, used on public deployments.
// It lives only in this browser (localStorage) and is sent with a review request over HTTPS.
// The server uses it for that run and does not store it.
export interface Credentials {
  key: string
  model: string
}

const KEY = 'horizon.credentials.v1'

export function loadCredentials(): Credentials {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Credentials>
      return { key: String(parsed.key ?? ''), model: String(parsed.model ?? '') }
    }
  } catch {
    // Storage can be unavailable (private mode).
  }
  return { key: '', model: '' }
}

let memory: Credentials | undefined

/** Falls back to memory when storage is blocked, so the key still works for this tab. */
export function getCredentials(): Credentials {
  return memory ?? loadCredentials()
}

export function saveCredentials(c: Credentials): void {
  memory = c
  try {
    localStorage.setItem(KEY, JSON.stringify(c))
  } catch {
    // keep the in-memory copy
  }
}

export function clearCredentials(): void {
  memory = { key: '', model: '' }
  try {
    localStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}

/** A Hugging Face key is a single token without spaces. Anything else is a typo. */
export function looksLikeKey(key: string): boolean {
  return /^[\x21-\x7e]{8,200}$/.test(key)
}

export function looksLikeModel(model: string): boolean {
  return model === '' || /^[A-Za-z0-9_.:/-]{1,100}$/.test(model)
}
