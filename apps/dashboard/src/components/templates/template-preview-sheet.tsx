import { GridEmptyState } from "../grid/empty-state";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { previewBody } from "../../lib/template-params";

/**
 * "Preview" — the template as Meta will render it (eccos-6je,
 * docs/console-gaps-2026-09 §4), read straight from the row's already-fetched
 * `components`.
 *
 * `listTemplates` asks Meta for `message_templates?limit=N` with no `fields`
 * parameter, so the default response already carries the `components` array —
 * the browser has had the body, header, footer and buttons all along and never
 * drew them. This sheet draws them.
 *
 * The sheet is READ-ONLY by construction: it is the template itself, exactly
 * as the row describes it, so nothing here is filled in and no action is
 * offered. A `{{n}}` placeholder is a real thing Meta will fill; the preview
 * shows it as it is rather than pretending a value exists — the same rule and
 * the same `previewBody` the "Send test" sheet's preview uses, applied with
 * no values so every slot stays literal.
 *
 * `TemplatePreview` is exported on its own because the sheet around it is a
 * Base UI dialog: closed, it renders nothing at all, so a static-markup test
 * of `TemplatePreviewSheet` would assert against an empty string. Tests
 * render the inner preview — the same split as `SendTestForm`/
 * `CreateTemplateFields`.
 */

/** The subset of a Meta message-template component the preview reads. */
interface MetaComponent {
  type?: string;
  format?: string;
  text?: string;
  buttons?: unknown;
}

/** The subset of a Meta button component the preview reads. */
interface MetaButton {
  type?: string;
  text?: string;
  url?: string;
}

/** Everything the preview renders for one row, already parsed and ordered. */
export interface PreviewContent {
  /** The template's static HEADER text, if it carries one. */
  header: string;
  /** The BODY text; `{{n}}` placeholders left exactly as Meta authored them. */
  body: string;
  /** The static FOOTER text, if it has one. */
  footer: string;
  /** URL buttons in BUTTONS order; a dynamic URL keeps its `{{n}}`. */
  buttons: { label: string; url: string }[];
}

function upper(value: unknown): string {
  return typeof value === "string" ? value.toUpperCase() : "";
}

function text(part: MetaComponent | undefined): string {
  return typeof part?.text === "string" ? part.text : "";
}

/**
 * The pieces of a row's `components` that can be previewed.
 *
 * `null` means there is nothing to show — either the row carries no
 * `components` at all (Meta returned the default shape without one) or every
 * component came back empty. The caller renders the graceful empty state
 * instead of a blank sheet.
 */
export function previewContent(components: unknown): PreviewContent | null {
  if (!Array.isArray(components)) return null;
  const parts = components as MetaComponent[];

  const header = text(parts.find((part) => upper(part.type) === "HEADER"));
  const body = text(parts.find((part) => upper(part.type) === "BODY"));
  const footer = text(parts.find((part) => upper(part.type) === "FOOTER"));

  const buttonsPart = parts.find((part) => upper(part.type) === "BUTTONS");
  const buttons = Array.isArray(buttonsPart?.buttons)
    ? (buttonsPart.buttons as MetaButton[]).map((button) => ({
        label: typeof button.text === "string" ? button.text : "",
        url: typeof button.url === "string" ? button.url : "",
      }))
    : [];

  if (!header && !body && !footer && buttons.length === 0) return null;
  return { header, body, footer, buttons };
}

const LABEL =
  "mb-1 block text-[11px] font-medium tracking-wider text-muted-foreground uppercase";

export interface TemplatePreviewProps {
  components?: unknown;
}

export function TemplatePreview({ components }: TemplatePreviewProps) {
  const content = previewContent(components);
  if (content === null) {
    // Data rule 6: a structured empty state, never a lone muted line. The
    // sheet still opens — "what does this template look like?" is the
    // operator's question, and the honest answer is that there is nothing
    // to show.
    return (
      <div className="px-4 pb-4">
        <GridEmptyState
          label="No preview"
          description="Meta returned this template without a components array, so there is nothing to preview here."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-4 pb-4">
      {content.header ? (
        <div>
          <span className={LABEL}>Header</span>
          <p className="m-0 text-sm text-pretty text-foreground whitespace-pre-wrap">
            {content.header}
          </p>
        </div>
      ) : null}

      {content.body ? (
        <div>
          <span className={LABEL}>Body</span>
          {/* Quiet and inert — `--ghost-fill` is the ghost CONTROL body and a
              preview that wore it would read as something to click. Same panel
              as the send sheet's preview: square, muted, `whitespace-pre-wrap`. */}
          <p className="m-0 border border-(--line) bg-muted p-3 text-sm whitespace-pre-wrap text-foreground">
            {/* No values to fill, so every unfilled slot stays its literal
                `{{n}}` — the preview never pretends a value exists. */}
            {previewBody(content.body, [])}
          </p>
        </div>
      ) : null}

      {content.footer ? (
        <div>
          <span className={LABEL}>Footer</span>
          <p className="m-0 text-sm text-pretty text-foreground whitespace-pre-wrap">
            {content.footer}
          </p>
        </div>
      ) : null}

      {content.buttons.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className={LABEL}>Buttons</span>
          {content.buttons.map((button, index) => (
            // Buttons have no names — BUTTONS order is the only identity, the
            // list never reorders and its length is fixed by the template.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional by definition
            <div key={index} className="flex flex-col gap-1 border border-(--line) p-2.5">
              <span className="text-sm text-foreground">{button.label}</span>
              {button.url ? (
                // A URL button's URL is shown as-is; a dynamic URL (a `{{n}}`
                // placeholder) keeps it literal, the same convention as the
                // body — there are no values to fill in a preview.
                <span className="font-mono text-xs break-all text-muted-foreground">
                  {previewBody(button.url, [])}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The sheet around the preview.
 *
 * The title lives here rather than in `TemplatePreview` because Base UI's
 * `Dialog.Title` needs the dialog context — which is also why the preview is
 * what the tests render.
 */
export function TemplatePreviewSheet({
  open,
  onOpenChange,
  templateName,
  language,
  components,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templateName: string;
  language: string | undefined;
  components: unknown;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-2 overflow-y-auto sm:max-w-md">
        <SheetHeader className="gap-2">
          <SheetTitle className="font-mono text-sm break-all">
            {templateName} {language ? ` · ${language}` : ""}
          </SheetTitle>
        </SheetHeader>
        <TemplatePreview components={components} />
      </SheetContent>
    </Sheet>
  );
}
