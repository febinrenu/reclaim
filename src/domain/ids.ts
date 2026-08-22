/**
 * Branded identifiers. These cost nothing at runtime and prevent the single most
 * common class of bug in a system with this many string keys: passing a transaction
 * id where an event id belongs. Both are opaque strings from an external provider,
 * so the compiler is the only thing that can tell them apart.
 */

declare const TXN: unique symbol
declare const EVENT: unique symbol
declare const CUSTOMER: unique symbol
declare const BATCH: unique symbol
declare const JOB: unique symbol
declare const AUDIT: unique symbol

/** A Razorpay payment id, or an invoice id in the receivables scenario. */
export type TransactionId = string & { readonly [TXN]: true }
/** A Razorpay webhook event id. The idempotency key for ingestion. */
export type EventId = string & { readonly [EVENT]: true }
export type CustomerId = string & { readonly [CUSTOMER]: true }
export type BatchId = string & { readonly [BATCH]: true }
export type JobId = string & { readonly [JOB]: true }
export type AuditId = string & { readonly [AUDIT]: true }

function nonEmpty(s: string, kind: string): string {
  if (typeof s !== 'string' || s.length === 0) {
    throw new TypeError(`${kind} must be a non-empty string, received ${JSON.stringify(s)}`)
  }
  return s
}

export const transactionId = (s: string): TransactionId =>
  nonEmpty(s, 'TransactionId') as TransactionId
export const eventId = (s: string): EventId => nonEmpty(s, 'EventId') as EventId
export const customerId = (s: string): CustomerId => nonEmpty(s, 'CustomerId') as CustomerId
export const batchId = (s: string): BatchId => nonEmpty(s, 'BatchId') as BatchId
export const jobId = (s: string): JobId => nonEmpty(s, 'JobId') as JobId
export const auditId = (s: string): AuditId => nonEmpty(s, 'AuditId') as AuditId
