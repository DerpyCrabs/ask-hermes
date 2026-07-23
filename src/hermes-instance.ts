import { workspaceText as text } from './workspace/strings'

export type HermesInstanceConfig = {
  remote: boolean
  address: string
  port: number
  token: string
  instanceId: string
  instanceName: string
}

export function buildHermesInstanceConfig(
  remote: boolean,
  address: string,
  port: string,
  token: string,
  instanceId?: string,
  instanceName?: string,
): HermesInstanceConfig {
  if (!remote) return {
    remote: false,
    address: '127.0.0.1',
    port: 0,
    token: '',
    instanceId: 'automatic-hermes',
    instanceName: text.automaticHermes,
  }

  const normalizedAddress = address.trim()
  if (!normalizedAddress || normalizedAddress.includes('://') || /[\s/\\@?#]/.test(normalizedAddress)) {
    throw new Error(text.invalidHermesHost)
  }
  const normalizedPort = Number(port.trim())
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65_535) {
    throw new Error(text.invalidHermesPort)
  }
  const normalizedToken = token.trim()

  return {
    remote: true,
    address: normalizedAddress,
    port: normalizedPort,
    token: normalizedToken,
    instanceId: instanceId?.trim() || `existing:${normalizedAddress}:${normalizedPort}`,
    instanceName: instanceName?.trim() || text.existingHermesInstance,
  }
}
