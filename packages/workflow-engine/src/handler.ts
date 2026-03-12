// Copyright (c) 2026 Jonathan Stark
// SPDX-License-Identifier: MIT

import type { Handler } from 'aws-lambda'
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge'
import { getWorkflowConfig, getStepsMetadata } from './decorators'
import type { StepContext } from './types'

const eventBridge = new EventBridgeClient({})

interface StepInput {
  executionId: string
  step: string
  message: string
  detailType: string
  taskToken?: string
}

interface StepOutput {
  step: string
  publishedAt: string
}

export function createHandler(WorkflowClass: new () => any): Handler<StepInput, StepOutput> {
  const instance = new WorkflowClass()
  const workflowConfig = getWorkflowConfig(WorkflowClass)
  const steps = getStepsMetadata(WorkflowClass)
  const source = workflowConfig?.source ?? workflowConfig?.name ?? 'workflow'

  // Build a lookup from step name → method
  const stepMethods = new Map<string, string>()
  for (const meta of steps) {
    if (meta.type === 'task') {
      stepMethods.set(meta.propertyKey, meta.propertyKey)
    }
  }

  return async (event) => {
    console.log('workflow handler invoked:', JSON.stringify(event))

    const { executionId, step, detailType, taskToken } = event
    const methodName = stepMethods.get(step)

    if (!methodName || typeof instance[methodName] !== 'function') {
      throw new Error(`No handler method found for step "${step}"`)
    }

    const ctx: StepContext = {
      executionId,
      step,
      taskToken,
      async publishEvent(dt: string, message: string) {
        const detail: Record<string, string> = { executionId, step, message }
        if (taskToken) {
          detail.taskToken = taskToken
        }

        await eventBridge.send(
          new PutEventsCommand({
            Entries: [
              {
                Source: source,
                EventBusName: 'default',
                DetailType: dt,
                Detail: JSON.stringify(detail),
              },
            ],
          }),
        )
        console.log('EventBridge event published:', { step, detailType: dt })
      },
    }

    await instance[methodName](ctx)

    return { step, publishedAt: new Date().toISOString() }
  }
}
