// 画布内核只需要视频协议这一个枚举；model-provider-contract 里还有服务端执行用的密钥上下文，不进内核（#3）。
export type ProviderVideoProtocol = 'relay-videos' | 'xai-native' | 'ark-seedance'

export function isProviderVideoProtocol(value: unknown): value is ProviderVideoProtocol {
  return value === 'relay-videos' || value === 'xai-native' || value === 'ark-seedance'
}
