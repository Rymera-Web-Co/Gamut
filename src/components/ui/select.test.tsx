import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function renderSelect(onValueChange = vi.fn()) {
  render(
    <Select defaultValue="b" onValueChange={onValueChange}>
      <SelectTrigger aria-label="Fruit">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="a">Apple</SelectItem>
        <SelectItem value="b">Banana</SelectItem>
        <SelectItem value="c">Cherry</SelectItem>
      </SelectContent>
    </Select>,
  );
  return onValueChange;
}

describe("Select", () => {
  it("exposes its accessible name and current value on the trigger", () => {
    renderSelect();
    const trigger = screen.getByRole("combobox", { name: "Fruit" });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent("Banana");
  });

  it("opens on click and lists every option", async () => {
    renderSelect();
    fireEvent.click(screen.getByRole("combobox", { name: "Fruit" }));

    expect(await screen.findByRole("option", { name: "Apple" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Banana" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Cherry" })).toBeInTheDocument();
  });

  it("fires onValueChange with the picked option's value", async () => {
    const onValueChange = renderSelect();
    fireEvent.click(screen.getByRole("combobox", { name: "Fruit" }));

    fireEvent.click(await screen.findByRole("option", { name: "Cherry" }));

    expect(onValueChange).toHaveBeenCalledWith("c");
  });
});
