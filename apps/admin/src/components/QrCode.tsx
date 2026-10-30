import qrcode from 'qrcode-generator'
import { useMemo } from 'react'

/**
 * Minimal client-side QR renderer for the TOTP enrollment screen. `qrcode-generator` is a
 * ~10kb, dependency-free pure-JS encoder (ships its own `.d.ts`) — chosen over heavier
 * canvas/image-based QR libraries since all that's needed here is a module matrix to paint as an
 * inline SVG. QR codes need real light/dark contrast to scan reliably, so this always renders
 * black-on-white regardless of the app's dark theme (the app's `login-2fa-enroll.tsx` also renders
 * the base32 secret as a manually-typed-in fallback per the spec, for anyone whose scanner
 * struggles with an embedded QR).
 */
export function QrCode({ value, size = 192 }: { value: string; size?: number }) {
  const { moduleCount, isDark } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(value)
    qr.make()
    const count = qr.getModuleCount()
    return { moduleCount: count, isDark: (row: number, col: number) => qr.isDark(row, col) }
  }, [value])

  const cell = size / moduleCount
  const rects: React.ReactNode[] = []
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (isDark(row, col)) {
        rects.push(
          <rect
            key={`${row}-${col}`}
            x={col * cell}
            y={row * cell}
            width={cell}
            height={cell}
            fill="#000000"
          />,
        )
      }
    }
  }

  return (
    <svg
      role="img"
      aria-label="Authenticator app QR code"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="rounded-md bg-white p-2"
    >
      <rect x={0} y={0} width={size} height={size} fill="#ffffff" />
      {rects}
    </svg>
  )
}
