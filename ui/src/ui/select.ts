export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface CustomSelectConfig {
  options: readonly SelectOption[];
  value?: string;
  name?: string;
  className?: string;
  buttonClassName?: string;
  placeholder?: string;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
}

let nextSelectId = 0;

/// Small vanilla-TS select/listbox control used where browser-native
/// dropdown styling is too inconsistent for Covenant's settings chrome.
/// It renders as a button + body-level listbox and optionally mirrors its
/// value into a hidden input for FormData-backed forms.
export class CustomSelect {
  readonly element: HTMLSpanElement;
  readonly button: HTMLButtonElement;

  private readonly labelEl: HTMLSpanElement;
  private readonly input: HTMLInputElement | null;
  private readonly placeholder: string;
  private readonly ariaLabel: string | null;
  private readonly onChange?: (value: string) => void;
  private readonly id = `ui-select-${++nextSelectId}`;

  private options: SelectOption[];
  private valueInternal: string;
  private disabledInternal: boolean;
  private popover: HTMLDivElement | null = null;
  private highlighted = -1;
  private outsideHandler: ((e: PointerEvent) => void) | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private repositionHandler: (() => void) | null = null;
  private disconnectObserver: MutationObserver | null = null;

  constructor(config: CustomSelectConfig) {
    this.options = config.options.map((o) => ({ ...o }));
    this.placeholder = config.placeholder ?? "";
    this.ariaLabel = config.ariaLabel ?? null;
    this.onChange = config.onChange;
    this.valueInternal = this.coerceValue(config.value ?? "");
    this.disabledInternal = config.disabled ?? false;

    this.element = document.createElement("span");
    this.element.className = ["ui-select", config.className ?? ""]
      .filter(Boolean)
      .join(" ");
    this.element.dataset.value = this.valueInternal;

    if (config.name) {
      this.input = document.createElement("input");
      this.input.type = "hidden";
      this.input.name = config.name;
      this.input.value = this.valueInternal;
      this.element.appendChild(this.input);
    } else {
      this.input = null;
    }

    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = ["ui-select__button", config.buttonClassName ?? ""]
      .filter(Boolean)
      .join(" ");
    this.button.setAttribute("aria-haspopup", "listbox");
    this.button.setAttribute("aria-expanded", "false");
    if (config.title) this.button.title = config.title;

    this.labelEl = document.createElement("span");
    this.labelEl.className = "ui-select__label";

    const caret = document.createElement("span");
    caret.className = "ui-select__caret";
    caret.setAttribute("aria-hidden", "true");
    caret.innerHTML = `
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="m6 9 6 6 6-6" />
      </svg>
    `;

    this.button.append(this.labelEl, caret);
    this.element.appendChild(this.button);

    this.button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
    });
    this.button.addEventListener("keydown", (e) => {
      if (this.disabledInternal) return;
      if (
        e.key === "ArrowDown" ||
        e.key === "ArrowUp" ||
        e.key === "Enter" ||
        e.key === " "
      ) {
        e.preventDefault();
        if (!this.popover) this.open(e.key === "ArrowUp" ? "last" : "current");
      }
    });

    this.renderButton();
  }

  get value(): string {
    return this.valueInternal;
  }

  set value(next: string) {
    this.setValue(next, false);
  }

  setOptions(options: readonly SelectOption[], value?: string): void {
    this.options = options.map((o) => ({ ...o }));
    this.setValue(value ?? this.valueInternal, false);
    if (this.popover) {
      this.highlighted = this.highlightIndexForValue();
      this.renderPopover();
      this.position();
    }
  }

  setDisabled(disabled: boolean): void {
    this.disabledInternal = disabled;
    this.button.disabled = disabled;
    this.element.classList.toggle("is-disabled", disabled);
    if (disabled) this.close();
  }

  destroy(): void {
    this.close();
    this.element.remove();
  }

  private toggle(): void {
    if (this.popover) this.close();
    else this.open("current");
  }

  private open(mode: "current" | "last"): void {
    if (this.disabledInternal || this.popover || !this.hasEnabledOptions()) return;
    if (!this.element.isConnected) return;

    const pop = document.createElement("div");
    pop.className = "ui-select__popover";
    pop.id = `${this.id}-listbox`;
    pop.setAttribute("role", "listbox");
    pop.setAttribute("aria-label", this.ariaLabel ?? "Options");
    document.body.appendChild(pop);
    this.popover = pop;

    this.highlighted =
      mode === "last" ? this.lastEnabledIndex() : this.highlightIndexForValue();
    this.renderPopover();
    this.position();

    this.button.setAttribute("aria-expanded", "true");
    this.button.setAttribute("aria-controls", pop.id);

    this.outsideHandler = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (!this.element.isConnected) {
        this.close();
        return;
      }
      if (this.popover?.contains(target)) return;
      if (this.button.contains(target)) return;
      this.close();
    };
    this.keyHandler = (e: KeyboardEvent): void => {
      if (!this.popover) return;
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          this.close();
          this.button.focus();
          break;
        case "ArrowDown":
          e.preventDefault();
          this.moveHighlight(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          this.moveHighlight(-1);
          break;
        case "Home":
          e.preventDefault();
          this.highlighted = this.firstEnabledIndex();
          this.renderPopover();
          break;
        case "End":
          e.preventDefault();
          this.highlighted = this.lastEnabledIndex();
          this.renderPopover();
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          this.chooseHighlighted();
          break;
        case "Tab":
          this.close();
          break;
      }
    };
    this.repositionHandler = (): void => this.position();
    this.disconnectObserver = new MutationObserver(() => {
      if (!this.element.isConnected) this.close();
    });
    this.disconnectObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    setTimeout(() => {
      if (!this.popover) return;
      document.addEventListener("pointerdown", this.outsideHandler!);
      document.addEventListener("keydown", this.keyHandler!);
      window.addEventListener("resize", this.repositionHandler!);
      window.addEventListener("scroll", this.repositionHandler!, true);
    }, 0);
  }

  private close(): void {
    if (this.popover) {
      this.popover.remove();
      this.popover = null;
    }
    this.button.setAttribute("aria-expanded", "false");
    this.button.removeAttribute("aria-controls");
    this.button.removeAttribute("aria-activedescendant");
    if (this.outsideHandler) {
      document.removeEventListener("pointerdown", this.outsideHandler);
      this.outsideHandler = null;
    }
    if (this.keyHandler) {
      document.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
    }
    if (this.repositionHandler) {
      window.removeEventListener("resize", this.repositionHandler);
      window.removeEventListener("scroll", this.repositionHandler, true);
      this.repositionHandler = null;
    }
    if (this.disconnectObserver) {
      this.disconnectObserver.disconnect();
      this.disconnectObserver = null;
    }
  }

  private renderButton(): void {
    const selected = this.currentOption();
    const label = selected?.label ?? this.placeholder;
    this.labelEl.textContent = label || "—";
    this.button.classList.toggle("is-placeholder", !selected);
    this.button.disabled = this.disabledInternal || !this.hasEnabledOptions();
    this.element.dataset.value = this.valueInternal;
    if (this.input) this.input.value = this.valueInternal;
    const accessible = this.ariaLabel ? `${this.ariaLabel}: ${label || "none"}` : label;
    if (accessible) this.button.setAttribute("aria-label", accessible);
  }

  private renderPopover(): void {
    if (!this.popover) return;
    this.popover.replaceChildren();
    this.options.forEach((option, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.id = `${this.id}-option-${index}`;
      btn.className = "ui-select__option";
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", String(option.value === this.valueInternal));
      btn.disabled = option.disabled ?? false;
      btn.dataset.value = option.value;
      const check = document.createElement("span");
      check.className = "ui-select__option-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = option.value === this.valueInternal ? "✓" : "";
      const label = document.createElement("span");
      label.className = "ui-select__option-label";
      label.textContent = option.label;
      btn.append(check, label);
      btn.classList.toggle("is-highlighted", index === this.highlighted);
      btn.classList.toggle("is-selected", option.value === this.valueInternal);
      btn.addEventListener("click", () => this.chooseIndex(index));
      btn.addEventListener("mouseenter", () => {
        if (option.disabled) return;
        this.highlighted = index;
        this.renderPopover();
      });
      this.popover!.appendChild(btn);
    });

    const active = this.popover.querySelector<HTMLElement>(".ui-select__option.is-highlighted");
    if (active) {
      this.button.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView({ block: "nearest" });
    } else {
      this.button.removeAttribute("aria-activedescendant");
    }
  }

  private position(): void {
    if (!this.popover || !this.element.isConnected) return;
    const rect = this.button.getBoundingClientRect();
    const margin = 8;
    const minWidth = Math.max(rect.width, 128);
    this.popover.style.minWidth = `${minWidth}px`;
    this.popover.style.maxWidth = `${Math.max(160, window.innerWidth - margin * 2)}px`;

    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const desiredMax = 280;
    const dropUp = spaceBelow < 160 && spaceAbove > spaceBelow;
    const available = Math.max(96, dropUp ? spaceAbove : spaceBelow);
    this.popover.style.maxHeight = `${Math.min(desiredMax, available)}px`;

    const popRect = this.popover.getBoundingClientRect();
    const left = Math.min(
      Math.max(margin, rect.left),
      Math.max(margin, window.innerWidth - popRect.width - margin),
    );
    const top = dropUp
      ? Math.max(margin, rect.top - popRect.height - 4)
      : Math.min(window.innerHeight - margin, rect.bottom + 4);
    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${top}px`;
  }

  private chooseHighlighted(): void {
    if (this.highlighted < 0) return;
    this.chooseIndex(this.highlighted);
  }

  private chooseIndex(index: number): void {
    const option = this.options[index];
    if (!option || option.disabled) return;
    this.setValue(option.value, true);
    this.close();
    this.button.focus();
  }

  private setValue(next: string, emit: boolean): void {
    const coerced = this.coerceValue(next);
    const changed = coerced !== this.valueInternal;
    this.valueInternal = coerced;
    this.renderButton();
    if (emit && changed) {
      this.onChange?.(this.valueInternal);
      this.element.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  private coerceValue(next: string): string {
    if (this.options.some((o) => o.value === next)) return next;
    if (next === "" && this.placeholder) return "";
    return this.firstEnabledOption()?.value ?? "";
  }

  private currentOption(): SelectOption | undefined {
    return this.options.find((o) => o.value === this.valueInternal);
  }

  private hasEnabledOptions(): boolean {
    return this.options.some((o) => !o.disabled);
  }

  private firstEnabledOption(): SelectOption | undefined {
    return this.options.find((o) => !o.disabled);
  }

  private enabledIndices(): number[] {
    return this.options
      .map((option, index) => (option.disabled ? -1 : index))
      .filter((index) => index >= 0);
  }

  private firstEnabledIndex(): number {
    return this.enabledIndices()[0] ?? -1;
  }

  private lastEnabledIndex(): number {
    const enabled = this.enabledIndices();
    return enabled[enabled.length - 1] ?? -1;
  }

  private highlightIndexForValue(): number {
    const selected = this.options.findIndex(
      (o) => o.value === this.valueInternal && !o.disabled,
    );
    return selected >= 0 ? selected : this.firstEnabledIndex();
  }

  private moveHighlight(delta: 1 | -1): void {
    const enabled = this.enabledIndices();
    if (enabled.length === 0) return;
    const currentPos = enabled.indexOf(this.highlighted);
    const base = currentPos >= 0 ? currentPos : delta > 0 ? -1 : 0;
    const nextPos = Math.max(0, Math.min(enabled.length - 1, base + delta));
    this.highlighted = enabled[nextPos] ?? enabled[0]!;
    this.renderPopover();
  }
}
