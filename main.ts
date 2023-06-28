import { simplePoolAdapter } from "@nostr-fetch/adapter-nostr-tools";
import { NostrFetcher } from "nostr-fetch";
import { SimplePool, getPublicKey } from "nostr-tools";

import rawConfig from "./config.json" assert { type: "json" };
import { Config } from "./config.ts";
import {
  acceptedReactionEvent,
  errorReplyEvent,
  getDirectReplyTarget,
  measureReplyTree,
  measurementResultEvent,
  publishToMultiRelays,
  unixtime,
} from "./util.ts";

const config: Config = rawConfig;

// Learn more at https://deno.land/manual/examples/module_metadata#concepts
if (import.meta.main) {
  console.log("starting Reply Tree Measurer!");

  const myPubkey = getPublicKey(config.privateKey);
  const relayPool = new SimplePool();
  const fetcher = NostrFetcher.withCustomPool(simplePoolAdapter(relayPool), {
    minLogLevel: "info",
  });

  const measuringEvents = new Set<string>();

  const sub = relayPool.sub(config.relay.read, [
    { kinds: [1], since: unixtime() },
  ]);
  sub.on("event", async (trigger) => {
    if (!trigger.content.includes("連鎖数")) {
      return;
    }
    if ([...config.botPubkeys, myPubkey].includes(trigger.pubkey)) {
      console.log("triggering by bot is not allowed");
      return;
    }
    console.log(trigger);

    const targetId = getDirectReplyTarget(trigger);
    if (targetId === undefined) {
      console.log("not a reply");
      return;
    }
    console.log("taret event ID:", targetId);

    if (measuringEvents.has(targetId)) {
      console.log("this event have been already measuring");
      return;
    }
    measuringEvents.add(targetId);
    try {
      const targetEv = await fetcher.fetchLastEvent(config.relay.read, {
        ids: [targetId],
      });
      if (targetEv === undefined) {
        console.log("target event not found");
        return;
      }
      if (targetEv.kind !== 1) {
        console.log("target event is not a text note");
        return;
      }
      console.log("target event:", targetEv);
      await publishToMultiRelays(
        relayPool,
        config.relay.write,
        acceptedReactionEvent(config.privateKey, trigger)
      );

      // measure reply tree of the target event
      const result = await measureReplyTree(fetcher, config, targetId);
      console.log("result:", result);

      const resultReply = (() => {
        switch (result.status) {
          case "ok":
            return measurementResultEvent(
              config.privateKey,
              trigger,
              targetEv,
              result.result
            );
          case "timed-out":
            console.log("measureReplyTree timed out");
            return errorReplyEvent(
              config.privateKey,
              trigger,
              "タイムアウトしました…"
            );
        }
      })();
      await publishToMultiRelays(relayPool, config.relay.write, resultReply);
    } catch (err) {
      console.log(err);
    } finally {
      measuringEvents.delete(targetId);
    }
  });
}
