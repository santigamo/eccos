import { useNavigate, useRouter } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { normalizeCustomerId } from "../../lib/customer-id";
import { invalidatePage } from "../../lib/invalidate";
import type { SendTestPhone } from "../templates/send-test-sheet";
import { SendTemplateSheet } from "./send-template-sheet";

interface NewConversationProps {
  wabaId: string;
  linkWabaId: string | null;
  phones: SendTestPhone[];
}

/** Starts a thread with a number that has none yet: an approved template, sent from the first phone. */
export function NewConversation({ wabaId, linkWabaId, phones }: NewConversationProps) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const router = useRouter();
  if (phones.length === 0) return null;

  async function onSent(recipient: string) {
    setOpen(false);
    const waId = normalizeCustomerId(recipient);
    // After the navigation: one still running would cancel this reload.
    if (waId) await navigate({ to: "/conversations", search: { wabaId: linkWabaId ?? undefined, waId } });
    void invalidatePage(router);
  }

  return (
    <>
      <Button type="button" size="sm" className="rounded-none" onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden="true" />
        New conversation
      </Button>
      <SendTemplateSheet
        open={open}
        onOpenChange={setOpen}
        title="New conversation"
        description="WhatsApp only lets a business start a conversation with an approved template."
        wabaId={wabaId}
        phoneNumberId={phones[0]?.phoneNumberId ?? ""}
        phones={phones}
        onSent={onSent}
      />
    </>
  );
}
