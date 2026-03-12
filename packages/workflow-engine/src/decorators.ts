// Copyright (c) 2026 Jonathan Stark
// SPDX-License-Identifier: MIT

import type {
  WorkflowConfig,
  StepConfig,
  ChoiceConfig,
  WaitConfig,
  ParallelConfig,
  StepMetadata,
} from './types'

// ---------------------------------------------------------------------------
// Metadata storage — WeakMaps keyed by constructor, no reflect-metadata needed
// ---------------------------------------------------------------------------

const workflowMetadata = new WeakMap<Function, WorkflowConfig>()
const stepsMetadata = new WeakMap<Function, StepMetadata[]>()

let globalOrder = 0

function ensureSteps(target: Function): StepMetadata[] {
  let steps = stepsMetadata.get(target)
  if (!steps) {
    steps = []
    stepsMetadata.set(target, steps)
  }
  return steps
}

// ---------------------------------------------------------------------------
// Class decorator
// ---------------------------------------------------------------------------

export function Workflow(config: WorkflowConfig) {
  return function (constructor: Function) {
    workflowMetadata.set(constructor, config)
  }
}

// ---------------------------------------------------------------------------
// Method decorators
// ---------------------------------------------------------------------------

export function Step(config: StepConfig = {}) {
  return function (_target: any, propertyKey: string) {
    const steps = ensureSteps(_target.constructor)
    steps.push({ propertyKey, type: 'task', config, order: globalOrder++ })
  }
}

export function Choice(config: ChoiceConfig) {
  return function (_target: any, propertyKey: string) {
    const steps = ensureSteps(_target.constructor)
    steps.push({ propertyKey, type: 'choice', config, order: globalOrder++ })
  }
}

export function Wait(config: WaitConfig) {
  return function (_target: any, propertyKey: string) {
    const steps = ensureSteps(_target.constructor)
    steps.push({ propertyKey, type: 'wait', config, order: globalOrder++ })
  }
}

export function Parallel(config: ParallelConfig) {
  return function (_target: any, propertyKey: string) {
    const steps = ensureSteps(_target.constructor)
    steps.push({ propertyKey, type: 'parallel', config, order: globalOrder++ })
  }
}

// ---------------------------------------------------------------------------
// Metadata accessors
// ---------------------------------------------------------------------------

export function getWorkflowConfig(constructor: Function): WorkflowConfig | undefined {
  return workflowMetadata.get(constructor)
}

export function getStepsMetadata(constructor: Function): StepMetadata[] {
  return (stepsMetadata.get(constructor) || []).sort((a, b) => a.order - b.order)
}
