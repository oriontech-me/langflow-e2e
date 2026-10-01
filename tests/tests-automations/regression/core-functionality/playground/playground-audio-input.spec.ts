import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createFlowFromStarter } from "../../../../helpers/flows/create-flow-from-starter";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

// The audio button transcribes through the BROWSER's speech recognition
// (hooks/use-audio-recording.ts), which headless Chromium cannot serve. This fake
// is the exact surface the hook consumes: start() -> onstart, stop() -> onend, and
// window.__emitSpeech() -> onresult. See docs/core-functionality/playground/playground-audio-input.md.
const FAKE_SPEECH_RECOGNITION = `
  window.__speechStarts = 0;
  class FakeSpeechRecognition {
    constructor() { window.__speech = this; }
    start() { window.__speechStarts++; setTimeout(() => this.onstart && this.onstart(), 0); }
    stop() { setTimeout(() => this.onend && this.onend(), 0); }
    abort() { setTimeout(() => this.onend && this.onend(), 0); }
  }
  window.SpeechRecognition = FakeSpeechRecognition;
  window.webkitSpeechRecognition = FakeSpeechRecognition;
  window.__emitSpeech = (transcript, isFinal) => {
    window.__speech.onresult({ resultIndex: 0, results: [{ 0: { transcript }, isFinal, length: 1 }] });
  };
`;

const NO_SPEECH_RECOGNITION = `
  delete window.SpeechRecognition;
  delete window.webkitSpeechRecognition;
  Object.defineProperty(window, "webkitSpeechRecognition", { value: undefined, configurable: true });
`;

let flowId: string | null = null;

test.afterEach(async ({ request }) => {
  if (flowId) {
    const auth = await getAuthToken(request);
    await deleteFlow(request, flowId, auth ? { headers: { Authorization: auth } } : undefined);
  }
  flowId = null;
});

async function openPlayground(page: Page, initScript: string): Promise<void> {
  await page.addInitScript(initScript);
  flowId = await createFlowFromStarter(page.request, "Basic Prompting", `audio-input-${Date.now()}`);
  await page.goto(`/flow/${flowId}`);
  await page.getByTestId("playground-btn-flow-io").click();
  await expect(page.getByTestId("audio-button")).toBeVisible({ timeout: 30000 });
}

async function startRecording(page: Page): Promise<void> {
  await page.getByTestId("audio-button").click();
  await expect(page.getByTestId("audio-button")).toHaveAttribute("aria-pressed", "true");
}

test(
  "the audio button is disabled in a browser without speech recognition",
  { tag: ["@stable", "@release", "@playground"] },
  async ({ page }) => {
    await test.step("open the playground with the speech recognition API removed", async () => {
      await openPlayground(page, NO_SPEECH_RECOGNITION);
    });

    await test.step("the button is disabled and says why", async () => {
      const button = page.getByTestId("audio-button");
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute("aria-label", "Voice input not supported in this browser");
    });
  },
);

test(
  "a click starts speech recognition and a second click stops it",
  { tag: ["@stable", "@release", "@playground"] },
  async ({ page }) => {
    const button = page.getByTestId("audio-button");

    await test.step("open the playground with speech recognition available", async () => {
      await openPlayground(page, FAKE_SPEECH_RECOGNITION);
      await expect(button).toHaveAttribute("aria-label", "Voice input");
      await expect(button).toHaveAttribute("aria-pressed", "false");
    });

    await test.step("the first click starts recognition", async () => {
      await startRecording(page);
      await expect(button).toHaveAttribute("aria-label", "Stop recording");
      expect(await page.evaluate(() => (window as unknown as { __speechStarts: number }).__speechStarts)).toBe(1);
    });

    await test.step("the second click stops it and returns to idle", async () => {
      await page.evaluate(() =>
        (window as unknown as { __emitSpeech: (t: string, f: boolean) => void }).__emitSpeech("stop check", true),
      );
      await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "false");
      await expect(button).toHaveAttribute("aria-label", "Voice input");
    });
  },
);

test(
  "the final transcript is appended to the text already in the input",
  { tag: ["@stable", "@release", "@playground"] },
  async ({ page }) => {
    const input = page.getByTestId("input-chat-playground");
    const finalToken = `final-${Date.now()}`;
    const interimToken = `interim-${Date.now()}`;

    await test.step("open the playground and type some text", async () => {
      await openPlayground(page, FAKE_SPEECH_RECOGNITION);
      await input.fill("existing text");
    });

    await test.step("dictate an interim and then a final result, and stop", async () => {
      await startRecording(page);
      await page.evaluate(
        ([interim, final]) => {
          const emit = (window as unknown as { __emitSpeech: (t: string, f: boolean) => void }).__emitSpeech;
          emit(interim, false);
          emit(final, true);
        },
        [interimToken, finalToken],
      );
      await page.getByTestId("audio-button").click();
    });

    await test.step("only the final transcript is appended, after one space", async () => {
      await expect(input).toHaveValue(`existing text ${finalToken}`);
    });
  },
);

test(
  "stopping with no speech shows the voice input error and leaves the input alone",
  { tag: ["@stable", "@release", "@playground"] },
  async ({ page }) => {
    const input = page.getByTestId("input-chat-playground");
    const button = page.getByTestId("audio-button");

    await test.step("open the playground and type some text", async () => {
      await openPlayground(page, FAKE_SPEECH_RECOGNITION);
      await input.fill("untouched text");
    });

    await test.step("start and stop recording without any speech", async () => {
      await startRecording(page);
      await button.click();
    });

    await test.step("the error is shown and the input is unchanged", async () => {
      await expect(page.getByText("Voice Input Error")).toBeVisible();
      await expect(page.getByText("No speech was detected. Please try again.")).toBeVisible();
      await expect(input).toHaveValue("untouched text");
      await expect(button).toHaveAttribute("aria-pressed", "false");
    });
  },
);
