# Workflow Engine

A decorator-based workflow engine for AWS Step Functions. Define your state machine and Lambda handler in a single TypeScript class — the engine generates both the ASL (Amazon States Language) JSON at build time and routes Step Functions invocations at runtime.

```
                 workflow.ts (source of truth)
                         │
            ┌────────────┴────────────┐
            ▼                         ▼
   generate-asl (build)       createHandler (runtime)
            │                         │
            ▼                         ▼
   state-machine.asl.json      Lambda handler
            │
            ▼
   Terraform templatefile()
```

## Quick Start

### 1. Create your workflow

```typescript
// packages/my_workflow/src/workflow.ts
import {
  Workflow,
  Step,
  Choice,
  Wait,
  Parallel,
  type StepContext,
} from 'workflow-engine'

@Workflow({ name: 'my-workflow', source: 'my-workflow' })
export class MyWorkflow {
  @Step({ next: 'checkStatus', resultPath: '$.initResult' })
  async initialize(ctx: StepContext) {
    await ctx.publishEvent('WorkflowStarted', 'Workflow has begun')
  }

  @Choice({
    choices: [{ variable: '$.initResult.ready', booleanEquals: true, next: 'process' }],
    default: 'handleNotReady',
  })
  checkStatus() {}

  @Step({ next: 'cooldown', resultPath: '$.processResult' })
  async process(ctx: StepContext) {
    await ctx.publishEvent('Processing', 'Doing the work...')
  }

  @Wait({ seconds: 10, next: 'complete' })
  cooldown() {}

  @Step({ end: true })
  async complete(ctx: StepContext) {
    await ctx.publishEvent('Completed', 'All done!')
  }

  @Step({ end: true })
  async handleNotReady(ctx: StepContext) {
    await ctx.publishEvent('NotReady', 'Preconditions not met')
  }
}
```

### 2. Create the handler

```typescript
// packages/my_workflow/src/index.ts
import { createHandler } from 'workflow-engine'
import { MyWorkflow } from './workflow'

export const handler = createHandler(MyWorkflow)
```

### 3. Configure the build

```json
// packages/my_workflow/package.json
{
  "scripts": {
    "build": "generate-asl src/workflow.ts dist && esbuild src/index.ts --bundle --platform=node --outfile=dist/index.js",
    "postbuild": "touch -t 197001010000.00 dist/index.js && zip -j dist/index.zip dist/index.js && rm dist/index.js"
  },
  "dependencies": {
    "workflow-engine": "*"
  }
}
```

```json
// packages/my_workflow/tsconfig.json
{
  "compilerOptions": {
    "experimentalDecorators": true
  }
}
```

### 4. Build

```bash
npm run build --workspace=packages/my_workflow
```

This produces:
- `dist/state-machine.asl.json` — the ASL definition with `${LAMBDA_ARN}` placeholders
- `dist/index.zip` — the Lambda deployment package

### 5. Wire it up in Terraform

```hcl
resource "aws_sfn_state_machine" "my_workflow" {
  name     = "my-workflow-${var.env_key}"
  role_arn = aws_iam_role.sfn_execution.arn

  definition = templatefile("${var.my_workflow_lambda_path}/state-machine.asl.json", {
    LAMBDA_ARN = aws_lambda_function.my_workflow.arn
  })
}
```

---

## API Reference

### Decorators

#### `@Workflow(config)`

Class decorator. Marks a class as a Step Functions workflow.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | Yes | Workflow identifier, used as the default EventBridge source |
| `source` | `string` | No | Override the EventBridge event source name |

```typescript
@Workflow({ name: 'order-processor', source: 'orders' })
export class OrderWorkflow { ... }
```

#### `@Step(config?)`

Method decorator. Defines a Task state that invokes the Lambda.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `next` | `string` | No | Name of the next method to transition to |
| `end` | `boolean` | No | Marks this as a terminal state |
| `resultPath` | `string` | No | JSONPath where the step result is stored (e.g., `$.myResult`) |
| `waitForTaskToken` | `boolean` | No | Enables the callback pattern — the state machine pauses until `SendTaskSuccess` or `SendTaskFailure` is called |
| `timeout` | `number` | No | Timeout in seconds (used with `waitForTaskToken`) |
| `catch` | `CatchRule[]` | No | Error handlers (see below) |

**Catch rules:**

```typescript
catch: [
  { error: 'States.Timeout', resultPath: '$.error', next: 'handleTimeout' },
  { error: 'States.ALL', next: 'handleError' },
]
```

**Task token pattern** — for human approval, external callbacks, etc:

```typescript
@Step({
  waitForTaskToken: true,
  timeout: 300,
  resultPath: '$.approval',
  next: 'processApproval',
  catch: [{ error: 'States.Timeout', resultPath: '$.error', next: 'onTimeout' }],
})
async waitForApproval(ctx: StepContext) {
  // ctx.taskToken is available here — publish it so an external system
  // can call SendTaskSuccess/SendTaskFailure with this token
  await ctx.publishEvent('AwaitingApproval', 'Waiting for human approval')
}
```

#### `@Choice(config)`

Method decorator. Defines a Choice state for conditional branching.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `choices` | `ChoiceRule[]` | Yes | Ordered list of branching rules |
| `default` | `string` | Yes | Fallback method name if no rules match |

**Choice rules:**

| Property | Type | Description |
|----------|------|-------------|
| `variable` | `string` | JSONPath expression to evaluate |
| `booleanEquals` | `boolean` | Value to compare against |
| `next` | `string` | Method name to transition to if matched |

```typescript
@Choice({
  choices: [
    { variable: '$.result.approved', booleanEquals: true, next: 'onApproved' },
  ],
  default: 'onRejected',
})
checkApproval() {}
```

#### `@Wait(config)`

Method decorator. Defines a Wait state that pauses execution.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `seconds` | `number` | Yes | Duration to wait |
| `next` | `string` | Yes | Method name to transition to after waiting |

```typescript
@Wait({ seconds: 30, next: 'checkAgain' })
delayBeforeRetry() {}
```

#### `@Parallel(config)`

Method decorator. Defines a Parallel state that runs multiple branches concurrently.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `branches` | `string[]` | Yes | Array of method names to execute in parallel |
| `resultPath` | `string` | No | JSONPath where the array of branch results is stored |
| `next` | `string` | No | Method name to transition to after all branches complete |
| `end` | `boolean` | No | Marks this as a terminal state |

Branch methods are automatically excluded from the top-level state machine and nested as single-step sub-state-machines.

```typescript
@Parallel({
  branches: ['sendEmail', 'sendSms', 'sendPush'],
  resultPath: '$.notifications',
  next: 'confirmDelivery',
})
fanOut() {}

@Step({ end: true })
async sendEmail(ctx: StepContext) { ... }

@Step({ end: true })
async sendSms(ctx: StepContext) { ... }

@Step({ end: true })
async sendPush(ctx: StepContext) { ... }
```

---

### Functions

#### `createHandler(WorkflowClass)`

Creates a Lambda handler that routes Step Functions invocations to the matching decorated method.

```typescript
import { createHandler } from 'workflow-engine'
import { MyWorkflow } from './workflow'

export const handler = createHandler(MyWorkflow)
```

**How it works:**
1. Instantiates the workflow class
2. Reads the `event.step` field from the Step Functions payload
3. Finds the method with a matching name
4. Builds a `StepContext` and calls the method
5. Returns `{ step, publishedAt }` to the state machine

#### `generateASL(WorkflowClass)`

Generates an ASL JSON string from a decorated workflow class. Used at build time.

```typescript
import { generateASL } from 'workflow-engine'
import { MyWorkflow } from './workflow'

const asl = generateASL(MyWorkflow)
// Write to file, inspect, etc.
```

**Conventions:**
- Method names are converted to PascalCase for ASL state names (`notifyStarted` becomes `NotifyStarted`)
- The first decorated method becomes `StartAt`
- Lambda function ARN uses `${LAMBDA_ARN}` placeholder for Terraform substitution
- Methods referenced in `@Parallel.branches` become nested sub-state-machines

---

### StepContext

The context object passed to every `@Step` method at runtime.

| Property | Type | Description |
|----------|------|-------------|
| `executionId` | `string` | The Step Functions execution ARN |
| `step` | `string` | Current step name (method name) |
| `taskToken` | `string \| undefined` | Callback token (present when `waitForTaskToken: true`) |
| `publishEvent(detailType, message)` | `function` | Publishes an EventBridge event |

**`publishEvent(detailType: string, message: string): Promise<void>`**

Publishes to the default EventBridge bus with:
- `Source` — the workflow's `source` config (or `name` if not set)
- `DetailType` — the `detailType` argument
- `Detail` — JSON with `{ executionId, step, message }` (plus `taskToken` if present)

---

### CLI

The `generate-asl` command is provided as a bin in the `workflow-engine` package. Available in npm scripts of any package that depends on `workflow-engine`.

```
generate-asl <workflow-module-path> [output-directory]
```

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `workflow-module-path` | Yes | — | Path to the TypeScript file exporting the workflow class |
| `output-directory` | No | `dist` | Directory to write `state-machine.asl.json` |

```bash
# Generate ASL from a workflow file
generate-asl src/workflow.ts dist

# Output: dist/state-machine.asl.json
```

---

## How It Works

### Build Time

```
workflow.ts ──► generate-asl CLI ──► state-machine.asl.json
                                         │
                                    Contains ${LAMBDA_ARN}
                                    placeholder
```

The `generate-asl` CLI imports your workflow module, reads the decorator metadata, and produces a valid ASL JSON file. Lambda function ARNs are left as `${LAMBDA_ARN}` placeholders — Terraform's `templatefile()` substitutes the real ARN at deploy time.

### Deploy Time

```
state-machine.asl.json ──► Terraform templatefile() ──► aws_sfn_state_machine
                                  │
                            Substitutes ${LAMBDA_ARN}
                            with actual Lambda ARN
```

### Runtime

```
Step Functions ──► Lambda (event.step = "notifyStarted")
                       │
                  createHandler() routes to
                  workflow.notifyStarted(ctx)
                       │
                  ctx.publishEvent() ──► EventBridge
```

The state machine invokes the same Lambda for every step. The handler reads `event.step` and dispatches to the matching method on your workflow class.

### Decorator Metadata

Decorators use `WeakMap`s keyed by the class constructor — no `reflect-metadata` dependency required. A global counter tracks declaration order so `generateASL()` knows which method is first (for `StartAt`).

---

## Full Example

The `step_test` package demonstrates all decorator types in an interactive workflow with human approval:

```typescript
// packages/step_test/src/workflow.ts
import {
  Workflow, Step, Choice, Wait, Parallel,
  type StepContext,
} from 'workflow-engine'

@Workflow({ name: 'sfn-poc', source: 'sfn-poc' })
export class SfnPocWorkflow {
  // 1. Kick off the workflow
  @Step({ next: 'waitForApproval', resultPath: '$.notifyResult' })
  async notifyStarted(ctx: StepContext) {
    await ctx.publishEvent('WorkflowStarted', 'Workflow started, waiting for approval...')
  }

  // 2. Pause and wait for a human to approve/reject (90s timeout)
  @Step({
    waitForTaskToken: true,
    timeout: 90,
    resultPath: '$.approvalResult',
    next: 'approvalChoice',
    catch: [{ error: 'States.Timeout', resultPath: '$.error', next: 'notifyTimedOut' }],
  })
  async waitForApproval(ctx: StepContext) {
    await ctx.publishEvent('WorkflowWaiting', 'Click Approve or Reject (90s timeout)')
  }

  // 3. Branch based on the approval result
  @Choice({
    choices: [{ variable: '$.approvalResult.approved', booleanEquals: true, next: 'notifyProcessing' }],
    default: 'notifyRejected',
  })
  approvalChoice() {}

  // 4. Approved — tell the UI processing is starting
  @Step({ next: 'processingDelay', resultPath: '$.processingResult' })
  async notifyProcessing(ctx: StepContext) {
    await ctx.publishEvent('WorkflowProcessing', 'Processing your request (15 seconds)...')
  }

  // 5. Simulate processing time
  @Wait({ seconds: 15, next: 'fanOutNotifications' })
  processingDelay() {}

  // 6. Notify both players in parallel
  @Parallel({
    branches: ['notifyPlayerA', 'notifyPlayerB'],
    resultPath: '$.parallelResults',
    next: 'notifyCompleted',
  })
  fanOutNotifications() {}

  @Step({ end: true })
  async notifyPlayerA(ctx: StepContext) {
    await ctx.publishEvent('WorkflowParallelA', 'Notifying Player A...')
  }

  @Step({ end: true })
  async notifyPlayerB(ctx: StepContext) {
    await ctx.publishEvent('WorkflowParallelB', 'Notifying Player B...')
  }

  // 7. Terminal states
  @Step({ end: true })
  async notifyCompleted(ctx: StepContext) {
    await ctx.publishEvent('WorkflowCompleted', 'All notifications sent! Workflow complete.')
  }

  @Step({ end: true })
  async notifyRejected(ctx: StepContext) {
    await ctx.publishEvent('WorkflowRejected', 'Workflow was rejected by user.')
  }

  @Step({ end: true })
  async notifyTimedOut(ctx: StepContext) {
    await ctx.publishEvent('WorkflowTimedOut', 'No response within 90 seconds — workflow timed out')
  }
}
```

This generates the following state machine:

```
NotifyStarted ──► WaitForApproval ──► ApprovalChoice
                       │                    │
                  [timeout]            ┌────┴────┐
                       │            approved   rejected
                       ▼               │         │
                 NotifyTimedOut        ▼         ▼
                              NotifyProcessing  NotifyRejected
                                     │
                                     ▼
                              ProcessingDelay (15s)
                                     │
                                     ▼
                            FanOutNotifications
                              ┌──────┴──────┐
                              ▼             ▼
                        NotifyPlayerA  NotifyPlayerB
                              └──────┬──────┘
                                     ▼
                              NotifyCompleted
```

---

## Creating a New Workflow Package

1. Create the package directory under `packages/`
2. Add `workflow-engine` as a dependency
3. Set `experimentalDecorators: true` in tsconfig.json
4. Define your workflow class with decorators
5. Export `createHandler(YourWorkflow)` from `index.ts`
6. Use `generate-asl` in your build script
7. Add the package to the `build-lambdas.yml` matrix
8. Add Terraform resources to consume the generated ASL via `templatefile()`

---

### State Types

| Feature | Status | Description |
|---------|--------|-------------|
| Task (`@Step`) | Available | Lambda invoke with optional callback pattern |
| Choice (`@Choice`) | Available | Conditional branching |
| Wait (`@Wait`) | Available | Static delay (seconds) |
| Parallel (`@Parallel`) | Available | Fan-out to concurrent branches |
| Pass (`@Pass`) | Coming Soon | Transform or inject data without a Lambda invocation |
| Fail (`@Fail`) | Coming Soon | Explicit terminal failure with `Error` and `Cause` |
| Succeed (`@Succeed`) | Coming Soon | Explicit terminal success state |
| Map (`@Map`) | Coming Soon | Iterate a sub-workflow over each item in an array (Inline and Distributed modes) |

### Task Features

| Feature | Status | Description |
|---------|--------|-------------|
| Catch | Available | Route errors to fallback states |
| Callback (waitForTaskToken) | Available | Pause execution until external callback |
| Timeout | Available | Time-limit for callback states |
| Retry | Coming Soon | Retry with backoff, max attempts, and jitter strategy |
| Non-Lambda integrations | Coming Soon | Direct SDK calls to DynamoDB, SQS, SNS, ECS, etc. |

### Choice Rules

| Feature | Status | Description |
|---------|--------|-------------|
| `BooleanEquals` | Available | Compare against boolean value |
| `StringEquals` | Coming Soon | Exact string match |
| `StringMatches` | Coming Soon | Glob-style pattern matching |
| `NumericEquals` / `NumericGreaterThan` / `NumericLessThan` | Coming Soon | Numeric comparisons |
| `IsPresent` / `IsNull` | Coming Soon | Existence and null checks |
| `And` / `Or` / `Not` | Coming Soon | Logical combinators for compound rules |

### Wait Variants

| Feature | Status | Description |
|---------|--------|-------------|
| `seconds` | Available | Static wait duration |
| `timestamp` | Coming Soon | Wait until a specific ISO 8601 timestamp |
| `secondsPath` | Coming Soon | Dynamic wait using a JSONPath value from state input |
| `timestampPath` | Coming Soon | Dynamic timestamp from state input |

### Input/Output Processing

| Feature | Status | Description |
|---------|--------|-------------|
| `resultPath` | Available | Store step result at a specific JSONPath |
| `inputPath` | Coming Soon | Filter state input before processing |
| `outputPath` | Coming Soon | Filter state output before passing to next state |
| `parameters` | Coming Soon | Construct custom input using JSONPath expressions |
