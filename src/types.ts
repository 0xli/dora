/**
 * Shared types for the Decent Registry.
 *
 * Wire format: messages flow over Carrier text channels with the magic
 * prefix `DECENT_REGISTRY:` followed by a JSON body. JSON keeps the
 * protocol debuggable and easy to extend; the prefix keeps it
 * distinguishable from decentlan's base64 packet frames.
 */

/** Magic prefix on every registry message. Plain ASCII; not valid base64. */
export const REGISTRY_PREFIX = "DECENT_REGISTRY:";

/**
 * Persisted record. `userid` is the primary key. `name` and `virtualIp`
 * are unique within a namespace and the registry rejects collisions.
 */
export interface RegistryRecord {
  userid: string; // base58 Carrier userid (NOT the carrier address)
  name: string; // human-friendly hostname, e.g. "lan-snoopy"
  virtualIp: string; // IPv4, e.g. "10.86.1.10"
  registeredAt: string; // ISO 8601
  lastSeenAt?: string; // ISO 8601, updated on heartbeat or re-register
}

/** Operation discriminator on the wire. */
export type RegistryOp =
  | "register"
  | "register-ok"
  | "register-err"
  | "lookup"
  | "lookup-ok"
  | "lookup-err"
  | "list"
  | "list-ok"
  | "list-err";

export interface RegisterRequest {
  op: "register";
  userid: string;
  name: string;
  /** Preferred IP; if omitted or in use, registry allocates. */
  requestedIp?: string;
  /** When true, an existing record for this userid will be overwritten
   *  (rename + reassign). When false, a mismatch yields register-err. */
  replace?: boolean;
}

export interface RegisterOk {
  op: "register-ok";
  record: RegistryRecord;
}

export interface RegisterErr {
  op: "register-err";
  reason: string;
  suggestion?: string;
}

export interface LookupRequest {
  op: "lookup";
  by: "userid" | "name" | "ip";
  value: string;
}

export interface LookupOk {
  op: "lookup-ok";
  record: RegistryRecord;
}

export interface LookupErr {
  op: "lookup-err";
  reason: string;
}

export interface ListRequest {
  op: "list";
}

export interface ListOk {
  op: "list-ok";
  records: RegistryRecord[];
}

export interface ListErr {
  op: "list-err";
  reason: string;
}

export type RegistryRequest = RegisterRequest | LookupRequest | ListRequest;
export type RegistryResponse =
  | RegisterOk
  | RegisterErr
  | LookupOk
  | LookupErr
  | ListOk
  | ListErr;

/**
 * Encode a request/response as a Carrier text payload.
 * Throws on serialization failure (e.g. circular reference).
 */
export function encode(msg: RegistryRequest | RegistryResponse): string {
  return REGISTRY_PREFIX + JSON.stringify(msg);
}

/**
 * Decode a Carrier text payload. Returns `null` if the text doesn't
 * carry our prefix (i.e. it's a regular decentlan packet frame) or if
 * the JSON body is malformed. Caller is expected to fall through to
 * whatever protocol normally handles unprefixed text.
 */
export function decode(
  text: string
): RegistryRequest | RegistryResponse | null {
  if (!text.startsWith(REGISTRY_PREFIX)) return null;
  const body = text.slice(REGISTRY_PREFIX.length);
  try {
    return JSON.parse(body) as RegistryRequest | RegistryResponse;
  } catch {
    return null;
  }
}
