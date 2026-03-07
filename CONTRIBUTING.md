# Contributing to Runcor

Thanks for your interest in contributing to Runcor! This guide covers how to set up the dev environment, run tests, and submit changes.

## Setup

```bash
git clone https://github.com/runcor-ai/runcor.git
cd runcor
npm install
npm test          # verify everything passes
```

Requires Node.js 20+.

## Running Tests

```bash
npm test              # full suite (2122 tests)
npm run test:watch    # watch mode for development
npx vitest run tests/unit/model/   # run a specific directory
```

## Test File Conventions

```
tests/
├── unit/              # Isolated module tests (mocked dependencies)
│   └── {module}/      # Matches src/ directory structure
│       └── {feature}.test.ts
├── integration/       # Tests with real engine wiring (createEngine)
│   └── {feature}.test.ts
├── contract/          # Public API contract tests
│   └── {feature}.test.ts
├── e2e/               # Cross-feature end-to-end tests
│   └── {scenario}.test.ts
└── stress/            # Performance and load tests
    └── {subsystem}.test.ts
```

**Naming rules:**
- File names use kebab-case: `cost-tracking.test.ts`, not `costTracking.test.ts`
- Unit tests mirror `src/` structure: `src/model/router.ts` → `tests/unit/model/router.test.ts`
- Each test file has a top-level `describe()` matching the feature or class being tested
- No internal task IDs or feature numbers in test comments — keep comments descriptive

**Example:**

```typescript
// Unit tests for CircuitBreaker
import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../../../src/model/circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('starts in healthy state', () => {
    // ...
  });
});
```

## Code Style

- TypeScript strict mode — no `any` in engine core
- Imports from `'runcor'` in examples, relative paths in `src/`
- Follow existing patterns in the module you're changing
- Run `npm test` before submitting — all tests must pass

## Pull Request Process

1. Fork the repo and create a feature branch from `main`
2. Make your changes with tests (TDD preferred — tests first)
3. Run `npm test` — all tests must pass
4. Submit a PR with a clear description of what changed and why
5. PRs are reviewed before merge

## Project Structure

```
src/
├── engine.ts          # Main Runcor class
├── types.ts           # All public type definitions
├── errors.ts          # Error classes
├── model/             # Provider implementations, router, circuit breaker
├── memory/            # Scoped memory system
├── cost/              # Cost tracking and budgets
├── policy/            # Rules, guardrails, rate limits, access control
├── evaluation/        # Quality scoring and human review
├── adapter/           # MCP adapter framework
├── agent/             # Autonomous agent execution
├── discernment/       # Portfolio-level analysis
├── http/              # HTTP server, SSE, dashboard
├── cli/               # CLI binary
├── config/            # YAML config loading and validation
├── scheduler/         # Cron-based flow scheduling
├── server/            # MCP server interface
└── telemetry/         # OpenTelemetry instrumentation
```

## License

By contributing, you agree that your contributions will be licensed under the project's MIT license.
