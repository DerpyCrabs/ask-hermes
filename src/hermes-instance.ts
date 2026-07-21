export type HermesInstanceConfig = {
  remote: boolean
  address: string
  port: number
  token: string
}

export function buildHermesInstanceConfig(
  remote: boolean,
  address: string,
  port: string,
  token: string,
): HermesInstanceConfig {
  if (!remote) return { remote: false, address: '127.0.0.1', port: 0, token: '' }

  const normalizedAddress = address.trim()
  if (!normalizedAddress || normalizedAddress.includes('://') || /[\s/\\@?#]/.test(normalizedAddress)) {
    throw new Error('Enter a valid Hermes hostname or IP address')
  }
  const normalizedPort = Number(port.trim())
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65_535) {
    throw new Error('Hermes port must be between 1 and 65535')
  }
  const normalizedToken = token.trim()
  if (!normalizedToken) throw new Error('Enter the Hermes session token')

  return {
    remote: true,
    address: normalizedAddress,
    port: normalizedPort,
    token: normalizedToken,
  }
}
