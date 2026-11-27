import { useState } from "react";
import { Link, useLoaderData } from "@tanstack/react-router";
import { templateRowsOf } from "@eccos/core/template-rules";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "../reui/frame";
import { FailureView } from "../dashboard/failure";
import { GridEmptyState } from "../grid/empty-state";
import { INLINE_LINK, Page } from "../../ui";
import type { Result, TemplatesResult } from "../../server/gateway";
import { peekHandoff } from "../../lib/template-handoff";
import type { TemplateRecord } from "../../lib/template-view";
import { TemplateEditor, type TemplateEditorProps } from "./template-editor";

/**
 * The authoring routes' shared frame: the template list as loaded, the WABA in
 * scope, and the states that come before the editor (a failed read, no WABA, a
 * name that is not on this account).
 */
export function AuthoringScreen({
  result,
  title,
  ...editor
}: Omit<TemplateEditorProps, "wabaId" | "businessName" | "rows" | "phones"> & { result: Result<TemplatesResult>; title: string }) {
  const root = useLoaderData({ from: "__root__" });
  // Latched: the editor drops the handoff on mount, and the list may not hold the new name yet.
  const [handedOff] = useState(() => Boolean(editor.name && peekHandoff(editor.name)));
  const ready = root.ok && root.data.stage === "ready" ? root.data.scope : null;
  const wabaId = editor.wabaParam ?? ready?.selectedWabaId;
  const phones = ready?.resources.wabas.find((waba) => waba.wabaId === wabaId)?.phones ?? [];
  const businessName = phones[0]?.displayPhoneNumber || "Your business";

  if (!result.ok) {
    return (
      <Page title={title} kicker="Cloud API">
        <FailureView failure={result} />
      </Page>
    );
  }
  if (!result.data.ok || !wabaId) {
    return (
      <Page title={title} kicker="Cloud API">
        <Frame variant="default" spacing="sm">
          <FramePanel fit>
            <FrameHeader>
              <FrameTitle>Failed to load templates</FrameTitle>
              <FrameDescription>
                The gateway could not read this account's templates, so the template cannot be authored here yet.
              </FrameDescription>
            </FrameHeader>
          </FramePanel>
        </Frame>
      </Page>
    );
  }

  const rows = templateRowsOf(result.data.data) as TemplateRecord[];
  const name = editor.name;
  if (editor.mode === "edit" && name && !rows.some((row) => row.name === name) && !handedOff) {
    return (
      <Page title={title} kicker="Cloud API">
        <GridEmptyState
          label="NOT FOUND"
          description="No template with this name is among the templates loaded for this WhatsApp Business Account. It may have been deleted."
          action={
            <Link to="/templates" search={{ wabaId: editor.wabaParam }} className={`text-sm ${INLINE_LINK}`}>
              Back to templates
            </Link>
          }
        />
      </Page>
    );
  }

  const canOperate = root.ok && "canOperate" in root.data && root.data.canOperate;
  return <TemplateEditor {...editor} wabaId={wabaId} businessName={businessName} rows={rows} phones={phones} canOperate={canOperate} />;
}
