export interface LinkRule {
  surface: string;
  note: string;
}

export interface PendingLink extends LinkRule {
  jot_id: string;
}

export interface AliasEntry {
  note: string;
  alias: string;
}

export interface Candidate extends LinkRule {
  forced?: boolean;
}

export function linkRuleKey(surface: string, note: string): string {
  return `${surface} ${note}`;
}

export function notesFor(list: LinkRule[], surface: string): string[] {
  return list
    .filter((rule) => rule.surface === surface)
    .map((rule) => rule.note);
}
