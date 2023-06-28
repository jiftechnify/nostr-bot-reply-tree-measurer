import { delay } from "https://deno.land/std@0.192.0/async/mod.ts";
import { Kind, SimplePool, finishEvent } from "nostr-tools";
import rawConfig from "./config.json" assert { type: "json" };
import { Config } from "./config.ts";
import { publishToMultiRelays, unixtime } from "./util.ts";

const config: Config = rawConfig;

if (import.meta.main) {
  const pool = new SimplePool();
  const ev = {
    kind: Kind.Metadata,
    content: JSON.stringify(config.profile),
    tags: [],
    created_at: unixtime(),
  };

  const signed = finishEvent(ev, config.privateKey);
  console.log(signed);

  await publishToMultiRelays(pool, config.relay.write, signed, 20);
  console.log("setting profile completed");

  pool.close(config.relay.write);
  await delay(1000);
  Deno.exit(0);
}
