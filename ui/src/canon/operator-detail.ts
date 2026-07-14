// Operator detail page — replaces the generic markdown reader with a
// structured view that surfaces the operator's identity, configuration,
// capabilities, and soul content.

import {
  operatorLevelFromXp,
  operatorSoulRead,
  type Operator,
} from "../api";
import { renderAvatarHtml } from "../operator/avatars";
import { renderMarkdown } from "../ui/markdown";

/** Strip a leading YAML frontmatter block so it doesn't render as a paragraph. */
function stripFrontmatter(md: string): string {
  return md.replace(/^﻿?\s*---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function fmtDateRelative(ms: number): string {
  if (!ms) return "";
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 2_592_000_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return fmtDate(ms);
}

/** Open a full-screen operator detail page over the workspace. */
export function openOperatorDetail(op: Operator): void {
  const overlay = document.createElement("div");
  overlay.className = "op-detail";

  const level = operatorLevelFromXp(op.xp);
  const xpIntoLevel = Math.max(0, op.xp) % 100;

  // ── Header ──
  overlay.innerHTML = `
    <header class="op-detail-header">
      <div class="op-detail-header-left">
        <div class="op-detail-avatar-wrap">
          ${renderAvatarHtml(op.emoji, 72)}
          <span class="op-detail-level" title="${escapeHtml(String(op.xp))} XP total">Lv ${level}</span>
        </div>
        <div class="op-detail-identity">
          <h2 class="op-detail-name">${escapeHtml(op.name)}</h2>
          <div class="op-detail-meta-row">
            ${op.tags.length > 0 ? op.tags.map((t) => `<span class="op-detail-tag">${escapeHtml(t)}</span>`).join("") : ""}
            ${op.is_default ? '<span class="op-detail-tag op-detail-tag--default">default</span>' : ""}
          </div>
          <div class="op-detail-xp-row">
            <div class="op-detail-xp-bar" role="progressbar"
                 aria-valuemin="0" aria-valuemax="100" aria-valuenow="${xpIntoLevel}">
              <div class="op-detail-xp-fill" style="width:${xpIntoLevel}%"></div>
            </div>
            <span class="op-detail-xp-label">${xpIntoLevel} / 100 XP</span>
          </div>
        </div>
      </div>
      <button type="button" class="op-detail-close" aria-label="Close (Esc)"><kbd class="settings-esc">esc</kbd></button>
    </header>

    <div class="op-detail-body">
      <div class="op-detail-content">
        <div class="op-detail-sidebar">
          ${renderInfoSection(op)}
          ${renderCapabilitiesSection(op)}
          ${renderProvenanceSection(op)}
        </div>
        <article class="op-detail-soul markdown-body markdown-doc">
          <div class="op-detail-soul-loading">Loading soul...</div>
        </article>
      </div>
    </div>
  `;

  const close = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  };
  overlay.querySelector(".op-detail-close")?.addEventListener("click", close);
  document.addEventListener("keydown", onKey);

  document.body.appendChild(overlay);

  // Load soul content
  const soulEl = overlay.querySelector<HTMLElement>(".op-detail-soul")!;
  void operatorSoulRead(op.id)
    .then((md) => {
      const clean = stripFrontmatter(md).trim();
      soulEl.innerHTML = clean
        ? renderMarkdown(clean)
        : `<p class="op-detail-empty-soul">No soul file authored yet.</p>`;
    })
    .catch((e) => {
      soulEl.innerHTML = `<p class="op-detail-empty-soul">Could not load soul: ${escapeHtml(String(e))}</p>`;
    });
}

function renderInfoSection(op: Operator): string {
  return `
    <section class="op-detail-section">
      <h3 class="op-detail-section-title">Configuration</h3>
      <dl class="op-detail-dl">
        <div class="op-detail-dl-row">
          <dt>Model</dt>
          <dd><code>${escapeHtml(op.model)}</code></dd>
        </div>
        <div class="op-detail-dl-row">
          <dt>Voice</dt>
          <dd>${escapeHtml(op.voice)}</dd>
        </div>
        <div class="op-detail-dl-row">
          <dt>Escalation threshold</dt>
          <dd>${op.escalate_threshold.toFixed(2)}</dd>
        </div>
        ${op.hard_constraints.trim() ? `
        <div class="op-detail-dl-row op-detail-dl-row--block">
          <dt>Hard constraints</dt>
          <dd><pre class="op-detail-constraints">${escapeHtml(op.hard_constraints)}</pre></dd>
        </div>` : ""}
      </dl>
    </section>
  `;
}

function renderCapabilitiesSection(op: Operator): string {
  const caps: { label: string; value: string; active: boolean }[] = [
    { label: "GitHub", value: op.github_access, active: op.github_access !== "Off" },
    { label: "ACP delegation", value: op.acp_enabled ? "On" : "Off", active: op.acp_enabled },
    { label: "Perception", value: op.perception_enabled ? "On" : "Off", active: op.perception_enabled },
  ];

  return `
    <section class="op-detail-section">
      <h3 class="op-detail-section-title">Capabilities</h3>
      <div class="op-detail-caps">
        ${caps.map((c) => `
          <div class="op-detail-cap ${c.active ? "is-active" : ""}">
            <span class="op-detail-cap-dot"></span>
            <span class="op-detail-cap-label">${escapeHtml(c.label)}</span>
            <span class="op-detail-cap-value">${escapeHtml(c.value)}</span>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function renderProvenanceSection(op: Operator): string {
  const rows: string[] = [];

  rows.push(`
    <div class="op-detail-dl-row">
      <dt>Created</dt>
      <dd>${escapeHtml(fmtDate(op.created_at_unix_ms))}</dd>
    </div>
  `);

  rows.push(`
    <div class="op-detail-dl-row">
      <dt>Updated</dt>
      <dd>${escapeHtml(fmtDateRelative(op.updated_at_unix_ms))}</dd>
    </div>
  `);

  if (op.org_slug) {
    rows.push(`
      <div class="op-detail-dl-row">
        <dt>Org</dt>
        <dd>${escapeHtml(op.org_slug)}</dd>
      </div>
    `);
  }

  if (op.soul_path) {
    const basename = op.soul_path.split("/").pop() ?? op.soul_path;
    rows.push(`
      <div class="op-detail-dl-row">
        <dt>Soul file</dt>
        <dd><code>${escapeHtml(basename)}</code></dd>
      </div>
    `);
  }

  rows.push(`
    <div class="op-detail-dl-row">
      <dt>Color</dt>
      <dd><span class="op-detail-color-swatch" style="background:${escapeHtml(op.color)}"></span>${escapeHtml(op.color)}</dd>
    </div>
  `);

  return `
    <section class="op-detail-section">
      <h3 class="op-detail-section-title">Provenance</h3>
      <dl class="op-detail-dl">${rows.join("")}</dl>
    </section>
  `;
}
