/**
 * The first-run workspace form (eccos-0x0.5).
 *
 * There used to be a `slugifyWorkspaceName` helper here, and a "Workspace URL"
 * field for it to feed. Both are gone: the slug is a globally unique column
 * across every tenant, so deriving it from the customer's own workspace name
 * turned a name collision between two unrelated customers into an error message
 * in the browser — a cross-tenant existence oracle. It is now minted
 * server-side as an opaque UUID (`createOrganization`), and the field that
 * promised "Your workspace opens at app.eccos.chat/{slug}" — a URL that never
 * existed — went with it.
 *
 * These assertions are the guard against it coming back.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  WorkspaceForm,
  WorkspaceFormFields,
} from "../src/components/blocks/auth-13/components/workspace-form";

const noop = () => {};

function renderForm(): string {
  return renderToStaticMarkup(
    <WorkspaceForm
      name="Citta"
      onNameChange={noop}
      error={null}
      pending={false}
      onSubmit={noop}
    />,
  );
}

describe("WorkspaceForm: a name, and nothing else", () => {
  test("asks for the workspace name", () => {
    const html = renderForm();
    expect(html).toContain("Workspace name");
    expect(html).toContain('id="onboarding-name"');
    expect(html).toContain('value="Citta"');
  });

  test("has no workspace-URL field and makes no URL promise", () => {
    const html = renderForm();
    expect(html).not.toContain("Workspace URL");
    expect(html).not.toContain("onboarding-slug");
    expect(html).not.toContain("app.eccos.chat");
    expect(html.toLowerCase()).not.toContain("slug");
  });

  test("exactly one input: nothing else is collected at first run", () => {
    expect(renderForm().match(/<input/g)?.length).toBe(1);
  });
});

describe("WorkspaceFormFields: the same field inside the console", () => {
  test("the in-console form is the first-run form without the brand shell", () => {
    const html = renderToStaticMarkup(
      <WorkspaceFormFields
        idPrefix="new-workspace"
        name=""
        onNameChange={noop}
        error={null}
        pending={false}
        onSubmit={noop}
      />,
    );
    expect(html).toContain('id="new-workspace-name"');
    expect(html).not.toContain("new-workspace-slug");
    expect(html).not.toContain("Workspace URL");
    expect(html.match(/<input/g)?.length).toBe(1);
  });

  test("the error banner is addressed by the name field alone", () => {
    const html = renderToStaticMarkup(
      <WorkspaceFormFields
        idPrefix="new-workspace"
        name="Citta"
        onNameChange={noop}
        error="Could not create the workspace right now. Please try again."
        pending={false}
        onSubmit={noop}
      />,
    );
    expect(html).toContain('id="new-workspace-error"');
    expect(html).toContain('aria-describedby="new-workspace-error"');
    expect(html).toContain("Could not create the workspace right now.");
  });
});
