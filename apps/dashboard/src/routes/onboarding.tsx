import { createFileRoute } from "@tanstack/react-router";
import { OnboardingView } from "../components/blocks/auth-13/onboarding-view";

export const Route = createFileRoute("/onboarding")({
  component: OnboardingPage,
});

function OnboardingPage() {
  return <OnboardingView />;
}
