import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { SetupScreen } from "../components/dashboard/setup-screen";
import { Page, Unreachable } from "../ui";

export const Route = createFileRoute("/setup")({
  component: SetupPage,
});

function SetupPage() {
  const state = useLoaderData({ from: "__root__" });
  if (!state.ok) {
    return (
      <main id="main-content" className="min-h-svh px-4 py-6 md:px-8 md:py-8">
        <Page title="Setup unavailable" kicker="First run">
          <Unreachable error={state.error} />
        </Page>
      </main>
    );
  }
  if (state.data.stage === "ready") return null;
  return <SetupScreen state={state.data} />;
}
