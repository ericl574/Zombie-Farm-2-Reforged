import { describe, expect, it } from "vitest";
import type { GameplayCommand, SequencedCommand } from "../../src/net/protocol";
import { MAX_GROWTH_ADVANCE_MS } from "../../src/net/protocol";
import { applyCommandBatch, freshGameplayState } from "../src/v3/engine";
import { POT_DURATION_MS, MONOLITH_MULT } from "../../src/zombie/potTiming";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const commands = (...values: GameplayCommand[]): SequencedCommand[] =>
  values.map((command, i) => ({ sequence: i + 1, command }));
const run = (state: ReturnType<typeof freshGameplayState>, ...values: GameplayCommand[]) =>
  applyCommandBatch(state, commands(...values), {
    now: NOW, growthTimeControlEnabled: true, random: () => 1, id: () => "grown-zombie",
  });
const plant = () => run(freshGameplayState(),
  { type: "farm.plow_many", plots: [{ oc: 0, or: 0 }, { oc: 4, or: 0 }] },
  { type: "farm.plant", oc: 0, or: 0, cropKey: "onion" },
  { type: "farm.plant", oc: 4, or: 0, cropKey: "ZombieActorRegularTier1" },
).state;

describe("private farm growth advancement", () => {
  it.each([1, 4, 8, 24, 1.25])("advances both kinds of crop by %sh, capped at ripe", (hours) => {
    const before = plant();
    const result = run(before, { type: "farm.advance_growth", milliseconds: hours * HOUR });
    expect(result.results[0].status).toBe("applied");
    expect(result.farmChanged).toBe(true);
    for (const [key, original] of Object.entries(before.farm.plots)) {
      if (original.state !== "planted") throw new Error("expected crop");
      expect(result.state.farm.plots[key]).toEqual({
        ...original, plantedAt: NOW - Math.min(hours * HOUR, original.growMs),
      });
    }
  });

  it("preserves every non-growth field and emits no quest/reward events", () => {
    const before = plant();
    before.farm.plots["8:0"] = { state: "spent" };
    before.farm.plots["12:0"] = { state: "plowed" };
    before.objects.objects = [{ instanceId: "decor", catalogKey: "monolithCombine", status: "placed", readyAt: NOW + HOUR }];
    before.raids.lastRaidAt = NOW;
    before.potSlots = { pot: "parent-a" };
    const result = run(before, { type: "farm.advance_growth", milliseconds: 24 * HOUR });
    expect({ ...result.state, farm: before.farm }).toEqual(before);
    expect(result.state.farm.plots["8:0"]).toEqual(before.farm.plots["8:0"]);
    expect(result.state.farm.plots["12:0"]).toEqual(before.farm.plots["12:0"]);
    expect(result.questChanges).toEqual([]);
    expect(result.createdZombieIds).toEqual([]);
    expect(result.objectChanged).toBe(false);
  });

  it("gates harvest, then harvests, replows and replants at age zero in command order", () => {
    const before = plant();
    expect(run(before, { type: "farm.harvest", oc: 0, or: 0 }).results[0].error).toBe("not_grown");
    const result = run(before,
      { type: "farm.advance_growth", milliseconds: 24 * HOUR },
      { type: "farm.harvest_many", plots: [{ oc: 0, or: 0 }, { oc: 4, or: 0 }] },
      { type: "farm.plow_many", plots: [{ oc: 0, or: 0 }, { oc: 4, or: 0 }] },
      { type: "farm.plant", oc: 0, or: 0, cropKey: "onion" },
      { type: "farm.plant", oc: 4, or: 0, cropKey: "ZombieActorRegularTier1" },
    );
    expect(result.results.every((r) => r.status === "applied")).toBe(true);
    expect(result.createdZombieIds).toEqual(["grown-zombie"]);
    for (const plot of Object.values(result.state.farm.plots)) expect(plot).toMatchObject({ plantedAt: NOW });
    const early = run(result.state, { type: "farm.harvest", oc: 0, or: 0 }, { type: "farm.harvest", oc: 4, or: 0 });
    expect(early.results.map((r) => r.error)).toEqual(["not_grown", "not_grown"]);
  });

  it("continues natural growth after a partial advance and an unchanged save round trip", () => {
    const advanced = run(plant(), { type: "farm.advance_growth", milliseconds: 8 * HOUR }).state;
    const restored = JSON.parse(JSON.stringify(advanced));
    expect(applyCommandBatch(restored, commands({ type: "farm.harvest", oc: 0, or: 0 }), {
      now: NOW + 16 * HOUR, random: () => 1,
    }).results[0].status).toBe("applied");
  });

  it("defaults off and rejects invalid advances without changing growth", () => {
    const state = plant();
    const disabled = applyCommandBatch(state, commands({ type: "farm.advance_growth", milliseconds: HOUR }), { now: NOW });
    expect(disabled.results[0].error).toBe("growth_time_disabled");
    expect(disabled.state.farm).toEqual(state.farm);
    for (const milliseconds of [0, -1, 0.5, NaN, Infinity, MAX_GROWTH_ADVANCE_MS + 1]) {
      const result = run(state, { type: "farm.advance_growth", milliseconds });
      expect(result.results[0].error).toBe("bad_growth_advance");
      expect(result.state.farm).toEqual(state.farm);
    }
  });

  it("handles empty and already-ripe farms without stockpiling growth for new plants", () => {
    const empty = run(freshGameplayState(), { type: "farm.advance_growth", milliseconds: MAX_GROWTH_ADVANCE_MS });
    expect(empty.farmChanged).toBe(false);
    const once = run(plant(), { type: "farm.advance_growth", milliseconds: MAX_GROWTH_ADVANCE_MS });
    const twice = run(once.state, { type: "farm.advance_growth", milliseconds: MAX_GROWTH_ADVANCE_MS });
    expect(twice.state.farm).toEqual(once.state.farm);
  });

  it("advances placed tree production, pays only on harvest, and resets the next cycle", () => {
    const state = freshGameplayState();
    state.objects.objects = [
      { instanceId: "apple", catalogKey: "fruitTreeApple", status: "placed", readyAt: NOW + 45_000 },
      { instanceId: "stored", catalogKey: "fruitTreeApple", status: "stored", readyAt: NOW + 45_000 },
      { instanceId: "decor", catalogKey: "monolithCombine", status: "placed", readyAt: NOW + HOUR },
    ];
    const partial = run(state, { type: "farm.advance_growth", milliseconds: 30_000 });
    expect(partial.state.objects.objects.map((o) => o.readyAt)).toEqual([NOW + 15_000, NOW + 45_000, NOW + HOUR]);
    expect(partial.state.balance).toEqual(state.balance);
    expect(run(partial.state, { type: "object.harvest_trees", instanceIds: ["apple"] }).results[0].error).toBe("no_effect");
    const ready = run(partial.state, { type: "farm.advance_growth", milliseconds: HOUR });
    expect(ready.state.objects.objects[0].readyAt).toBe(NOW);
    expect(ready.questChanges).toEqual([]);
    expect(ready.state.balance).toEqual(state.balance);
    const collected = run(ready.state, { type: "object.harvest_trees", instanceIds: ["apple"] });
    expect(collected.results[0].status).toBe("applied");
    expect(collected.state.balance.gold).toBe(state.balance.gold + 5);
    expect(collected.state.objects.objects[0].readyAt).toBe(NOW + 45_000);
    expect(run(collected.state, { type: "object.harvest_trees", instanceIds: ["apple"] }).results[0].error).toBe("no_effect");
    expect(run(collected.state, { type: "farm.advance_growth", milliseconds: HOUR }).state.objects.objects[0].readyAt).toBe(NOW);
  });

  const potFarm = () => {
    const state = freshGameplayState();
    state.roster = ["a", "b", "c", "d"].map((id) => ({
      id, key: "ZombieActorRegularTier1", mutation: 0, invasions: 0, stored: false,
    }));
    return state;
  };

  it.each([false, true])("advances a combine without collecting or changing its result (Clay Monolith=%s)", (fast) => {
    const before = potFarm();
    if (fast) before.objects.objects = [{ instanceId: "clay", catalogKey: "monolithCombine", status: "placed" }];
    const start = run(before, { type: "roster.combine_start", potId: "pot", parentAId: "a", parentBId: "b" });
    const duration = POT_DURATION_MS * (fast ? MONOLITH_MULT : 1);
    expect(start.state.potTimers!.pot.finishAt).toBe(NOW + duration);
    const partial = run(start.state, { type: "farm.advance_growth", milliseconds: duration / 2 });
    expect(partial.state.potTimers!.pot).toMatchObject({ startedAt: NOW - duration / 2, finishAt: NOW + duration / 2 });
    expect(partial.state.roster).toEqual(start.state.roster);
    expect(partial.state.balance).toEqual(start.state.balance);
    expect(partial.questChanges).toEqual([]);
    const ready = run(partial.state, { type: "farm.advance_growth", milliseconds: HOUR });
    expect(ready.state.potTimers!.pot.finishAt).toBe(NOW);
    expect(run(ready.state, { type: "farm.advance_growth", milliseconds: HOUR }).state.potTimers).toEqual(ready.state.potTimers);
    const collect: GameplayCommand = { type: "roster.combine", potId: "pot", parentAId: "a", parentBId: "b" };
    const collected = run(ready.state, collect);
    const ordinary = run(start.state, collect);
    expect(collected.results).toEqual(ordinary.results);
    expect(collected.state.roster).toEqual(ordinary.state.roster);
    expect(collected.questChanges).toEqual(ordinary.questChanges);
    expect(collected.state.potTimers).toEqual({});
    const next = run(collected.state, { type: "roster.combine_start", potId: "pot", parentAId: "c", parentBId: "d" });
    expect(next.state.potTimers!.pot).toMatchObject({ parentAId: "c", parentBId: "d", startedAt: NOW, finishAt: NOW + duration });
  });

  it("keeps targeted Insta-Grow working independently for multiple pots", () => {
    const before = potFarm();
    before.inventory.insta_grow = 2;
    const started = run(before,
      { type: "roster.combine_start", potId: "first", parentAId: "a", parentBId: "b" },
      { type: "roster.combine_start", potId: "second", parentAId: "c", parentBId: "d" },
    );
    const boosted = run(started.state, { type: "power.use", key: "insta_grow", target: "zombie_pot", potId: "second" });
    expect(boosted.state.potTimers!.second.finishAt).toBe(NOW);
    expect(boosted.state.potTimers!.first.finishAt).toBe(NOW + HOUR);
    expect(boosted.state.inventory.insta_grow).toBe(1);
    expect(boosted.state.roster).toEqual(started.state.roster);
  });
});
