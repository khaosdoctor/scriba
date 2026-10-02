/** A learned surface->note pair: a rejection to skip, or a forced link to always make.
 *  Ordered by (surface, note) wherever it is listed, so an interactive picker can index
 *  into the list by position and re-derive the same order on each tap. */
export interface LinkRule {
  surface: string;
  note: string;
}

/** An ambiguous link question waiting on a button tap. */
export interface PendingLink {
  jot_id: string;
  surface: string;
  note: string;
}
