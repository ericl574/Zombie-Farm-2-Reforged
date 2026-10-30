import { MAX_GROWTH_ADVANCE_MS, validGrowthAdvance } from "../../net/protocol";
import { openModal } from "../Modal";

export function openGrowthTime(host: HTMLElement, advance: (milliseconds: number) => boolean): void {
  const { panel, close } = openModal({
    host, title: "Time Control", panelClass: "growth-time-panel",
    bgClass: "growth-time-bg", replaceSelector: ".growth-time-bg",
  });
  const note = document.createElement("p");
  note.textContent = "Advance crops, zombies, tree production, running Zombie Pot combines and the Invade cooldown. New plantings, jobs and invasions start with their normal timers.";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const submit = (milliseconds: number) => {
    if (advance(milliseconds)) close();
    else status.textContent = "Connect to your Online Farm and sync before advancing time.";
  };
  const presets = document.createElement("div");
  presets.className = "growth-time-presets";
  for (const hours of [1, 4, 8, 24]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `+${hours}h`;
    button.onclick = () => submit(hours * 3_600_000);
    presets.append(button);
  }
  const form = document.createElement("form");
  const label = document.createElement("label");
  label.textContent = "Custom hours";
  const input = document.createElement("input");
  input.type = "number";
  input.inputMode = "decimal";
  input.min = "0.01";
  input.max = String(MAX_GROWTH_ADVANCE_MS / 3_600_000);
  input.step = "0.01";
  input.value = "2";
  input.required = true;
  label.append(input);
  const custom = document.createElement("button");
  custom.type = "submit";
  custom.textContent = "Advance";
  form.onsubmit = (event) => {
    event.preventDefault();
    const milliseconds = Math.round(input.valueAsNumber * 3_600_000);
    if (!validGrowthAdvance(milliseconds)) {
      status.textContent = "Enter a positive number of hours, up to 8760.";
      return;
    }
    submit(milliseconds);
  };
  form.append(label, custom);
  panel.append(note, presets, form, status);
}
