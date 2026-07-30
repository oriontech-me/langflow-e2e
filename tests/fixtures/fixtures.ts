// tests/fixtures.ts
import { test as base, expect, type Page } from "@playwright/test";
import { classifyHttpError } from "./http-error-policy";

/**
 * The escape hatches this fixture bolts onto `page`.
 *
 * Specs reach them through `(page as any)` today; this type exists so the two
 * names are discoverable and spelled consistently.
 */
export type PageWithErrorHooks = Page & {
  /** Flow-execution errors are expected in this test — do not fail on them. */
  allowFlowErrors: () => void;
  /**
   * Backend HTTP errors are expected in this test — do not report them.
   *
   * For specs that drive an endpoint into a 4xx/5xx **on purpose**, including
   * the ones that mock one with `page.route` (`execution-error-notification`
   * fulfils a 503, `llm-invalid-api-key-ui` a 500). Since HTTP errors are
   * advisory (below), this suppresses log noise rather than a failure — which is
   * the point: the fixture's only real gate is a human reading that log, so a
   * deliberately-provoked error sitting in it makes the log less trustworthy,
   * not more (#1084).
   */
  allowHttpErrors: () => void;
};

// Extend test to log backend errors
export const test = base.extend({
  page: async ({ page }, use) => {
    const errors: Array<{
      url: string;
      status: number;
      statusText: string;
      responseBody?: string;
      type?: string;
    }> = [];

    // Flag to allow flow errors (for tests that expect errors)
    let allowFlowErrors = false;
    // Same, for backend HTTP errors the test provokes deliberately.
    let allowHttpErrors = false;
    /**
     * Responses the policy chose not to report, by reason. Not printed unless
     * asked for: the Store 500s alone would put a line in every test's log, and
     * re-noising the log is exactly what #1084 was about. Set
     * `PW_HTTP_ERROR_DEBUG=1` to see them — useful when deciding whether the
     * ignore list is still right, or whether HTTP errors could start failing
     * tests (the open half of #1084).
     */
    const ignoredByPolicy = new Map<string, number>();

    // Add helper method to page context
    (page as any).allowFlowErrors = () => {
      allowFlowErrors = true;
    };
    (page as any).allowHttpErrors = () => {
      allowHttpErrors = true;
    };

    // Monitor API responses for errors
    page.on("response", async (response) => {
      const url = response.url();
      const status = response.status();

      // Report any backend 4xx/5xx the policy considers meaningful. The rules —
      // and the reason for each exemption — live in `http-error-policy.ts`,
      // where they are unit-tested; this used to be an inline list of four
      // status codes that silently missed 401/403/405/409/502/503 (#1084).
      const verdict = classifyHttpError({ url, status });
      if (!verdict.monitored) {
        // Only 4xx/5xx are worth accounting for. Counting every 2xx would put
        // "32× not an error status" in the debug breakdown and bury the entries
        // that answer the question it exists to answer.
        if (status >= 400) {
          ignoredByPolicy.set(
            verdict.ignoreReason,
            (ignoredByPolicy.get(verdict.ignoreReason) ?? 0) + 1,
          );
        }
      } else if (!allowHttpErrors) {
        console.log(
          `🚨 Backend Error: ${status} ${response.statusText()} - ${url}`,
        );
        // Recorded BEFORE the body is read, because reading it is an `await`
        // inside an async event handler and the fixture's teardown does not wait
        // for it. An error observed late in a test therefore raced the summary
        // below and could be dropped from the count — measured: a 405 fired at
        // the end of a test printed `🚨` with no `📋 Found N backend error(s)`
        // line at all. Since that summary is the whole gate for HTTP errors, an
        // undercount is the one failure this mechanism cannot afford (#1084).
        const entry: {
          url: string;
          status: number;
          statusText: string;
          responseBody?: string;
          type: string;
        } = {
          url,
          status,
          statusText: response.statusText(),
          type: "http_error",
        };
        errors.push(entry);
        try {
          entry.responseBody = await response.text();
          console.log(`   Response: ${entry.responseBody}`);
        } catch (e) {
          entry.responseBody = "Could not read response";
        }
      }

      // Monitor event delivery endpoints for error messages (streaming/polling/direct)
      if (
        status === 200 &&
        (url.includes("/events?event_delivery=") ||
          url.includes("/build/") ||
          url.includes("/run/"))
      ) {
        try {
          const headers = response.headers();
          const contentType = (headers["content-type"] || "").toLowerCase();
          const streamingContentHints = [
            "text/event-stream",
            "application/grpc",
            "application/octet-stream",
            "application/x-ndjson",
          ];
          const isStreamLike = streamingContentHints.some((hint) =>
            contentType.includes(hint),
          );
          if (isStreamLike) {
            console.log(
              `Skipping streaming response body parsing for ${url} (${contentType || "unknown content-type"})`,
            );
            return;
          }

          const READ_BODY_TIMEOUT_MS = 2000;
          const bodyTimeoutToken = Symbol("response-body-timeout");
          let responseBody: string | undefined;
          let timeoutId: ReturnType<typeof setTimeout> | undefined;

          try {
            const bodyResult = await Promise.race([
              response.text(),
              new Promise<symbol>((resolve) => {
                timeoutId = setTimeout(
                  () => resolve(bodyTimeoutToken),
                  READ_BODY_TIMEOUT_MS,
                );
              }),
            ]);

            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = undefined;
            }

            if (bodyResult === bodyTimeoutToken) {
              console.warn(
                `Timed out reading response body for ${url}; skipping body inspection.`,
              );
              return;
            }

            responseBody = bodyResult as string;
          } catch (bodyReadErr) {
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = undefined;
            }
            console.warn(
              `Failed to read response body for ${url}; skipping body inspection.`,
              bodyReadErr,
            );
            return;
          }

          if (!responseBody) {
            return;
          }

          // Try to parse as JSON and extract error details
          let errorPreview: string | null = null;
          let hasError = false;

          try {
            const lines = responseBody.split("\n");
            for (const line of lines) {
              if (line.trim()) {
                try {
                  const json = JSON.parse(line);

                  // Check for error in params field (build errors)
                  if (json.data?.build_data?.params?.startsWith("Error")) {
                    errorPreview = json.data.build_data.params;
                    hasError = true;
                    break;
                  }

                  // Check for error: true (not error: false)
                  if (json.data?.error === true || json.error === true) {
                    const errMsg =
                      json.data?.error_message ||
                      json.error_message ||
                      "Unknown error";
                    errorPreview = errMsg;
                    hasError = true;
                    break;
                  }
                } catch (lineParseErr) {
                  // Skip lines that aren't valid JSON
                }
              }
            }
          } catch (parseErr) {
            // Fallback to string search if JSON parsing completely fails
          }

          // Fallback: check for Python exceptions in the raw text
          if (!hasError) {
            const exceptionPatterns = [
              /NameError: .+/,
              /TypeError: .+/,
              /ValueError: .+/,
              /AttributeError: .+/,
              /ImportError: .+/,
              /KeyError: .+/,
              /An error occured .+/,
            ];

            for (const pattern of exceptionPatterns) {
              const match = responseBody.match(pattern);
              if (match) {
                errorPreview = match[0];
                hasError = true;
                break;
              }
            }
          }

          if (hasError && errorPreview) {
            console.log(`🚨 Flow Error Detected in Event Stream - ${url}`);
            console.log(`   Error: ${errorPreview}`);

            const error = {
              url,
              status: 200,
              statusText: "Flow Error",
              responseBody: errorPreview,
              type: "flow_error",
            };
            errors.push(error);

            // Fail immediately if flow errors are not allowed
            if (!allowFlowErrors) {
              const errorMessage =
                `Flow execution error detected during test:\n\n` +
                `URL: ${url}\n` +
                `Error: ${errorPreview}\n\n` +
                `If this error is expected, call page.allowFlowErrors() at the start of your test.`;

              // Use page.close() to fail the test immediately
              (page as any).emit("pageerror", new Error(errorMessage));
              throw new Error(errorMessage);
            }
          }
        } catch (e) {
          // Only ignore parsing errors, not our intentional throws
          if (
            e instanceof Error &&
            e.message.includes("Flow execution error")
          ) {
            throw e;
          }
          // Ignore parsing errors for event streams
        }
      }
    });

    await use(page);

    if (process.env.PW_HTTP_ERROR_DEBUG === "1" && ignoredByPolicy.size > 0) {
      const breakdown = [...ignoredByPolicy.entries()]
        .map(([reason, count]) => `      ${count}× ${reason}`)
        .join("\n");
      console.log(
        `\n🔎 HTTP responses ignored by policy (tests/fixtures/http-error-policy.ts):\n${breakdown}`,
      );
    }

    // Check for errors and fail test if not allowed
    if (errors.length > 0) {
      const flowErrors = errors.filter((e) => e.type === "flow_error");
      const httpErrors = errors.filter((e) => e.type === "http_error");

      console.log(`\n📋 Found ${errors.length} backend error(s) during test`);

      if (flowErrors.length > 0) {
        console.log(
          `   ⚠️  ${flowErrors.length} flow execution error(s) detected`,
        );
      }
      if (httpErrors.length > 0) {
        // Say what happens next, because nothing does. An HTTP error is logged
        // and never fails the test — on any path, for any endpoint — so the only
        // thing between a real backend 500 and a green run is someone reading
        // this line. Leaving that implicit is how the suite ended up with docs
        // claiming a gate it does not have (#1084).
        console.log(
          `   ⚠️  ${httpErrors.length} HTTP error(s) detected — ADVISORY: these do NOT fail the test. Review them before trusting this run.`,
        );
      }

      // Fail the test if flow errors occurred and weren't allowed
      if (flowErrors.length > 0 && !allowFlowErrors) {
        const errorDetails = flowErrors
          .map((e) => {
            const bodyPreview = e.responseBody
              ? e.responseBody.substring(0, 300)
              : "No response body";
            return `\n  - ${e.url}\n    ${bodyPreview}`;
          })
          .join("\n");

        throw new Error(
          `Test failed due to ${flowErrors.length} flow execution error(s):${errorDetails}\n\n` +
            `If this error is expected, call page.allowFlowErrors() at the start of your test.`,
        );
      }
    }
  },
});

export { expect };
