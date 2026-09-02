import { useState, type ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Logo } from "@/components/blocks/app-shell-7/components/logo";
import { AUTH_ERROR_BANNER_CLASS } from "@/components/auth/auth-page";
import {
  validateWorkspaceName,
  validateWorkspaceSlug,
} from "./validation";

type FormSubmitHandler = NonNullable<ComponentProps<"form">["onSubmit"]>;
export type FormSubmitEvent = Parameters<FormSubmitHandler>[0];

/**
 * Derive the workspace URL slug from its name: lowercase, ascii letters and
 * digits collapsed to single dashes. Pure and exported for tests.
 */
export function slugifyWorkspaceName(name: string): string {
  return name
    .toLowerCase()
    // NFKD splits an accented letter into base + combining mark, and the next
    // step drops the marks so "Clinica" stays one word instead of breaking at
    // the accent. `noMisleadingCharacterClass` is off in biome.json purely
    // because of that class: in Biome 1.9.4 the rule reads a range hyphen as a
    // base character, so any range whose upper bound is a combining mark is
    // reported (a lone combining mark in a class is not). No spelling of this
    // range gets past it, and the alternatives (\p{Mn}, \p{Diacritic}) widen
    // the matched set.
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

/** What both callers of the workspace form drive it with. */
export interface WorkspaceFormProps {
  name: string;
  onNameChange: (value: string) => void;
  slug: string;
  onSlugChange: (value: string) => void;
  error: string | null;
  pending: boolean;
  onSubmit: (event: FormSubmitEvent) => void;
  /** Server-side or caller-level errors, keyed "name" / "slug". */
  fieldErrors?: Record<string, string | null>;
  onFieldClear?: (key: string) => void;
}

/**
 * First-run workspace creation form (machine-voice labels, one green primary,
 * shared error banner). On success the caller performs the full navigation to
 * /numbers.
 *
 * This is the BRAND-SHELL version — logo, headline, first-run copy — for the
 * account that has no workspace yet. Creating an ADDITIONAL workspace happens
 * from inside the console instead (routes/workspaces.new.tsx), with the
 * console's own page chrome around the very same fields; that is why the form
 * body is its own component rather than this one growing a mode.
 */
export function WorkspaceForm(props: WorkspaceFormProps) {
  return (
    <div className="mx-auto flex w-full max-w-[22rem] flex-col gap-8">
      {/* Heading */}
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <Logo />
          <span className="text-foreground text-sm font-semibold tracking-[0.18em] uppercase">
            Eccos
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <h1 className="text-3xl leading-tight font-semibold text-balance">
            Create your workspace
          </h1>
          <p className="text-muted-foreground text-base text-pretty">
            Name your workspace to get your own Eccos account and start
            connecting WhatsApp numbers.
          </p>
        </div>
      </div>

      <WorkspaceFormFields idPrefix="onboarding" {...props} />
    </div>
  );
}

/**
 * The fields themselves: name, URL slug, the shared error banner, one green
 * primary. Validation runs on submit and clears on change.
 *
 * `idPrefix` namespaces the element ids and their `aria-describedby` targets so
 * two instances could coexist on one page without colliding; the first-run
 * screen keeps the `onboarding-*` ids it has always had.
 */
export function WorkspaceFormFields({
  idPrefix,
  name,
  onNameChange,
  slug,
  onSlugChange,
  error,
  pending,
  onSubmit,
  fieldErrors: externalErrors,
  onFieldClear,
  submitLabel = "Create workspace",
  pendingLabel = "Creating workspace…",
}: WorkspaceFormProps & {
  idPrefix: string;
  submitLabel?: string;
  pendingLabel?: string;
}) {
  const [localErrors, setLocalErrors] = useState<Record<string, string | null>>({});
  const fieldErrors = { ...localErrors, ...externalErrors };
  const clearField = (key: string) => {
    setLocalErrors((prev) => (prev[key] ? { ...prev, [key]: null } : prev));
    onFieldClear?.(key);
  };
  const nameId = `${idPrefix}-name`;
  const slugId = `${idPrefix}-slug`;
  const errorId = `${idPrefix}-error`;
  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      onSubmit={(event) => {
        const errors: Record<string, string | null> = {
          name: validateWorkspaceName(name),
          slug: validateWorkspaceSlug(slug),
        };
        if (Object.values(errors).some(Boolean)) {
          setLocalErrors(errors);
          return;
        }
        setLocalErrors({});
        onSubmit(event);
      }}
    >
      <FieldGroup className="gap-4">
        <Field className="gap-2">
          <FieldLabel
            htmlFor={nameId}
            className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
          >
            Workspace name
          </FieldLabel>
          <Input
            id={nameId}
            value={name}
            onChange={(event) => {
              onNameChange(event.target.value);
              clearField("name");
            }}
            autoComplete="organization"
            placeholder="Dunder Mifflin"
            aria-invalid={fieldErrors.name || error ? true : undefined}
            aria-describedby={
              [fieldErrors.name ? `${nameId}-error` : null, error ? errorId : null]
                .filter(Boolean)
                .join(" ") || undefined
            }
            maxLength={200}
          />
          {fieldErrors.name ? (
            <p id={`${nameId}-error`} className="text-destructive text-xs" role="alert">
              {fieldErrors.name}
            </p>
          ) : null}
        </Field>
        <Field className="gap-2">
          <FieldLabel
            htmlFor={slugId}
            className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
          >
            Workspace URL
          </FieldLabel>
          <Input
            id={slugId}
            value={slug}
            onChange={(event) => {
              onSlugChange(event.target.value);
              clearField("slug");
            }}
            autoComplete="off"
            className="font-mono"
            aria-invalid={fieldErrors.slug || error ? true : undefined}
            aria-describedby={
              [fieldErrors.slug ? `${slugId}-error` : null, error ? errorId : null]
                .filter(Boolean)
                .join(" ") || undefined
            }
          />
          <FieldDescription>
            Your workspace opens at app.eccos.chat/{slug || "workspace"}
          </FieldDescription>
          {fieldErrors.slug ? (
            <p id={`${slugId}-error`} className="text-destructive text-xs" role="alert">
              {fieldErrors.slug}
            </p>
          ) : null}
        </Field>
      </FieldGroup>

      {error ? (
        <p id={errorId} className={AUTH_ERROR_BANNER_CLASS} role="alert">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}
