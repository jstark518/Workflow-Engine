#!/usr/bin/env tsx
// Copyright (c) 2026 Jonathan Stark
// SPDX-License-Identifier: MIT

import { resolve } from 'path'
import { writeFileSync, mkdirSync } from 'fs'
import { generateASL } from './generator'

async function main() {
  const workflowPath = process.argv[2]
  if (!workflowPath) {
    console.error('Usage: generate-asl <path-to-workflow-module>')
    console.error('  e.g. generate-asl src/workflow.ts')
    process.exit(1)
  }

  const outDir = process.argv[3] || 'dist'
  const absPath = resolve(process.cwd(), workflowPath)
  const mod = await import(absPath)

  // Find the first exported class decorated with @Workflow
  const WorkflowClass = Object.values(mod).find(
    (v) => typeof v === 'function' && v.prototype,
  ) as Function | undefined

  if (!WorkflowClass) {
    console.error(`No exported class found in ${workflowPath}`)
    process.exit(1)
  }

  mkdirSync(outDir, { recursive: true })
  const outFile = resolve(outDir, 'state-machine.asl.json')
  writeFileSync(outFile, generateASL(WorkflowClass))
  console.log(`Generated ${outFile}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
