import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: initialize advertises the tcop.ai/eval evidence contract', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)

  const res = await agent.initialize({ protocolVersion: 1 } as any)

  assert.deepEqual(res._meta, {
    'tcop.ai/eval': {
      version: 1,
      artifact: true,
      tool_name: true,
      model_identity: true
    }
  })
})
