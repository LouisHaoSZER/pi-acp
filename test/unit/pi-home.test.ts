import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockedModelSettings, preparePiHome } from '../../src/acp/pi-home.js'

test('lockedModelSettings targets the locked pi model registry', () => {
  const settings = lockedModelSettings()

  assert.equal(settings.defaultProvider, 'deepseek')
  assert.equal(settings.defaultModel, 'deepseek-flash')
  assert.equal(settings.defaultThinkingLevel, 'high')
  assert.deepEqual(settings.enabledModels, ['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro'])
})

test('preparePiHome writes a managed settings file and cleans it up', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-home-'))
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  try {
    const home = preparePiHome(root)
    assert.equal(home.path, join(root, '.pi-home'))
    assert.equal(existsSync(join(home.path, '.pi-acp-managed')), true)

    const settings = JSON.parse(readFileSync(join(home.path, 'settings.json'), 'utf-8')) as Record<string, unknown>
    assert.equal(settings.defaultProvider, 'deepseek')
    assert.equal(settings.defaultModel, 'deepseek-flash')
    assert.deepEqual(settings.enabledModels, ['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro'])

    home.cleanup()
    assert.equal(existsSync(home.path), false)
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
  }
})

test('preparePiHome refuses to overwrite an unmanaged .pi-home', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-home-'))
  const existing = join(root, '.pi-home')
  mkdirSync(existing, { recursive: true })
  writeFileSync(join(existing, 'keep.txt'), 'user data', 'utf-8')

  assert.throws(() => preparePiHome(root), /non-pi-acp-managed/)
  assert.equal(existsSync(join(existing, 'keep.txt')), true)
})
