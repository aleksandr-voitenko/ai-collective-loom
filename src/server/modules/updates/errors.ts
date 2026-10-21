const messages = {
  updates_attention_refresh_required: 'Attention settings changed. Refresh attention selection over the same subjects and intervals, or open Complete retrieval.',
  updates_attention_preparing: 'Routine attention selection is still preparing. Continue preparing or refresh attention selection over the same subjects and intervals; Complete retrieval remains available.',
  updates_token_invalid: 'This Updates descriptor does not match its owner, purpose, operation or bound selection.',
  updates_descriptor_expired: 'This Updates view expired. Renew the same retained view and page.',
  updates_state_unavailable: 'The bounded grouping state is unavailable. Exact page recovery cannot be established; explicitly resynchronize.',
  updates_visibility_replay_required: 'Visibility changed. Replay both retained streams, including history before completed lower bounds.',
  updates_shared_history_gap: 'Required shared history is unavailable. Explicit resynchronization cannot reconstruct those events.',
  updates_personal_history_gap: 'Required personal history is unavailable. Explicit resynchronization cannot reconstruct those deliveries.',
  updates_epoch_changed: 'An Updates or component recovery epoch changed. Continuity requires deployment recovery.',
  updates_definition_changed: 'Following changed. Start a new retained-history scope to include newly selected history.',
  updates_capacity: 'The synthetic grouping or custody limit was reached. Narrow oversized scopes; if retained view slots are full, reuse a saved view or wait for expiry. Live views are not evicted.',
  updates_work_limit: 'Updates exceeded a bounded work deadline. Retry the same position; no failed component advanced.',
  updates_view_changed: 'Authority or source state changed during retrieval. Reauthorize the same page.',
};
export class UpdatesError extends Error { constructor(readonly code: keyof typeof messages) { super(messages[code]); } }
