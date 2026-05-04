import { invoke } from "@tauri-apps/api/core";

export interface DraftFrontmatter {
  status: string;
  title: string;
  slug: string;
  created_at: string;
  updated_at: string;
  llm_calls: number;
}

export interface DraftSummary {
  slug: string;
  title: string;
  updated_at: string;
}

export interface DraftDocument {
  frontmatter: DraftFrontmatter;
  body: string;
}

export type SuggestSection = "out-of-scope" | "acceptance-criteria" | "open-questions";

export const draftsApi = {
  list: (repoRoot: string) =>
    invoke<DraftSummary[]>("list_drafts", { repoRoot }),
  read: (repoRoot: string, slug: string) =>
    invoke<DraftDocument>("read_draft", { repoRoot, slug }),
  save: (repoRoot: string, slug: string, title: string, body: string) =>
    invoke<DraftDocument>("save_draft", { repoRoot, slug, title, body }),
  delete: (repoRoot: string, slug: string) =>
    invoke<void>("delete_draft", { repoRoot, slug }),
  publish: (repoRoot: string, slug: string, id: string, finalSlug: string) =>
    invoke<string>("publish_draft", { repoRoot, slug, id, finalSlug }),
  nextId: (repoRoot: string) =>
    invoke<string>("next_draft_id", { repoRoot }),
  suggest: (repoRoot: string, slug: string, section: SuggestSection) =>
    invoke<string[]>("suggest_draft_section", { repoRoot, slug, section }),
  listPublishedSpecs: (repoRoot: string) =>
    invoke<PublishedSpec[]>("list_published_specs", { repoRoot }),
  readSpecBody: (path: string, maxBytes?: number) =>
    invoke<SpecBody>("read_spec_body", { path, maxBytes: maxBytes ?? null }),
};

export interface PublishedSpec {
  id: string;
  title: string;
  goal: string;
  path: string;
  updated_at: string;
}

export interface SpecBody {
  body: string;
  truncated: boolean;
}
