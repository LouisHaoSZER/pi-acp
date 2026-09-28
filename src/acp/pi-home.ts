import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const MANAGED_MARKER_FILE = '.pi-acp-managed'
const MANAGED_MARKER = 'pi-acp'

/**
 * Per-session private pi config dir (`<cwd>/.pi-home`) used as `PI_CODING_AGENT_DIR`.
 * This keeps pi sessions, trust, and settings inside the trial workspace so nothing is
 * written to the user's `~/.pi/agent`.
 */
export type PiHome = {
  path: string
  cleanup: () => void
}

/**
 * Model settings for the locked pi runtime. These must match the installed pi version's
 * settings schema (`defaultProvider` / `defaultModel` / `defaultThinkingLevel` /
 * `enabledModels`) and the model ids actually registered in that pi build.
 */
export function lockedModelSettings(): Record<string, unknown> {
  return {
    defaultProvider: 'deepseek',
    defaultModel: 'deepseek-flash',
    defaultThinkingLevel: 'high',
    enabledModels: ['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro']
  }
}

function getBaseAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent')
}

/**
 * pi resolves `npm:` packages from `<agentDir>/npm`. A fresh per-session home has no such
 * cache, so referencing `npm:pi-mcp-adapter` would make pi hit the network. Reference the
 * already-installed package by absolute path instead, which loads from the image-local cache
 * and keeps `--mcp-config` available after we relocate `PI_CODING_AGENT_DIR`.
 */
function getPiMcpAdapterPackageSource(): string | null {
  const path = join(getBaseAgentDir(), 'npm', 'node_modules', 'pi-mcp-adapter')
  return existsSync(path) ? path : null
}

export function hasPiMcpAdapter(): boolean {
  return getPiMcpAdapterPackageSource() !== null
}

function settingsForPiHome(): Record<string, unknown> {
  const settings = lockedModelSettings()
  const mcpAdapter = getPiMcpAdapterPackageSource()
  if (mcpAdapter) settings.packages = [mcpAdapter]
  return settings
}

function isManaged(path: string): boolean {
  try {
    return readFileSync(join(path, MANAGED_MARKER_FILE), 'utf-8') === MANAGED_MARKER
  } catch {
    return false
  }
}

export function preparePiHome(cwd: string): PiHome {
  const path = join(cwd, '.pi-home')

  if (existsSync(path)) {
    if (!isManaged(path)) {
      throw new Error(`Refusing to use existing, non-pi-acp-managed pi home: ${path}`)
    }
    rmSync(path, { recursive: true, force: true })
  }

  mkdirSync(path, { recursive: true })
  try {
    writeFileSync(join(path, 'settings.json'), JSON.stringify(settingsForPiHome(), null, 2) + '\n', {
      encoding: 'utf-8'
    })
    writeFileSync(join(path, MANAGED_MARKER_FILE), MANAGED_MARKER, { encoding: 'utf-8' })
  } catch (e) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // best effort
    }
    throw e
  }

  return {
    path,
    cleanup: () => {
      try {
        if (isManaged(path)) rmSync(path, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
  }
}
