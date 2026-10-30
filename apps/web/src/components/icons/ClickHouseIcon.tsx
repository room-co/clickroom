import type { SVGProps } from 'react'

/**
 * ClickHouse brick-logo mark. Colors are literal (`#f00` / `#fc0`) since this
 * is a brand mark, not a monochrome icon — do not swap to `currentColor`.
 */
export function ClickHouseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 9 8" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
      <path d="m0 7h1v1h-1z" fill="#f00" />
      <path d="m0 0h1v7h-1zm2 0h1v8h-1zm2 0h1v8h-1zm2 0h1v8h-1zm2 3.25h1v1.5h-1z" fill="#fc0" />
    </svg>
  )
}
