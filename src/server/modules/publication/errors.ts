export type PublicationErrorCode = 'invalid_input' | 'invalid_actor' | 'unavailable' | 'forbidden'
  | 'revision_conflict' | 'idempotency_conflict' | 'retryable' | 'service_unavailable' | 'reference_format_required' | 'change_format_required' | 'file_format_required';

const messages: Record<PublicationErrorCode, string> = {
  file_format_required: 'This artifact uses files. Supply artifact-files-v1 with a deliberate complete file_set.',
  invalid_input: 'The publication input is unsupported.',
  reference_format_required: 'This source uses recorded references. Edit with loom-markdown-v2 and an explicit reference list.',
  change_format_required: 'This source uses change metadata. Edit with loom-markdown-v3 and explicit change_note/change_account fields; retain its account declaration or deliberately remove it.',
  invalid_actor: 'A trusted actor context is required.',
  unavailable: 'The publication context is unavailable.',
  forbidden: 'The current actor cannot publish this revision.',
  revision_conflict: 'The current revision differs from the expected revision.',
  idempotency_conflict: 'The attempt key was already used with different input.',
  retryable: 'Retry or reconcile using the same attempt identity.',
  service_unavailable: 'The publication outcome could not be established. Reconcile the same attempt.',
};

/** Internal safe failure; SQL errors and authored input are never copied into it. */
export class PublicationError extends Error {
  constructor(readonly code: PublicationErrorCode, readonly current_revision_id?: string | null) {
    super(messages[code]);
    this.name = 'PublicationError';
  }
}

export function safeError(error: unknown): never {
  if (error instanceof PublicationError) throw error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  throw new PublicationError(['40P01', '40001', '55P03'].includes(String(code)) ? 'retryable' : 'service_unavailable');
}
