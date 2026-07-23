import { describe, it, expect, afterEach } from "vitest";

import { isModalOpen } from "./dom";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isModalOpen", () => {
  it("is false when no modal dialog is present", () => {
    expect(isModalOpen()).toBe(false);
  });

  it('is true when an element with role="dialog" is in the document', () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    expect(isModalOpen()).toBe(true);
  });

  it("goes back to false once the dialog is removed", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    dialog.remove();
    expect(isModalOpen()).toBe(false);
  });
});
