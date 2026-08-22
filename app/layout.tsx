import type { Metadata } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans, Big_Shoulders } from 'next/font/google'
import './globals.css'

/*
 * Fonts go through next/font rather than a stylesheet link, for two reasons that
 * both matter here. It self-hosts the files at build time, so the demo has no
 * runtime dependency on fonts.googleapis.com being reachable. And it eliminates
 * the layout shift that a late-arriving font causes, which is very visible on a
 * dense table of figures.
 *
 * The pairing is deliberate. A condensed grotesque for labels against a monospace
 * for data avoids defaulting to one mono everywhere, which is the single most
 * overused signal of the terminal aesthetic.
 */
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
})

const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-sans',
  display: 'swap',
})

// Google renamed this family from Big_Shoulders_Display to Big_Shoulders. It is a
// variable font, so the weight axis is requested as a range rather than a list.
const bigShoulders = Big_Shoulders({
  subsets: ['latin'],
  weight: 'variable',
  variable: '--font-big-shoulders',
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
    <html
      lang="en"
      className={`${plexMono.variable} ${plexSans.variable} ${bigShoulders.variable}`}
    >
      <body>
        <a
          href="#main"
          className="absolute left-[-9999px] focus:left-2 focus:top-2 focus:z-50 focus:bg-surface focus:px-3 focus:py-2 focus:text-fg"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  )
}
