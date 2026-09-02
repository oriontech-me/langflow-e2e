#!/usr/bin/env node
/**
 * Decides the echo endpoint (`ECHO_BASE_URL`) a CI lane should hand to Langflow,
 * given what the surrounding bash managed to discover about the job's topology.
 *
 * ## Why this is a script and not inline bash (#1128)
 *
 * The self-hosted go-httpbin decoupling built for #462/#639 lived in exactly one
 * workflow, and every other lane silently fell back to public `httpbin.org`. That
 * fallback is *invisible when it happens* — a PR reds on a third-party outage and
 * the log looks like a product failure. Extending the service to four lanes means
 * the choice now runs in two different job topologies, and picking the wrong
 * address fails in ways that are hard to read:
 *
 * - Langflow's API Request component runs `validators.url()` and **rejects a
 *   single-label host**, so `http://go-httpbin:8080` never works even though the
 *   service name resolves. It accepts a raw IP (#462).
 * - Langflow's SSRF layer blocks private addresses unless they are pre-authorized
 *   by `LANGFLOW_SSRF_ALLOWED_HOSTS`, and it blocks loopback outright — which is
 *   why `localhost` cannot be handed to Langflow, even though that is the address
 *   the *job* uses to probe the service.
 *
 * So the address the job probes and the address Langflow calls are **not the same
 * address**, and which is which depends on whether the job runs inside a
 * container. That is decision logic, and inline bash makes it unprovable until a
 * real lane breaks. Here it is covered by `npm run test:scripts` on every PR.
 *
 * ## The second topology: no container at all (`--topology native`)
 *
 * The QA VMs have neither Docker nor Podman, so there is no service container and
 * no container IP to discover — `scripts/start-echo-source.sh` runs the pinned
 * go-httpbin binary on the host and reports the address it bound. The decision
 * left is which of the machine's addresses may become `ECHO_BASE_URL`, and there
 * the two constraints above stop being equivalent: a PUBLIC address satisfies both
 * (it is neither a single-label host nor loopback) and still ruins the lane,
 * because `privateEchoEndpoint()` in `tests/helpers/other/private-echo-endpoint.ts`
 * **skips** an admitted-case assertion whose host is not blocked by default — and a
 * host carrying a public address alongside the private one makes that a coin flip on
 * interface ordering rather than a hypothetical.
 *
 * Hence the one deliberate difference between the topologies: a non-private
 * address is a WARNING under a container, where it merely risks a 400 that names
 * itself, and an ERROR natively, where it subtracts a test from a lane that then
 * reports success.
 *
 * Pure by design: it takes discovered facts as flags and returns a decision. It
 * never shells out, resolves DNS, or calls the network — the bash in
 * `.github/actions/resolve-echo-endpoint`, or the VM's run script, does that and
 * passes the results in.
 *
 * Run:
 *   node scripts/resolve-echo-endpoint.mjs \
 *     --service-port 8080 --mapped-port 8080 \
 *     --getent-ip "" --docker-ip 172.18.0.3 --in-container false --mode fail
 *   node scripts/resolve-echo-endpoint.mjs \
 *     --topology native --service-port 8080 --host-ips 203.0.113.10,10.0.0.5
 *
 * Output (stdout, JSON): { ok, langflowUrl, probeUrl, strategy, warnings, error }
 */

const HELP = `usage: resolve-echo-endpoint.mjs [options]

  --topology T        container (default) | native — see the header comment
  --service-port N    port the echo listens on inside its container (default 8080)
  --mapped-port N     host port the service is published on (default = service-port)
  --getent-ip IP      result of \`getent hosts <service>\` (empty when it failed)
  --docker-ip IP      result of \`docker inspect\` on the service (empty when it failed)
  --in-container BOOL whether the JOB itself runs inside a container
  --host-ips A,B      native only: the addresses the echo host reported
  --mode fail|warn    what an unavailable service means for this lane
`;

/** RFC-1918 + the link-local range Docker never uses for bridge networks. */
export function isPrivateIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host ?? "");
  if (!m) return false;
  const [a, b] = m.slice(1).map(Number);
  if (m.slice(1).some((p) => Number(p) > 255)) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** Loopback in any of the shapes Langflow's SSRF layer rejects. */
export function isLoopback(host) {
  return (
    host === "localhost" ||
    host === "::1" ||
    /^127\./.test(host ?? "")
  );
}

export function isIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host ?? "");
  return !!m && m.slice(1).every((p) => Number(p) <= 255);
}

/**
 * The native topology: the echo is a process on a host, and the only question is
 * which of that host's addresses the specs can actually assert against.
 *
 * Kept separate from the container decision rather than folded into it, because the
 * two disagree about exactly one input — a public address — and folding them would
 * mean one code path whose severity depends on a flag. Here each topology states its
 * own consequence, and neither can drift into the other's.
 */
function resolveNativeEndpoint({ hostIps, servicePort, mode }) {
  const candidates = hostIps.filter((ip) => ip && ip.length > 0);

  if (candidates.length === 0) {
    const detail = "no host address was supplied for the native echo endpoint";
    if (mode === "warn") {
      return {
        ok: false,
        langflowUrl: null,
        probeUrl: null,
        strategy: null,
        warnings: [
          `${detail}. ECHO_BASE_URL left unset, so the specs fall back to their PUBLIC default — this lane is now exposed to a third-party outage (#1128).`,
        ],
        error: null,
      };
    }
    return {
      ok: false,
      langflowUrl: null,
      probeUrl: null,
      strategy: null,
      warnings: [],
      error: `${detail}. Failing rather than falling back to public httpbin.org: start it with scripts/start-echo-source.sh, which prints ECHO_HOST_IP on success.`,
    };
  }

  // First private address wins, so the choice is a function of the order the host
  // reported its interfaces — deterministic, and re-derivable from the log.
  const chosen = candidates.find((ip) => isPrivateIpv4(ip));

  if (!chosen) {
    // Same refusal in all three shapes, but each gets its own cause: a lane blocked
    // by a message that names the wrong reason costs the same hour as no message.
    if (candidates.some((ip) => isLoopback(ip))) {
      return {
        ok: false,
        langflowUrl: null,
        probeUrl: null,
        strategy: null,
        warnings: [],
        error: `the only addresses offered were loopback (${candidates.join(", ")}). Langflow's SSRF layer blocks loopback outright — it ignores LANGFLOW_SSRF_ALLOWED_HOSTS for those addresses — so no echo spec can pass against it. Bind the echo to an RFC-1918 address instead.`,
      };
    }
    if (!candidates.every((ip) => isIpv4(ip))) {
      return {
        ok: false,
        langflowUrl: null,
        probeUrl: null,
        strategy: null,
        warnings: [],
        error: `resolved "${candidates.join(", ")}", which is not an IPv4 address. Langflow's API Request component runs validators.url() and rejects a single-label host, so ECHO_BASE_URL must be a raw IP (#462).`,
      };
    }
    return {
      ok: false,
      langflowUrl: null,
      probeUrl: null,
      strategy: null,
      warnings: [],
      error: `every address offered (${candidates.join(", ")}) is outside the RFC-1918 ranges in LANGFLOW_SSRF_ALLOWED_HOSTS. A public address is reachable, so this would look like it worked — but privateEchoEndpoint() SKIPS an admitted-case assertion whose host Langflow does not block by default, so the SSRF spec would silently stop asserting anything. Refused for that reason, not for reachability.`,
    };
  }

  const langflowUrl = `http://${chosen}:${servicePort}`;
  return {
    ok: true,
    langflowUrl,
    // The same address, on purpose. There is no port mapping to probe around here,
    // and probing loopback instead would confirm only that the process is up — not
    // that the address the specs depend on is reachable, which is the half that
    // breaks when a bind lands on the wrong interface.
    probeUrl: langflowUrl,
    strategy: "host address reported by the echo starter (native, no container)",
    warnings: [],
    error: null,
  };
}

/**
 * @param facts.topology    "container" (default) | "native"
 * @param facts.getentIp    container IP from inside the job's network, or ""
 * @param facts.dockerIp    container IP seen from the runner host, or ""
 * @param facts.inContainer does the JOB run inside a container?
 * @param facts.hostIps     native only: addresses the echo host reported
 * @param facts.servicePort port inside the container
 * @param facts.mappedPort  port published on the host
 * @param facts.mode        "fail" (block the lane) | "warn" (carry on)
 */
export function resolveEchoEndpoint({
  topology = "container",
  getentIp = "",
  dockerIp = "",
  inContainer = false,
  hostIps = [],
  servicePort = 8080,
  mappedPort = servicePort,
  mode = "fail",
} = {}) {
  if (topology === "native") {
    return resolveNativeEndpoint({ hostIps, servicePort, mode });
  }

  const warnings = [];

  // The address LANGFLOW must call. Both topologies put the echo on the same
  // Docker network as the langflow service container, so a container IP is
  // always the right answer for Langflow — what differs is how the job finds it.
  // `getent` only resolves service aliases when the job itself is in a container;
  // on a host-based job the same lookup fails and `docker inspect` is the route.
  const candidates = inContainer
    ? [
        { ip: getentIp, strategy: "getent (job runs in a container)" },
        { ip: dockerIp, strategy: "docker inspect (fallback inside container)" },
      ]
    : [
        { ip: dockerIp, strategy: "docker inspect (host-based job)" },
        { ip: getentIp, strategy: "getent (unexpected on a host-based job)" },
      ];

  const chosen = candidates.find((c) => c.ip && c.ip.length > 0);

  if (!chosen) {
    const detail =
      "neither `getent hosts` nor `docker inspect` found the echo service";
    if (mode === "warn") {
      return {
        ok: false,
        langflowUrl: null,
        probeUrl: null,
        strategy: null,
        warnings: [
          `${detail}. ECHO_BASE_URL left unset, so the specs fall back to their PUBLIC default — this lane is now exposed to a third-party outage (#1128).`,
        ],
        error: null,
      };
    }
    return {
      ok: false,
      langflowUrl: null,
      probeUrl: null,
      strategy: null,
      warnings: [],
      error: `${detail}. Failing the lane instead of falling back to public httpbin.org: a PR is the one place a human is waiting on the result, and a silent public fallback is what made #1128 look like a product failure.`,
    };
  }

  // Langflow rejects a single-label host outright (`validators.url()`), so an IP
  // is not a preference here — it is the only thing that works (#462).
  if (!isIpv4(chosen.ip)) {
    return {
      ok: false,
      langflowUrl: null,
      probeUrl: null,
      strategy: chosen.strategy,
      warnings: [],
      error: `resolved "${chosen.ip}", which is not an IPv4 address. Langflow's API Request component runs validators.url() and rejects a single-label host, so ECHO_BASE_URL must be a raw IP (#462).`,
    };
  }
  if (isLoopback(chosen.ip)) {
    return {
      ok: false,
      langflowUrl: null,
      probeUrl: null,
      strategy: chosen.strategy,
      warnings: [],
      error: `resolved loopback (${chosen.ip}). Langflow's SSRF protection blocks loopback ("Hostname localhost resolves to blocked IP address(es): ::1, 127.0.0.1"), so this address can never be handed to Langflow — it is only valid as the JOB's probe address.`,
    };
  }
  if (!isPrivateIpv4(chosen.ip)) {
    // Not fatal — a public IP would work if reachable — but it means the CIDR
    // allowlist does not cover it, so say so rather than let the SSRF layer
    // produce a 400 that reads like a component bug.
    warnings.push(
      `${chosen.ip} is outside the RFC-1918 ranges pre-authorized in LANGFLOW_SSRF_ALLOWED_HOSTS; if Langflow answers 400 on the echo URL, that allowlist is why.`,
    );
  }

  const langflowUrl = `http://${chosen.ip}:${servicePort}`;
  // The job's own probe. On a host-based job the container IP may not be
  // routable from the host on every platform, whereas the published port always
  // is — so probe loopback there and keep the container IP for Langflow. Inside
  // a container the job shares the network and can probe the IP directly.
  const probeUrl = inContainer
    ? langflowUrl
    : `http://localhost:${mappedPort}`;

  return {
    ok: true,
    langflowUrl,
    probeUrl,
    strategy: chosen.strategy,
    warnings,
    error: null,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--getent-ip") args.getentIp = argv[++i] ?? "";
    else if (a === "--docker-ip") args.dockerIp = argv[++i] ?? "";
    else if (a === "--service-port") args.servicePort = Number(argv[++i]);
    else if (a === "--mapped-port") args.mappedPort = Number(argv[++i]);
    else if (a === "--in-container") args.inContainer = argv[++i] === "true";
    else if (a === "--topology") args.topology = argv[++i];
    // Split on both separators: the starter prints one address per line and a shell
    // capturing it with $(...) hands over whitespace, while a human types commas.
    // Accepting only one of the two makes the other silently resolve to zero
    // candidates — which reads as "the echo is not running".
    else if (a === "--host-ips") {
      args.hostIps = (argv[++i] ?? "")
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    else if (a === "--mode") args.mode = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`resolve-echo-endpoint: unknown argument ${a}`);
  }
  if (args.mappedPort === undefined && args.servicePort !== undefined) {
    args.mappedPort = args.servicePort;
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (args.mode && args.mode !== "fail" && args.mode !== "warn") {
    process.stderr.write(
      `::error::resolve-echo-endpoint: --mode must be "fail" or "warn", got "${args.mode}"\n`,
    );
    process.exit(2);
  }
  // Rejected rather than defaulted. A typo silently falling back to the container
  // topology would answer the native lane's question with the container's rules —
  // and the difference between them is precisely a warning where an error belongs.
  if (args.topology && args.topology !== "container" && args.topology !== "native") {
    process.stderr.write(
      `::error::resolve-echo-endpoint: --topology must be "container" or "native", got "${args.topology}"\n`,
    );
    process.exit(2);
  }

  const result = resolveEchoEndpoint(args);
  for (const w of result.warnings) process.stderr.write(`::warning::${w}\n`);
  if (result.error) process.stderr.write(`::error::${result.error}\n`);
  if (result.ok) {
    process.stderr.write(
      `echo endpoint via ${result.strategy}: Langflow → ${result.langflowUrl}, job probes ${result.probeUrl}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  // Exit 1 (not 2) when the decision itself says "unavailable and that is fatal":
  // the action distinguishes a broken resolver (2) from an absent service (1).
  process.exit(result.ok ? 0 : result.error ? 1 : 0);
}
