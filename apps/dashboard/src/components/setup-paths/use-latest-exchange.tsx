import { useEffect, useState } from "react";
import type { MessageRecord } from "@eccos/gateway-contract";
import { plusNumber, shortTime } from "../../lib/setup-test";
import { getConversation, listConversations } from "../../server/gateway";
import type { Proof } from "./activation-paywall";

/** The newest few written messages of one conversation, oldest first, as the paywall's proof. */
export function exchangeProof(waId: string, records: MessageRecord[]): Proof | null {
  const written = records
    .filter((m) => (m.direction === "in" || m.direction === "out") && m.text)
    .sort((a, b) => a.at - b.at)
    .slice(-3);
  const last = written.at(-1);
  if (!last) return null;
  const who = plusNumber(waId);
  const delivered = (m: MessageRecord) => m.status === "delivered" || m.status === "read";
  const time = <span className="font-mono text-xs text-foreground">{shortTime(last.at)}</span>;
  return {
    title: who,
    messages: written.map((m) => ({
      key: m.id,
      direction: m.direction === "in" ? "in" : "out",
      text: m.text ?? "",
      at: m.at,
      delivered: delivered(m),
    })),
    note:
      last.direction === "out" && delivered(last) ? (
        <>Delivered to {who} at {time}.</>
      ) : (
        <>Received from {who} at {time}.</>
      ),
  };
}

/**
 * When the server reports activation the console was not watching (a reply
 * from the inbox, a send from the API), the proof is read back: the newest
 * conversation's last messages. Null until read, or when there are none.
 */
export function useLatestExchange(wabaId: string | undefined, active: boolean): Proof | null {
  const [proof, setProof] = useState<Proof | null>(null);
  useEffect(() => {
    if (!active || !wabaId) return;
    let current = true;
    void (async () => {
      const list = await listConversations({ data: { wabaId, limit: 1 } });
      const waId = list.ok ? list.data.items[0]?.waId : undefined;
      if (!waId) return;
      const thread = await getConversation({ data: { wabaId, waId, limit: 10 } });
      if (current && thread.ok) setProof(exchangeProof(waId, thread.data.items));
    })().catch(() => {
      // No proof: the paywall still renders, without the chat.
    });
    return () => {
      current = false;
    };
  }, [wabaId, active]);
  return proof;
}
