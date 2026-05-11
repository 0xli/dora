/**
 * Public surface of decent-registry. Decentlan imports from here.
 */

export { RegistryServer, type RegistryServerOptions } from "./server.js";
export { RegistryClient, type RegistryClientOptions } from "./client.js";
export { RegistryStore } from "./store.js";
export { IpAllocator, type AllocatorOptions } from "./allocator.js";
export {
  REGISTRY_PREFIX,
  encode,
  decode,
  type RegistryRecord,
  type RegistryRequest,
  type RegistryResponse,
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
