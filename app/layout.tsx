import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

/*
 * One family, several weights. The reference uses a single heavy neo-grotesque
 * throughout rather than a display/body pairing: closed apertures, an angled `t`
 * terminal, a double-story `a`, and very tight tracking at display sizes. Inter is
 * the closest freely available match, and loading it as a variable font gives the
 * full weight axis, which the design needs because it leans on 400 against 900
 * rather than on two different typefaces.
 *
 * Some design guidance treats Inter as a generic-default warning sign. That applies
 * when an axis is left free and gets spent on a default. Here the typeface is pinned
 * by the reference, so matching it is the correct call.
 *
 * next/font self-hosts at build time, so there is no runtime dependency on Google's
 * CDN during a recorded demo, and no layout shift on a page dense with figures.
 */
const inter = Inter({
  subsets: ['latin'],
  weight: 'variable',
  variable: '--font-inter',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Reclaim',
  description:
    'Risk-aware revenue recovery. Prices every recovery action, including doing nothing.',
  // A demo instance holds only generated data, but there is no reason to be indexed.
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <a
          href="#main"
          className="absolute left-[-9999px] z-50 bg-accent px-3 py-2 text-ink focus:left-4 focus:top-4"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  )
}
