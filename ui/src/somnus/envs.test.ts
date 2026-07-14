import { describe, expect, it, vi } from "vitest";
import type { SomnusEnvironment } from "../api";
import { EnvEditor } from "./envs";

const envs: SomnusEnvironment[] = [
  {
    id: "e1",
    name: "Staging",
    vars: JSON.stringify([
      { key: "base_url", value: "https://stg.test", secret: false },
      { key: "tok", value: "s3", secret: true },
    ]),
    is_active: true,
  },
  { id: "e2", name: "Prod", vars: "[]", is_active: false },
];

describe("EnvEditor render", () => {
  it("renders one row per environment with the active dot", () => {
    const ed = new EnvEditor({ onChanged: vi.fn() });
    document.body.append(ed.element);
    ed.render(envs);
    const rows = ed.element.querySelectorAll(".somnus-env-row");
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector(".rail-dot")?.classList.contains("is-ok")).toBe(true);
    expect(rows[1].querySelector(".rail-dot")?.classList.contains("is-ok")).toBe(false);
  });

  it("secret vars render as password inputs when expanded", () => {
    const ed = new EnvEditor({ onChanged: vi.fn() });
    document.body.append(ed.element);
    ed.render(envs);
    (ed.element.querySelector(".somnus-env-row") as HTMLElement).click();
    const values = [...ed.element.querySelectorAll(".somnus-env-vars input.somnus-env-val")];
    expect((values[0] as HTMLInputElement).type).toBe("text");
    expect((values[1] as HTMLInputElement).type).toBe("password");
  });
});
