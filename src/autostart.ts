export type AutostartAction = 'enable' | 'disable' | 'none'

export function autostartAction(current: boolean, desired: boolean): AutostartAction {
  if (current === desired) return 'none'
  return desired ? 'enable' : 'disable'
}
