import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, mock, test } from "bun:test";
import { installServerFnMocks } from "./helpers/server-fn-mocks";

/**
 * A partly failed create lands on `/templates/$name` with a handoff that the
 * editor drops on mount. The list read behind it may not hold the new name yet
 * (Meta lag, or the 100-row cap), so the page must latch the handoff: a tab
 * click re-renders the screen, and it must not turn into NOT FOUND.
 */

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installServerFnMocks({ env: { BETTER_AUTH_URL: "http://localhost:3000" } });

const routerModule = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...routerModule,
  useBlocker: () => ({ status: "idle" }),
  useNavigate: () => () => {},
  useRouter: () => ({ invalidate: async () => {} }),
  useLoaderData: () => ({ ok: true, data: { stage: "ready", scope: { selectedWabaId: "W", resources: { wabas: [] } } } }),
  Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AuthoringScreen } = await import("../src/components/templates/authoring-screen");
const { peekHandoff, putHandoff } = await import("../src/lib/template-handoff");

afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const draft = (language: string, body: string) => ({ language, body, examples: [], footer: "", buttons: [] });

test("the handoff page survives the next render after the handoff is dropped", async () => {
  putHandoff("shipping_delay", {
    category: "UTILITY",
    languages: {
      en_US: { added: true, sent: draft("en_US", "Your order is running a couple of days late.") },
      es: { added: true, draft: draft("es", "Tu pedido llega con un par de días de retraso."), error: { title: "t", detail: "d" } },
    },
    receipt: "",
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const screen = (language: string) => (
    <AuthoringScreen
      result={{ ok: true, data: { ok: true, data: { data: [] } } } as never}
      title="shipping_delay"
      mode="edit"
      wabaParam="W"
      name="shipping_delay"
      language={language}
      onLanguage={() => {}}
    />
  );
  await act(async () => root.render(screen("es")));
  expect(peekHandoff("shipping_delay")).toBeUndefined();
  expect(host.textContent).toContain("Retry Spanish");

  // A tab click: the same screen, another `?language=`.
  await act(async () => root.render(screen("en_US")));
  expect(host.textContent).not.toContain("NOT FOUND");
  expect(host.textContent).toContain("Meta is reviewing English (US)");
  act(() => root.unmount());
});
