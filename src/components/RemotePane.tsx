import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Check,
  Copy,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  TimerOff,
  Trash2,
  Wifi,
} from 'lucide-react'

import { Badge } from '@/components/Badge'
import { Button } from '@/components/Button'
import { IconButton } from '@/components/IconButton'
import { PaneHeader } from '@/components/PaneHeader'
import { QrCode } from '@/components/QrCode'
import { t } from '@/lib/i18n'
import type { MessageKey } from '@/lib/i18n'
import type { RemoteDevice, RemoteStatus } from '@/lib/ipc'
import { ask } from '@/state/dialog'
import { reportAction } from '@/state/failure'
import { useHarness } from '@/state/harness'
import { useRemote } from '@/state/remote'

/** Why this is safe to switch on, in the four sentences that say it. */
const NOTES: MessageKey[] = [
  'remote.note.loopback',
  'remote.note.secret',
  'remote.note.perDevice',
  'remote.note.oneAddress',
]

/** The QR symbol's edge. The lapsed tile matches it so the card never jumps. */
const TILE = 196

/** Below this many seconds the countdown stops being background information. */
const LOW_WATER = 20

/**
 * How often the pane re-reads a door that is open.
 *
 * The change event fires on traffic, and two things here are clocks instead:
 * how long the code has left, and when each device was last seen. A slow tick
 * keeps both honest — including across a machine that slept — without turning
 * the pane into a poller.
 */
const RESYNC = 30_000

/**
 * An address, drawn as the thing it is: text to be read off the screen and typed
 * into a phone. The chip is what makes it findable, and it stays selectable
 * because "copy" is the other way it gets to the phone.
 */
const ADDRESS_CHIP =
  'selectable rounded-sm bg-control-fill px-2 py-1 font-mono text-ui-sm text-text tabular-nums'

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
 * What the symbol carries is not what the phone keeps, and the pane is shaped
 * by that: a code that visibly runs out, and below it the devices that used one
 * — each removable on its own, because a list nobody can prune is a list that
 * stops being read.
 *
 * The security notes are on the pane rather than in a document. This is the one
 * switch in the app that changes what the machine tells the network, and the
 * questions it raises are asked at the moment of switching it on.
 */
export function RemotePane() {
  const phase = useHarness((state) => state.status.phase)
  const status = useRemote((state) => state.status)
  const busy = useRemote((state) => state.busy)
  const operation = useRemote((state) => state.operation)
  const error = useRemote((state) => state.error)
  const refresh = useRemote((state) => state.refresh)
  const open = useRemote((state) => state.open)
  const close = useRemote((state) => state.close)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const serving = phase === 'ready'
  const isOpen = status?.open ?? false
  const suspended = status?.suspended ?? false

  useEffect(() => {
    if (!isOpen) return
    const timer = window.setInterval(() => void refresh(), RESYNC)
    return () => window.clearInterval(timer)
  }, [isOpen, refresh])

  return (
    <section className="flex min-h-0 flex-1 animate-rise flex-col">
      <PaneHeader title={t('remote.title')} subtitle={t('remote.subtitle')} width="narrow">
        <Badge tone={isOpen ? 'ok' : 'neutral'}>
          {operation === 'open'
            ? t('remote.opening')
            : operation === 'close'
              ? t('remote.closing')
              : isOpen
                ? t('remote.state.open')
                : suspended
                  ? t('remote.state.reconnecting')
                  : t('remote.state.closed')}
        </Badge>

        {operation === 'open' ? (
          <Button variant="secondary" onClick={() => void close()}>
            <Loader2 className="animate-spin" />
            {t('remote.cancelOpening')}
          </Button>
        ) : operation === 'close' ? (
          <Button variant="secondary" disabled>
            <Loader2 className="animate-spin" />
            {t('remote.closing')}
          </Button>
        ) : isOpen ? (
          <Button variant="secondary" onClick={() => void close()} disabled={busy}>
            {t('remote.close')}
          </Button>
        ) : suspended ? (
          <span className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => void close()} disabled={busy}>
              {t('remote.close')}
            </Button>
            <Button variant="primary" onClick={() => void open()} disabled={!serving || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t('remote.reconnect')}
            </Button>
          </span>
        ) : (
          <Button variant="primary" onClick={() => void open()} disabled={!serving || busy}>
            {busy ? (
              <>
                <Loader2 className="animate-spin" />
                {t('remote.opening')}
              </>
            ) : (
              <>
                <Wifi />
                {t('remote.open')}
              </>
            )}
          </Button>
        )}
      </PaneHeader>

      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas px-6 pb-6">
        <div className="mx-auto flex max-w-[780px] flex-col gap-4">
          {status?.open ? (
            <>
              <Door status={status} />
              <Devices devices={status.devices} />
              <Counters active={status.active} served={status.served} refused={status.refused} />
            </>
          ) : (
            <Closed serving={serving} addresses={status?.addresses ?? []} />
          )}

          {suspended && (
            <p className="selectable rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-ui-sm text-warn">
              {t('remote.reconnectingHint')}
            </p>
          )}

          {error && (
            <p className="selectable rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-ui-sm text-danger">
              {error}
            </p>
          )}

          <ul className="card flex flex-col gap-2 px-4 py-3">
            {NOTES.map((note) => (
              <li key={note} className="flex gap-2">
                <ShieldCheck
                  size={14}
                  strokeWidth={2}
                  className="mt-0.5 shrink-0 text-ok"
                  aria-hidden="true"
                />
                <p className="text-ui-sm text-muted">{t(note)}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}

/**
 * The open door: a code with a life on it, the address, and the link.
 *
 * Live and lapsed share the card and the tile's size, so a code running out
 * changes what is in the frame rather than the shape of the pane around it.
 */
function Door({ status }: { status: RemoteStatus }) {
  const refresh = useRemote((state) => state.refresh)
  const renew = useRemote((state) => state.renew)
  const { qr, url, pairingUrl, codeSecondsLeft, codeLifetimeSeconds } = status

  return (
    <div className="card card--pad flex flex-col gap-5 sm:flex-row">
      <div className="flex shrink-0 flex-col items-center gap-3" style={{ width: TILE }}>
        {qr && codeSecondsLeft !== null ? (
          <>
            <QrCode matrix={qr} size={TILE} label={t('remote.scan')} />
            <Countdown seconds={codeSecondsLeft} lifetime={codeLifetimeSeconds} onLapse={refresh} />
          </>
        ) : (
          <Lapsed onRenew={() => void renew()} />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <p className="text-ui-base text-muted">
          {pairingUrl ? t('remote.scanHint') : t('remote.expiredHint')}
        </p>

        {url && (
          <dl className="flex flex-col gap-1.5">
            <dt className="caption">{t('remote.address')}</dt>
            <dd className={`${ADDRESS_CHIP} self-start`}>
              {url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
            </dd>
          </dl>
        )}

        {pairingUrl && <CopyButton value={pairingUrl} label={t('remote.copyPairing')} />}
      </div>
    </div>
  )
}

interface CountdownProps {
  /** Seconds left as of the last status read. */
  seconds: number
  /** Seconds a fresh code gets, which is what the bar is a fraction of. */
  lifetime: number
  /** Called at zero, to read the status that will say the code is gone. */
  onLapse: () => void
}

/** A code visibly running out, which is the only warning it ever gives. */
function Countdown({ seconds, lifetime, onLapse }: CountdownProps) {
  const [left, setLeft] = useState(seconds)

  // What the last status said, parked for the tick below to read rather than
  // applied the moment it arrives. Statuses land on traffic as well as on the
  // clock, and a burst of them must not be able to restart the second or shove
  // the number around inside one.
  const authoritative = useRef(seconds)
  useEffect(() => {
    authoritative.current = seconds
  }, [seconds])

  useEffect(() => {
    if (left <= 0) {
      onLapse()
      return
    }
    // Never higher than what Rust last said: a window the compositor stopped
    // waking comes back with a clock that owes time, and this is where it pays.
    // Never lower either, because the two clocks round from different phases,
    // and correcting a single second of that would read as the number stumbling.
    const timer = window.setTimeout(() => {
      setLeft((current) => Math.min(current - 1, authoritative.current))
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [left, onLapse])

  const low = left <= LOW_WATER

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="h-1 overflow-hidden rounded-full bg-line">
        <div
          className={`h-full rounded-full transition-[width] duration-1000 ease-linear ${
            low ? 'bg-warn' : 'bg-brand'
          }`}
          style={{ width: `${Math.min(100, (left / lifetime) * 100)}%` }}
        />
      </div>
      <span
        className={`text-center text-ui-xs tabular-nums ${low ? 'text-warn' : 'text-faint'}`}
        aria-live="off"
      >
        {t('remote.expiresIn', { seconds: left })}
      </span>
    </div>
  )
}

/** Where the code was. Nothing broke — the door is still open. */
function Lapsed({ onRenew }: { onRenew: () => void }) {
  return (
    <>
      <div
        className="grid place-items-center rounded-xl border border-dashed border-line-strong bg-control-fill"
        style={{ width: TILE, height: TILE }}
      >
        <div className="flex flex-col items-center gap-2 px-5 text-center">
          <TimerOff
            size={24}
            strokeWidth={1.4}
            className="text-faint opacity-60"
            aria-hidden="true"
          />
          <span className="text-ui-sm text-muted">{t('remote.expired')}</span>
        </div>
      </div>
      <Button variant="secondary" onClick={onRenew}>
        <RefreshCw />
        {t('remote.newCode')}
      </Button>
    </>
  )
}

/**
 * The phones that used a code, and the button that takes one back.
 *
 * Forgetting is what makes a two-minute code worth having: the code is how a
 * device gets in, and this is the only way it stops being in. The button is
 * quiet rather than hidden, because a control that appears on hover is a
 * control most people never learn exists.
 */
function Devices({ devices }: { devices: RemoteDevice[] }) {
  const forget = useRemote((state) => state.forget)

  const confirmForget = async (device: RemoteDevice) => {
    const taken = await ask({
      title: t('remote.confirmForget'),
      body: t('remote.confirmForgetBody'),
      subject: device.label ?? t('remote.unknownDevice'),
      confirm: t('remote.forget'),
    })
    if (taken) await forget(device.id)
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="caption">{t('remote.devices')}</h3>

      {devices.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong px-4 py-5 text-center text-ui-sm text-faint">
          {t('remote.noDevices')}
        </p>
      ) : (
        <ul className="list-card">
          {devices.map((device) => (
            <li key={device.id} className="list-row list-row--roomy">
              <Smartphone
                size={16}
                strokeWidth={1.9}
                className="shrink-0 text-faint"
                aria-hidden="true"
              />

              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-ui-base font-medium text-text">
                  {device.label ?? t('remote.unknownDevice')}
                </span>
                <span className="truncate text-ui-sm text-muted">
                  {t('remote.pairedAgo', { when: when(device.pairedSecondsAgo) })}
                  {' · '}
                  {t('remote.lastSeen', { when: when(device.lastSeenSecondsAgo) })}
                </span>
              </div>

              <IconButton
                variant="danger-ghost"
                icon={Trash2}
                label={t('remote.forget')}
                onClick={() => void confirmForget(device)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** How long ago, coarsely — which is all a list of phones ever needs. */
function when(seconds: number): string {
  if (seconds < 60) return t('when.now')
  if (seconds < 3_600) return t('when.minutes', { count: Math.floor(seconds / 60) })
  if (seconds < 86_400) return t('when.hours', { count: Math.floor(seconds / 3_600) })
  return t('when.days', { count: Math.floor(seconds / 86_400) })
}

/** The closed door: what would happen, and what is stopping it. */
function Closed({ serving, addresses }: { serving: boolean; addresses: string[] }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line-strong px-6 py-10 text-center">
      <Smartphone
        size={24}
        strokeWidth={1.4}
        className="text-faint opacity-60"
        aria-hidden="true"
      />

      {!serving ? (
        <p className="text-ui-base text-muted">{t('remote.needsHarness')}</p>
      ) : addresses.length === 0 ? (
        <p className="text-ui-base text-muted">{t('remote.noNetwork')}</p>
      ) : (
        <>
          <p className="caption">{t('remote.reachableAt')}</p>
          <ul className="flex flex-wrap items-center justify-center gap-2">
            {addresses.map((address) => (
              <li key={address} className={ADDRESS_CHIP}>
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
    <dl className="card grid grid-cols-3 divide-x divide-line">
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
    <div className="flex flex-col gap-1 px-4 py-3">
      <dt className="caption">{label}</dt>
      <dd className={`font-mono text-ui-xl tabular-nums ${tone ?? 'text-text'}`}>{value}</dd>
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
    void reportAction(async () => {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    })
  }

  return (
    <Button variant="secondary" className="self-start" onClick={copy}>
      {copied ? <Check className="text-ok" /> : <Copy />}
      {copied ? t('statusbar.copied') : label}
    </Button>
  )
}
