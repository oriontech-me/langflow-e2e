import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeRunArtifact, firstLines } from './artifacts.ts'

// Shape of a real playwright-json-daily-<run> artifact, trimmed to what the
// summarizer reads: three provider projects of the same spec line, one flaky
// (passed then failed on a serial-group retry) and one hard failure.
const ARTIFACT = JSON.stringify({
  suites: [{
    title: 'agent-context-id-isolation.spec.ts',
    suites: [
      {
        title: 'Agent Context ID Isolation [openai / gpt-4o-mini]',
        specs: [{
          title: "switching the agent's context_id re-tags new turns",
          file: 'llm-agents/agent-context-id-isolation.spec.ts',
          line: 570,
          tests: [{
            projectName: 'chromium',
            status: 'flaky',
            results: [
              { retry: 0, status: 'passed', duration: 25000 },
              { retry: 2, status: 'failed', duration: 56000, error: { message: 'Error: expect(received).toBe(expected)\n\nExpected: "turns-tagged"\nReceived: "turn-2 message(s) with wrong context_id"' } },
            ],
          }],
        }],
      },
      {
        title: 'Agent Context ID Isolation [google / gemini-2.5-flash]',
        specs: [{
          title: "switching the agent's context_id re-tags new turns",
          file: 'llm-agents/agent-context-id-isolation.spec.ts',
          line: 570,
          tests: [{
            projectName: 'chromium',
            status: 'unexpected',
            results: [{ retry: 0, status: 'failed', duration: 58000, error: { message: 'TimeoutError: apiRequestContext.get: Timeout 20000ms exceeded.\nCall log:\n  - → GET http://localhost:7860/api/v1/auto_login' } }],
          }],
        }],
      },
      {
        title: 'some other spec',
        specs: [{
          title: 'an unrelated test',
          file: 'other.spec.ts',
          line: 10,
          tests: [{ projectName: 'chromium', status: 'expected', results: [{ retry: 0, status: 'passed', duration: 1000 }] }],
        }],
      },
    ],
  }],
})

test('summarizeRunArtifact reports every attempt of every matching test', () => {
  const lines = summarizeRunArtifact(ARTIFACT, 'context_id')
  const text = lines.join('\n')
  assert.equal(lines.filter(l => l.startsWith('llm-agents/')).length, 2)
  assert.match(text, /\[chromium\].*→ flaky/)
  assert.match(text, /attempt 0: passed \(25s\)/)
  assert.match(text, /attempt 2: failed \(56s\)/)
  assert.match(text, /wrong context_id/)
  // The two rows had different causes — the summary must show both verbatim.
  assert.match(text, /auto_login/)
  assert.ok(!text.includes('an unrelated test'))
})

test('summarizeRunArtifact without a filter covers the whole run', () => {
  const text = summarizeRunArtifact(ARTIFACT).join('\n')
  assert.match(text, /an unrelated test/)
})

test('summarizeRunArtifact says so when nothing matches or the blob is broken', () => {
  assert.match(summarizeRunArtifact(ARTIFACT, 'nope')[0], /no test matching/)
  assert.match(summarizeRunArtifact('not json')[0], /not valid JSON/)
})

test('firstLines strips ANSI colouring and caps the error head', () => {
  const msg = '[2mError:[22m boom\n\nline two\nline three\nline four'
  const out = firstLines(msg)
  assert.ok(!out.includes('['))
  assert.equal(out.split(' ⏎ ').length, 3)
})
