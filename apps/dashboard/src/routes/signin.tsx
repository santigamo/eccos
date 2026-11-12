import { createFileRoute, useSearch } from "@tanstack/react-router";
import { SignInView } from "../components/blocks/auth-13/signin-view";
import { safeRedirectTarget } from "../auth/redirect-target";

type SigninSearch = { redirect?: string; error?: string; reauth?: true };

export const Route = createFileRoute("/signin")({
  validateSearch: (search: Record<string, unknown>): SigninSearch => {
    const redirect = safeRedirectTarget(
      typeof search.redirect === "string" ? search.redirect : undefined,
    );
    const error = typeof search.error === "string" ? search.error : undefined;
    return {
      ...(redirect ? { redirect } : {}),
      ...(error ? { error } : {}),
      ...(search.reauth === 1 || search.reauth === "1" ? { reauth: true as const } : {}),
    };
  },
  component: SignInPage,
});

function SignInPage() {
  const { redirect: rawRedirect, error: searchError, reauth } = useSearch({ from: "/signin" });
  // Re-validate: useSearch can also feed from internal navigation states.
  const redirectTo = safeRedirectTarget(rawRedirect) ?? "/";
  return (
    <SignInView redirectTo={redirectTo} searchError={searchError ?? null} reauth={reauth} />
  );
}
