import { createFileRoute, useSearch } from "@tanstack/react-router";
import { SignInView } from "../components/blocks/auth-13/signin-view";
import { safeRedirectTarget } from "../components/auth/auth-page";

type SigninSearch = { redirect?: string; error?: string };

export const Route = createFileRoute("/signin")({
  validateSearch: (search: Record<string, unknown>): SigninSearch => {
    const redirect = safeRedirectTarget(
      typeof search.redirect === "string" ? search.redirect : undefined,
    );
    const error = typeof search.error === "string" ? search.error : undefined;
    return {
      ...(redirect ? { redirect } : {}),
      ...(error ? { error } : {}),
    };
  },
  component: SignInPage,
});

function SignInPage() {
  const { redirect: rawRedirect, error: searchError } = useSearch({ from: "/signin" });
  // Re-validate: useSearch can also feed from internal navigation states.
  const redirectTo = safeRedirectTarget(rawRedirect) ?? "/";
  return (
    <SignInView redirectTo={redirectTo} searchError={searchError ?? null} />
  );
}
