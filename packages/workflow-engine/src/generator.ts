// Copyright (c) 2026 Jonathan Stark
// SPDX-License-Identifier: MIT

import { getWorkflowConfig, getStepsMetadata } from './decorators'
import type {
  StepConfig,
  ChoiceConfig,
  WaitConfig,
  ParallelConfig,
  StepMetadata,
} from './types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPascalCase(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

function buildTaskState(
  meta: StepMetadata,
  config: StepConfig,
): Record<string, unknown> {
  const stateName = toPascalCase(meta.propertyKey)
  const isCallback = config.waitForTaskToken === true
  const resource = isCallback
    ? 'arn:aws:states:::lambda:invoke.waitForTaskToken'
    : 'arn:aws:states:::lambda:invoke'

  const payload: Record<string, unknown> = {
    'executionId.$': '$$.Execution.Id',
    step: meta.propertyKey,
    message: `Step: ${stateName}`,
    detailType: stateName,
  }

  if (isCallback) {
    payload['taskToken.$'] = '$$.Task.Token'
  }

  const state: Record<string, unknown> = {
    Type: 'Task',
    Resource: resource,
    Parameters: {
      FunctionName: '${LAMBDA_ARN}',
      Payload: payload,
    },
  }

  // waitForTaskToken results come from SendTaskSuccess (raw callback payload),
  // not from a Lambda invoke response, so there is no $.Payload wrapper.
  if (!isCallback) {
    state.ResultSelector = {
      'step.$': '$.Payload.step',
      'publishedAt.$': '$.Payload.publishedAt',
    }
  }

  if (config.timeout) {
    state.TimeoutSeconds = config.timeout
  }

  if (config.resultPath) {
    state.ResultPath = config.resultPath
  }

  if (config.end) {
    state.End = true
  } else if (config.next) {
    state.Next = toPascalCase(config.next)
  }

  if (config.catch && config.catch.length > 0) {
    state.Catch = config.catch.map((c) => ({
      ErrorEquals: [c.error],
      ResultPath: c.resultPath,
      Next: toPascalCase(c.next),
    }))
  }

  return state
}

function buildChoiceState(config: ChoiceConfig): Record<string, unknown> {
  return {
    Type: 'Choice',
    Choices: config.choices.map((rule) => {
      const choice: Record<string, unknown> = {
        Variable: rule.variable,
        Next: toPascalCase(rule.next),
      }
      if (rule.booleanEquals !== undefined) {
        choice.BooleanEquals = rule.booleanEquals
      }
      return choice
    }),
    Default: toPascalCase(config.default),
  }
}

function buildWaitState(config: WaitConfig): Record<string, unknown> {
  return {
    Type: 'Wait',
    Seconds: config.seconds,
    Next: toPascalCase(config.next),
  }
}

function buildParallelState(
  config: ParallelConfig,
  allSteps: StepMetadata[],
): Record<string, unknown> {
  const branches = config.branches.map((branchMethodName) => {
    const branchMeta = allSteps.find((s) => s.propertyKey === branchMethodName)
    if (!branchMeta) {
      throw new Error(`Parallel branch method "${branchMethodName}" not found`)
    }

    const branchStateName = toPascalCase(branchMethodName)
    const branchState = buildTaskState(branchMeta, {
      ...(branchMeta.config as StepConfig),
      end: true,
    })

    return {
      StartAt: branchStateName,
      States: { [branchStateName]: branchState },
    }
  })

  const state: Record<string, unknown> = {
    Type: 'Parallel',
    Branches: branches,
  }

  if (config.resultPath) {
    state.ResultPath = config.resultPath
  }

  if (config.end) {
    state.End = true
  } else if (config.next) {
    state.Next = toPascalCase(config.next)
  }

  return state
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generateASL(WorkflowClass: Function): string {
  const workflowConfig = getWorkflowConfig(WorkflowClass)
  if (!workflowConfig) {
    throw new Error('Class is not decorated with @Workflow')
  }

  const allSteps = getStepsMetadata(WorkflowClass)
  if (allSteps.length === 0) {
    throw new Error('No steps defined in workflow')
  }

  // Collect branch method names referenced by @Parallel — these are sub-states, not top-level
  const parallelBranchNames = new Set<string>()
  for (const step of allSteps) {
    if (step.type === 'parallel') {
      for (const branch of (step.config as ParallelConfig).branches) {
        parallelBranchNames.add(branch)
      }
    }
  }

  // Top-level states = everything except parallel branch methods
  const topLevelSteps = allSteps.filter(
    (s) => !parallelBranchNames.has(s.propertyKey),
  )

  const startAt = toPascalCase(topLevelSteps[0].propertyKey)
  const states: Record<string, unknown> = {}

  for (const step of topLevelSteps) {
    const stateName = toPascalCase(step.propertyKey)

    switch (step.type) {
      case 'task':
        states[stateName] = buildTaskState(step, step.config as StepConfig)
        break
      case 'choice':
        states[stateName] = buildChoiceState(step.config as ChoiceConfig)
        break
      case 'wait':
        states[stateName] = buildWaitState(step.config as WaitConfig)
        break
      case 'parallel':
        states[stateName] = buildParallelState(
          step.config as ParallelConfig,
          allSteps,
        )
        break
    }
  }

  const asl = { StartAt: startAt, States: states }
  return JSON.stringify(asl, null, 2)
}
