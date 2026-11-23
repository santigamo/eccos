import { useState, type FormEvent } from "react";
import { renameWorkspace } from "../../organizations";
import { failureCopy, type FailureCopy } from "../../lib/failure";
import { followSignIn } from "../../lib/follow-sign-in";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyButton } from "./copy-button";
import { RoleNote } from "./role-note";
import { ERROR_CLASS, MACHINE_CLASS } from "./plain-table";
import { Row, Rows, SectionFrame, SettingsSection } from "./settings-section";
import { StatusTag } from "../../ui";

export interface WorkspaceView {
  id: string;
  name: string;
  /** Better Auth's role string; may hold several comma-separated roles. */
  role: string;
}

/** `"owner,admin"` reads as "Owner, Admin". */
export function roleLabel(role: string): string {
  return role
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => name.charAt(0).toUpperCase() + name.slice(1))
    .join(", ");
}

export function WorkspacePanel({
  accountId,
  workspace,
  canRename,
  onRenamed,
  rename = renameWorkspace,
}: {
  accountId: string;
  workspace?: WorkspaceView | null;
  canRename?: boolean;
  onRenamed?: () => void;
  /** Test seam. */
  rename?: typeof renameWorkspace;
}) {
  return (
    <SettingsSection
      id="workspace"
      title="Workspace"
      description="Your numbers, keys and logs belong to this workspace. Support asks for its account ID."
    >
      <SectionFrame flush>
        <Rows>
          {workspace ? (
            <NameRow key={workspace.id} workspace={workspace} canRename={canRename} onRenamed={onRenamed} rename={rename} />
          ) : null}
          <Row label="Account ID" action={<CopyButton value={accountId} variant="outline" size="sm" />}>
            <span className="font-mono text-xs font-normal break-all">{accountId}</span>
          </Row>
          {workspace?.role ? (
            <Row label="Your role">
              <StatusTag status={roleLabel(workspace.role)} />
            </Row>
          ) : null}
        </Rows>
      </SectionFrame>
    </SettingsSection>
  );
}

function NameRow({
  workspace,
  canRename,
  onRenamed,
  rename,
}: {
  workspace: WorkspaceView;
  canRename?: boolean;
  onRenamed?: () => void;
  rename: typeof renameWorkspace;
}) {
  // The saved name shows at once and gives way the moment the server's name changes.
  const [saved, setSaved] = useState<string | null>(null);
  const [serverName, setServerName] = useState(workspace.name);
  if (workspace.name !== serverName) {
    setServerName(workspace.name);
    setSaved(null);
  }
  const name = saved ?? workspace.name;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refusal is a step not taken, not a fault: it reads like the role note, never in red.
  const [refusal, setRefusal] = useState<FailureCopy | null>(null);

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setRefusal(null);
    try {
      const res = await rename({ data: { organizationId: workspace.id, name: draft } });
      if (!res.ok) {
        if (res.kind === "forbidden") setRefusal(failureCopy(res));
        else setError(failureCopy(res).detail);
        return;
      }
      setSaved(res.data.name);
      setEditing(false);
      onRenamed?.();
    } catch (err) {
      if (followSignIn(err)) return;
      setError("Could not rename the workspace right now. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="px-5 py-3">
        <dt>
          <label htmlFor="workspace-name" className={`mb-1.5 block ${MACHINE_CLASS}`}>
            Name
          </label>
        </dt>
        <dd className="m-0">
          <form onSubmit={onSave} aria-busy={saving} className="flex flex-wrap items-center gap-2">
            <Input
              id="workspace-name"
              className="w-full max-w-sm"
              value={draft}
              maxLength={200}
              required
              autoFocus
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              data-form-type="other"
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button type="submit" variant="outline" size="sm" disabled={saving || !draft.trim() || draft.trim() === name}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setError(null);
                setRefusal(null);
              }}
            >
              Cancel
            </Button>
          </form>
          <div aria-live="polite">
            {error ? <p className={`m-0 ${ERROR_CLASS}`}>{error}</p> : null}
            {refusal ? (
              <div className="mt-3">
                <RoleNote copy={refusal} />
              </div>
            ) : null}
          </div>
        </dd>
      </div>
    );
  }

  return (
    <Row
      label="Name"
      action={
        canRename ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft(name);
              setEditing(true);
            }}
          >
            Rename
          </Button>
        ) : null
      }
    >
      {name}
    </Row>
  );
}
