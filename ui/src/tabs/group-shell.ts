export interface GroupShellOptions {
  groupId: string;
  color: string | null | undefined;
  collapsed: boolean;
}

export interface GroupShell {
  shell: HTMLElement;
  body: HTMLElement;
}

/**
 * Builds the per-group flex container used by the tab sidebar.
 * Layout: [stripe 3px][body]. Caller appends the group chip and any
 * member tab pills into `body`. The stripe paints the group color and
 * stretches to match body height automatically (CSS `align-self: stretch`).
 */
export function createGroupShell(opts: GroupShellOptions): GroupShell {
  const shell = document.createElement("div");
  shell.className = "tab-group-shell";
  shell.dataset.groupId = opts.groupId;
  if (opts.color) {
    shell.classList.add("tab-group-shell-colored");
    shell.style.setProperty("--group-color", opts.color);
  }
  if (opts.collapsed) {
    shell.classList.add("tab-group-shell-collapsed");
  }

  const stripe = document.createElement("div");
  stripe.className = "tab-group-stripe";
  shell.appendChild(stripe);

  const body = document.createElement("div");
  body.className = "tab-group-body";
  shell.appendChild(body);

  return { shell, body };
}
