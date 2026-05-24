import { describe, expect, it, vi } from "vitest";
import { renderTaskCard } from "./task-card";
import type { ProposeTask, TeammateMessage } from "../api";

function sampleMessage(opts: { confirmed?: boolean; dismissed?: boolean; taskId?: string | null } = {}): TeammateMessage {
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
    task_id: opts.taskId ?? null,
    role: "operator",
    content: { kind: "propose", data: propose },
    created_at_unix_ms: 0,
    confirmed_at_unix_ms: opts.confirmed ? 1 : null,
    dismissed_at_unix_ms: opts.dismissed ? 1 : null,
  };
}

describe("renderTaskCard", () => {
  it("renders archetype badge, title, deliverable, scope, and three buttons when actionable", () => {
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

  it("collapses to a confirmed pill when already confirmed", () => {
    const el = renderTaskCard(sampleMessage({ confirmed: true, taskId: "task-1" }), {
      onConfirm: vi.fn(), onCancel: vi.fn(), onEdit: vi.fn(),
    });
    expect(el.classList.contains("task-pill")).toBe(true);
    expect(el.classList.contains("task-pill--confirmed")).toBe(true);
    expect(el.querySelector('[data-action="confirm"]')).toBeNull();
    expect(el.textContent).toContain("Revisar migración de auth");
    expect(el.textContent).toContain("tab abierto");
  });

  it("invokes onOpenTab from the confirmed pill link", () => {
    const onOpenTab = vi.fn();
    const el = renderTaskCard(sampleMessage({ confirmed: true, taskId: "task-1" }), {
      onConfirm: vi.fn(), onCancel: vi.fn(), onEdit: vi.fn(), onOpenTab,
    });
    (el.querySelector('[data-action="open-tab"]') as HTMLButtonElement).click();
    expect(onOpenTab).toHaveBeenCalledWith("task-1");
  });

  it("renders a cancelled pill when dismissed", () => {
    const el = renderTaskCard(sampleMessage({ dismissed: true }), {
      onConfirm: vi.fn(), onCancel: vi.fn(), onEdit: vi.fn(),
    });
    expect(el.classList.contains("task-pill--cancelled")).toBe(true);
    expect(el.textContent).toContain("cancelada");
  });
});
