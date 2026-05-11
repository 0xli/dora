/**
 * Public surface of decent-dora. Decentlan imports from here.
 */

export { RegistryServer as DoraServer, type RegistryServerOptions as DoraServerOptions } from "./server.js";
export {
  RegistryClient as DoraClient,
  type RegistryClientOptions as DoraClientOptions,
  AllRegistriesUnavailableError,
  randomIpInSubnet,
} from "./client.js";
export { RegistryStore as DoraStore } from "./store.js";
export { IpAllocator, type AllocatorOptions } from "./allocator.js";
export {
  DORA_PREFIX,
  encode,
  decode,
  type RegistryRecord as DoraRecord,
  type RegistryRequest as DoraRequest,
  type RegistryResponse as DoraResponse,
  type RegisterRequest,
  type RegisterOk,
  type RegisterErr,
  type LookupRequest,
  type LookupOk,
  type LookupErr,
  type ListRequest,
  type ListOk,
  type ListErr,
} from "./types.js";
