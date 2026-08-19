# SCUA benchmarks

The benchmark layer keeps two questions separate:

1. did the planner choose a useful sequence of generic SCUA operations; and
2. did SCUA deliver and verify those operations without disturbing the user?

Every episode stores the instruction, task evaluator result, Codex usage, SCUA
tool calls, delivery and verification outcomes, stale-state count, wall time,
frontmost-application transitions, and physical-pointer displacement. The
agent's own success claim is diagnostic only; the task evaluator decides pass
or fail. Pointer and focus telemetry describes total physical-user activity
during the episode; use SCUA's foreground-escalation fields to attribute a
focus takeover to the executor.

## Twenty-task macOS pilot

The versioned pilot contains eight Calculator tasks, four TextEdit tasks, four
Finder rename tasks, and four isolated browser-form tasks. TextEdit and Finder
operate only on a fresh directory below the system temporary directory. The
runner refuses those tasks unless the caller explicitly acknowledges desktop
mutation.

Inspect the plan without acting:

```sh
npm run benchmark:pilot -- --dry-run
```

Run non-mutating Calculator and isolated-browser tasks:

```sh
npm run benchmark:pilot -- --domain calculator --domain browser
```

Run all twenty tasks:

```sh
npm run benchmark:pilot -- --allow-desktop-mutation
```

Use `--task ID`, `--limit N`, `--model MODEL`, or `--timeout-ms N` to narrow or
pin a run. Local results are written below `benchmarks/results/` and ignored by
Git. The runner uses the authenticated Codex application binary by default;
set `SCUA_BENCH_CODEX` to an alternate executable.

Benchmark integrity is fail-closed. Codex runs with a read-only filesystem
sandbox and pre-approves only tools from the injected SCUA server so its
state-changing MCP calls can run non-interactively. The JSONL trajectory is
audited, and any shell or non-SCUA tool call makes `integrityPassed` false even
when the external evaluator passes.

## MacAgentBench

MacAgentBench's `OpenClawAgent` takes ownership of a complete task inside the
guest instead of returning one PyAutoGUI action per host loop. SCUA uses the
same whole-agent boundary because its immutable state and native AX refs must
remain inside the macOS guest.

Provision the benchmark VM before running:

1. install Codex in the guest and authenticate it with the benchmark account;
2. clone SCUA to `/Users/pipiwu/scua`, run `npm install`, and install the signed
   helper with `node scripts/setup-helper.mjs`;
3. grant Accessibility and Screen Recording to the installed helper; and
4. verify `/Users/pipiwu/scua/scripts/run-mcp.sh` starts successfully.

Copy `benchmarks/adapters/macagentbench/scua_agent.py` into
`MacAgentBench/mm_agents/scua_agent.py`, then apply the versioned runner patch:

```sh
git apply /path/to/scua/benchmarks/adapters/macagentbench/batch_run.patch
```

The patch makes these narrow runner changes:

```py
from mm_agents.scua_agent import ScuaAgent

# In create_agent(...):
if model_type == "scua":
    return ScuaAgent(model=model, url=url)

# In the whole-agent branch:
if isinstance(agent, (OpenClawAgent, ScuaAgent)):
    run_result = agent.run_task(env, env.task.instruction)
```

Run a small GUI-only slice first. MacAgentBench owns VM reset, recordings, and
its deterministic final-state evaluator; the adapter owns only the task-time
planner plus SCUA control path. Each run returns a guest trajectory directory
containing `trajectory.jsonl` and `stderr.log`, which MacAgentBench copies next
to the normal task artifacts. Report these runs as tool-augmented SCUA agent
results, not as a raw screenshot/PyAutoGUI leaderboard entry.
