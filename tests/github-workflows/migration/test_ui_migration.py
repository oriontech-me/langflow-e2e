"""Phase 3b: Playwright UI tests for migration verification.

Tests:
1. Open the migrated flow in the UI
2. Check for component error messages
3. Check for "Updates are available" banner
4. Update components via Review All → Select All → Update Components
5. Execute the flow from the Playground UI
"""

import os
import re
import time

import pytest
from playwright.sync_api import Page, expect

from . import state_store

STATE_FILE = os.environ.get("STATE_FILE", "/tmp/migration-test-state.json")

PHASE = "nightly_ui"


def save_ui_state(results: dict):
    """Merge this test's results into the shared state file's `nightly_ui` phase.

    Merges rather than assigns (#1120). `setup` below is an autouse fixture, so
    pytest hands each test method a fresh `self.results`; the previous
    `state["phases"]["nightly_ui"] = results` therefore erased every step recorded
    before it. Run #115 ran six UI tests and the report showed one row. The contract
    and its unit tests live in `state_store.py`.
    """
    state_store.save_phase(PHASE, results, state_file=STATE_FILE)


class TestMigrationUI:
    """UI tests for the migrated flow."""

    @pytest.fixture(autouse=True)
    def setup(self, page: Page, langflow_url: str, flow_id: str):
        self.page = page
        self.base_url = langflow_url
        self.flow_id = flow_id
        self.results = {"steps": {}, "start_time": time.time()}

        # Increase default timeout for CI environments
        page.set_default_timeout(30_000)

    def _save_results(self):
        self.results["end_time"] = time.time()
        self.results["duration_s"] = round(
            self.results["end_time"] - self.results["start_time"], 1
        )
        save_ui_state(self.results)

    def test_01_open_flow(self):
        """Navigate to the migrated flow in the editor."""
        self.page.goto(f"{self.base_url}/flow/{self.flow_id}", wait_until="networkidle")
        self.page.wait_for_timeout(5000)

        # Verify the flow editor loaded: check the URL still contains the flow_id
        # (not redirected to home/login) and that the page has interactive content.
        # Avoids coupling to ReactFlow's internal CSS class names which change across versions.
        expect(self.page).to_have_url(re.compile(self.flow_id), timeout=20_000)

        # Also verify the React app div is in the DOM (not a blank/loading screen).
        # Uses state="attached" to avoid matching the invisible <noscript> sibling.
        self.page.wait_for_selector("body > div", state="attached", timeout=10_000)

        self.results["steps"]["open_flow"] = {"status": "pass"}
        self._save_results()

    def test_02_check_component_errors(self):
        """Check if any component error messages appear after migration."""
        self.page.goto(f"{self.base_url}/flow/{self.flow_id}", wait_until="networkidle")
        self.page.wait_for_timeout(5000)

        # Look for error indicators: red error toasts/banners
        error_elements = self.page.locator(
            "[class*='error' i], [class*='destructive' i], "
            "[data-testid*='error' i]"
        ).all()

        error_texts = []
        for el in error_elements:
            if el.is_visible():
                text = el.inner_text()
                if text.strip() and "error" in text.lower():
                    error_texts.append(text.strip()[:200])

        # Also check for the specific error toast from the screenshot
        error_toast = self.page.locator("text=/Error while updating/i")
        if error_toast.count() > 0 and error_toast.first.is_visible():
            error_texts.append(error_toast.first.inner_text()[:200])

        # Check for import errors
        import_error = self.page.locator("text=/ImportError|Cannot import/i")
        if import_error.count() > 0 and import_error.first.is_visible():
            error_texts.append(import_error.first.inner_text()[:200])

        has_errors = len(error_texts) > 0
        self.results["steps"]["component_errors"] = {
            "status": "fail" if has_errors else "pass",
            "errors_found": error_texts,
        }
        self._save_results()

        if has_errors:
            self.page.screenshot(path="test-results/component-errors.png")
            self._save_results()
            pytest.fail(f"Component errors detected after migration: {error_texts}")

    def test_03_check_update_banner(self):
        """Check if 'Updates are available' banner appears."""
        self.page.goto(f"{self.base_url}/flow/{self.flow_id}", wait_until="networkidle")
        self.page.wait_for_timeout(5000)

        # Look for the update banner
        update_banner = self.page.locator("text=/Updates are available/i")
        banner_visible = update_banner.count() > 0 and update_banner.first.is_visible()

        # Also check individual component update badges
        update_badges = self.page.locator("text=/Update available/i")
        badge_count = 0
        if update_badges.count() > 0:
            for i in range(update_badges.count()):
                if update_badges.nth(i).is_visible():
                    badge_count += 1

        self.results["steps"]["update_banner"] = {
            "status": "pass",
            "banner_visible": banner_visible,
            "component_update_count": badge_count,
        }
        self._save_results()

    def test_04_update_components(self):
        """Update all components via Review All → Select All → Update Components."""
        self.page.goto(f"{self.base_url}/flow/{self.flow_id}", wait_until="networkidle")
        self.page.wait_for_timeout(5000)

        # Check if "Review All" button exists
        review_all_btn = self.page.locator("button:has-text('Review All'), button:has-text('Review all')")

        if review_all_btn.count() == 0 or not review_all_btn.first.is_visible():
            self.results["steps"]["update_components"] = {
                "status": "skip",
                "detail": "No 'Review All' button found — no updates needed",
            }
            self._save_results()
            return

        # Click "Review All"
        review_all_btn.first.click()
        self.page.wait_for_timeout(2000)

        # Wait for the modal to appear
        modal = self.page.locator(
            "[role='dialog'], [class*='modal' i], "
            "div:has-text('Update components')"
        )
        expect(modal.first).to_be_visible(timeout=10_000)

        # Screenshot the update modal
        self.page.screenshot(path="test-results/update-modal.png")

        # Click the "Component" header checkbox to select all components
        # The checkbox is in the table header row
        header_checkbox = self.page.locator(
            "th input[type='checkbox'], "
            "thead input[type='checkbox'], "
            "[role='dialog'] input[type='checkbox']:first-of-type, "
            "label:has-text('Component') input[type='checkbox']"
        )

        if header_checkbox.count() > 0:
            # Check if already checked
            first_cb = header_checkbox.first
            if not first_cb.is_checked():
                first_cb.click()
                self.page.wait_for_timeout(500)
        else:
            # Fallback: try to find and click individual checkboxes
            checkboxes = self.page.locator("[role='dialog'] input[type='checkbox']")
            for i in range(checkboxes.count()):
                cb = checkboxes.nth(i)
                if cb.is_visible() and not cb.is_checked():
                    cb.click()
                    self.page.wait_for_timeout(200)

        # Click "Update Components" button
        update_btn = self.page.locator(
            "button:has-text('Update Components'), button:has-text('Update components')"
        )
        expect(update_btn.first).to_be_visible(timeout=5_000)
        update_btn.first.click()

        # Wait for update to complete (modal should close or show success)
        self.page.wait_for_timeout(5000)

        # Check if modal closed (success)
        modal_still_open = modal.first.is_visible() if modal.count() > 0 else False

        # Check for any error after update
        post_update_error = self.page.locator("text=/Error|Failed/i")
        has_error = False
        error_text = ""
        if post_update_error.count() > 0:
            for i in range(post_update_error.count()):
                el = post_update_error.nth(i)
                if el.is_visible():
                    t = el.inner_text()
                    if "error" in t.lower() or "failed" in t.lower():
                        has_error = True
                        error_text = t[:200]
                        break

        self.results["steps"]["update_components"] = {
            "status": "fail" if has_error else "pass",
            "modal_closed": not modal_still_open,
            "error_after_update": error_text if has_error else None,
        }
        self._save_results()

        self.page.screenshot(path="test-results/after-update-components.png")

    def test_05_execute_flow_ui(self):
        """Execute the flow from the Playground UI.

        ## Selectors (#1120)

        Every locator below is one the TypeScript suite drives against live Langflow
        — `playground-btn-flow-io` (81 call sites), `input-chat-playground` (125),
        `button-send` (74), `button-stop` (18), `div-chat-message` (51). The previous
        version invented its own and two of them matched nothing:

        - `[data-testid='playground-btn']` — never existed.
        - `button[data-testid='send-button']` — never existed either, so the
          `button:has(svg):near(textarea)` fallback clicked some *other* svg button
          near the textarea and `click()` timed out after 30 s. That is the failure
          that opened this issue.

        ## No conditional bypasses

        The old body was a chain of `if count() > 0 and is_visible(): … else:
        status="skip"; return`, and its final verdict could only be `pass` or
        `warn` — so a Playground that never rendered, or a flow that answered
        nothing, was recorded as a non-failure. This test now fails when the
        Playground does not open, when the reply never arrives, or when the reply is
        empty.
        """
        self.page.goto(f"{self.base_url}/flow/{self.flow_id}", wait_until="networkidle")

        # Open the Playground. A migrated flow that cannot open its Playground is a
        # migration failure, so this is asserted, not probed.
        self.page.get_by_test_id("playground-btn-flow-io").click(timeout=30_000)
        expect(self.page.get_by_test_id("button-send").last).to_be_visible(
            timeout=30_000
        )

        question = "Hello, what is 2+2?"
        self.page.get_by_test_id("input-chat-playground").last.fill(question)
        self.page.get_by_test_id("button-send").last.click()

        # The user's own bubble proves the send landed — the step the old version
        # could not tell apart from a click that did nothing. Langflow renders it as
        # `chat-message-User-<text>`, verified on 1.12.0.dev9.
        # `.last`, not the bare locator: the session keeps its history, so asking the
        # same question twice resolves to several bubbles and strict mode rejects it.
        expect(
            self.page.get_by_test_id(f"chat-message-User-{question}").last
        ).to_be_visible(timeout=30_000)

        # Then the reply — waited on by its TEXT, not by its presence (#1143).
        # Run #116 failed here against a healthy product: `div-chat-message` is
        # rendered the moment the machine message is created, so `to_be_visible`
        # resolved against a bubble still holding its loading dot and `inner_text()`
        # read `''` ~1.5 s after send. The artifact screenshot showed the stream
        # mid-flight, and `execute_flow_api_post_update` answered the same flow on
        # the same nightly seconds later.
        #
        # Still not waited on via `button-stop` disappearing: `to_be_hidden` is
        # satisfied by an element that never existed, so a run that never started
        # would pass that check — the read-absence-as-success mistake of #1120.
        reply = self.page.get_by_test_id("div-chat-message").last
        expect(reply).to_have_text(re.compile(r"\S"), timeout=120_000)

        # Let the stream settle so the recorded detail is the whole reply instead of
        # its first tokens — a truncated reply in the report reads like a broken one.
        # Bounded, and it cannot mask a failure: a stream that produced no text at
        # all has already failed the assertion above.
        reply_text = ""
        for _ in range(30):
            current = reply.inner_text().strip()
            if current and current == reply_text:
                break
            reply_text = current
            self.page.wait_for_timeout(500)

        self.page.screenshot(path="test-results/playground-result.png")

        self.results["steps"]["execute_flow_ui"] = {
            "status": "pass" if reply_text else "fail",
            "detail": reply_text[:200] if reply_text else "the reply bubble rendered empty",
        }
        self._save_results()

        assert reply_text, (
            "the Playground rendered a reply bubble with no text — the flow ran but "
            "produced nothing after migration"
        )

    def test_06_execute_flow_api_post_update(self):
        """Execute the flow via API after component updates."""
        import requests

        token_resp = requests.get(f"{self.base_url}/api/v1/auto_login", timeout=10)
        token_resp.raise_for_status()
        token = token_resp.json().get("access_token", "")

        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"

        payload = {
            "input_value": "What is 3+5?",
            "output_type": "chat",
            "input_type": "chat",
        }

        try:
            r = requests.post(
                f"{self.base_url}/api/v1/run/{self.flow_id}",
                headers=headers,
                json=payload,
                timeout=120,
            )
            r.raise_for_status()
            result = r.json()

            outputs = result.get("outputs", [])
            success = len(outputs) > 0
            detail = str(outputs[0].get("outputs", [{}])[0].get("results", {}))[:200] if success else "No outputs"

            self.results["steps"]["execute_flow_api_post_update"] = {
                "status": "pass" if success else "fail",
                "detail": detail,
            }
        except Exception as e:
            self.results["steps"]["execute_flow_api_post_update"] = {
                "status": "fail",
                "detail": str(e)[:300],
            }

        self._save_results()
