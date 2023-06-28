import { NostrEvent, NostrFetcher } from "nostr-fetch";
import { Kind, SimplePool, finishEvent, nip10, nip19 } from "nostr-tools";
import { Config } from "./config.ts";

export const unixtime = (date = new Date()) =>
  Math.floor(date.getTime() / 1000);

export const getDirectReplyTarget = (ev: NostrEvent): string | undefined => {
  const parsed = nip10.parse(ev);
  return parsed.reply?.id ?? parsed.root?.id;
};

type MeasureReplyTreeContext = {
  fetcher: NostrFetcher;
  botPubkeys: Set<string>;
  readRelays: string[];
  abortSignal: AbortSignal;
};

type ReplyTreeMeasurement = {
  depth: number;
  leaves: number;
};

type MeasureReplyTreeResult =
  | {
      status: "ok";
      result: ReplyTreeMeasurement;
    }
  | {
      status: "timed-out";
    };

export const measureReplyTree = (
  fetcher: NostrFetcher,
  config: Config,
  targetId: string
): Promise<MeasureReplyTreeResult> => {
  const ac = new AbortController();

  const timeout = new Promise<MeasureReplyTreeResult>((resolve) => {
    setTimeout(() => {
      ac.abort();
      resolve({ status: "timed-out" });
    }, config.timeoutSec * 1000);
  });

  return Promise.race([
    measureReplySubtree(
      {
        fetcher,
        botPubkeys: new Set(config.botPubkeys),
        readRelays: config.relay.read,
        abortSignal: ac.signal,
      },
      [targetId]
    ).then((res) => {
      return { status: "ok", result: res } as const;
    }),
    timeout,
  ]);
};

const measureReplySubtree = async (
  ctx: MeasureReplyTreeContext,
  frontiers: string[],
  depth = 0,
  leaves = 0
): Promise<ReplyTreeMeasurement> => {
  const refs = await ctx.fetcher.fetchAllEvents(
    ctx.readRelays,
    { kinds: [1], "#e": frontiers },
    {},
    { abortSignal: ctx.abortSignal }
  );
  const refIds = refs
    .filter(
      (ev) => ctx.botPubkeys.has(ev.pubkey) && isNonRootRef(ev, frontiers)
    )
    .map((ev) => ev.id);
  if (refIds.length === 0) {
    return { depth, leaves };
  }
  return measureReplySubtree(ctx, refIds, depth + 1, leaves + refIds.length);
};

const isNonRootRef = (ev: NostrEvent, targetIds: string[]) => {
  const eTags = ev.tags.filter((t) => t[0] === "e");
  if (eTags.length <= 1) {
    return true;
  }

  // does the e tag with root marker reference target?
  const refWithRootMarker = eTags.filter((t) => t[3] === "root")[0];
  if (refWithRootMarker && targetIds.includes(refWithRootMarker[1])) {
    return false;
  }
  // if there are 2 or more e tags, the first e tag is considered root reference
  const firstEtag = eTags[0];
  if (
    firstEtag &&
    firstEtag[3] === undefined &&
    targetIds.includes(firstEtag[1])
  ) {
    return false;
  }

  return true;
};

export const publishToMultiRelays = async (
  pool: SimplePool,
  relayUrls: string[],
  ev: NostrEvent,
  timeoutSec = 5
): Promise<void> => {
  const timeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      console.log("publish timed out")
      resolve();
    }, timeoutSec * 1000);
  });

  const pub = async (rurl: string) => {
    const r = await pool.ensureRelay(rurl);
    return new Promise<void>((resolve) => {
      const pub = r.publish(ev);
      pub.on("ok", () => {
        console.log("ok", r.url);
        resolve();
      });
      pub.on("failed", () => {
        console.log("failed", r.url);
        resolve();
      });
    });
  };
  await Promise.all(
    relayUrls.map((rurl) => Promise.race([pub(rurl), timeout]))
  );
};

export const acceptedReactionEvent = (
  privkey: string,
  triggerEv: NostrEvent
): NostrEvent => reactionEvent(privkey, triggerEv, "👌");

export const errorReplyEvent = (
  privkey: string,
  triggerEv: NostrEvent,
  msg: string
): NostrEvent => {
  const ev = {
    kind: Kind.Text,
    content: msg,
    tags: [
      ["p", triggerEv.pubkey, ""],
      ["e", triggerEv.id, "", "root"],
    ],
    created_at: unixtime(),
  };
  return finishEvent(ev, privkey);
};

export const measurementResultEvent = (
  privkey: string,
  triggerEv: NostrEvent,
  targetEv: NostrEvent,
  { depth, leaves }: ReplyTreeMeasurement
): NostrEvent => {
  // 連鎖数(深さ)が1以下の場合はリアクションのみ
  if (depth <= 1) {
    return reactionEvent(privkey, triggerEv, depth === 0 ? " 0️⃣" : "1️⃣");
  }
  // 連鎖数(深さ)2以上の場合は、対象イベントを引用しつつトリガーに結果をリプライ
  const nevent = nip19.neventEncode({ id: targetEv.id });
  const pTags =
    triggerEv.pubkey === targetEv.pubkey
      ? [["p", triggerEv.pubkey, ""]]
      : [
          ["p", triggerEv.pubkey, ""],
          ["p", targetEv.pubkey, ""],
        ];
  const ev = {
    kind: Kind.Text,
    content: `リプライ連鎖数: ${depth}${"！".repeat(
      depth
    )}\nリプライ総数: ${leaves}\nnostr:${nevent}`,
    tags: [
      ...pTags,
      ["e", triggerEv.id, "", "reply"],
      ["e", targetEv.id, "", "mention"],
    ],
    created_at: unixtime(),
  };
  return finishEvent(ev, privkey);
};

const reactionEvent = (
  privkey: string,
  to: NostrEvent,
  content: string
): NostrEvent => {
  const ev = {
    kind: Kind.Reaction,
    content,
    tags: [
      ["p", to.pubkey, ""],
      ["e", to.id, ""],
    ],
    created_at: unixtime(),
  };
  return finishEvent(ev, privkey);
};
