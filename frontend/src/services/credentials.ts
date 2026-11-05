import { invoke } from "@tauri-apps/api/core";
import { RpcError } from "./backend";
import type { CredentialField, CredentialSaveResult } from "../types";

export async function credentialStatus(): Promise<CredentialField[]> {
  try {
    return await invoke<CredentialField[]>("credentials_status");
  } catch (error) {
    throw RpcError.from(error);
  }
}

export interface LegacyCredentials {
  found: boolean;
  path: string | null;
  keys: string[];
}

export async function legacyCredentialsStatus(): Promise<LegacyCredentials> {
  try {
    return await invoke<LegacyCredentials>("credentials_legacy_status");
  } catch (error) {
    throw RpcError.from(error);
  }
}

export async function importLegacyCredentials(): Promise<CredentialSaveResult> {
  try {
    return await invoke<CredentialSaveResult>("credentials_import_legacy");
  } catch (error) {
    throw RpcError.from(error);
  }
}

export async function saveCredentials(
  values: Record<string, string>,
  clear: string[] = [],
): Promise<CredentialSaveResult> {
  try {
    return await invoke<CredentialSaveResult>("credentials_save", { values, clear });
  } catch (error) {
    throw RpcError.from(error);
  }
}
