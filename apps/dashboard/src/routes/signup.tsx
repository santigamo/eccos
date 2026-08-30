import { createFileRoute } from "@tanstack/react-router";
import { SignUpView } from "../components/blocks/auth-13/signup-view";

export const Route = createFileRoute("/signup")({
  component: SignUpPage,
});

function SignUpPage() {
  return <SignUpView />;
}
