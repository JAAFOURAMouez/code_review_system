import { useEffect, useState } from 'react'
import { Spinner, useDismiss } from '../design/ui.tsx'
import { getCredentials } from '../state/credentials.ts'
import { store, useApp } from '../state/store.ts'

const MAX_CODE_BYTES = 100_000

/** The visitor's own Hugging Face key (upload deployments). Stays in this browser. */
export function KeyForm({ compact }: { compact?: boolean }) {
  const { hasKey } = useApp()
  const saved = getCredentials()
  const [key, setKey] = useState('')
  const [model, setModel] = useState(saved.model)
  const [error, setError] = useState<string>()
  const [shown, setShown] = useState(false)

  const save = () => {
    const err = store.saveCredentials(key || saved.key, model)
    setError(err)
    if (!err) {
      setKey('')
      store.toast('success', 'Saved in this browser')
    }
  }

  return (
    <form
      className="reviewform"
      onSubmit={(e: { preventDefault: () => void }) => {
        e.preventDefault()
        save()
      }}
    >
      <div className="field">
        <label htmlFor="hf-key">Your Hugging Face key</label>
        <div className="keyrow">
          <input
            id="hf-key"
            className="input"
            type={shown ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            value={key}
            placeholder={hasKey ? 'A key is saved. Paste a new one to replace it.' : 'hf_…'}
            onChange={(e: { target: { value: string } }) => setKey(e.target.value)}
          />
          <button type="button" className="btn btn--sm" onClick={() => setShown(!shown)}>
            {shown ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      {!compact && (
        <div className="field">
          <label htmlFor="hf-model">Model (optional)</label>
          <input
            id="hf-model"
            className="input"
            value={model}
            placeholder="openai/gpt-oss-20b:groq"
            spellCheck={false}
            onChange={(e: { target: { value: string } }) => setModel(e.target.value)}
          />
        </div>
      )}
      {error && (
        <p className="reviewform__error" role="alert">
          {error}
        </p>
      )}
      <p className="muted reviewform__note">
        Create a free key at huggingface.co/settings/tokens (read access is enough). It is kept only
        in this browser and sent with each review over HTTPS. The server uses it for that run and
        does not store it. Your code is sent to Hugging Face with your key.
      </p>
      <div className="actions">
        <button type="submit" className="btn btn--primary" disabled={!key && !hasKey}>
          Save key
        </button>
        {hasKey && (
          <button type="button" className="btn" onClick={() => store.removeKey()}>
            Remove key
          </button>
        )}
      </div>
    </form>
  )
}

/** Choose what to review and start. Path mode: a project file. Upload mode: pasted or uploaded code. */
export function ReviewForm({ onStarted }: { onStarted?: () => void }) {
  const { ws, submitMode, hasKey } = useApp()
  const upload = submitMode === 'upload'
  const [files, setFiles] = useState<string[] | undefined>()
  const [file, setFile] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('snippet.py')
  const [loadError, setLoadError] = useState<string>()
  const [starting, setStarting] = useState(false)
  const reviewing = !!ws?.tasks.some((t) => t.status === 'running')

  useEffect(() => {
    if (upload) return
    let live = true
    store
      .listFiles()
      .then((f) => {
        if (!live) return
        setFiles(f)
        setFile((cur) => cur || f[0] || '')
      })
      .catch((e: unknown) => {
        if (live) setLoadError(e instanceof Error ? e.message : 'Could not list the project files.')
      })
    return () => {
      live = false
    }
  }, [upload])

  const tooBig = new Blob([code]).size > MAX_CODE_BYTES
  const canStart = upload ? hasKey && !!code.trim() && !tooBig : !!file

  const submit = async () => {
    setStarting(true)
    const ok = await store.startReview(upload ? { code, name } : { file, name: file })
    setStarting(false)
    if (ok) onStarted?.()
  }

  const readFile = async (f: File | undefined) => {
    if (!f) return
    if (f.size > MAX_CODE_BYTES) {
      store.toast('error', `That file is larger than ${MAX_CODE_BYTES / 1000} KB.`)
      return
    }
    setCode(await f.text())
    setName(f.name)
  }

  if (!upload) {
    if (loadError) return <p className="muted reviewform__error">{loadError}</p>
    if (!files) return <Spinner label="Listing project files" />
    if (files.length === 0)
      return (
        <p className="muted">
          No Python files were found in the project folder. Add a file such as{' '}
          <code>src/sample.py</code> and reopen this panel.
        </p>
      )
  }

  return (
    <form
      className="reviewform"
      onSubmit={(e: { preventDefault: () => void }) => {
        e.preventDefault()
        void submit()
      }}
    >
      {upload ? (
        <>
          <div className="field">
            <label htmlFor="review-code">Python code to review</label>
            <textarea
              id="review-code"
              className="input reviewform__code"
              rows={9}
              spellCheck={false}
              value={code}
              placeholder="Paste your code here, or choose a .py file below"
              onChange={(e: { target: { value: string } }) => setCode(e.target.value)}
            />
            {tooBig && (
              <span className="reviewform__error">
                The code is larger than {MAX_CODE_BYTES / 1000} KB.
              </span>
            )}
          </div>
          <div className="field">
            <label htmlFor="review-upload">Or upload a file</label>
            <input
              id="review-upload"
              type="file"
              accept=".py,text/x-python"
              onChange={(e: { target: { files: FileList | null } }) =>
                void readFile(e.target.files?.[0])
              }
            />
          </div>
          <div className="field">
            <label htmlFor="review-name">File name</label>
            <input
              id="review-name"
              className="input"
              value={name}
              onChange={(e: { target: { value: string } }) => setName(e.target.value)}
            />
          </div>
        </>
      ) : (
        <div className="field">
          <label htmlFor="review-file">Python file to review</label>
          <select
            id="review-file"
            className="select"
            value={file}
            onChange={(e: { target: { value: string } }) => setFile(e.target.value)}
          >
            {(files ?? []).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
      )}
      <p className="muted reviewform__note">
        {upload
          ? 'The agents run one after another on this code. The model-based agents send it to Hugging Face with your key; static analysis stays on the server and never runs your code.'
          : 'The agents run one after another on this file. The model-based agents send its contents to the Hugging Face API configured in your .env; static analysis stays local.'}
      </p>
      {upload && !hasKey && (
        <p className="reviewform__error" role="status">
          Add your Hugging Face key first (Settings, or the form on this page).
        </p>
      )}
      <button
        type="submit"
        className="btn btn--primary"
        disabled={starting || reviewing || !canStart}
        title={reviewing ? 'A review is already running' : undefined}
      >
        {reviewing ? 'A review is running…' : starting ? 'Starting…' : 'Start review'}
      </button>
    </form>
  )
}

export function NewReview() {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  return (
    <div className="popwrap" ref={ref}>
      <button
        type="button"
        className="btn btn--primary btn--sm"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        Run review
      </button>
      {open && (
        <div className="pop pop--review" role="dialog" aria-label="Start a review">
          <div className="pop__head">
            <h3>Start a review</h3>
          </div>
          <div className="pop__body">
            <ReviewForm onStarted={() => setOpen(false)} />
          </div>
        </div>
      )}
    </div>
  )
}

/** Shown by a live backend before the first review exists. */
export function FirstRun() {
  const { repoLabel, submitMode, hasKey } = useApp()
  return (
    <div className="boot">
      <div className="boot__card firstrun">
        <div>
          <h2>No reviews yet</h2>
          <p className="muted">
            {submitMode === 'upload'
              ? 'Paste or upload some Python code and the agents review it, step by step. You bring your own Hugging Face key.'
              : `Connected to ${repoLabel.replace('Live · ', '')}. Pick a file to run your agents on; Horizon shows each run as it happens.`}
          </p>
          {submitMode === 'upload' && !hasKey && <KeyForm compact />}
          <ReviewForm />
        </div>
      </div>
    </div>
  )
}
