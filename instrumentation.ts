/**
 * Next runs register() once per server process, before handling any request.
 *
 * Everything Node-specific lives in src/server/boot.ts behind a dynamic import,
 * because this file is compiled for the Edge runtime as well and a static reference
 * to process.stdout would fail that compilation regardless of runtime guards.
 *
 * From D2 this also applies migrations and loads seeds. From D6 it starts the
 * embedded worker loop, which is what lets `npm run dev` be the only command a
 * stranger needs to run.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { boot } = await import('@/server/boot')
  boot()
}
