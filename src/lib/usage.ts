/**
 * A shelf of sessions, folded into a statement.
 *
 * Three questions, and they are not the same question: which model spent it,
 * which day it went, and what that comes to in money. The first two are facts
 * the logs already carry. The third is not — no log records what the user's
 * contract charges, and no provider's public price list stays true for long —
 * so money is only ever computed from a rate the user set themselves, and a
 * model with no rate is reported as unpriced rather than quietly counted as
 * free.
 *
 * Days are the user's own local days, not UTC ones. Somebody asking what they
 * spent yesterday means the yesterday they lived through.
 */
import type { SessionCard, Spend, Tokens } from '@/lib/ipc'

/** Every provider quotes a price per million tokens, so a rate is one too. */
const MILLION = 1_000_000

/** What a model costs, in money per million tokens. */
export interface Rate {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Rates by model name. A model missing from this is a model with no price. */
export type Rates = Record<string, Rate>

/** What one model was asked for, across every session on the shelf. */
export interface ModelUsage {
  model: string
  tokens: Tokens
  /** Sessions this model did some of the work in. */
  sessions: number
}

/** One day of it. */
export interface DayUsage {
  /** `YYYY-MM-DD`, in the user's own timezone. */
  date: string
  tokens: Tokens
  /** What the priced models came to, or null when none of the day's are priced. */
  cost: number | null
  sessions: number
}

/** A statement: what it comes to, and what could not be priced. */
export interface Bill {
  total: number
  /** Models that spent something and have no rate, so the total is short by them. */
  unpriced: string[]
}

export const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

export const plus = (left: Tokens, right: Tokens): Tokens => ({
  input: left.input + right.input,
  output: left.output + right.output,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
})

/** Every token, of every kind — the one number a bar chart can be drawn from. */
export const weigh = (tokens: Tokens): number =>
  tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite

/** What a spend cost, or null when nobody has said what the model charges. */
export function cost(tokens: Tokens, rate: Rate | undefined): number | null {
  if (!rate) return null

  return (
    (tokens.input * rate.input +
      tokens.output * rate.output +
      tokens.cacheRead * rate.cacheRead +
      tokens.cacheWrite * rate.cacheWrite) /
    MILLION
  )
}

/**
 * What a set of per-model spends came to, or null when none of them are priced.
 *
 * Null and zero are different answers and are kept different all the way up: a
 * session that ran entirely on an unpriced model has an unknown cost, and
 * showing that as `0.00` would be the machine making something up.
 */
export function charge(spends: Spend[], rates: Rates): number | null {
  let money: number | null = null

  for (const spend of spends) {
    const share = cost(spend.tokens, rates[spend.model])
    if (share !== null) money = (money ?? 0) + share
  }

  return money
}

/** Who spent what, heaviest first. */
export function byModel(cards: SessionCard[]): ModelUsage[] {
  const tally = new Map<string, ModelUsage>()

  for (const card of cards) {
    for (const spend of card.byModel) {
      const running = tally.get(spend.model) ?? { model: spend.model, tokens: zero(), sessions: 0 }
      tally.set(spend.model, {
        model: spend.model,
        tokens: plus(running.tokens, spend.tokens),
        sessions: running.sessions + 1,
      })
    }
  }

  return [...tally.values()].sort((left, right) => weigh(right.tokens) - weigh(left.tokens))
}

/**
 * The last `span` days, oldest first, including the ones nothing happened on.
 *
 * The empty days are the point: a chart drawn only from the days that have data
 * spaces them evenly and turns a fortnight off into a flat week of work.
 *
 * A session is counted on the day it began. One that ran past midnight is rare,
 * and splitting it would need per-message usage the log does not report.
 */
export function byDay(
  cards: SessionCard[],
  span: number,
  rates: Rates = {},
  now: number = Date.now(),
): DayUsage[] {
  const tally = new Map<string, DayUsage>()

  for (const card of cards) {
    if (card.started <= 0) continue

    const date = stamp(new Date(card.started))
    const running = tally.get(date) ?? { date, tokens: zero(), cost: null, sessions: 0 }
    const share = charge(card.byModel, rates)
    const money = share === null ? running.cost : (running.cost ?? 0) + share

    tally.set(date, {
      date,
      tokens: plus(running.tokens, card.tokens),
      cost: money,
      sessions: running.sessions + 1,
    })
  }

  const today = new Date(now)
  const days: DayUsage[] = []

  for (let back = span - 1; back >= 0; back -= 1) {
    // Built from the parts rather than by subtracting milliseconds, so the two
    // days a year that are not 24 hours long still land on themselves.
    const date = stamp(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back))
    days.push(tally.get(date) ?? { date, tokens: zero(), cost: null, sessions: 0 })
  }

  return days
}

/** Add the priced models up, and name the ones that could not be. */
export function bill(usage: ModelUsage[], rates: Rates): Bill {
  let total = 0
  const unpriced: string[] = []

  for (const one of usage) {
    const money = cost(one.tokens, rates[one.model])
    if (money === null) {
      if (weigh(one.tokens) > 0) unpriced.push(one.model)
      continue
    }
    total += money
  }

  return { total, unpriced }
}

/** A spreadsheet-safe daily statement with facts only, never inferred prices. */
export function usageCsv(days: DayUsage[], currency: string): string {
  const rows = [
    [
      'date',
      'sessions',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'total_tokens',
      'cost',
      'currency',
    ].join(','),
  ]
  for (const one of days) {
    rows.push(
      [
        one.date,
        one.sessions,
        one.tokens.input,
        one.tokens.output,
        one.tokens.cacheRead,
        one.tokens.cacheWrite,
        weigh(one.tokens),
        one.cost ?? '',
        csvCell(currency),
      ].join(','),
    )
  }
  return `${rows.join('\r\n')}\r\n`
}

/** Keep future currency labels from becoming spreadsheet formulas or columns. */
function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value
  return `"${safe.replaceAll('"', '""')}"`
}

/** A local calendar day, as the key a tally is kept under. */
function stamp(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  return `${at.getFullYear()}-${month}-${day}`
}
