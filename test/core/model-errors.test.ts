import { describe, expect, it } from 'vitest'
import { explainModelError, modelProblem, needsRetentionMode, problemWords } from '../../src/core/model-errors.js'

const RAW = "Claude Code returned an error result: API Error: 400 data retention mode 'default' is not available for this model"

describe('why the model could not be called', () => {
  it('names the data retention setting, and that no retry mends it', () => {
    const p = modelProblem(RAW)
    expect(p?.kind).toBe('data-retention')
    expect(p?.retry).toBe(false)
    expect(problemWords(p!)).toMatch(/^The AWS account's data retention setting .* does not allow the model this installation uses\. An admin runs the installer again/)
  })
  it('reads Bedrock\'s other wording of the same refusal', () => {
    expect(modelProblem("This model is not available under data retention mode 'default'.")?.kind).toBe('data-retention')
  })
  it('tells access, a missing model and a busy model apart', () => {
    expect(modelProblem("AccessDeniedException: You don't have access to the model with the specified model ID.")?.kind).toBe('no-access')
    expect(modelProblem('ValidationException: The provided model identifier is invalid.')?.kind).toBe('not-found')
    const busy = modelProblem('ThrottlingException: Too many requests, please wait before trying again.')
    expect(busy?.kind).toBe('busy')
    expect(busy?.retry).toBe(true)
  })
  it('leaves every other error alone', () => {
    expect(modelProblem('kicad-cli exited 1')).toBeNull()
    expect(modelProblem(null)).toBeNull()
    expect(explainModelError('kicad-cli exited 1')).toBe('kicad-cli exited 1')
  })
  it('puts the plain words first and keeps the raw error, once', () => {
    const said = explainModelError(RAW)
    expect(said.startsWith('trace could not reach its model: the AWS account\'s data retention setting')).toBe(true)
    expect(said).toContain(`(The model said: ${RAW}.)`)
    expect(explainModelError(said)).toBe(said)
  })
  it('knows which models need a chosen retention setting', () => {
    expect(needsRetentionMode('global.anthropic.claude-fable-5-1')).toBe(true)
    expect(needsRetentionMode('us.anthropic.claude-mythos-5')).toBe(true)
    expect(needsRetentionMode('us.anthropic.claude-sonnet-4-6')).toBe(false)
  })
})
