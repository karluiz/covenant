import { describe, expect, it, vi } from "vitest";
import { renderTaskCard } from "./task-card";
import type { ProposeTask, TeammateMessage } from "../api";

function sampleMessage(confirmed = false, dismissed = false): TeammateMessage {
  const propose: ProposeTask = {
    draft: {
      archetype: "do",
      title: "Revisar migración de auth",
      deliverable: "resumen + riesgos + PR draft",
      scope: { paths: ["crates/app/src/auth_mig.rs"] },
    },
    rationale: "user asked for an audit",
  };
  return {
    id: "msg1",
    operator_id: "op1",
    task_id: null,
    role: "operator",
    content: { kind: "propose", data: propose },
    created_at_unix_ms: 0,
    confirmed_at_unix_ms: confirmed ? 1 : null,
    dismissed_at_unix_ms: dismissed ? 1 : null,
  };
}

describe("renderTaskCard", () => {
  it("renders archetype badge, title, deliverable, scope, and three buttons", () => {
    const el = renderTaskCard(sampleMessage(), {
      onConfirm: vi.fn(), onCancel: vi.fn(), onEdit: vi.fn(),
    });
    expect(el.querySelector('[data-archetype="do"]')).not.toBeNull();
    expect(el.textContent).toContain("Revisar migración de auth");
    expect(el.textContent).toContain("resumen + riesgos + PR draft");
    expect(el.textContent).toContain("crates/app/src/auth_mig.rs");
    expect(el.querySelector('[data-action="confirm"]')).not.toBeNull();
    expect(el.querySelector('[data-action="edit"]')).not.toBeNull();
    expect(el.querySelector('[data-action="cancel"]')).not.toBeNull();
  });

  it("invokes onConfirm when Confirmar is clicked", () => {
    const onConfirm = vi.fn();
    const el = renderTaskCard(sampleMessage(), {
      onConfirm, onCancel: vi.fn(), onEdit: vi.fn(),
    });
    (el.querySelector('[data-action="confirm"]') as HTMLButtonElement).click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("shows confirmed state and disables buttons when already confirmed", () => {
    const el = renderTaskCard(sampleMessage(true), {
      onConfirm: vi.fn(), onCancel: vi.fn(), onEdit: vi.fn(),
    });
    expect(el.classList.contains("task-card--confirmed")).toBe(true);
    const confirmBtn = el.querySelector('[data-action="confirm"]') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it("shows cancelled state when dismissed", () => {
    const el = renderTaskCard(sampleMessage(false, true), {
      onConfirm: vi.fn(), onCancel: vi.fn(), onEdit: vi.fn(),
    });
    expect(el.classList.contains("task-card--cancelled")).toBe(true);
  });
});
