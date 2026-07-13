import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

// The getting-started tracker is per-user backend state (optins) plus a
// flow-existence step, surfaced as a percentage in the home sidebar. This spec
// drives the auto_login superuser — a stable session with no fragile multi-user
// login (the previous fresh-user design was flaky: 1-of-2 runs died in the
// Admin-Page user-creation/login flow) — and it is the ONLY spec that touches
// the superuser's optins or the getting-started widget, so the shared state is
// not contended under the parallel @stable suite. The flow step is satisfied by
// a flow this spec owns and cleans up (id-scoped); other workers' flows only
// keep the binary "has >=1 flow" true, never break it. Removing this spec as
// the last cleanAllFlows caller means no @stable spec wipes flows globally.

let createdFlowId: string | undefined;

async function superuserAuth(request: APIRequestContext): Promise<string> {
  const res = await request.get("/api/v1/auto_login");
  const { access_token } = await res.json();
  return `Bearer ${access_token}`;
}

async function resetOptins(
  request: APIRequestContext,
  bearer: string,
): Promise<void> {
  const who = await request.get("/api/v1/users/whoami", {
    headers: { Authorization: bearer },
  });
  const { id } = await who.json();
  await request.patch(`/api/v1/users/${id}`, {
    headers: { Authorization: bearer },
    data: {
      optins: {
        github_starred: false,
        discord_clicked: false,
        dialog_dismissed: false,
      },
    },
  });
}

// Start every run from a provably-zero tracked state.
test.beforeEach(async ({ request }) => {
  await resetOptins(request, await superuserAuth(request));
});

// Delete the owned flow (id-scoped) and leave optins reset so repeat runs and
// unrelated specs never see stale getting-started state.
test.afterEach(async ({ request }) => {
  const bearer = await superuserAuth(request);
  if (createdFlowId) {
    await deleteFlow(request, createdFlowId, {
      headers: { Authorization: bearer },
    }).catch(() => {});
    createdFlowId = undefined;
  }
  await resetOptins(request, bearer);
});

test(
  "getting-started progress increments as onboarding steps complete",
  { tag: ["@stable", "@release", "@database", "@mainpage", "@ui-ux"] },
  async ({ page, context, request }) => {
    const bearer = await superuserAuth(request);

    await test.step("own a flow so the flow step is done and the widget renders", async () => {
      // API-created (id-scoped) rather than via the empty page: the empty page
      // requires zero flows globally, which the parallel suite cannot promise.
      createdFlowId = await createFlow(
        request,
        {
          name: `progress-track-${Date.now()}`,
          description: "",
          data: { nodes: [], edges: [] },
          is_component: false,
        },
        { headers: { Authorization: bearer } },
      );
    });

    await test.step("baseline: widget shows 33% (flow step only)", async () => {
      await page.goto("/");
      await expect(
        page.getByTestId("get_started_progress_title"),
      ).toBeVisible({ timeout: 15000 });
      // Causal 33%: exactly the flow step done, both optins reset to false.
      await expect(
        page.getByTestId("get_started_progress_percentage").first(),
      ).toHaveText("33%");
      await expect(
        page.getByTestId("github_starred_icon_get_started"),
      ).toHaveCount(0);
      await expect(
        page.getByTestId("discord_joined_icon_get_started"),
      ).toHaveCount(0);
    });

    await test.step("completing the GitHub step advances to 66%", async () => {
      const popup = context.waitForEvent("page");
      await page.getByTestId("github_starred_btn_get_started").click();
      await (await popup).close();
      await expect(
        page.getByTestId("get_started_progress_percentage").first(),
      ).toHaveText("66%");
      await expect(
        page.getByTestId("github_starred_icon_get_started"),
      ).toBeVisible();
    });

    await test.step("completing the Discord step advances to 100%", async () => {
      const popup = context.waitForEvent("page");
      await page.getByTestId("discord_joined_btn_get_started").click();
      await (await popup).close();
      await expect(
        page.getByTestId("get_started_progress_percentage").first(),
      ).toHaveText("100%");
      await expect(
        page.getByTestId("discord_joined_icon_get_started"),
      ).toBeVisible();
    });

    await test.step("backend tracks both optins as done", async () => {
      // The tracked state itself: the UI percentage is derived from these.
      const who = await request.get("/api/v1/users/whoami", {
        headers: { Authorization: bearer },
      });
      const { optins } = await who.json();
      expect(optins.github_starred, "github optin must persist").toBe(true);
      expect(optins.discord_clicked, "discord optin must persist").toBe(true);
    });
  },
);
