import { describe, expect, it } from "vitest";
import type { BootstrapResponse, CommandBatchResponse, GameplayCommand } from "../../../src/net/protocol";
import { call, commandBody, grantBalance, grantRoster, signIn, uniqueSub } from "./helpers";
import { RAID_RULESET_VERSION } from "../../../src/raid/replay";

describe("growth control over HTTP and D1", () => {
  it("persists invasion cooldown advances once across devices and starts the next cooldown normally", async () => {
    const sub = uniqueSub("invasion-time");
    const owner = await signIn(sub);
    await grantRoster(owner, [{ id: "invasion-time-zombie", key: "ZombieActorRegularTier1", stored: false }]);
    const invasion = {
      raidId: 1, orderedUnitIds: ["invasion-time-zombie"], rulesetVersion: RAID_RULESET_VERSION,
    };
    const start = () => call<any>("POST", "/raid/start", owner.token, invasion);
    const retreat = (sessionId: string) => call("POST", "/raid/finish", owner.token, {
      sessionId, finalTick: 0, inputs: [{ seq: 1, tick: 0, type: "retreat" }], clientWin: false,
    });
    const boot = async (token = owner.token) => {
      const response = await call<BootstrapResponse>("POST", "/bootstrap", token, {});
      expect(response.status).toBe(200);
      return response.body;
    };
    const started = await start();
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect((await retreat(started.body.sessionId)).status).toBe(200);
    const before = await boot();
    const blockedBefore = await start();
    expect(blockedBefore).toMatchObject({ status: 429, body: { error: "cooldown" } });

    const partialBody = commandBody(before, uniqueSub("invasion-partial"), 1,
      [{ type: "farm.advance_growth", milliseconds: 3_600_000 }]);
    const partial = await call<CommandBatchResponse>("POST", "/commands", owner.token, partialBody);
    expect(partial.status).toBe(200);
    expect(partial.body.results[0].status).toBe("applied");
    expect(partial.body.gameplay.raids).toEqual({
      ...before.gameplay.raids, lastRaidAt: before.gameplay.raids.lastRaidAt - 3_600_000,
    });
    expect(partial.body.gameplay.balance).toEqual(before.gameplay.balance);
    expect(partial.body.gameplay.quests).toEqual(before.gameplay.quests);
    expect(partial.body.gameplay.periodicQuests).toEqual(before.gameplay.periodicQuests);
    const duplicate = await call<CommandBatchResponse>("POST", "/commands", owner.token, partialBody);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.gameplay.raids).toEqual(partial.body.gameplay.raids);
    const other = await signIn(sub, false);
    expect((await boot(other.token)).gameplay.raids).toEqual(partial.body.gameplay.raids);
    const blockedAfter = await start();
    expect(blockedAfter).toMatchObject({ status: 429, body: { error: "cooldown" } });
    expect(blockedAfter.body.cooldownRemaining).toBeGreaterThan(0);
    expect(blockedAfter.body.cooldownRemaining).toBeLessThanOrEqual(blockedBefore.body.cooldownRemaining - 3_600_000);

    const ready = await call<CommandBatchResponse>("POST", "/commands", owner.token,
      commandBody(await boot(), uniqueSub("invasion-ready"), 2,
        [{ type: "farm.advance_growth", milliseconds: 24 * 3_600_000 }]));
    expect(ready.status).toBe(200);
    expect(ready.body.results[0].status).toBe("applied");
    expect((await boot(other.token)).gameplay.raids).toEqual(ready.body.gameplay.raids);
    const next = await start();
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect((await retreat(next.body.sessionId)).status).toBe(200);
    expect((await boot(other.token)).gameplay.raids.lastRaidAt).toBe(next.body.lastRaidAt);
    const freshCooldown = await start();
    expect(freshCooldown).toMatchObject({ status: 429, body: { error: "cooldown" } });
    expect(freshCooldown.body.cooldownRemaining).toBeGreaterThan(3_600_000);
  });

  it("persists tree and Pot advancement, preserves collection, and starts fresh production/jobs", async () => {
    const sub = uniqueSub("tree-pot-growth");
    const owner = await signIn(sub);
    await grantBalance(owner, { gold: 50_000, brains: 50, xp: 218_000 });
    await grantRoster(owner, ["a", "b", "c", "d"].map((id) => ({ id, key: "ZombieActorRegularTier1", stored: false })));
    let sequence = 1;
    const boot = async (token = owner.token) => {
      const response = await call<BootstrapResponse>("POST", "/bootstrap", token, {});
      expect(response.status).toBe(200);
      return response.body;
    };
    const send = async (...commands: GameplayCommand[]) => {
      const envelope = commandBody(await boot(), uniqueSub("tree-pot-batch"), sequence, commands);
      sequence += commands.length;
      const response = await call<CommandBatchResponse>("POST", "/commands", owner.token, envelope);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.results.every((r) => r.status === "applied"), JSON.stringify(response.body.results)).toBe(true);
      return { envelope, result: response.body };
    };
    await send(
      { type: "object.buy", catalogKey: "fruitTreeApple", clientInstanceId: "growth-tree" },
      { type: "object.buy", catalogKey: "zombieCombiner", clientInstanceId: "growth-pot" },
      { type: "roster.combine_start", potId: "growth-pot", parentAId: "a", parentBId: "b" },
    );
    const before = await boot();
    const tree = (boot: { gameplay: BootstrapResponse["gameplay"] }) =>
      boot.gameplay.objects.objects.find((o) => o.instanceId === "growth-tree")!;
    const partial = await send({ type: "farm.advance_growth", milliseconds: 30_000 });
    expect(tree(partial.result).readyAt).toBe(tree(before).readyAt! - 30_000);
    expect(partial.result.gameplay.potTimers!["growth-pot"].finishAt).toBe(before.gameplay.potTimers!["growth-pot"].finishAt - 30_000);
    expect(partial.result.gameplay.balance).toEqual(before.gameplay.balance);
    expect(partial.result.gameplay.quests).toEqual(before.gameplay.quests);
    expect(partial.result.gameplay.raids).toEqual(before.gameplay.raids);
    expect(partial.result.gameplay.periodicQuests).toEqual(before.gameplay.periodicQuests);
    const duplicate = await call<CommandBatchResponse>("POST", "/commands", owner.token, partial.envelope);
    expect(duplicate.body.gameplay.potTimers).toEqual(partial.result.gameplay.potTimers);
    const other = await signIn(sub, false);
    const synced = await boot(other.token);
    expect(synced.gameplay.potTimers).toEqual(partial.result.gameplay.potTimers);
    expect(synced.gameplay.objects).toEqual(partial.result.gameplay.objects);

    const ready = await send({ type: "farm.advance_growth", milliseconds: 3_600_000 });
    expect(tree(ready.result).readyAt).toBeLessThanOrEqual(ready.result.serverTime);
    expect(ready.result.gameplay.potTimers!["growth-pot"].finishAt).toBeLessThanOrEqual(ready.result.serverTime);
    expect(ready.result.gameplay.balance).toEqual(before.gameplay.balance);
    expect(ready.result.gameplay.roster).toEqual(before.gameplay.roster);
    const collected = await send(
      { type: "object.harvest_trees", instanceIds: ["growth-tree"] },
      { type: "roster.combine", potId: "growth-pot", parentAId: "a", parentBId: "b" },
    );
    expect(collected.result.gameplay.balance.gold).toBe(before.gameplay.balance.gold + 5);
    expect(tree(collected.result).readyAt).toBe(collected.result.serverTime + 45_000);
    expect(collected.result.gameplay.potTimers).toEqual({});
    expect(collected.result.gameplay.roster).toHaveLength(3);
    const next = await send({ type: "roster.combine_start", potId: "growth-pot", parentAId: "c", parentBId: "d" });
    expect(next.result.gameplay.potTimers!["growth-pot"].finishAt).toBe(next.result.serverTime + 3_600_000);
    expect((await boot(other.token)).gameplay.potTimers).toEqual(next.result.gameplay.potTimers);
  });

  it.each(["keyed", "single"])("adopts a %s legacy Pot timer without restarting it or changing its snapshots", async (kind) => {
    const owner = await signIn(uniqueSub("legacy-pot-growth"));
    await grantRoster(owner, ["a", "b"].map((id) => ({ id, key: "ZombieActorRegularTier1", stored: false })));
    const before = await call<BootstrapResponse>("POST", "/bootstrap", owner.token, {});
    const job = { parentAId: "a", parentBId: "b", keyA: "ZombieActorRegularTier1", keyB: "ZombieActorRegularTier1",
      maskA: 0, maskB: 0, nameA: "Keeper", startedAt: before.body.serverTime - 600_000, finishAt: before.body.serverTime + 1_800_000 };
    const saved = await call("PUT", "/presentation", owner.token, {
      protocolVersion: 3, expectedVersion: before.body.presentation.version,
      data: kind === "keyed" ? { zombiePots: { legacy: job } } : { zombiePot: job },
    });
    expect(saved.status).toBe(200);
    const current = await call<BootstrapResponse>("POST", "/bootstrap", owner.token, {});
    const advanced = await call<CommandBatchResponse>("POST", "/commands", owner.token,
      commandBody(current.body, uniqueSub("legacy-advance"), 1, [{ type: "farm.advance_growth", milliseconds: 300_000 }]));
    expect(advanced.status).toBe(200);
    expect(advanced.body.gameplay.potTimers!.legacy).toEqual({
      parentAId: "a", parentBId: "b", startedAt: job.startedAt - 300_000, finishAt: job.finishAt - 300_000,
    });
    const reconnected = await call<BootstrapResponse>("POST", "/bootstrap", owner.token, {});
    expect(reconnected.body.gameplay.potTimers).toEqual(advanced.body.gameplay.potTimers);
    const presentation = reconnected.body.presentation.data;
    expect(kind === "keyed" ? (presentation.zombiePots as any).legacy : presentation.zombiePot).toEqual(job);
  });

  it("persists advances across reconnects/devices, replays once and resets on replant", async () => {
    const sub = uniqueSub("growth-time");
    const owner = await signIn(sub);
    await grantBalance(owner, { gold: 10_000, brains: 10, xp: 0 });
    let sequence = 1;
    const boot = async (token = owner.token) => {
      const result = await call<BootstrapResponse>("POST", "/bootstrap", token, {});
      expect(result.status).toBe(200);
      return result.body;
    };
    const send = async (...commands: GameplayCommand[]) => {
      const envelope = commandBody(await boot(), uniqueSub("growth-batch"), sequence, commands);
      sequence += commands.length;
      const result = await call<CommandBatchResponse>("POST", "/commands", owner.token, envelope);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.results.every((r) => r.status === "applied")).toBe(true);
      return { envelope, result: result.body };
    };
    expect((await boot()).growthTimeControlEnabled).toBe(true);
    await send(
      { type: "farm.plow_many", plots: [{ oc: 0, or: 0 }, { oc: 4, or: 0 }] },
      { type: "farm.plant", oc: 0, or: 0, cropKey: "onion" },
      { type: "farm.plant", oc: 4, or: 0, cropKey: "ZombieActorRegularTier1" },
    );
    const before = await boot();
    const { envelope, result } = await send({ type: "farm.advance_growth", milliseconds: 3_600_000 });
    const onionBefore = before.gameplay.farm.plots["0:0"];
    if (onionBefore.state !== "planted") throw new Error("expected onion");
    expect(result.gameplay.farm.plots["0:0"]).toMatchObject({ plantedAt: onionBefore.plantedAt - 3_600_000 });
    expect(result.gameplay.balance).toEqual(before.gameplay.balance);
    expect(result.gameplay.raids).toEqual(before.gameplay.raids);
    expect(result.gameplay.quests).toEqual(before.gameplay.quests);
    expect(result.gameplay.objects).toEqual(before.gameplay.objects);
    const duplicate = await call<CommandBatchResponse>("POST", "/commands", owner.token, envelope);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.gameplay.farm).toEqual(result.gameplay.farm);

    // Independent signed-in sessions model reconnects and a read on a second device.
    const phone = await signIn(sub, false);
    const tablet = await signIn(sub, false);
    const refused = await call("POST", "/commands", phone.token,
      commandBody(await boot(phone.token), uniqueSub("read-only-growth"), 1,
        [{ type: "farm.advance_growth", milliseconds: 3_600_000 }], "device-bbbbbbbb"));
    expect(refused.status).toBe(423);
    for (const session of [phone, tablet]) {
      const other = await boot(session.token);
      expect(other.gameplay.farm).toEqual(result.gameplay.farm);
      expect(other.writer.status).toBe("other");
    }
    const otherFarm = await signIn(uniqueSub("unaffected-farm"));
    expect((await boot(otherFarm.token)).gameplay.farm.plots).not.toEqual(result.gameplay.farm.plots);

    await send(
      { type: "farm.advance_growth", milliseconds: 24 * 3_600_000 },
      { type: "farm.harvest_many", plots: [{ oc: 0, or: 0 }, { oc: 4, or: 0 }] },
      { type: "farm.plow_many", plots: [{ oc: 0, or: 0 }, { oc: 4, or: 0 }] },
      { type: "farm.plant", oc: 0, or: 0, cropKey: "onion" },
      { type: "farm.plant", oc: 4, or: 0, cropKey: "ZombieActorRegularTier1" },
    );
    const reconnected = await boot(phone.token);
    for (const key of ["0:0", "4:0"]) {
      const plot = reconnected.gameplay.farm.plots[key];
      expect(plot.state).toBe("planted");
      if (plot.state === "planted") expect(reconnected.serverTime - plot.plantedAt).toBeLessThan(10_000);
    }
    expect(reconnected.gameplay.roster.some((z) => z.key === "ZombieActorRegularTier1")).toBe(true);
  });
});
