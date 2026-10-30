import { describe, expect, it } from 'vitest'
import { AGENT_TOOLS, getMutatingTools, getReadTools } from './registry.js'
import { jsonResult, textResult } from './result.js'

describe('AGENT_TOOLS registry', () => {
  it('is non-empty and every tool has a ZodObject input', () => {
    expect(AGENT_TOOLS.length).toBeGreaterThan(0)
    for (const tool of AGENT_TOOLS) {
      expect(tool.input._def.typeName).toBe('ZodObject')
    }
  })

  it('has unique tool names', () => {
    const names = AGENT_TOOLS.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('splits cleanly into read + mutating tools that reconstitute the full set', () => {
    const readTools = getReadTools()
    const mutatingTools = getMutatingTools()
    expect(readTools.every((tool) => !tool.mutates)).toBe(true)
    expect(mutatingTools.every((tool) => tool.mutates)).toBe(true)
    expect(readTools.length + mutatingTools.length).toBe(AGENT_TOOLS.length)
  })
})

describe('result helpers', () => {
  it('jsonResult serializes a value as pretty JSON text', () => {
    const result = jsonResult({ ok: true })
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }])
  })

  it('jsonResult maps undefined to the literal null', () => {
    const result = jsonResult(undefined)
    expect(result.content).toEqual([{ type: 'text', text: 'null' }])
  })

  it('textResult wraps plain text and can mark an error', () => {
    expect(textResult('hi')).toEqual({ content: [{ type: 'text', text: 'hi' }] })
    expect(textResult('bad', true)).toEqual({
      content: [{ type: 'text', text: 'bad' }],
      isError: true,
    })
  })
})
