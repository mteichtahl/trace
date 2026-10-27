import { useEffect, useState } from 'react'

/** The current time, ticking every `ms` (for countdowns and "12 min so far"). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}
