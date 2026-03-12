// Copyright (c) 2026 Jonathan Stark
// SPDX-License-Identifier: MIT

export interface WorkflowConfig {
  name: string
  source?: string
}

export interface StepConfig {
  next?: string
  end?: boolean
  resultPath?: string
  waitForTaskToken?: boolean
  timeout?: number
  catch?: Array<{ error: string; resultPath?: string; next: string }>
}

export interface ChoiceRule {
  variable: string
  booleanEquals?: boolean
  next: string
}

export interface ChoiceConfig {
  choices: ChoiceRule[]
  default: string
}

export interface WaitConfig {
  seconds: number
  next: string
}

export interface ParallelConfig {
  branches: string[]
  resultPath?: string
  next?: string
  end?: boolean
}

export interface StepContext {
  executionId: string
  step: string
  taskToken?: string
  publishEvent(detailType: string, message: string): Promise<void>
}

export type StepType = 'task' | 'choice' | 'wait' | 'parallel'

export interface StepMetadata {
  propertyKey: string
  type: StepType
  config: StepConfig | ChoiceConfig | WaitConfig | ParallelConfig
  order: number
}
