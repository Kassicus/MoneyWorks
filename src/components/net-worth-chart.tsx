'use client'

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { formatCents } from '@/lib/money'

/**
 * The only Client Component in the app. It receives plain serialisable data and imports
 * nothing but recharts and the money formatter — no database handle, no Clerk, no env.
 * Anything imported here is compiled into the browser bundle.
 *
 * `netWorth` is integer cents, like everything else; `formatCents` is the render boundary.
 */
export function NetWorthChart({ data }: { data: { date: string; netWorth: number }[] }) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <LineChart data={data}>
          <XAxis dataKey="date" tick={{ fontSize: 12 }} minTickGap={40} />
          <YAxis tickFormatter={(v: number) => formatCents(v)} width={90} tick={{ fontSize: 12 }} />
          {/*
            recharts types a tooltip value as `ValueType | undefined` because a chart may
            plot strings or ranges. This one plots `netWorth`, which is always a number; the
            guard is a type accommodation rather than a branch that runs.
          */}
          <Tooltip
            formatter={(v: unknown) => (typeof v === 'number' ? formatCents(v) : String(v ?? ''))}
          />
          {/*
            Dots only when a line cannot be drawn. On day one the series is a single point,
            and a one-point line with `dot={false}` renders an empty chart — the owner's
            first day would look like a bug.
          */}
          <Line type="monotone" dataKey="netWorth" dot={data.length < 3} strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
