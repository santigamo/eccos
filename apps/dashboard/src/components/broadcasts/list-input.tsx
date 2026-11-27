import { useId, useRef, useState, type DragEvent } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Textarea } from "@/components/ui/textarea";
import { isRefusal, type ListTable, listRefusalCopy, readList, readListFile } from "../../lib/list-file";
import { SUPPORT_TIER } from "../dashboard/plain-table";

const PLACEHOLDER = "+34 600 111 222\tAna\tFriday\n+34 600 333 444\tLuis\tSaturday";

/**
 * The list before it exists: paste rows from a spreadsheet, or choose or drop a
 * CSV. Paste is the path for Excel users, which is why `.xlsx` is refused with
 * a pointer back here. The list stays in this tab's memory.
 */
export function ListInput({ onList, onExample }: { onList: (table: ListTable) => void; onExample?: () => void }) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const id = useId();

  function take(result: ReturnType<typeof readList>) {
    if (isRefusal(result)) setRefusal(listRefusalCopy(result));
    else onList(result);
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    take(readListFile(file.name, new Uint8Array(await file.arrayBuffer())));
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    void readFile(event.dataTransfer.files[0]);
  }

  return (
    <div className="flex flex-col gap-3 p-5">
      <label htmlFor={id} className={SUPPORT_TIER}>
        Paste rows from Excel or Google Sheets, or type one phone number per line.
      </label>
      <Textarea
        id={id}
        value={text}
        rows={6}
        placeholder={PLACEHOLDER}
        className={`min-h-32 font-mono ${dragging ? "border-ring" : ""}`}
        onChange={(event) => setText(event.target.value)}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData("text/plain");
          if (!pasted.trim()) return;
          event.preventDefault();
          take(readList(pasted, null));
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>
          Choose a CSV file
        </Button>
        <span className={SUPPORT_TIER}>or drop it on the box.</span>
        {text.trim() ? (
          <Button type="button" variant="outline" onClick={() => take(readList(text, null))}>
            Use these rows
          </Button>
        ) : null}
        {onExample ? (
          <button type="button" onClick={onExample} className="ml-auto text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
            Download an example file for this template
          </button>
        ) : null}
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/plain"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            void readFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>
      <p className={`m-0 ${SUPPORT_TIER}`}>Your list stays in this browser tab until you send it.</p>
      <output aria-live="polite">{refusal ? <Callout tone="error">{refusal}</Callout> : null}</output>
    </div>
  );
}
