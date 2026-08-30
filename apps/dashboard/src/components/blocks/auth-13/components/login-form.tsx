import { type ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Logo } from "@/components/blocks/app-shell-7/components/logo";
import {
  AUTH_ERROR_BANNER_CLASS,
} from "@/components/auth/auth-page";
import { PasswordField } from "@/components/auth/password-field";
import { ArrowRightIcon } from "lucide-react";

type FormSubmitHandler = NonNullable<ComponentProps<"form">["onSubmit"]>;
export type FormSubmitEvent = Parameters<FormSubmitHandler>[0];

/**
 * Eccos sign-in form on the reui auth-13 split-screen skeleton.
 *
 * Design-contract adaptations vs the stock block: machine-voice labels
 * (11px uppercase, tracking-wider), dark-only palette, the real
 * email+password flow (the stock block's magic link and social logins do
 * not exist in Eccos), pending state, the shared anti-enumeration error
 * mapping, and no external image dependencies.
 */
export function LoginForm({
  onSubmit,
  error,
  pending,
  email,
  password,
  onEmailChange,
  onPasswordChange,
}: {
  onSubmit: (event: FormSubmitEvent) => void;
  error: string | null;
  pending: boolean;
  email: string;
  password: string;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
}) {
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
            Sign in
          </h1>
          <p className="text-muted-foreground text-base text-pretty">
            The self-hosted gateway for the official WhatsApp Cloud API.
          </p>
        </div>
      </div>

      {/* Form */}
      <form className="flex flex-col gap-5" onSubmit={onSubmit}>
        <FieldGroup className="gap-4">
          <Field className="gap-2">
            <FieldLabel
              htmlFor="signin-email"
              className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
            >
              Email
            </FieldLabel>
            <Input
              id="signin-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => onEmailChange(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "signin-error" : undefined}
              required
            />
          </Field>
          <PasswordField
            id="signin-password"
            label="Password"
            value={password}
            onChange={onPasswordChange}
            autoComplete="current-password"
            errorId={error ? "signin-error" : undefined}
            hasError={Boolean(error)}
            required
          />
        </FieldGroup>

        {error ? (
          <p
            id="signin-error"
            className={AUTH_ERROR_BANNER_CLASS}
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
            <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
          </Button>
          <a
            href="/forgot-password"
            className="text-muted-foreground text-xs hover:text-foreground"
          >
            Forgot password?
          </a>
        </div>
      </form>

      <div className="flex items-center gap-3">
        <Separator className="flex-1" />
        <span className="text-muted-foreground text-xs uppercase tracking-wider">
          New to Eccos
        </span>
        <Separator className="flex-1" />
      </div>

      <a href="/signup" className="block">
        <Button type="button" variant="outline" className="w-full">
          Create your account
        </Button>
      </a>
    </div>
  );
}
