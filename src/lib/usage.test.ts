import { describe, expect, it } from 'vitest'

import type { SessionCard, Tokens } from '@/lib/ipc'
import { bill, byDay, byModel, charge, cost, plus, usageCsv, weigh, type Rates } from '@/lib/usage'

const tokens = (input: number, output = 0, cacheRead = 0, cacheWrite = 0): Tokens => ({
  input,
  output,
  cacheRead,
  cacheWrite,
})

/** A day in the machine's own timezone, so the tests mean the same everywhere. */
const at = (year: number, month: number, day: number, hour = 12): number =>
  new Date(year, month - 1, day, hour).getTime()

const card = (fields: Partial<SessionCard> = {}): SessionCard => ({
  id: 'one',
  project: 'D:\\work',
  started: at(2026, 8, 18),
  touched: at(2026, 8, 18),
  title: 'a session',
  turns: 4,
  models: [],
  tokens: tokens(0),
  byModel: [],
  delegated: false,
  bytes: 0,
  ...fields,
})

describe('weigh', () => {
  it('counts cache traffic, which is spend the user was billed for', () => {
    expect(weigh(tokens(1, 2, 4, 8))).toBe(15)
  })
})

describe('plus', () => {
  it('adds every kind separately', () => {
    expect(plus(tokens(1, 2, 3, 4), tokens(10, 20, 30, 40))).toEqual(tokens(11, 22, 33, 44))
  })
})

describe('cost', () => {
  it('is null for a model nobody has priced, rather than zero', () => {
    expect(cost(tokens(1_000_000), undefined)).toBeNull()
  })

  it('prices each kind of token at its own rate, per million', () => {
    const rate = { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 }

    expect(cost(tokens(1_000_000, 500_000, 2_000_000, 200_000), rate)).toBeCloseTo(
      2 + 4 + 0.4 + 0.5,
    )
  })
})

describe('charge', () => {
  const rates: Rates = { priced: { input: 6, output: 0, cacheRead: 0, cacheWrite: 0 } }

  it('is null when nothing in the set has a price, rather than zero', () => {
    expect(charge([{ model: 'unpriced', tokens: tokens(1_000_000) }], rates)).toBeNull()
  })

  it('counts what it can and says nothing about what it cannot', () => {
    const money = charge(
      [
        { model: 'priced', tokens: tokens(500_000) },
        { model: 'unpriced', tokens: tokens(9_000_000) },
      ],
      rates,
    )

    expect(money).toBeCloseTo(3)
  })
})

describe('byModel', () => {
  it('adds a model up across sessions and counts the sessions it worked in', () => {
    const usage = byModel([
      card({ byModel: [{ model: 'deepseek-chat', tokens: tokens(100, 10) }] }),
      card({
        byModel: [
          { model: 'deepseek-chat', tokens: tokens(200, 20) },
          { model: 'deepseek-reasoner', tokens: tokens(5, 1) },
        ],
      }),
    ])

    expect(usage).toEqual([
      { model: 'deepseek-chat', tokens: tokens(300, 30), sessions: 2 },
      { model: 'deepseek-reasoner', tokens: tokens(5, 1), sessions: 1 },
    ])
  })

  it('puts the heaviest first, whichever session it appeared in', () => {
    const usage = byModel([
      card({
        byModel: [
          { model: 'light', tokens: tokens(1) },
          { model: 'heavy', tokens: tokens(0, 0, 900) },
        ],
      }),
    ])

    expect(usage.map((one) => one.model)).toEqual(['heavy', 'light'])
  })

  it('has nothing to report for logs that never recorded usage', () => {
    expect(byModel([card(), card()])).toEqual([])
  })
})

describe('byDay', () => {
  const now = at(2026, 8, 18)

  it('returns the whole span oldest first, including the days nothing happened on', () => {
    const days = byDay([card({ started: at(2026, 8, 18), tokens: tokens(50) })], 3, {}, now)

    expect(days.map((day) => day.date)).toEqual(['2026-08-16', '2026-08-17', '2026-08-18'])
    expect(days[0]?.tokens).toEqual(tokens(0))
    expect(days[0]?.sessions).toBe(0)
    expect(days[2]?.tokens).toEqual(tokens(50))
  })

  it('adds up the sessions that began on the same local day', () => {
    const days = byDay(
      [
        card({ started: at(2026, 8, 18, 1), tokens: tokens(10) }),
        card({ started: at(2026, 8, 18, 23), tokens: tokens(5) }),
      ],
      2,
      {},
      now,
    )

    expect(days[1]).toEqual({
      date: '2026-08-18',
      tokens: tokens(15),
      cost: null,
      sessions: 2,
    })
  })

  it('drops sessions older than the span, and ones the log gave no start time', () => {
    const days = byDay(
      [
        card({ started: at(2026, 1, 1), tokens: tokens(999) }),
        card({ started: 0, tokens: tokens(999) }),
      ],
      2,
      {},
      now,
    )

    expect(days.every((day) => weigh(day.tokens) === 0)).toBe(true)
  })

  it('prices a day from its own models, and leaves it unpriced when none of them are', () => {
    const rates: Rates = { priced: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 } }
    const days = byDay(
      [
        card({
          started: at(2026, 8, 17),
          tokens: tokens(1_000_000),
          byModel: [{ model: 'unpriced', tokens: tokens(1_000_000) }],
        }),
        card({
          started: at(2026, 8, 18),
          tokens: tokens(2_000_000),
          byModel: [
            { model: 'priced', tokens: tokens(1_000_000) },
            { model: 'unpriced', tokens: tokens(1_000_000) },
          ],
        }),
      ],
      2,
      rates,
      now,
    )

    expect(days[0]?.cost).toBeNull()
    expect(days[1]?.cost).toBeCloseTo(3)
  })
})

describe('bill', () => {
  const rates: Rates = { 'deepseek-chat': { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } }

  it('adds up what is priced and names what is not', () => {
    const statement = bill(
      [
        { model: 'deepseek-chat', tokens: tokens(1_000_000, 1_000_000), sessions: 1 },
        { model: 'deepseek-reasoner', tokens: tokens(1_000_000), sessions: 1 },
      ],
      rates,
    )

    expect(statement.total).toBeCloseTo(10)
    expect(statement.unpriced).toEqual(['deepseek-reasoner'])
  })

  it('does not call a model unpriced when it never spent anything', () => {
    expect(bill([{ model: 'idle', tokens: tokens(0), sessions: 1 }], rates)).toEqual({
      total: 0,
      unpriced: [],
    })
  })
})

describe('usageCsv', () => {
  it('exports every token class, the exact total and blank unknown costs', () => {
    const csv = usageCsv(
      [
        { date: '2026-08-23', sessions: 1, tokens: tokens(1, 2, 3, 4), cost: null },
        { date: '2026-08-24', sessions: 2, tokens: tokens(10, 20, 30, 40), cost: 1.25 },
      ],
      'CNY',
    )

    expect(csv).toContain('date,sessions,input_tokens,output_tokens')
    expect(csv).toContain('2026-08-23,1,1,2,3,4,10,,"CNY"')
    expect(csv).toContain('2026-08-24,2,10,20,30,40,100,1.25,"CNY"')
    expect(csv.endsWith('\r\n')).toBe(true)
  })

  it('prevents a future custom currency label from becoming a spreadsheet formula', () => {
    const csv = usageCsv([], '=IMPORTDATA("https://tracker.example")')
    const one = usageCsv(
      [{ date: '2026-08-24', sessions: 0, tokens: tokens(0), cost: null }],
      '=USD',
    )

    expect(csv).not.toContain('tracker.example')
    expect(one).toContain('"\'=USD"')
  })
})
