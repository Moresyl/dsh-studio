import { useEffect, useState, type ReactNode } from 'react'
import { Check, Copy, Loader2, ShieldCheck, Smartphone, Wifi } from 'lucide-react'

import { Button } from '@/components/Button'
import { PaneHeader } from '@/components/PaneHeader'
import { QrCode } from '@/components/QrCode'
import { StatusDot } from '@/components/StatusDot'
import { t } from '@/lib/i18n'
import type { MessageKey } from '@/lib/i18n'
import type { QrMatrix } from '@/lib/ipc'
import { useHarness } from '@/state/harness'
import { useRemote } from '@/state/remote'

/** Why this is safe to switch on, in the three sentences that say it. */
const NOTES: MessageKey[] = ['remote.note.loopback', 'remote.note.secret', 'remote.note.oneAddress']

/**
 * Reaching the harness from a phone.
 *
 * The pane is built around the QR code because that is the whole interaction:
 * open the door, point a camera at it, and the phone is paired. Typing a
 * 32-character secret into a phone keyboard is the version of this feature
 * nobody uses twice, so the secret is never presented as something to read —
 * it is in the symbol, and behind one button for the case where the phone is
 * being messaged rather than pointed.
 *
 * The security notes are on the pane rather than in a document. This is the one
 * switch in the app that changes what the machine tells the network, and the
 * questions it raises are asked at the moment of switching it on.
 */
export function RemotePane() {
  const phase = useHarness((state) => state.status.phase)
  const status = useRemote((state) => state.status)
  const busy = useRemote((state) => state.busy)
  const error = useRemote((state) => state.error)
  const refresh = useRemote((state) => state.refresh)
  const open = useRemote((state) => state.open)
  const close = useRemote((state) => state.close)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const serving = phase === 'ready'
  const isOpen = status?.open ?? false

  return (
    <section className="flex min-h-0 flex-1 animate-rise flex-col">
      <PaneHeader title={t('remote.title')} subtitle={t('remote.subtitle')}>
        <span className="flex items-center gap-1.5 text-[11.5px] text-muted">
          <StatusDot
            tone={{
              color: isOpen ? 'var(--color-ok)' : 'var(--color-faint)',
              live: false,
            }}
            size={6}
          />
          {isOpen ? t('remote.state.open') : t('remote.state.closed')}
        </span>

        {isOpen ? (
          <Button variant="secondary" onClick={() => void close()} disabled={busy}>
            {t('remote.close')}
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void open()} disabled={!serving || busy}>
            {busy ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                {t('remote.opening')}
              </>
            ) : (
              <>
                <Wifi size={13} strokeWidth={2.3} />
                {t('remote.open')}
              </>
            )}
          </Button>
        )}
      </PaneHeader>

      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas px-6 py-5">
        <div className="mx-auto flex max-w-[780px] flex-col gap-4">
          {status?.open && status.qr && status.url && status.pairingUrl ? (
            <Pairing qr={status.qr} url={status.url} pairingUrl={status.pairingUrl} />
          ) : (
            <Closed serving={serving} addresses={status?.addresses ?? []} />
          )}

          {status?.open && (
            <Counters active={status.active} served={status.served} refused={status.refused} />
          )}

          {error && (
            <p className="selectable rounded-control border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] leading-relaxed text-danger">
              {error}
            </p>
          )}

          <ul className="flex flex-col gap-2.5 rounded-panel border border-line bg-canvas-deep/40 px-4 py-3.5">
            {NOTES.map((note) => (
              <li key={note} className="flex gap-2.5">
                <ShieldCheck
                  size={13}
                  strokeWidth={2.1}
                  className="mt-[3px] shrink-0 text-ok"
                  aria-hidden="true"
                />
                <p className="text-[12px] leading-relaxed text-muted">{t(note)}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}

interface PairingProps {
  qr: QrMatrix
  /** The address a paired device uses afterwards. */
  url: string
  /** The address that does the pairing, secret included. */
  pairingUrl: string
}

/** The open door: the symbol, the address, and the link behind a button. */
function Pairing({ qr, url, pairingUrl }: PairingProps) {
  return (
    <div className="flex flex-col gap-5 rounded-panel border border-line bg-canvas-deep/50 p-5 sm:flex-row">
      <div className="flex shrink-0 flex-col items-center gap-2.5">
        <QrCode matrix={qr} size={196} label={t('remote.scan')} />
        <span className="caption">{t('remote.scan')}</span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <p className="text-[12.5px] leading-relaxed text-muted">{t('remote.scanHint')}</p>

        <dl className="flex flex-col gap-1">
          <dt className="caption">{t('remote.address')}</dt>
          <dd className="selectable font-mono text-[13px] text-text tabular-nums">
            {url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
          </dd>
        </dl>

        <CopyButton value={pairingUrl} label={t('remote.copyPairing')} />
      </div>
    </div>
  )
}

/** The closed door: what would happen, and what is stopping it. */
function Closed({ serving, addresses }: { serving: boolean; addresses: string[] }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-panel border border-dashed border-line-strong bg-canvas-deep/40 px-6 py-10 text-center">
      <Smartphone size={26} strokeWidth={1.5} className="text-faint" aria-hidden="true" />

      {!serving ? (
        <p className="text-[12.5px] text-muted">{t('remote.needsHarness')}</p>
      ) : addresses.length === 0 ? (
        <p className="text-[12.5px] text-muted">{t('remote.noNetwork')}</p>
      ) : (
        <>
          <p className="caption">{t('remote.reachableAt')}</p>
          <ul className="flex flex-wrap items-center justify-center gap-1.5">
            {addresses.map((address) => (
              <li
                key={address}
                className="selectable rounded-control border border-line bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-muted tabular-nums"
              >
                {address}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/** Three numbers that only mean something together. */
function Counters({
  active,
  served,
  refused,
}: {
  active: number
  served: number
  refused: number
}) {
  return (
    <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-panel border border-line bg-line">
      <Stat label={t('remote.active')} value={active} tone={active > 0 ? 'text-ok' : undefined} />
      <Stat label={t('remote.served')} value={served} />
      <Stat
        label={t('remote.refused')}
        value={refused}
        tone={refused > 0 ? 'text-warn' : undefined}
      />
    </dl>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex flex-col gap-1 bg-canvas-deep px-3.5 py-2.5">
      <dt className="caption">{label}</dt>
      <dd className={`font-mono text-[17px] leading-none tabular-nums ${tone ?? 'text-text'}`}>
        {value}
      </dd>
    </div>
  )
}

/**
 * Copy, with the confirmation on the button that was pressed.
 *
 * The webview's own clipboard rather than a plugin: this document is served
 * from localhost, which is a secure context everywhere this ships, and a click
 * is the user gesture the API asks for.
 */
function CopyButton({ value, label }: { value: string; label: string }): ReactNode {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    })
  }

  return (
    <Button variant="secondary" className="self-start" onClick={copy}>
      {copied ? (
        <Check size={13} strokeWidth={2.6} className="text-ok" />
      ) : (
        <Copy size={13} strokeWidth={2.1} />
      )}
      {copied ? t('statusbar.copied') : label}
    </Button>
  )
}
