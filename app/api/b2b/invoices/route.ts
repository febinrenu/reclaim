/**
 * `POST /api/b2b/invoices` — the B2B receivables scenario's real, live
 * surface. Closes `docs/adr/0007`'s named gap: `decide()`/`computeEv`/
 * `evaluateRisk`/the audit schema generalizing to a second scenario was,
 * until now, provable only through the offline simulator and training
 * scripts, never through a route a real request could reach. See
 * `src/app/b2b/process-invoice-event.ts` for the full pipeline and why it
 * doesn't replicate `process-event.ts`'s crash-recovery matrix (there is no
 * external event source or claimed job here to crash mid-way through).
 *
 * Real database writes on every call (a real `transactions` row, a real
 * `action_attempts` intent, a real `recovery_audit` row) — unauthenticated,
 * so rate-limited the same way `/api/batches` already is.
 */
import { z } from 'zod'
import { getDeps } from '@/server/di'
import { processB2bInvoiceEvent } from '@/app/b2b/process-invoice-event'
import { checkRateLimit, clientKeyFrom } from '@/app/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const B2B_RATE_LIMIT = 30
const B2B_RATE_WINDOW_SECONDS = 300

const RequestSchema = z.object({
  eventId: z.string().min(1),
  invoiceId: z.string().min(1),
  customerId: z.string().min(1),
  amountPaise: z.number().int().positive(),
  daysOverdue: z.number().int().min(0),
  billingAddressMismatch: z.boolean().optional(),
  optedOut: z.boolean().optional(),
  paid: z.boolean().optional(),
})

export async function POST(req: Request): Promise<Response> {
  const deps = await getDeps()

  const rateLimit = await checkRateLimit(deps.kv, 'b2b-invoices', clientKeyFrom(req), B2B_RATE_LIMIT, B2B_RATE_WINDOW_SECONDS)
  if (!rateLimit.allowed) {
    return new Response('rate limit exceeded, try again shortly', {
      status: 429,
      headers: { 'retry-after': String(rateLimit.retryAfterSeconds) },
    })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return new Response('malformed JSON body', { status: 400 })
  }

  const parsed = RequestSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'invalid request body', issues: parsed.error.issues }, { status: 400 })
  }

  const result = await processB2bInvoiceEvent(deps, parsed.data)
  return Response.json(result, { status: result.duplicate ? 200 : 201 })
}
