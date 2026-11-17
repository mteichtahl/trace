import { describe, expect, it } from 'vitest'
import { jobLabel, progressLabel, stepLabel } from './check-names'

describe('build jobs and steps by a readable name', () => {
  it('names the jobs trace knows, and leaves the rest', () => {
    expect(jobLabel('check')).toBe('The design\'s checks')
    expect(jobLabel('automerge')).toBe('Applying it once the checks pass')
    expect(jobLabel('ci / open-pr')).toBe('Opening the change')
    expect(jobLabel('ERC')).toBe('ERC')
  })
  it('folds the setup steps into "Getting ready" and numbers the unnamed ones', () => {
    expect(stepLabel('Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1')).toBe('Getting ready')
    expect(stepLabel('Run aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd')).toBe('Getting ready')
    expect(stepLabel('step 8')).toBe('Step 8')
    expect(stepLabel('Update the installation')).toBe('Update the installation')
  })
  it('says a progress line as the job and its step', () => {
    expect(progressLabel('python-bridge › Run actions/setup-python@6d4fd22b20465ccc0f7354476588e8df7c9ca0e0')).toBe('The design tools\' tests › Getting ready')
    expect(progressLabel('update-installation › Update the installation')).toBe('Updating the installation › Update the installation')
    expect(progressLabel('tests pass › every job it needs passed')).toBe('Every check passed › every job it needs passed')
  })
})
