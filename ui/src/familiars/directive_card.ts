import { Familiars } from "./api";

export interface DirectiveCardSpec {
  familiar_id: string;
  directive_id: string;
  kind: string;
  payload: string;
  rationale: string;
  /** Called with the rendered synthetic message after approval. */
  onApproved: (rendered: string) => Promise<void> | void;
  onRejected?: () => void;
}

export function renderDirectiveCard(spec: DirectiveCardSpec): HTMLElement {
  const card = document.createElement("div");
  card.className = "directive-card";
  card.innerHTML = `
    <div class="directive-head">
      <span class="directive-kind">${spec.kind.toUpperCase()}</span>
      <span class="directive-status">PROPOSED</span>
    </div>
    <pre class="directive-payload"></pre>
    <div class="directive-rationale"></div>
    <div class="directive-actions">
      <button class="btn-approve">Approve</button>
      <button class="btn-reject">Reject</button>
      <button class="btn-edit">Edit</button>
    </div>`;
  (card.querySelector(".directive-payload") as HTMLElement).textContent = spec.payload;
  (card.querySelector(".directive-rationale") as HTMLElement).textContent = spec.rationale;

  const setStatus = (s: string, cls: string) => {
    const el = card.querySelector(".directive-status") as HTMLElement;
    el.textContent = s;
    card.classList.remove("approved", "rejected", "executed");
    card.classList.add(cls);
  };

  card.querySelector(".btn-approve")!.addEventListener("click", async () => {
    const rendered = await Familiars.approve(spec.familiar_id, spec.directive_id);
    setStatus("APPROVED", "approved");
    await spec.onApproved(rendered);
  });
  card.querySelector(".btn-reject")!.addEventListener("click", async () => {
    await Familiars.reject(spec.familiar_id, spec.directive_id);
    setStatus("REJECTED", "rejected");
    spec.onRejected?.();
  });
  card.querySelector(".btn-edit")!.addEventListener("click", () => {
    const pre = card.querySelector(".directive-payload") as HTMLElement;
    pre.contentEditable = "true";
    pre.focus();
  });
  return card;
}
