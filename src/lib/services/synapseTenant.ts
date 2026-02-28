import { env } from "@/env";

const DEFAULT_SYNAPSE_TENANT_ID = "default";
const LEGACY_SYNAPSE_TENANT_ID = "sophie-prod";

const configuredTenantId =
  typeof env.SYNAPSE_TENANT_ID === "string" ? env.SYNAPSE_TENANT_ID.trim() : "";

export const SYNAPSE_CANONICAL_TENANT_ID =
  !configuredTenantId || configuredTenantId === LEGACY_SYNAPSE_TENANT_ID
    ? DEFAULT_SYNAPSE_TENANT_ID
    : configuredTenantId;

