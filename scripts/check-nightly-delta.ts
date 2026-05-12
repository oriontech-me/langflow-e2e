/**
 * Decides whether the adaptive workflow should run by comparing the current
 * `langflowai/langflow-nightly:latest` image to the last one we successfully
 * tested.
 *
 * Run: `npx ts-node scripts/check-nightly-delta.ts`
 *
 * Inputs (env):
 *   LAST_TESTED_NIGHTLY_SHA — Langflow git SHA of the last nightly we ran
 *                             against; empty/unset triggers bootstrap.
 *   GH_TOKEN / GITHUB_TOKEN — used by the `gh` CLI for the Langflow tag
 *                             lookup (rate limits are friendlier with auth).
 *
 * Output (stdout, JSON, single object):
 *   {
 *     "decision":     "run" | "skip",
 *     "reason":       string,
 *     "currentDigest": string,    // sha256 manifest digest from Docker Hub
 *     "currentTag":   string,    // e.g. "1.10.0.dev20260507"
 *     "currentSha":   string,    // Langflow git SHA at the matching tag
 *     "baseSha":      string,    // git SHA to diff against (last tested or
 *                                //   previous nightly tag on bootstrap)
 *     "isBootstrap":  boolean
 *   }
 *
 * The workflow consumes this with `jq` and decides whether to run the subset
 * and what diff range to feed `impacted-tests.ts`.
 *
 * Why Docker Hub digest, not just the git tag: the Langflow `nightly_build`
 * workflow creates the git tag in an early job, *before* the Docker image is
 * built and pushed. If a later job fails, the tag exists but the
 * `:latest` image is stale. Treating the digest as the source of truth avoids
 * acting on a tag whose image never shipped.
 */

import { execSync } from "child_process";

const DOCKER_REPO = "langflowai/langflow-nightly";
const LATEST_TAG = "latest";
const NIGHTLY_VERSION_RE = /^\d+\.\d+\.\d+\.dev\d+$/;

interface DockerImage {
  digest: string;
  architecture?: string;
  os?: string;
}

interface DockerTag {
  name: string;
  last_updated: string;
  images: DockerImage[];
}

interface DockerTagsPage {
  results: DockerTag[];
}

interface Decision {
  decision: "run" | "skip";
  reason: string;
  currentDigest: string;
  currentTag: string;
  currentSha: string;
  baseSha: string;
  isBootstrap: boolean;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * Compares two image lists by their first amd64/linux digest. Docker Hub
 * returns one entry per platform variant, and `:latest` shares a manifest
 * digest with the version tag built in the same run.
 */
function primaryDigest(images: DockerImage[]): string {
  const linuxAmd64 = images.find(
    (i) => i.os === "linux" && i.architecture === "amd64"
  );
  return (linuxAmd64 ?? images[0])?.digest ?? "";
}

async function fetchLatestTag(): Promise<DockerTag> {
  return fetchJson<DockerTag>(
    `https://hub.docker.com/v2/repositories/${DOCKER_REPO}/tags/${LATEST_TAG}`
  );
}

async function fetchRecentTags(): Promise<DockerTag[]> {
  const page = await fetchJson<DockerTagsPage>(
    `https://hub.docker.com/v2/repositories/${DOCKER_REPO}/tags/?page_size=50&ordering=last_updated`
  );
  return page.results;
}

function findVersionTagForDigest(tags: DockerTag[], digest: string): DockerTag | undefined {
  return tags.find(
    (t) =>
      t.name !== LATEST_TAG &&
      NIGHTLY_VERSION_RE.test(t.name) &&
      primaryDigest(t.images) === digest
  );
}

function findPreviousVersionTag(
  tags: DockerTag[],
  excludeName: string
): DockerTag | undefined {
  // `tags` already comes ordered by last_updated desc when ordering is set;
  // the first entry that is a version tag and not the current one is the
  // previous nightly.
  return tags.find(
    (t) => t.name !== LATEST_TAG && t.name !== excludeName && NIGHTLY_VERSION_RE.test(t.name)
  );
}

interface GitRef {
  object: { sha: string; type: string };
}

interface GitTag {
  object: { sha: string };
}

/**
 * Resolves a Langflow nightly version tag (e.g. `1.10.0.dev20260507`) to the
 * commit SHA the tag points at. The Langflow git tag uses a `v` prefix, and
 * may be either a lightweight ref (points directly at the commit) or an
 * annotated tag object (points at a tag object that points at the commit).
 */
function resolveTagToSha(versionTag: string): string {
  const gitTag = `v${versionTag}`;
  const refJson = execSync(
    `gh api repos/langflow-ai/langflow/git/refs/tags/${gitTag}`,
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const ref = JSON.parse(refJson) as GitRef;
  if (ref.object.type === "commit") return ref.object.sha;
  // Annotated tag — dereference to the underlying commit.
  const tagJson = execSync(
    `gh api repos/langflow-ai/langflow/git/tags/${ref.object.sha}`,
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const tag = JSON.parse(tagJson) as GitTag;
  return tag.object.sha;
}

function emit(d: Decision): void {
  process.stdout.write(JSON.stringify(d) + "\n");
}

async function main(): Promise<void> {
  const lastSha = (process.env.LAST_TESTED_NIGHTLY_SHA ?? "").trim();

  const latest = await fetchLatestTag();
  const currentDigest = primaryDigest(latest.images);
  if (!currentDigest) {
    throw new Error("Docker Hub returned :latest with no digest");
  }

  const recent = await fetchRecentTags();
  const versionTag = findVersionTagForDigest(recent, currentDigest);
  if (!versionTag) {
    throw new Error(
      `No version tag matches :latest digest ${currentDigest}. The nightly Docker push likely did not complete; aborting.`
    );
  }

  const currentSha = resolveTagToSha(versionTag.name);

  if (!lastSha) {
    // Bootstrap: diff against the previous nightly so the first run is useful.
    const prev = findPreviousVersionTag(recent, versionTag.name);
    if (!prev) {
      // No previous nightly available — fall back to "no diff base", which the
      // workflow interprets as "run the full suite this time".
      emit({
        decision: "run",
        reason: "bootstrap with no previous nightly available; running full suite",
        currentDigest,
        currentTag: versionTag.name,
        currentSha,
        baseSha: "",
        isBootstrap: true,
      });
      return;
    }
    const prevSha = resolveTagToSha(prev.name);
    emit({
      decision: "run",
      reason: `bootstrap; diffing against previous nightly ${prev.name}`,
      currentDigest,
      currentTag: versionTag.name,
      currentSha,
      baseSha: prevSha,
      isBootstrap: true,
    });
    return;
  }

  if (lastSha === currentSha) {
    emit({
      decision: "skip",
      reason: "current nightly SHA matches last tested SHA — no new image",
      currentDigest,
      currentTag: versionTag.name,
      currentSha,
      baseSha: lastSha,
      isBootstrap: false,
    });
    return;
  }

  emit({
    decision: "run",
    reason: `new nightly: ${lastSha} → ${currentSha}`,
    currentDigest,
    currentTag: versionTag.name,
    currentSha,
    baseSha: lastSha,
    isBootstrap: false,
  });
}

main().catch((err: Error) => {
  process.stderr.write(`[check-nightly-delta] ERROR: ${err.message}\n`);
  process.exit(1);
});
