import { createFileRoute, useSearch } from "@tanstack/react-router";
import { SignUpView } from "../components/blocks/auth-13/signup-view";
import { safeRedirectTarget } from "../auth/redirect-target";

type SignupSearch = { redirect?: string };

/** Only a console page survives as the place to land after verifying. */
export function signupSearch(search: Record<string, unknown>): SignupSearch {
  const redirect = safeRedirectTarget(typeof search.redirect === "string" ? search.redirect : undefined);
  return redirect ? { redirect } : {};
}

export const Route = createFileRoute("/signup")({
  validateSearch: signupSearch,
  component: SignUpPage,
});

function SignUpPage() {
  const { redirect } = useSearch({ from: "/signup" });
  return <SignUpView redirectTo={redirect} />;
}
