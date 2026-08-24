import { useEffect, useMemo, useState } from 'react'
import { save as pickPath } from '@tauri-apps/plugin-dialog'
import { Check, Coins, Download, Pencil, Wallet } from 'lucide-react'

import { Empty } from '@/components/Empty'
import { TabButton } from '@/components/TabButton'
import { count, day } from '@/lib/format'
import { describe } from '@/lib/errors'
import { t } from '@/lib/i18n'
import * as ipc from '@/lib/ipc'
import type { MessageKey } from '@/lib/i18n'
import type { SessionCard } from '@/lib/ipc'
import {
  bill,
  byDay,
  byModel,
  charge,
  cost,
  usageCsv,
  weigh,
  type DayUsage,
  type ModelUsage,
  type Rate,
  type Rates,
} from '@/lib/usage'
import { SYMBOL, useRates, type Currency } from '@/state/rates'
import { showError } from '@/state/dialog'
import { spent } from '@/state/sessions'

/** How far back a statement can look. Days, because that is what a bar is. */
const SPANS: { days: number; label: MessageKey }[] = [
  { days: 7, label: 'usage.span.week' },
  { days: 30, label: 'usage.span.month' },
  { days: 90, label: 'usage.span.quarter' },
]

/** Enough to see who the heavy sessions are, few enough to read at a glance. */
const TOP = 8

const CURRENCIES: Currency[] = ['CNY', 'USD']

/** Which fields a price has, in the order somebody would read them off a page. */
const FIELDS: { key: keyof Rate; label: MessageKey }[] = [
  { key: 'input', label: 'sessions.input' },
  { key: 'output', label: 'sessions.output' },
  { key: 'cacheRead', label: 'sessions.cached' },
  { key: 'cacheWrite', label: 'usage.cacheWrite' },
]

/**
 * A statement, drawn from the logs that were already on the disk.
 *
 * The harness records what every turn cost in tokens and then never mentions it
 * again, which means the one question everybody asks — "what have I spent?" —
 * has no answer anywhere on the machine. This is that answer, cut three ways,
 * because the three are asked for different reasons: by day tells you whether
 * this month is worse than last, by model tells you which one to stop reaching
 * for, and by session tells you which piece of work was the expensive one.
 *
 * Money is the part that cannot be read off the disk. No log records what the
 * user's contract charges, a published price list is wrong for somebody on the
 * day it ships, and inventing a number here would be worse than having none. So
 * a price is asked for once per model and remembered, everything is counted in
 * tokens until then, and a model with no price is named as uncounted rather
 * than folded into a total that would look complete and be short.
 */
export function UsageReport({
  cards,
  onOpen,
}: {
  cards: SessionCard[]
  onOpen: (id: string) => void
}) {
  const rates = useRates((state) => state.rates)
  const currency = useRates((state) => state.currency)
  const choose = useRates((state) => state.choose)
  const monthlyBudget = useRates((state) => state.monthlyBudget)
  const setBudget = useRates((state) => state.setBudget)

  const [span, setSpan] = useState(30)
  /** The model whose price is being typed, if one is. */
  const [editing, setEditing] = useState<string | null>(null)
  const [budgetDraft, setBudgetDraft] = useState(() => String(monthlyBudget ?? ''))
  const [exported, setExported] = useState(false)

  const symbol = SYMBOL[currency]

  // The span is the statement, not just the chart: switching to 7 days should
  // answer "what did this week cost", including which model did it.
  const within = useMemo(() => {
    const today = new Date()
    const floor = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - (span - 1),
    ).getTime()
    return cards.filter((card) => card.started >= floor)
  }, [cards, span])

  const models = useMemo(() => byModel(within), [within])
  const days = useMemo(() => byDay(within, span, rates), [within, span, rates])
  const statement = useMemo(() => bill(models, rates), [models, rates])
  const tokens = useMemo(() => spent(within), [within])
  const month = useMemo(() => {
    const today = new Date()
    const floor = new Date(today.getFullYear(), today.getMonth(), 1).getTime()
    const ceiling = new Date(today.getFullYear(), today.getMonth() + 1, 1).getTime()
    const cardsThisMonth = cards.filter((card) => card.started >= floor && card.started < ceiling)
    return bill(byModel(cardsThisMonth), rates)
  }, [cards, rates])

  const total = weigh(tokens)
  // A priced model can still cost exactly zero when all of this span's tokens
  // happened to use a zero-priced class (for example cached input). Presence
  // of a user rate, not a positive bill, is what makes the amount known.
  const priced = models.some((model) => rates[model.model] !== undefined)
  // Everything that spent anything has a price, so money is a complete unit and
  // the chart and the ranking can use it. While one model is still unpriced they
  // stay in tokens: a bar drawn from a partial cost is a bar that is wrong by an
  // amount nobody can see, and a ranking by it puts the cheap-looking session on
  // top because nobody has priced the model it ran on.
  const settled = models.length > 0 && statement.unpriced.length === 0
  const budgetComplete = month.unpriced.length === 0

  useEffect(() => {
    if (!exported) return
    const timer = window.setTimeout(() => setExported(false), 1_400)
    return () => window.clearTimeout(timer)
  }, [exported])

  const commitBudget = () => {
    const value = Number(budgetDraft)
    const next = Number.isFinite(value) && value > 0 ? value : null
    setBudget(next)
    setBudgetDraft(String(next ?? ''))
  }

  const exportTrend = async () => {
    try {
      const last = days.at(-1)?.date ?? new Date().toISOString().slice(0, 10)
      const path = await pickPath({
        title: t('usage.exportTitle'),
        defaultPath: `dsh-usage-${last}-${span}d.csv`,
        filters: [{ name: t('usage.exportKind'), extensions: ['csv'] }],
      })
      if (!path) return
      await ipc.sessionSave(path, usageCsv(days, currency))
      setExported(true)
    } catch (cause) {
      showError({
        title: t('usage.exportFailed'),
        body: t('usage.exportFailedBody'),
        details: describe(cause),
        close: t('dialog.error.close'),
        copy: t('dialog.error.copy'),
        copied: t('dialog.error.copied'),
      })
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <div className="flex items-center gap-0.5 rounded-control bg-canvas-deep p-0.5 hairline">
          {SPANS.map((choice) => (
            <TabButton
              key={choice.days}
              label={t(choice.label)}
              active={span === choice.days}
              onClick={() => setSpan(choice.days)}
            />
          ))}
        </div>

        <label className="ml-auto flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2 text-[10.5px] text-faint">
          {t('usage.monthlyBudget')}
          <span>{symbol}</span>
          <input
            type="number"
            min={0}
            step="1"
            inputMode="decimal"
            value={budgetDraft}
            onChange={(event) => setBudgetDraft(event.target.value)}
            onBlur={commitBudget}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
            placeholder={t('usage.noBudget')}
            className="w-16 bg-transparent text-[11px] text-text tabular-nums outline-none placeholder:text-faint"
          />
        </label>

        <button
          type="button"
          onClick={() => void exportTrend()}
          data-hint={t('usage.export')}
          aria-label={t('usage.export')}
          className="grid size-7 place-items-center rounded-control border border-line text-faint hover:bg-surface-2 hover:text-text"
        >
          {exported ? (
            <Check size={13} className="text-ok" aria-hidden="true" />
          ) : (
            <Download size={13} aria-hidden="true" />
          )}
        </button>

        <div
          className="flex items-center gap-0.5 rounded-control bg-canvas-deep p-0.5 hairline"
          data-hint={t('usage.currency')}
        >
          {CURRENCIES.map((one) => (
            <TabButton
              key={one}
              label={`${SYMBOL[one]} ${one}`}
              active={currency === one}
              onClick={() => choose(one)}
            />
          ))}
        </div>
      </div>

      {total === 0 ? (
        <Empty icon={Coins} message={t('usage.empty')} hint={t('usage.emptyHint')} />
      ) : (
        <div className="flex flex-col gap-4 p-4">
          <Headline
            money={priced ? statement.total : null}
            symbol={symbol}
            tokens={total}
            sessions={within.length}
          />

          {monthlyBudget !== null && (
            <Budget
              spent={month.total}
              budget={monthlyBudget}
              complete={budgetComplete}
              symbol={symbol}
            />
          )}

          {statement.unpriced.length > 0 && (
            <Short models={statement.unpriced} onPrice={(model) => setEditing(model)} />
          )}

          <Daily days={days} symbol={symbol} money={settled} />

          <Models
            models={models}
            rates={rates}
            symbol={symbol}
            heaviest={total}
            editing={editing}
            onEdit={setEditing}
          />

          <Costliest
            cards={within}
            rates={rates}
            symbol={symbol}
            settled={settled}
            onOpen={onOpen}
          />
        </div>
      )}
    </div>
  )
}

function Budget({
  spent,
  budget,
  complete,
  symbol,
}: {
  spent: number
  budget: number
  complete: boolean
  symbol: string
}) {
  const share = complete ? spent / budget : null
  const tone =
    share === null
      ? 'border-line bg-surface'
      : share >= 1
        ? 'border-danger/30 bg-danger/[0.07]'
        : share >= 0.8
          ? 'border-warn/30 bg-warn/[0.07]'
          : 'border-ok/25 bg-ok/[0.05]'
  const message =
    share === null
      ? t('usage.budgetUnknown')
      : share >= 1
        ? t('usage.budgetOver', { spent: cash(spent, symbol), budget: cash(budget, symbol) })
        : t('usage.budgetStatus', {
            spent: cash(spent, symbol),
            budget: cash(budget, symbol),
            percent: String(Math.round(share * 100)),
          })

  return (
    <section className={`rounded-panel border px-3 py-2 ${tone}`}>
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span className="font-medium text-text">{t('usage.monthBudgetStatus')}</span>
        <span className={share !== null && share >= 1 ? 'text-danger' : 'text-muted'}>
          {message}
        </span>
      </div>
      {share !== null && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
          <span
            className={
              share >= 1
                ? 'block h-full bg-danger'
                : share >= 0.8
                  ? 'block h-full bg-warn'
                  : 'block h-full bg-ok'
            }
            style={{ width: `${Math.min(share * 100, 100)}%` }}
          />
        </div>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */

/** The four numbers somebody came here for, before any of the detail. */
function Headline({
  money,
  symbol,
  tokens,
  sessions,
}: {
  money: number | null
  symbol: string
  tokens: number
  sessions: number
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Card
        label={t('usage.total')}
        value={money === null ? '—' : cash(money, symbol)}
        note={money === null ? t('usage.unpriced') : undefined}
        lead
      />
      <Card label={t('usage.tokens')} value={count(tokens)} />
      <Card label={t('usage.sessions')} value={String(sessions)} />
      <Card
        label={t('usage.perSession')}
        value={
          sessions === 0
            ? '—'
            : money === null
              ? count(Math.round(tokens / sessions))
              : cash(money / sessions, symbol)
        }
      />
    </div>
  )
}

function Card({
  label,
  value,
  note,
  lead = false,
}: {
  label: string
  value: string
  note?: string
  lead?: boolean
}) {
  return (
    <div className="rounded-panel border border-line bg-surface px-3 py-2.5">
      <p className="text-[10.5px] tracking-[0.04em] text-faint uppercase">{label}</p>
      <p
        className={[
          'mt-1.5 truncate text-[19px] leading-none font-semibold tabular-nums',
          lead ? 'text-brand' : 'text-text',
        ].join(' ')}
      >
        {value}
      </p>
      {note && <p className="mt-1 text-[10.5px] leading-none text-faint">{note}</p>}
    </div>
  )
}

/** Which models the total is short by — said plainly, with the way to fix it. */
function Short({ models, onPrice }: { models: string[]; onPrice: (model: string) => void }) {
  return (
    <div className="flex items-center gap-2 rounded-panel border border-warn/25 bg-warn/[0.07] px-3 py-2">
      <Wallet size={13} strokeWidth={2.1} className="shrink-0 text-warn" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate text-[11.5px] text-muted" data-hint={models.join(', ')}>
        {t('usage.short', { models: models.map(named).join('、') })}
      </p>
      <button
        type="button"
        data-hint={t('usage.shortHint')}
        onClick={() => {
          const first = models[0]
          if (first !== undefined) onPrice(first)
        }}
        className="shrink-0 text-[11.5px] text-brand transition-opacity duration-100 hover:opacity-75"
      >
        {t('usage.priceThem')}
      </button>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * Every day in the span as one bar, including the empty ones.
 *
 * Bars measure money only once every model has a price, and tokens until then;
 * the heading says which, because a chart whose unit quietly changed under the
 * reader is worse than no chart. The empty days stay in: leaving them out would
 * space the remaining ones evenly and turn a fortnight away from the desk into
 * a flat week of work.
 */
function Daily({ days, symbol, money }: { days: DayUsage[]; symbol: string; money: boolean }) {
  const values = days.map((one) => (money ? (one.cost ?? 0) : weigh(one.tokens)))
  const ceiling = Math.max(...values, 0)

  return (
    <section className="rounded-panel border border-line bg-surface px-3 pt-2.5 pb-2">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h3 className="text-[11.5px] font-semibold text-text">{t('usage.daily')}</h3>
        <span className="text-[10.5px] text-faint">
          {money ? t('usage.dailyMoney') : t('usage.dailyTokens')}
        </span>
      </div>

      {ceiling === 0 ? (
        <p className="py-6 text-center text-[11.5px] text-faint">{t('usage.dailyEmpty')}</p>
      ) : (
        <>
          <div className="flex h-28 items-end gap-[2px]">
            {days.map((one, index) => {
              const value = values[index] ?? 0
              return (
                <div
                  key={one.date}
                  data-hint={`${one.date} · ${count(weigh(one.tokens))} tokens${
                    one.cost === null ? '' : ` · ${cash(one.cost, symbol)}`
                  }`}
                  className="group flex h-full min-w-0 flex-1 items-end"
                >
                  {value > 0 ? (
                    <span
                      // Percent of the tallest, so the shape is the comparison
                      // and no bar needs a number printed on it.
                      style={{ height: `${Math.max((value / ceiling) * 100, 3)}%` }}
                      className="w-full rounded-t-[2px] bg-brand/55 transition-colors duration-100 group-hover:bg-brand"
                    />
                  ) : (
                    <span className="h-px w-full bg-line-strong" />
                  )}
                </div>
              )
            })}
          </div>

          <div className="mt-1.5 flex justify-between text-[10.5px] text-faint tabular-nums">
            <span>{days[0]?.date}</span>
            <span>{days[days.length - 1]?.date}</span>
          </div>
        </>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */

interface ModelsProps {
  models: ModelUsage[]
  rates: Rates
  symbol: string
  /** Every token in the span, so each row can say what share of it it was. */
  heaviest: number
  editing: string | null
  onEdit: (model: string | null) => void
}

/** Who spent it, and what that comes to once somebody says what they charge. */
function Models({ models, rates, symbol, heaviest, editing, onEdit }: ModelsProps) {
  return (
    <section className="overflow-hidden rounded-panel border border-line bg-surface">
      <h3 className="border-b border-line px-3 py-2 text-[11.5px] font-semibold text-text">
        {t('usage.byModel')}
      </h3>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[11.5px] tabular-nums">
          <thead>
            <tr className="text-[10.5px] tracking-[0.04em] text-faint uppercase">
              <th className="px-3 py-1.5 text-left font-medium">{t('usage.model')}</th>
              <th className="px-3 py-1.5 text-right font-medium">{t('usage.share')}</th>
              <th className="px-3 py-1.5 text-right font-medium">{t('sessions.input')}</th>
              <th className="px-3 py-1.5 text-right font-medium">{t('sessions.output')}</th>
              <th className="px-3 py-1.5 text-right font-medium">{t('sessions.cached')}</th>
              <th className="px-3 py-1.5 text-right font-medium">{t('usage.cost')}</th>
              <th className="w-8 px-3 py-1.5" />
            </tr>
          </thead>

          <tbody>
            {models.map((one) => {
              const money = cost(one.tokens, rates[one.model])
              const open = editing === one.model

              return (
                <Row
                  key={one.model}
                  model={one.model}
                  share={heaviest === 0 ? 0 : weigh(one.tokens) / heaviest}
                  usage={one}
                  money={money}
                  symbol={symbol}
                  open={open}
                  onToggle={() => onEdit(open ? null : one.model)}
                />
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Row({
  model,
  share,
  usage,
  money,
  symbol,
  open,
  onToggle,
}: {
  model: string
  share: number
  usage: ModelUsage
  money: number | null
  symbol: string
  open: boolean
  onToggle: () => void
}) {
  return (
    <>
      <tr className="border-t border-line/70 transition-colors duration-100 hover:bg-surface-2/45">
        <td className="max-w-[220px] truncate px-3 py-1.5 font-mono text-[11px] text-text">
          {named(model)}
        </td>
        <td className="px-3 py-1.5 text-right">
          <span className="inline-flex items-center gap-1.5">
            {/* The bar is the column: percentages of a total this size are read
                by comparing lengths, not by reading four decimal numbers. */}
            <span aria-hidden="true" className="h-1 w-10 overflow-hidden rounded-full bg-line">
              <span
                style={{ width: `${Math.round(share * 100)}%` }}
                className="block h-full rounded-full bg-brand/70"
              />
            </span>
            <span className="w-8 text-right text-faint">{Math.round(share * 100)}%</span>
          </span>
        </td>
        <td className="px-3 py-1.5 text-right text-muted">{count(usage.tokens.input)}</td>
        <td className="px-3 py-1.5 text-right text-muted">{count(usage.tokens.output)}</td>
        <td className="px-3 py-1.5 text-right text-muted">{count(usage.tokens.cacheRead)}</td>
        <td
          className={['px-3 py-1.5 text-right', money === null ? 'text-faint' : 'text-text'].join(
            ' ',
          )}
        >
          {money === null ? t('usage.unpriced') : cash(money, symbol)}
        </td>
        <td className="px-3 py-1.5 text-right">
          <button
            type="button"
            aria-expanded={open}
            data-hint={t('usage.setPrice')}
            aria-label={t('usage.setPrice')}
            onClick={onToggle}
            className={[
              'grid size-[19px] place-items-center rounded-control transition-colors duration-100',
              open ? 'bg-surface-2 text-text' : 'text-faint hover:bg-surface-2 hover:text-text',
            ].join(' ')}
          >
            <Pencil size={11} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </td>
      </tr>

      {open && (
        <tr className="border-t border-line/70 bg-canvas-deep/40">
          <td colSpan={7} className="px-3 py-3">
            <Editor model={model} symbol={symbol} onDone={onToggle} />
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * Four boxes and a price.
 *
 * Written straight through to the store on every keystroke rather than behind a
 * save button, so the row above and the total above that move while the number
 * is being typed — which is the fastest way to find out that a rate was entered
 * per thousand instead of per million.
 */
function Editor({ model, symbol, onDone }: { model: string; symbol: string; onDone: () => void }) {
  const rate = useRates((state) => state.rates[model])
  const price = useRates((state) => state.price)
  const forget = useRates((state) => state.forget)

  // Text rather than numbers, so a half-typed "0." survives being echoed back.
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map(({ key }) => [key, String(rate?.[key] ?? '')])),
  )

  const set = (key: keyof Rate, text: string) => {
    const next = { ...draft, [key]: text }
    setDraft(next)
    price(model, {
      input: Number(next.input) || 0,
      output: Number(next.output) || 0,
      cacheRead: Number(next.cacheRead) || 0,
      cacheWrite: Number(next.cacheWrite) || 0,
    })
  }

  const clear = () => {
    setDraft(Object.fromEntries(FIELDS.map(({ key }) => [key, ''])))
    forget(model)
    onDone()
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-faint">{t('usage.priceTitle', { model: named(model) })}</p>

      <div className="flex flex-wrap items-end gap-2">
        {FIELDS.map(({ key, label }) => (
          <label key={key} className="flex flex-col gap-1">
            <span className="text-[10.5px] text-faint">{t(label)}</span>
            <span className="flex h-[26px] items-center rounded-control border border-line bg-canvas px-1.5 focus-within:border-brand">
              <span className="mr-1 text-[11px] text-faint">{symbol}</span>
              <input
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={draft[key] ?? ''}
                onChange={(event) => set(key, event.target.value)}
                placeholder="0"
                className="w-[68px] bg-transparent text-[11.5px] text-text tabular-nums outline-none placeholder:text-faint"
              />
            </span>
          </label>
        ))}

        <span className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={clear}
            className="h-[26px] rounded-control border border-line px-2.5 text-[11.5px] text-muted transition-colors duration-100 hover:border-line-strong hover:bg-surface-2 hover:text-text"
          >
            {t('usage.clearPrice')}
          </button>
          <button
            type="button"
            onClick={onDone}
            className="h-[26px] rounded-control bg-brand px-2.5 text-[11.5px] font-medium text-on-brand transition-opacity duration-100 hover:opacity-90"
          >
            {t('usage.done')}
          </button>
        </span>
      </div>

      <p className="text-[10.5px] text-faint">{t('usage.priceHint')}</p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

/** The sessions worth looking at again, and a way straight into them. */
function Costliest({
  cards,
  rates,
  symbol,
  settled,
  onOpen,
}: {
  cards: SessionCard[]
  rates: Rates
  symbol: string
  /** Every model has a price, so money is a scale every session can be put on. */
  settled: boolean
  onOpen: (id: string) => void
}) {
  const ranked = useMemo(() => {
    // Tokens until every model is priced. Ranking a half-priced shelf by money
    // would compare a session's yuan against another session's token count and
    // put whichever ran on the unpriced model at the top of the list.
    const scored = cards.map((card) => ({ card, money: charge(card.byModel, rates) }))
    return scored
      .sort((left, right) =>
        settled
          ? (right.money ?? 0) - (left.money ?? 0)
          : weigh(right.card.tokens) - weigh(left.card.tokens),
      )
      .slice(0, TOP)
  }, [cards, rates, settled])

  if (ranked.length === 0) return null

  return (
    <section className="overflow-hidden rounded-panel border border-line bg-surface">
      <h3 className="border-b border-line px-3 py-2 text-[11.5px] font-semibold text-text">
        {t('usage.top')}
      </h3>

      <ul>
        {ranked.map(({ card, money }) => (
          <li key={card.id}>
            <button
              type="button"
              onClick={() => onOpen(card.id)}
              className="flex w-full items-baseline gap-3 border-t border-line/70 px-3 py-2 text-left transition-colors duration-100 hover:bg-surface-2/45"
            >
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-text">
                {card.title || t('sessions.untitled')}
              </span>
              {card.started > 0 && (
                <span className="shrink-0 text-[10.5px] text-faint tabular-nums">
                  {day(new Date(card.started).toISOString())}
                </span>
              )}
              <span className="w-16 shrink-0 text-right text-[11px] text-faint tabular-nums">
                {count(weigh(card.tokens))}
              </span>
              <span className="w-20 shrink-0 text-right text-[11.5px] text-text tabular-nums">
                {money === null ? '—' : cash(money, symbol)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* -------------------------------------------------------------------------- */

/** Older logs recorded usage without saying who did it; say so rather than blank. */
const named = (model: string): string => model || t('usage.unnamed')

/**
 * Money, to the cent.
 *
 * A spend under a cent rounds to `0.00`, which reads as free, so it is written
 * as the bound it is under instead. Nothing here converts currencies — the
 * symbol is the one the rates were typed in.
 */
function cash(value: number, symbol: string): string {
  if (value > 0 && value < 0.01) return `${symbol}<0.01`

  return `${symbol}${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}
