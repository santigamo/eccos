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

/**
 * First-run workspace creation form (machine-voice labels, one green primary,
 * shared error banner). On success the caller performs the full navigation to
 * /numbers.
 */
export function WorkspaceForm({
  name,
  onNameChange,
  slug,
  onSlugChange,
  error,
  pending,
  onSubmit,
  fieldErrors: externalErrors,
  onFieldClear,
}: {
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
}) {
  const [localErrors, setLocalErrors] = useState<Record<string, string | null>>({});
  const fieldErrors = { ...localErrors, ...externalErrors };
  const clearField = (key: string) => {
    setLocalErrors((prev) => (prev[key] ? { ...prev, [key]: null } : prev));
    onFieldClear?.(key);
  };
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

      {/* Form */}
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
              htmlFor="onboarding-name"
              className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
            >
              Workspace name
            </FieldLabel>
            <Input
              id="onboarding-name"
              value={name}
              onChange={(event) => {
                onNameChange(event.target.value);
                clearField("name");
              }}
              autoComplete="organization"
              placeholder="Dunder Mifflin"
              aria-invalid={fieldErrors.name || error ? true : undefined}
              aria-describedby={
                [fieldErrors.name ? "onboarding-name-error" : null, error ? "onboarding-error" : null]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              maxLength={200}
            />
            {fieldErrors.name ? (
              <p id="onboarding-name-error" className="text-destructive text-xs" role="alert">
                {fieldErrors.name}
              </p>
            ) : null}
          </Field>
          <Field className="gap-2">
            <FieldLabel
              htmlFor="onboarding-slug"
              className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
            >
              Workspace URL
            </FieldLabel>
            <Input
              id="onboarding-slug"
              value={slug}
              onChange={(event) => {
                onSlugChange(event.target.value);
                clearField("slug");
              }}
              autoComplete="off"
              className="font-mono"
              aria-invalid={fieldErrors.slug || error ? true : undefined}
              aria-describedby={
                [fieldErrors.slug ? "onboarding-slug-error" : null, error ? "onboarding-error" : null]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
            />
            <FieldDescription>
              Your workspace opens at app.eccos.chat/{slug || "workspace"}
            </FieldDescription>
            {fieldErrors.slug ? (
              <p id="onboarding-slug-error" className="text-destructive text-xs" role="alert">
                {fieldErrors.slug}
              </p>
            ) : null}
          </Field>
        </FieldGroup>

        {error ? (
          <p
            id="onboarding-error"
            className={AUTH_ERROR_BANNER_CLASS}
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Creating workspace…" : "Create workspace"}
        </Button>
      </form>
    </div>
  );
}
